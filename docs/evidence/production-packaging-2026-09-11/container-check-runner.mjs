import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';

const image='maintainflow-documents:qa-20260911';
const evidence='/Users/rory/Documents/Ideation/parseur/docs/evidence/production-packaging-2026-09-11';
const startedAt=new Date().toISOString();
const volume=`maintainflow-documents-qa-${randomBytes(6).toString('hex')}`;
const checks=[];
const run=(args)=>spawnSync('docker',args,{encoding:'utf8',timeout:120000});
const record=(name,result,expectedExit=0)=>{
  const passed=result.status===expectedExit;
  checks.push({name,passed,exitCode:result.status,error:result.error?.message,stdout:result.stdout?.trim(),stderr:result.stderr?.trim()});
  console.log(`${name}: ${passed?'passed':'FAILED'} (exit ${result.status})`);
  return passed;
};
let volumeCreated=false;
try{
  const inspected=run(['image','inspect',image,'--format','{{.Id}}']);
  if(!record('image identity',inspected))throw new Error('Image is unavailable');
  const create=run(['volume','create',volume]);
  if(!record('temporary private originals volume',create))throw new Error('Temporary volume could not be created');
  volumeCreated=true;
  const common=['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','128','--memory','1g','--cpus','1','--tmpfs','/tmp:rw,noexec,nosuid,size=256m,mode=1777'];
  const simple="await import('./server/integrations/secrets.ts')";
  record('production missing encryption key rejected',run([...common,'--entrypoint','node',image,'--import','tsx','--input-type=module','-e',simple]),1);
  record('production invalid encryption key rejected',run([...common,'-e','INTEGRATION_ENCRYPTION_KEY=invalid','--entrypoint','node',image,'--import','tsx','--input-type=module','-e',simple]),1);
  const positive=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {spawn} from 'node:child_process';
    import {encryptSecret,decryptSecret} from './server/integrations/secrets.ts';
    import {inspectSource} from './server/core/source.ts';
    import sharp from 'sharp';
    assert.equal(process.getuid(),1000);
    assert.equal(process.env.NODE_ENV,'production');
    for(const filename of ['/app/.env.local','/app/.env','/app/.local','/app/.git']){
      await assert.rejects(fs.stat(filename),{code:'ENOENT'});
    }
    assert.equal(decryptSecret(encryptSecret('synthetic-container-check')),'synthetic-container-check');
    const filename='/var/lib/maintainflow/files/synthetic-container-check';
    await fs.writeFile(filename,'private original',{flag:'wx',mode:0o600});
    assert.equal(await fs.readFile(filename,'utf8'),'private original');
    assert.equal((await fs.stat(filename)).mode&0o777,0o600);
    await fs.unlink(filename);
    const text=await inspectSource(Buffer.from('Invoice number: QA-0001\\nTotal: 18.60\\n'),'synthetic.txt');
    assert.equal(text.pageCount,1);
    assert.ok(text.pages[0].text.includes('QA-0001'));
    const png=await sharp({create:{width:64,height:64,channels:3,background:'#ffffff'}}).png().toBuffer();
    const inspected=await inspectSource(png,'synthetic.png');
    assert.equal(inspected.mimeType,'image/png');
    assert.equal(inspected.pageCount,1);
    const api=spawn(process.execPath,['--import','tsx','server/app.ts'],{stdio:['ignore','ignore','pipe']});
    let apiError='';
    api.stderr.on('data',chunk=>{apiError=(apiError+chunk).slice(-2000)});
    try{
      let health;
      for(let attempt=0;attempt<60;attempt++){
        try{const response=await fetch('http://127.0.0.1:4318/api/health');if(response.ok){health=await response.json();break}}
        catch{}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.equal(health?.environment,'production',apiError);
      const page=await fetch('http://127.0.0.1:4318/');
      assert.equal(page.status,200);
      assert.match(await page.text(),/<!doctype html>/i);
    }finally{
      api.kill('SIGTERM');
      await new Promise(resolve=>api.once('exit',resolve));
    }
    console.log(JSON.stringify({uid:process.getuid(),secretRoundTrip:true,privateOriginalWriteReadDelete:true,sourceTextDecoder:true,sourceImageDecoder:true,localSecretsExcluded:true,productionApiLiveness:true,frontendServed:true}));
  `;
  record('non-root private storage and decoder execution',run([...common,'--mount',`type=volume,source=${volume},target=/var/lib/maintainflow/files`,'-e',`INTEGRATION_ENCRYPTION_KEY=${Buffer.alloc(32,19).toString('base64')}`,'--entrypoint','node',image,'--import','tsx','--input-type=module','-e',positive]));
}catch(error){
  checks.push({name:'runner',passed:false,error:error.message});
}finally{
  if(volumeCreated)record('temporary volume cleanup',run(['volume','rm',volume]));
  await mkdir(evidence,{recursive:true});
  const result={startedAt,finishedAt:new Date().toISOString(),image,scope:'Local Docker image and isolated container primitives; no database, external providers, Compose orchestration or hosted deployment',checks,passed:checks.every(check=>check.passed)};
  await writeFile(`${evidence}/container-checks.json`,JSON.stringify(result,null,2)+'\n');
  if(!result.passed)process.exitCode=1;
}
