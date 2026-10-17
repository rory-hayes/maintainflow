import test,{after,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Socket} from 'node:net';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type {Role} from '../shared/types.js';
import {hashToken,requireActor} from '../server/core/auth.js';
import {adminPool,appPool,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {registerDocuments} from '../server/core/document-routes.js';
import {registerWorkspace} from '../server/core/workspace-routes.js';
import {registerExports} from '../server/integrations/exports.js';
import {registerIntegrations} from '../server/integrations/webhooks.js';
import {registerProviders} from '../server/integrations/providers.js';

// Real HTTP handlers with synthetic identity responses only. These tests do not
// create accounts/invitations or establish database RLS, storage or hosted proof.
const workspace='abcdefab-cdef-4abc-8def-abcdefabcdef';
const foreignWorkspace='01234567-89ab-4cde-8fab-0123456789ab';
const resource='87654321-4321-4321-8321-cba987654321';
type Method='GET'|'POST'|'PATCH'|'DELETE';
type Principal={userId:string;role:Role;session:string;key:string;scopes:string[]};
type Route=[Method,string,unknown?];
const allScopes=['documents:read','documents:write','results:read','parsers:read','parsers:write','integrations:write','exports:read'];
after(closeDatabase);

async function fixture(context:TestContext){
 const principals=Object.fromEntries((['owner','admin','editor','viewer'] as const).map((role,index)=>[role,{
  userId:`12345678-1234-4123-8123-123456789ab${index}`,role,
  session:`synthetic-role-route-${role}`,key:`fl_synthetic-role-route-${role}`,scopes:[...allScopes],
 }])) as Record<Role,Principal>;
 const identityQueries:string[]=[],workspaceReads:string[]=[],forbiddenCalls:string[]=[];
 const forbidden=(operation:string):never=>{forbiddenCalls.push(operation);throw new Error(`Unexpected ${operation} in controlled route-guard fixture`);};
 context.mock.method(adminPool,'query',async(sql:unknown,parameters:unknown[]=[])=>{
  if(typeof sql!=='string')return forbidden('non-string database query');
  if(sql.startsWith('select s.* from sessions')){
   identityQueries.push('session');
   const principal=Object.values(principals).find(value=>hashToken(value.session)===parameters[0]);
   return {rows:principal?[{user_id:principal.userId,workspace_id:workspace}]:[],rowCount:principal?1:0};
  }
  if(sql==='select role from memberships where user_id=$1 and workspace_id=$2'){
   identityQueries.push('membership');
   const principal=Object.values(principals).find(value=>value.userId===parameters[0]);
   const member=principal&&parameters[1]===workspace;
   return {rows:member?[{role:principal.role}]:[],rowCount:member?1:0};
  }
  if(sql.startsWith('select k.*')){
   identityQueries.push('key');
   const principal=Object.values(principals).find(value=>hashToken(value.key)===parameters[0]);
   return {rows:principal?[{id:principal.userId,user_id:principal.userId,workspace_id:workspace,role:principal.role,scopes:principal.scopes}]:[],rowCount:principal?1:0};
  }
  if(sql==='update api_keys set last_used_at=now() where id=$1'){
   assert.ok(Object.values(principals).some(value=>value.userId===parameters[0]));
   identityQueries.push('last-used');return {rows:[],rowCount:1};
  }
  if(sql==='select * from workspaces where id=$1'){
   assert.deepEqual(parameters,[workspace]);workspaceReads.push(String(parameters[0]));
   return {rows:[{id:workspace,name:'Synthetic role guard workspace',settings:{},plan:{id:'explore'}}],rowCount:1};
  }
  return forbidden('resource database query');
 });
 context.mock.method(adminPool,'connect',async()=>forbidden('administrator database connection'));
 context.mock.method(appPool,'query',async()=>forbidden('tenant database query'));
 context.mock.method(appPool,'connect',async()=>forbidden('tenant database connection'));
 context.mock.method(globalThis,'fetch',async()=>forbidden('provider fetch'));
 context.mock.method(Socket.prototype,'connect',(()=>forbidden('network connection')) as typeof Socket.prototype.connect);
 const app=Fastify({logger:false});
 // Keep even the in-process positive control bounded without a database store.
 await app.register(rateLimit,{max:100,timeWindow:'1 minute'});
 await app.register(cookie);
 await registerDocuments(app);await registerWorkspace(app);await registerExports(app);
 await registerIntegrations(app,{validateDestination:async()=>forbidden('destination validation')});
 await registerProviders(app);
 // This positive control uses the same real authentication helper as the routes.
 app.get('/controlled-role-fixture/actor',async request=>requireActor(request));
 context.after(()=>app.close());
 const request=(principal:Principal,route:Route,options:{api?:boolean;workspaceId?:string;origin?:string;fetchSite?:string}={})=>{
  const [method,url,payload]=route;
  return app.inject({method,url,payload:payload as any,headers:{
   ...(options.api?{authorization:`Bearer ${principal.key}`}:{cookie:`folio_session=${principal.session}`}),
   origin:options.origin??config.origin,
   ...(options.workspaceId?{'x-workspace-id':options.workspaceId}:{}),
   ...(options.fetchSite?{'sec-fetch-site':options.fetchSite}:{}),
  }});
 };
 return {app,principals,request,identityQueries,workspaceReads,forbiddenCalls};
}

test('all four session roles and scoped API keys pass positive identity controls',async context=>{
 const f=await fixture(context);
 for(const principal of Object.values(f.principals)){
  const settings=await f.request(principal,['GET','/api/workspace/settings']);
  assert.equal(settings.statusCode,200,settings.body);assert.equal(settings.json().role,principal.role);
  assert.equal(settings.json().workspace.id,workspace);
  const actor=await f.request(principal,['GET','/controlled-role-fixture/actor'],{api:true});
  assert.equal(actor.statusCode,200,actor.body);
  assert.deepEqual(actor.json(),{userId:principal.userId,workspaceId:workspace,role:principal.role,authType:'api',scopes:allScopes});
 }
 assert.equal(f.workspaceReads.length,4);assert.equal(f.identityQueries.filter(value=>value==='membership').length,4);
 assert.deepEqual(f.forbiddenCalls,[]);
});

test('direct resource requests reject absent or invalid sessions and foreign workspace membership before resource access',async context=>{
 const f=await fixture(context),routes:Route[]=[
  ['GET',`/api/documents/${resource}`],['GET',`/api/documents/${resource}/original`],
  ['GET',`/api/exports/${resource}/download`],['GET','/api/workspace/settings'],['GET','/api/integrations'],
 ];
 for(const [method,url] of routes){
  assert.equal((await f.app.inject({method,url})).statusCode,401,url);
  assert.equal((await f.app.inject({method,url,headers:{cookie:'folio_session=synthetic-unknown-session'}})).statusCode,401,url);
  const denied=await f.request(f.principals.owner,[method,url],{workspaceId:foreignWorkspace});
  assert.equal(denied.statusCode,403,`${url}: ${denied.body}`);
 }
 assert.deepEqual(f.workspaceReads,[]);assert.deepEqual(f.forbiddenCalls,[]);
});

test('Viewer document mutation HTTP routes reject before multipart, persistence or extraction work',async context=>{
 const f=await fixture(context),routes:Route[]=[
  ['POST',`/api/parsers/${resource}/documents`,{}],['POST',`/api/parsers/${resource}/sample`,{}],
  ['POST',`/api/documents/${resource}/reprocess`,{}],['DELETE',`/api/documents/${resource}`],
  ['POST','/api/documents/bulk',{ids:[resource],action:'delete'}],
  ['POST',`/api/runs/${resource}/corrections`,{values:{reference:'synthetic'}}],
  ['POST',`/api/runs/${resource}/approve`,{}],
 ];
 for(const route of routes){const response=await f.request(f.principals.viewer,route);assert.equal(response.statusCode,403,`${route[1]}: ${response.body}`);}
 assert.deepEqual(f.forbiddenCalls,[]);
});

test('Editor and Viewer cannot administer settings, audit records or API keys through direct HTTP routes',async context=>{
 const f=await fixture(context),routes:Route[]=[
  ['PATCH','/api/workspace/settings',{name:'Must not persist'}],['GET','/api/workspace/audit'],
  ['GET','/api/workspace/api-keys'],['POST','/api/workspace/api-keys',{name:'Must not create',scopes:['documents:read']}],
  ['DELETE',`/api/workspace/api-keys/${resource}`],
 ];
 for(const role of ['editor','viewer'] as const)for(const route of routes){
  const response=await f.request(f.principals[role],route);assert.equal(response.statusCode,403,`${role} ${route[1]}: ${response.body}`);
 }
 assert.deepEqual(f.workspaceReads,[]);assert.deepEqual(f.forbiddenCalls,[]);
});

test('administrator sessions cannot change member roles reserved to the owner',async context=>{
 const f=await fixture(context);
 for(const role of ['admin','editor','viewer'] as const){
  const response=await f.request(f.principals.admin,['PATCH',`/api/workspace/members/${resource}`,{role}]);
  assert.equal(response.statusCode,403,response.body);assert.match(response.json().message,/Only the workspace owner/);
 }
 assert.deepEqual(f.forbiddenCalls,[]);
});

test('Editor and Viewer integration management requests stop before destination, provider or persistence work',async context=>{
 const f=await fixture(context),routes:Route[]=[
  ['POST','/api/integrations/webhooks',{name:'Synthetic denied webhook',url:'https://example.test/hook'}],
  ['PATCH',`/api/integrations/${resource}`,{enabled:false}],['DELETE',`/api/integrations/${resource}`],
  ['POST',`/api/deliveries/${resource}/replay`,{}],['GET','/api/providers/events'],
  ['POST','/api/providers/email-routes',{parserId:resource}],['DELETE',`/api/providers/email-routes/${resource}`],
  ['POST','/api/google/start',{integrationId:resource}],['POST',`/api/google/${resource}/disconnect`,{}],
 ];
 for(const role of ['editor','viewer'] as const)for(const route of routes){
  const response=await f.request(f.principals[role],route);assert.equal(response.statusCode,403,`${role} ${route[1]}: ${response.body}`);
 }
 assert.deepEqual(f.forbiddenCalls,[]);
});

test('otherwise authorized administrator API keys cannot enter browser-session-only management routes',async context=>{
 const f=await fixture(context),routes:Route[]=[
  ['GET','/api/workspace/settings'],['PATCH','/api/workspace/settings',{name:'Must not persist'}],
  ['GET','/api/workspace/audit'],['GET','/api/workspace/api-keys'],
  ['POST','/api/workspace/api-keys',{name:'Must not create',scopes:['documents:read']}],
  ['DELETE',`/api/workspace/api-keys/${resource}`],['GET','/api/providers/status'],['GET','/api/providers/events'],
  ['GET','/api/providers/email-routes'],['POST','/api/providers/email-routes',{parserId:resource}],
  ['DELETE',`/api/providers/email-routes/${resource}`],['POST','/api/google/start',{integrationId:resource}],
  ['POST',`/api/google/${resource}/disconnect`,{}],
 ];
 for(const route of routes){
  const response=await f.request(f.principals.admin,route,{api:true});assert.equal(response.statusCode,403,`${route[1]}: ${response.body}`);
  assert.match(response.json().message,/requires a browser session/);
 }
 assert.equal(f.identityQueries.filter(value=>value==='key').length,routes.length);
 assert.deepEqual(f.forbiddenCalls,[]);
});

test('direct original and saved-export HTTP routes enforce their distinct API scopes before resource reads',async context=>{
 const f=await fixture(context),principal=f.principals.admin;
 principal.scopes=['results:read'];
 for(const path of ['original','original-url','bundle-original','bundle-original-url','archive-original','archive-original-url']){
  const response=await f.request(principal,['GET',`/api/documents/${resource}/${path}`],{api:true});
  assert.equal(response.statusCode,403,response.body);assert.match(response.json().message,/documents:read/);
 }
 principal.scopes=['documents:read'];
 for(const url of ['/api/exports',`/api/exports/${resource}/download`]){
  const response=await f.request(principal,['GET',url],{api:true});assert.equal(response.statusCode,403,response.body);
  assert.match(response.json().message,/exports:read or results:read/);
 }
 principal.scopes=['exports:read'];
 const create=await f.request(principal,['POST','/api/exports',{documentIds:[resource],format:'json'}],{api:true});
 assert.equal(create.statusCode,403,create.body);assert.match(create.json().message,/results:read/);
 assert.deepEqual(f.forbiddenCalls,[]);
});

test('current membership role and browser origin checks still govern existing identities at the HTTP boundary',async context=>{
 const f=await fixture(context),principal=f.principals.admin;
 principal.role='viewer';
 for(const api of [false,true]){
  const response=await f.request(principal,['POST',`/api/documents/${resource}/reprocess`,{}],{api});
  assert.equal(response.statusCode,403,response.body);assert.match(response.json().message,/workspace role/);
 }
 principal.role='admin';
 const settings=await f.request(principal,['GET','/api/workspace/settings']);assert.equal(settings.statusCode,200);assert.equal(settings.json().role,'admin');
 for(const options of [{origin:'https://foreign-origin.example.test'},{fetchSite:'cross-site'}]){
  const response=await f.request(principal,['PATCH','/api/workspace/settings',{name:'Must not persist'}],options);
  assert.equal(response.statusCode,403,response.body);assert.match(response.json().message,/origin|Cross-site/);
 }
 assert.deepEqual(f.forbiddenCalls,[]);
});
