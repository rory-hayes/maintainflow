/**
 * Local browser action fixture; this script performs database operations only.
 * Keep the development worker and global delivery test processors stopped until
 * the browser has replayed and removed the fixture.
 *
 * node --import tsx scripts/browser-webhook-fixture.ts create --worker-stopped
 * node --import tsx scripts/browser-webhook-fixture.ts cleanup <fixture-id> --worker-stopped
 *
 * stdout contains IDs only. The fixture ID is also the integration ID.
 */
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {adminPool,closeDatabase,transaction} from '../server/core/db.js';
import {databaseConfig} from '../server/core/config.js';
import {encryptSecret} from '../server/integrations/secrets.js';

const ownerEmail='browser-qa@folio.example';
const parserName='Pagination QA';
const fixtureName='UI fixture — no request sent';
const fixtureMarker='browser-webhook-fixture-v1';
const fixtureUrl='https://ui-fixture.folio.example/no-request-sent';
const fixtureSecret='synthetic-ui-fixture-signing-secret-not-a-provider-credential';
const projectRoot=fileURLToPath(new URL('..',import.meta.url));

function assertLocalRun(){
  if(process.env.NODE_ENV==='production'||path.resolve(process.cwd())!==path.resolve(projectRoot))throw new Error('Run this local fixture from the parseur project directory in development mode.');
  for(const connection of [process.env.DATABASE_ADMIN_URL,process.env.DATABASE_URL]){
    if(!connection)continue;
    const url=new URL(connection),host=url.searchParams.get('host')||url.hostname;
    if(!path.isAbsolute(host)&&!['localhost','127.0.0.1','[::1]',''].includes(host))throw new Error('This fixture accepts local database connections only.');
  }
  if(!path.isAbsolute(databaseConfig.host)&&!['localhost','127.0.0.1','::1'].includes(databaseConfig.host))throw new Error('This fixture accepts a local socket or loopback database host only.');
}

try{
  assertLocalRun();
  const args=process.argv.slice(2);
  const mode=args[0];
  if(!args.includes('--worker-stopped')||!((mode==='create'&&args.length===2&&args[1]==='--worker-stopped')||(mode==='cleanup'&&args.length===3&&args[2]==='--worker-stopped')))throw new Error('Usage: create --worker-stopped, or cleanup <fixture-id> --worker-stopped. Stop all delivery workers before using the fixture.');
  const requestedId=mode==='cleanup'?z.uuid().parse(args[1]):undefined;
  const ids=await transaction(adminPool,async client=>{
    const scope=await client.query<{workspace_id:string;parser_id:string}>(`
      SELECT p.workspace_id,p.id AS parser_id
      FROM users u JOIN memberships m ON m.user_id=u.id
      JOIN parsers p ON p.workspace_id=m.workspace_id
      WHERE u.email=$1 AND m.role='owner' AND p.name=$2 AND NOT p.archived
      FOR UPDATE OF p`,[ownerEmail,parserName]);
    if(scope.rowCount!==1)throw new Error('Expected exactly one active Pagination QA parser in a workspace owned by the synthetic QA account; no changes made.');
    const {workspace_id:workspaceId,parser_id:parserId}=scope.rows[0];
    await client.query("SELECT set_config('app.workspace_id',$1,true)",[workspaceId]);

    if(mode==='create'){
      const existing=await client.query("SELECT id FROM integrations WHERE workspace_id=$1 AND parser_id=$2 AND config->>'fixtureMarker'=$3",[workspaceId,parserId,fixtureMarker]);
      if(existing.rowCount)throw new Error('A browser webhook fixture already exists in this parser. Remove that fixture before creating another.');
      const fixtureId=randomUUID(),deliveryId=randomUUID();
      await client.query(`INSERT INTO integrations(id,workspace_id,parser_id,name,kind,config,secret_ciphertext,enabled)
        VALUES($1,$2,$3,$4,'webhook',$5,$6,false)`,[fixtureId,workspaceId,parserId,fixtureName,JSON.stringify({url:fixtureUrl,fixtureMarker,fixtureId}),encryptSecret(fixtureSecret)]);
      await client.query(`INSERT INTO webhook_deliveries(id,workspace_id,integration_id,event_key,payload,status,attempts,next_attempt_at,error)
        VALUES($1,$2,$3,$4,$5,'failed',0,'infinity',$6)`,[deliveryId,workspaceId,fixtureId,`ui-fixture:${fixtureId}`,JSON.stringify({event:'ui.fixture',fixtureId,synthetic:true,note:fixtureName,parserId}),fixtureName]);
      return {workspaceId,parserId,fixtureId,integrationId:fixtureId,deliveryId};
    }

    const found=await client.query(`SELECT id FROM integrations WHERE id=$1 AND workspace_id=$2 AND parser_id=$3
      AND kind='webhook' AND name=$4 AND config->>'url'=$5 AND config->>'fixtureMarker'=$6 AND config->>'fixtureId'=$1::text
      FOR UPDATE`,[requestedId,workspaceId,parserId,fixtureName,fixtureUrl,fixtureMarker]);
    if(found.rowCount!==1)throw new Error('No matching fixture exists in the exact QA workspace/parser; no changes made.');
    const deliveries=await client.query<{id:string;event_key:string;payload:{fixtureId?:string}}>('SELECT id,event_key,payload FROM webhook_deliveries WHERE integration_id=$1 AND workspace_id=$2 FOR UPDATE',[requestedId,workspaceId]);
    if(deliveries.rows.some(row=>row.event_key!==`ui-fixture:${requestedId}`||row.payload.fixtureId!==requestedId))throw new Error('The fixture has a non-fixture delivery. Cleanup refused to preserve other data.');
    // The FK cascade removes only this fixture's deliveries; audit history stays.
    await client.query('DELETE FROM integrations WHERE id=$1 AND workspace_id=$2 AND parser_id=$3',[requestedId,workspaceId,parserId]);
    return {workspaceId,parserId,fixtureId:requestedId,integrationId:requestedId,deliveryIds:deliveries.rows.map(row=>row.id)};
  });
  process.stdout.write(`${JSON.stringify(ids)}\n`);
}catch(error){
  process.stderr.write(`${error instanceof Error?error.message:'Fixture operation failed.'}\n`);
  process.exitCode=1;
}finally{
  await closeDatabase();
}
