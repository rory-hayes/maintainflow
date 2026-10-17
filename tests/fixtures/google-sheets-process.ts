// Invoked only by the isolated database lifecycle test. Every Google operation
// is replaced before delivery; no HTTP listener or provider request is made.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {adminPool,closeDatabase} from '../../server/core/db.js';
import {sendGoogleSheets} from '../../server/integrations/providers.js';

assert.equal(process.env.FOLIO_SYNTHETIC_GOOGLE_PROCESS,'true');
const input=JSON.parse(await new Promise<string>((resolve,reject)=>{
 let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>text+=part);process.stdin.once('end',()=>resolve(text));process.stdin.once('error',reject);
}));
let accessCalls=0;const requests:unknown[]=[];
OAuth2Client.prototype.getAccessToken=(async function(this:OAuth2Client){
 accessCalls++;assert.equal(this.credentials.refresh_token,input.expectedRefreshToken);
 this.credentials={...this.credentials,access_token:'SYNTHETIC_REPLACEMENT_ACCESS',refresh_token:'SYNTHETIC_PERSISTED_REFRESH',expiry_date:Date.now()+3_600_000};
 this.emit('tokens',this.credentials);
 return {token:'SYNTHETIC_REPLACEMENT_ACCESS',res:{status:200}};
}) as typeof OAuth2Client.prototype.getAccessToken;
OAuth2Client.prototype.request=(async function(this:OAuth2Client,request:unknown){
 assert.equal(this.credentials.refresh_token,'SYNTHETIC_PERSISTED_REFRESH');requests.push(request);return {status:200,data:{}};
}) as typeof OAuth2Client.prototype.request;
try{
 const {rows:[integration]}=await adminPool.query('select * from integrations where id=$1 and workspace_id=$2',[input.integrationId,input.workspaceId]);
 assert.ok(integration);
 const result=await sendGoogleSheets(integration,input.delivery);
 const {rows:writes}=await adminPool.query('select event_key,data_range,status,cells from sheet_writes where integration_id=$1 order by data_range',[input.integrationId]);
 process.stdout.write(JSON.stringify({pid:process.pid,result,accessCalls,requestCount:requests.length,requestDigests:requests.map(request=>createHash('sha256').update(JSON.stringify(request)).digest('hex')),writes}));
}finally{await closeDatabase();}
