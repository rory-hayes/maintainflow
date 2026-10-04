import test,{after,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {FastifyRequest} from 'fastify';
import type {Role} from '../shared/types.js';
import {requireActor,editors} from '../server/core/auth.js';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {validateStorageKey} from '../server/core/storage.js';

// Controlled database responses only: no actual database, provider or bank data.
const workspace='abcdefab-cdef-4abc-8def-abcdefabcdef';
const foreignWorkspace='01234567-89ab-4cde-8fab-0123456789ab';
const user='12345678-1234-4123-8123-123456789abc';
const originalKey=`${workspace}/${user}`;
const request=(selected?:string,method='GET',headers:Record<string,string>={})=>({method,cookies:{folio_session:'synthetic-owned-session'},headers:{origin:config.origin,...(selected===undefined?{}:{'x-workspace-id':selected}),...headers}} as unknown as FastifyRequest);
const denied=(status:number)=>(error:any)=>error.statusCode===status;
function sessionQueries(context:TestContext,state:{role:Role}={role:'owner'}){
 const membershipWorkspaceIds:string[]=[];
 context.mock.method(adminPool,'query',async(sql:unknown,parameters:unknown[]=[])=>{
  assert.equal(typeof sql,'string');
  if(String(sql).startsWith('select s.* from sessions'))return {rows:[{user_id:user,workspace_id:workspace}]};
  if(String(sql)==='select role from memberships where user_id=$1 and workspace_id=$2'){
   assert.equal(parameters[0],user);assert.equal(typeof parameters[1],'string');
   const selected=parameters[1] as string;membershipWorkspaceIds.push(selected);
   // PostgreSQL UUID identity ignores letter case; the actor must do so too.
   return {rows:selected.toLowerCase()===workspace?[{role:state.role}]:[]};
  }
  throw new Error('Unexpected database access in controlled workspace fixture');
 });
 return membershipWorkspaceIds;
}
after(closeDatabase);

test('workspace case variants authorize the same original without changing its storage key',async context=>{
 const membershipWorkspaceIds=sessionQueries(context);
 for(const selected of [undefined,workspace,workspace.toUpperCase(),'Abcdefab-cdef-4abc-8def-abcdefabcdef']){
  const actor=await requireActor(request(selected));
  assert.deepEqual(actor,{userId:user,workspaceId:workspace,role:'owner',authType:'session'});
  assert.equal(validateStorageKey(originalKey,actor.workspaceId),originalKey);
 }
 assert.deepEqual(membershipWorkspaceIds,[workspace,workspace,workspace,workspace]);
});

test('workspace canonicalization still denies foreign membership and malformed UUID headers',async context=>{
 const membershipWorkspaceIds=sessionQueries(context);
 await assert.rejects(requireActor(request(foreignWorkspace.toUpperCase())),denied(403));
 assert.deepEqual(membershipWorkspaceIds,[foreignWorkspace]);
 for(const invalid of [`${workspace}\n`,`${workspace}/../${foreignWorkspace}`,` ${workspace}`,`${workspace} `,'not-a-workspace'])await assert.rejects(requireActor(request(invalid)),denied(400));
 assert.deepEqual(membershipWorkspaceIds,[foreignWorkspace],'Malformed headers must not reach membership lookup');
});

test('case variants retain current roles and the existing mutation origin checks',async context=>{
 const state:{role:Role}={role:'editor'};sessionQueries(context,state);
 const actor=await requireActor(request(workspace.toUpperCase(),'POST'),{roles:editors});assert.equal(actor.role,'editor');assert.equal(actor.workspaceId,workspace);
 state.role='viewer';
 await assert.rejects(requireActor(request(workspace.toUpperCase(),'POST'),{roles:editors}),denied(403));
 assert.equal((await requireActor(request(workspace.toUpperCase()))).role,'viewer');
 state.role='admin';
 await assert.rejects(requireActor(request(workspace.toUpperCase(),'POST',{origin:'https://foreign-origin.example.test'}),{roles:editors}),denied(403));
 await assert.rejects(requireActor(request(workspace.toUpperCase(),'POST',{'sec-fetch-site':'cross-site'}),{roles:editors}),denied(403));
});

test('session workspace normalization does not expand scoped API-key or current-role access',async context=>{
 let role:Role='editor',available=true;
 context.mock.method(adminPool,'query',async(sql:unknown)=>{
  if(String(sql).startsWith('select k.*'))return {rows:available?[{id:user,user_id:user,workspace_id:workspace,role,scopes:['documents:read','documents:write']}]:[]};
  if(String(sql)==='update api_keys set last_used_at=now() where id=$1')return {rows:[]};
  throw new Error('Unexpected database access in controlled API-key fixture');
 });
 const keyed=request(foreignWorkspace.toUpperCase(),'POST',{authorization:'Bearer fl_synthetic-owned-key'});
 assert.equal((await requireActor(keyed,{roles:editors,scope:'documents:write'})).workspaceId,workspace);
 await assert.rejects(requireActor(keyed,{scope:'results:read'}),denied(403));
 role='viewer';await assert.rejects(requireActor(keyed,{roles:editors,scope:'documents:write'}),denied(403));
 available=false;await assert.rejects(requireActor(keyed,{scope:'documents:read'}),denied(401));
});
