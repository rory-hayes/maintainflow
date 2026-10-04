import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Original, clearly synthetic .test-domain EML fixture (CC0-1.0).
// The malformed-address shape comes from the primary upstream advisory:
// https://github.com/nodemailer/nodemailer/security/advisories/GHSA-g57g-f23g-4646
// Expected dependency update: mailparser 3.9.33 / Nodemailer 10.0.13.
// This checks the uploaded EML decoder's sender text, not SMTP delivery.
const fixture = {
  malformed: '"synthetic"@accounting.example.test(comment)trailing.example.test',
  ordinary: '"Accounting Fixture" <synthetic@accounting.example.test>',
  subject: 'MaintainFlow synthetic malformed-address fixture',
  body: 'Reference: MF-SYNTHETIC-ADDRESS-001\r\nTotal: 18.60',
};

test('uploaded EML keeps trailing comment-separated domain atoms out of the normalized sender address', async () => {
  const root = process.cwd(), exec = promisify(execFile);
  const source = `
    import assert from 'node:assert/strict';
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    const require=createRequire(${JSON.stringify(pathToFileURL(path.join(root,'package.json')).href)});
    let transportAttempts=0;
    const blocked=()=>{transportAttempts++;throw new Error('No transports allowed in synthetic EML regression');};
    require('node:net').Socket.prototype.connect=blocked;
    require('node:net').connect=blocked;require('node:net').createConnection=blocked;
    for(const module of ['node:http','node:https']){require(module).request=blocked;require(module).get=blocked;}
    require('node:tls').connect=blocked;require('node:dgram').createSocket=blocked;
    require('node:dns').lookup=blocked;globalThis.fetch=async()=>blocked();syncBuiltinESMExports();
    const {decodeSource}=await import(${JSON.stringify(pathToFileURL(path.join(root,'server/core/decoder-engine.ts')).href)});
    const {simpleParser}=await import('mailparser');
    const fixture=${JSON.stringify(fixture)}, results=[];
    for(const sender of [fixture.malformed,fixture.ordinary]){
      const bytes=Buffer.from('From: '+sender+'\\r\\nSubject: '+fixture.subject+'\\r\\nMIME-Version: 1.0\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\n'+fixture.body+'\\r\\n');
      const original=Buffer.from(bytes),decoded=await decodeSource(bytes,'synthetic-malformed-address.eml');
      const parsed=await simpleParser(bytes,{skipHtmlToText:true,skipTextToHtml:true,maxHtmlLengthToParse:2*1024*1024});
      assert.deepEqual(bytes,original);assert.equal(decoded.mimeType,'message/rfc822');
      assert.equal(decoded.pageCount,1);assert.equal(decoded.pages.length,1);assert.equal(decoded.pages[0].page,1);
      results.push({addresses:parsed.from?.value??[],sourceText:decoded.pages[0].text,unchangedBytes:bytes.equals(original)});
    }
    assert.equal(transportAttempts,0);
    process.stdout.write(JSON.stringify({results,transportAttempts}));
  `;
  const result = await exec(process.execPath, [
    '--max-old-space-size=256','--import',import.meta.resolve('tsx'),'--input-type=module','-e',source,
  ], {
    cwd: root,
    env: {NODE_ENV:'test',TZ:'UTC',LANG:'en_US.UTF-8',TSX_DISABLE_CACHE:'1'},
    timeout: 10_000,
    maxBuffer: 64*1024,
    killSignal: 'SIGKILL',
  });
  const output = JSON.parse(result.stdout);
  assert.equal(output.transportAttempts,0);
  assert.equal(output.results.length,2);
  const [malformed,ordinary] = output.results;
  // Malformed trailing atoms can remain visibly represented as a display name;
  // they must not become a space-containing, ambiguous normalized mailbox.
  assert.deepEqual(malformed.addresses,[{address:'synthetic@accounting.example.test',name:'trailing.example.test'}]);
  assert.deepEqual(ordinary.addresses,[{address:'synthetic@accounting.example.test',name:'Accounting Fixture'}]);
  assert.equal(malformed.sourceText,`Subject: ${fixture.subject}\nFrom: "trailing.example.test" <synthetic@accounting.example.test>\nReference: MF-SYNTHETIC-ADDRESS-001\nTotal: 18.60\n`);
  assert.equal(ordinary.sourceText,`Subject: ${fixture.subject}\nFrom: "Accounting Fixture" <synthetic@accounting.example.test>\nReference: MF-SYNTHETIC-ADDRESS-001\nTotal: 18.60\n`);
  assert.equal(malformed.unchangedBytes,true);assert.equal(ordinary.unchangedBytes,true);
});
