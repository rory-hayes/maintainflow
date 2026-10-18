/** Synthetic cost-history acceptance shared by the two isolated restore fixtures. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';

export interface AiUsageFixture {
 rows:string[];
 ids:string[];
 workspaces:string[];
 deletedSources:{table:string;id:string}[];
 sha256:string;
}
const digest=(rows:string[])=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
async function rows(client:pg.Client,ids:string[]){return(await client.query('SELECT to_jsonb(t)::text body FROM folio.ai_usage_attempts t WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows.map(r=>r.body as string);}

export async function seedAiUsageFixture(client:pg.Client):Promise<AiUsageFixture>{
 const workspaces=(await client.query('SELECT id FROM folio.workspaces ORDER BY id LIMIT 2')).rows.map(r=>r.id as string);
 assert.equal(workspaces.length,2);
 const user=(await client.query('SELECT id FROM folio.users ORDER BY id LIMIT 1')).rows[0]?.id;assert.ok(user);
 const fixture:AiUsageFixture={rows:[],ids:[],workspaces,deletedSources:[],sha256:''};
 for(const workspace of workspaces){
  const parser=randomUUID(),schema=randomUUID(),document=randomUUID();
  const operations={extraction:randomUUID(),schema_suggestion:randomUUID(),split_suggestion:randomUUID()};
  await client.query("INSERT INTO folio.parsers(id,workspace_id,name) VALUES($1,$2,'SYNTHETIC cost-retention source')",[parser,workspace]);
  await client.query("INSERT INTO folio.schema_versions(id,workspace_id,parser_id,version,schema) VALUES($1,$2,$3,1,'{}')",[schema,workspace,parser]);
  await client.query("INSERT INTO folio.documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,page_count) VALUES($1,$2,$3,'SYNTHETIC deleted cost source.txt','text/plain',1,$4,$5,1)",[document,workspace,parser,'a'.repeat(64),workspace+'/'+randomUUID()]);
  await client.query("INSERT INTO folio.jobs(id,workspace_id,document_id,schema_version_id,config,state) VALUES($1,$2,$3,$4,'{}','completed')",[operations.extraction,workspace,document,schema]);
  await client.query("INSERT INTO folio.schema_suggestions(id,workspace_id,parser_id,document_id,base_schema_id,request_id,document_sha256,config,state) VALUES($1,$2,$3,$4,$5,$6,$7,'{}','failed')",[operations.schema_suggestion,workspace,parser,document,schema,randomUUID(),'a'.repeat(64)]);
  await client.query("INSERT INTO folio.split_suggestions(id,workspace_id,parser_id,requested_by,request_id,auth_type,token_hash,source_name,source_sha256,source_mime_type,expected_bytes,source_reserved_bytes,config,state) VALUES($1,$2,$3,$4,$5,'session',$6,'SYNTHETIC deleted split source.pdf',$7,'application/pdf',1,0,'{}','cancelled')",[operations.split_suggestion,workspace,parser,user,randomUUID(),'b'.repeat(64),'c'.repeat(64)]);
  for(const [kind,operation]of Object.entries(operations))for(let attempt=1;attempt<=5;attempt++){
   const id=randomUUID(),response=attempt>=3,priced=attempt===5,reported=attempt>=4;
   fixture.ids.push(id);
   await client.query(`INSERT INTO folio.ai_usage_attempts(id,workspace_id,kind,operation_id,attempt,created_at,observed_at,outcome,model,request_id,response_id,http_status,response_status,usage_state,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,cost_usd,pricing_basis)
    VALUES($1,$2,$3,$4,$5,'2026-10-01T00:00:00Z',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,[
    id,workspace,kind,operation,attempt,response?'2026-10-01T00:01:00Z':null,
    attempt===1?'pending':attempt===2?'interrupted':'response_received',response?'synthetic-model-v1':null,response?'req_synthetic_'+id:null,response?'resp_synthetic_'+id:null,response?200:null,response?(priced?'failed':'completed'):null,
    priced?'reported_priced':reported?'reported_unpriced':'unknown',reported?1234:null,reported?234:null,reported?87:null,reported?17:null,
    priced?(kind==='split_suggestion'?'0.000000000':'0.012345678'):null,priced?'SYNTHETIC fixed restore price; not a provider quote':null]);
  }
  const sources=[{table:'jobs',id:operations.extraction},{table:'schema_suggestions',id:operations.schema_suggestion},{table:'split_suggestions',id:operations.split_suggestion}];
  for(const source of sources)assert.equal((await client.query(`SELECT count(*)::int n FROM folio.${source.table} WHERE id=$1`,[source.id])).rows[0].n,1);
  await client.query('DELETE FROM folio.parsers WHERE id=$1',[parser]);
  fixture.deletedSources.push(...sources,{table:'documents',id:document},{table:'parsers',id:parser});
 }
 fixture.rows=await rows(client,fixture.ids);assert.equal(fixture.rows.length,30);fixture.sha256=digest(fixture.rows);
 await assertAiUsageFixture(client,fixture);
 return fixture;
}

export async function assertAiUsageFixture(client:pg.Client,fixture:AiUsageFixture){
 const actual=await rows(client,fixture.ids);assert.deepEqual(actual,fixture.rows);assert.equal(digest(actual),fixture.sha256);
 for(const source of fixture.deletedSources){assert.ok(['jobs','schema_suggestions','split_suggestions','documents','parsers'].includes(source.table));assert.equal((await client.query(`SELECT count(*)::int n FROM folio.${source.table} WHERE id=$1`,[source.id])).rows[0].n,0);}
 const shape=(await client.query(`SELECT kind,usage_state,outcome,count(*)::int count FROM folio.ai_usage_attempts WHERE id=ANY($1::uuid[]) GROUP BY kind,usage_state,outcome ORDER BY kind,usage_state,outcome`,[fixture.ids])).rows;
 assert.equal(shape.length,15);assert.ok(shape.every(r=>r.count===2));
 const coverage=(await client.query(`SELECT count(*) FILTER(WHERE usage_state='unknown' AND cost_usd IS NULL)::int unknown,
  count(*) FILTER(WHERE usage_state='reported_unpriced' AND cost_usd IS NULL)::int unpriced,
  count(*) FILTER(WHERE usage_state='reported_priced')::int priced,
  count(*) FILTER(WHERE cost_usd::text='0.000000000')::int zero,
  count(*) FILTER(WHERE cost_usd::text='0.012345678')::int nine_decimal
  FROM folio.ai_usage_attempts WHERE id=ANY($1::uuid[])`,[fixture.ids])).rows[0];
 assert.deepEqual(coverage,{unknown:18,unpriced:6,priced:6,zero:2,nine_decimal:4});
}

/** Opens fresh restricted connections. All server-write probes roll back. */
export async function assertAiUsagePermissions(connect:(role:string)=>pg.Client,fixture:AiUsageFixture){
 const tenant=connect('backup_app');await tenant.connect();
 try{
  assert.equal((await tenant.query('SELECT count(*)::int n FROM folio.ai_usage_attempts')).rows[0].n,0);
  for(const workspace of fixture.workspaces){
   await tenant.query("SELECT set_config('app.workspace_id',$1,false)",[workspace]);
   const actual=await rows(tenant,fixture.ids),expected=fixture.rows.filter(row=>JSON.parse(row).workspace_id===workspace);
   assert.equal(actual.length,15);assert.deepEqual(actual,expected);
   await assert.rejects(tenant.query('DELETE FROM folio.ai_usage_attempts'),(e:any)=>e.code==='42501');
   await assert.rejects(tenant.query("UPDATE folio.ai_usage_attempts SET outcome='interrupted' WHERE outcome='pending'"),(e:any)=>e.code==='42501');
   await assert.rejects(tenant.query("INSERT INTO folio.ai_usage_attempts(id,workspace_id,kind,operation_id,attempt) VALUES($1,$2,'extraction',$3,1)",[randomUUID(),workspace,randomUUID()]),(e:any)=>e.code==='42501');
  }
 }finally{await tenant.end();}
 const admin=connect('backup_admin');await admin.connect();
 try{
  assert.deepEqual(await rows(admin,fixture.ids),fixture.rows);
  await admin.query('BEGIN');
  const id=randomUUID();await admin.query("INSERT INTO folio.ai_usage_attempts(id,workspace_id,kind,operation_id,attempt) VALUES($1,$2,'extraction',$3,1)",[id,fixture.workspaces[0],randomUUID()]);
  assert.equal((await admin.query("UPDATE folio.ai_usage_attempts SET outcome='interrupted' WHERE id=$1",[id])).rowCount,1);
  assert.equal((await admin.query('SELECT outcome FROM folio.ai_usage_attempts WHERE id=$1',[id])).rows[0].outcome,'interrupted');
  await admin.query('ROLLBACK');
  const finalized=JSON.parse(fixture.rows.find(row=>JSON.parse(row).usage_state==='reported_priced')!);
  await assert.rejects(admin.query('UPDATE folio.ai_usage_attempts SET cost_usd=cost_usd+1 WHERE id=$1',[finalized.id]),/immutable/);
  const pending=JSON.parse(fixture.rows.find(row=>JSON.parse(row).outcome==='pending')!);
  await assert.rejects(admin.query('UPDATE folio.ai_usage_attempts SET operation_id=$1 WHERE id=$2',[randomUUID(),pending.id]),/immutable/);
  await assertAiUsageFixture(admin,fixture);
 }finally{await admin.query('ROLLBACK').catch(()=>undefined);await admin.end();}
}
