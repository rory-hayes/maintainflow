import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {nodeFileTrace} from '@vercel/nft';
import {createRequire} from 'node:module';

const root=process.cwd();
const require=createRequire(import.meta.url);
const stage=path.join(root,'.vercel/folio-runtime');
const output=path.join(root,'.vercel/output');
const functionRoot=path.join(output,'functions/api.func');
await fs.rm(stage,{recursive:true,force:true});
await fs.rm(output,{recursive:true,force:true});
await fs.mkdir(functionRoot,{recursive:true});
async function sourceFiles(directory){
  const entries=await fs.readdir(directory,{withFileTypes:true});
  const nested=await Promise.all(entries.map(entry=>entry.isDirectory()?sourceFiles(path.join(directory,entry.name)):entry.name.endsWith('.ts')?[path.join(directory,entry.name)]:[]));
  return nested.flat();
}
// Keep module paths intact, including the separate resource-limited decoder process.
await build({entryPoints:[...await sourceFiles('server'),...await sourceFiles('shared')],outdir:stage,outbase:'.',bundle:false,platform:'node',format:'esm',target:'node24',logLevel:'warning'});
await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({type:'module'}));
// PDF.js discovers its worker and native canvas through runtime-only imports.
// Explicit trace roots preserve those files without copying unrelated packages.
const traced=await nodeFileTrace([path.join(stage,'server/hosted-entry.js'),path.join(stage,'server/core/decoder-child.js'),require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),require.resolve('@napi-rs/canvas')],{base:root,processCwd:stage});
for(const name of traced.fileList){
  const source=path.join(root,name);
  const relative=name.startsWith('.vercel/folio-runtime/')?path.relative(stage,source):name;
  if(!relative.startsWith('node_modules/')&&!name.startsWith('.vercel/folio-runtime/'))throw new Error(`Unexpected runtime dependency: ${relative}`);
  const target=path.join(functionRoot,relative);
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.copyFile(source,target);
}
await fs.writeFile(path.join(functionRoot,'package.json'),JSON.stringify({type:'module'}));
await fs.writeFile(path.join(functionRoot,'.vc-config.json'),JSON.stringify({runtime:'nodejs24.x',handler:'server/hosted-entry.js',launcherType:'Nodejs',maxDuration:300,memory:2048,regions:['fra1'],supportsResponseStreaming:true},null,2));
await fs.cp('dist',path.join(output,'static'),{recursive:true});
await fs.writeFile(path.join(output,'config.json'),JSON.stringify({version:3,routes:[
  {src:'/api(?:/.*)?',dest:'/api'},
  {src:'/assets/(.*)',headers:{'Cache-Control':'public, max-age=31536000, immutable'},continue:true},
  {handle:'filesystem'},
  {src:'/.*',dest:'/index.html'},
]},null,2));
let bytes=0;
async function size(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const filename=path.join(directory,entry.name);if(entry.isDirectory())await size(filename);else bytes+=(await fs.stat(filename)).size;}}
await size(functionRoot);
if(bytes>240*1024*1024)throw new Error('Function bundle exceeds the safe 240 MiB packaging budget.');
console.log(`Vercel function: ${traced.fileList.size} files, ${(bytes/1024/1024).toFixed(1)} MiB. Static UI and private Node runtime packaged separately.`);
