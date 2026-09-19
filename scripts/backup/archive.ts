import fs from 'node:fs/promises';
import {constants,createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {Encrypter,Decrypter} from 'age-encryption';
import {backupAssert,BackupError} from './errors.js';
import {backupLimits,ensurePrivateDirectory,safeDestination,validateManifest} from './files.js';
import type {BackupManifest} from './types.js';

export const backupMagic=Buffer.from('FOLIO-BACKUP\n1\n','ascii');

async function* plaintext(directory:string,manifest:BackupManifest){
  const encoded=Buffer.from(JSON.stringify(manifest));
  backupAssert(encoded.length<=backupLimits.manifestBytes,'BACKUP_LIMIT','The backup manifest exceeds its size limit.');
  const length=Buffer.alloc(4);length.writeUInt32BE(encoded.length);
  yield backupMagic;yield length;yield encoded;
  for(const record of manifest.files){
    const parts=record.name.split('/');let parent=directory;
    for(const part of parts.slice(0,-1)){parent=path.join(parent,part);await ensurePrivateDirectory(parent);}
    const file=await fs.open(path.join(directory,record.name),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await file.stat();backupAssert(stat.isFile()&&stat.size===record.bytes,'BACKUP_PAYLOAD','A prepared backup payload is missing or has changed.');
      const hash=createHash('sha256');let bytes=0;
      for await(const chunk of file.createReadStream({autoClose:false})){bytes+=chunk.length;backupAssert(bytes<=record.bytes,'BACKUP_CHANGED','A backup payload changed during encryption.');hash.update(chunk);yield chunk;}
      backupAssert(bytes===record.bytes&&hash.digest('hex')===record.sha256,'BACKUP_CHANGED','A backup payload changed during encryption.');
    }finally{await file.close();}
  }
}

/** Encrypts the standard age stream; rejects source mutation and never replaces output. */
export async function sealArchive(directory:string,value:BackupManifest,recipient:string,outputFile:string){
  const manifest=validateManifest(value);await ensurePrivateDirectory(directory);
  const encrypter=new Encrypter();encrypter.addRecipient(recipient);
  const output=await fs.open(outputFile,'wx',0o600);let complete=false;
  const source=Readable.from(plaintext(directory,manifest));
  try{
    const encrypted=await encrypter.encrypt(Readable.toWeb(source) as ReadableStream<Uint8Array>);
    const stream=Readable.fromWeb(encrypted as Parameters<typeof Readable.fromWeb>[0]);
    for await(const chunk of stream)await output.writeFile(chunk);
    await output.sync();complete=true;
  }finally{source.destroy();await output.close();if(!complete)await fs.unlink(outputFile).catch(()=>{});}
}

class ByteReader {
  private readonly iterator:AsyncIterator<Buffer>;
  private chunk=Buffer.alloc(0);private offset=0;private ended=false;
  constructor(stream:Readable){this.iterator=stream[Symbol.asyncIterator]();}
  async refill():Promise<boolean>{
    if(this.offset<this.chunk.length)return true;
    if(this.ended)return false;
    const next=await this.iterator.next();
    if(next.done){this.ended=true;this.chunk=Buffer.alloc(0);this.offset=0;return false;}
    this.chunk=Buffer.from(next.value);this.offset=0;
    return this.chunk.length>0||this.refill();
  }
  async take(length:number){const result=Buffer.alloc(length);let written=0;for await(const chunk of this.chunks(length)){chunk.copy(result,written);written+=chunk.length;}return result;}
  async *chunks(length:number){
    let remaining=length;
    while(remaining>0){backupAssert(await this.refill(),'BACKUP_TRUNCATED','The backup payload is truncated.');const available=Math.min(remaining,this.chunk.length-this.offset);const part=this.chunk.subarray(this.offset,this.offset+available);this.offset+=available;remaining-=available;yield part;}
  }
  async finish(){backupAssert(!await this.refill(),'BACKUP_TRAILING','The backup contains trailing plaintext.');}
  async close(){await this.iterator.return?.();}
}

/** Fully authenticates to age EOF before returning any payload for database restoration. */
export async function openArchive(inputFile:string,identity:string,directory:string):Promise<{manifest:BackupManifest;ciphertextSha256:string}>{
  await ensurePrivateDirectory(directory);
  backupAssert((await fs.readdir(directory)).length===0,'BACKUP_TARGET','The temporary extraction directory must be empty.');
  const input=await fs.open(inputFile,constants.O_RDONLY|constants.O_NOFOLLOW);let reader:ByteReader|undefined,source:Readable|undefined,meter:Transform|undefined,success=false;
  try{
    const stat=await input.stat();
    backupAssert(stat.isFile()&&stat.size>0&&stat.size<=backupLimits.payloadBytes+backupLimits.manifestBytes+16*1024**2,'BACKUP_LIMIT','The encrypted backup is empty or exceeds the supported size limit.');
    const header=Buffer.alloc(Math.min(backupLimits.headerBytes,stat.size));let headerRead=0;
    while(headerRead<header.length){const {bytesRead}=await input.read(header,headerRead,header.length-headerRead,headerRead);if(!bytesRead)break;headerRead+=bytesRead;}
    const prefix=Buffer.from('age-encryption.org/v1\n');
    backupAssert(header.subarray(0,prefix.length).equals(prefix)&&/^--- [A-Za-z0-9+/]{43}\n/m.test(header.subarray(0,headerRead).toString('latin1')),'BACKUP_HEADER','Use a binary age backup with a bounded authenticated header.');
    const hash=createHash('sha256');let encryptedBytes=0;
    meter=new Transform({transform(chunk:Buffer,_encoding,callback){encryptedBytes+=chunk.length;if(encryptedBytes>stat.size)return callback(new BackupError('BACKUP_CHANGED','The encrypted backup changed while being read.'));hash.update(chunk);callback(null,chunk);}});
    source=input.createReadStream({start:0,autoClose:false});
    source.on('error',error=>meter?.destroy(error));
    const measured=source.pipe(meter);
    const decrypter=new Decrypter();decrypter.addIdentity(identity);
    const decrypted=await decrypter.decrypt(Readable.toWeb(measured) as ReadableStream<Uint8Array>);
    reader=new ByteReader(Readable.fromWeb(decrypted as Parameters<typeof Readable.fromWeb>[0]));
    backupAssert((await reader.take(backupMagic.length)).equals(backupMagic),'BACKUP_FORMAT','The decrypted file is not a supported Folio backup.');
    const length=(await reader.take(4)).readUInt32BE();backupAssert(length>0&&length<=backupLimits.manifestBytes,'BACKUP_LIMIT','The backup manifest exceeds its size limit.');
    const bytes=await reader.take(length);let value:unknown;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new BackupError('BACKUP_MANIFEST','The backup manifest is not valid UTF-8 JSON.');}
    const manifest=validateManifest(value);
    for(const record of manifest.files){
      const outputFile=await safeDestination(directory,record.name),fileHash=createHash('sha256');
      const check=new Transform({transform(chunk:Buffer,_encoding,callback){fileHash.update(chunk);callback(null,chunk);}});
      await pipeline(Readable.from(reader.chunks(record.bytes)),check,createWriteStream(outputFile,{flags:'wx',mode:0o600}));
      backupAssert(fileHash.digest('hex')===record.sha256,'BACKUP_DIGEST','A backup payload failed its integrity check.');
    }
    // This final read validates the last authenticated chunk and rejects appended bytes.
    await reader.finish();
    backupAssert(encryptedBytes===stat.size,'BACKUP_CHANGED','The encrypted backup changed while being read.');
    success=true;return {manifest,ciphertextSha256:hash.digest('hex')};
  }finally{
    await reader?.close().catch(()=>{});source?.destroy();meter?.destroy();await input.close();
    if(!success)for(const item of await fs.readdir(directory))await fs.rm(path.join(directory,item),{recursive:true,force:true});
  }
}
