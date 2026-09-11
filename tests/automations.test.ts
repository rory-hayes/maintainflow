import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {signDelivery} from '../server/integrations/webhooks.js';
import {closeDatabase} from '../server/core/db.js';
import {after} from 'node:test';
import {verifyApprovalDelivery} from '../examples/automations/verify.js';
const read=(file:string)=>JSON.parse(readFileSync(new URL(`../fixtures/automations/${file}`,import.meta.url),'utf8'));
const fixture=read('document-approved.json'),schema=z.fromJSONSchema(read('document-approved.schema.json'));
after(closeDatabase);
test('four automation recipes map actual approved-event fields without identifier coercion',()=>{
 schema.parse(fixture);assert.equal(schema.safeParse({...fixture,revision:'1'}).success,false);assert.equal(schema.safeParse({...fixture,event:'document.received'}).success,false);
 const recipes=read('recipes.json').recipes;assert.deepEqual(recipes.map((r:any)=>r.platform),['Zapier','Make','n8n','Power Automate']);
 for(const recipe of recipes)for(const mapping of recipe.mappings){const value=mapping.sourcePath.split('.').reduce((v:any,key:string)=>v?.[key],fixture);assert.deepEqual(value,mapping.expected,`${recipe.platform}: ${mapping.field}`);}
 assert.equal(fixture.values.invoice_number,'000127');assert.equal(fixture.values.line_items.reduce((sum:number,row:any)=>sum+row.amount,0),fixture.values.subtotal);
});
test('receiver example verifies the sender contract before JSON parsing and preserves replay identity',()=>{
 const body=Buffer.from(JSON.stringify(fixture)),timestamp=String(Math.floor(Date.now()/1000)),secret='synthetic-receiver-test-only',deliveryId=randomUUID();
 const headers={'X-Folio-Delivery':deliveryId,'Idempotency-Key':deliveryId,'X-Folio-Timestamp':timestamp,'X-Folio-Signature':`v1=${signDelivery(secret,timestamp,body.toString())}`};
 const verified=verifyApprovalDelivery({body,headers},secret);assert.equal(verified.deliveryId,deliveryId);assert.deepEqual(verified.event,fixture);
 assert.deepEqual(verifyApprovalDelivery({body,headers},secret),verified);
 assert.throws(()=>verifyApprovalDelivery({body:Buffer.from(body.toString()+' '),headers},secret),/signature/);
 assert.throws(()=>verifyApprovalDelivery({body,headers},secret,Number(timestamp)+301),/expired/);
 assert.throws(()=>verifyApprovalDelivery({body,headers},'wrong-fixture-secret'),/signature/);
 assert.throws(()=>verifyApprovalDelivery({body,headers:{...headers,'Idempotency-Key':randomUUID()}},secret),/identity/);
});
