import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync,openSync,fstatSync,closeSync,constants } from 'node:fs';
import { resolve,isAbsolute } from 'node:path';

function configuredFileKey(filename:string){
 let descriptor:number|undefined;
 try{
  if(!isAbsolute(filename))throw new Error('Invalid key file.');
  descriptor=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  const stat=fstatSync(descriptor);
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>256)throw new Error('Invalid key file.');
  const bytes=readFileSync(descriptor);
  if(bytes.length===32)return bytes;
  const value=bytes.toString('utf8').trim(),decoded=Buffer.from(value,'base64');
  if(decoded.length!==32||decoded.toString('base64')!==value)throw new Error('Invalid key file.');
  return decoded;
 }catch{throw new Error('INTEGRATION_ENCRYPTION_KEY_FILE must be an absolute path to an owner-only regular file containing 32 raw bytes or their canonical base64 encoding.');}
 finally{if(descriptor!==undefined)closeSync(descriptor);}
}

let key: Buffer | undefined;
function encryptionKey() {
  const configured = process.env.INTEGRATION_ENCRYPTION_KEY;
  const filename=process.env.INTEGRATION_ENCRYPTION_KEY_FILE;
  if(configured&&filename)throw new Error('Configure only one of INTEGRATION_ENCRYPTION_KEY and INTEGRATION_ENCRYPTION_KEY_FILE.');
  if (key) return key;
  if(filename){key=configuredFileKey(filename);return key;}
  if (configured) {
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== configured.replace(/=+$/, '')) {
      throw new Error('Integration encryption key must be a base64-encoded 32-byte value.');
    }
    key = decoded;
    return key;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('INTEGRATION_ENCRYPTION_KEY is required in production.');
  const directory = resolve('.local/secrets');
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const fallbackFilename = resolve(directory, 'integration-key');
  try { writeFileSync(fallbackFilename, randomBytes(32), {mode: 0o600, flag: 'wx'}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stored = readFileSync(fallbackFilename);
  if (stored.length !== 32) throw new Error('The local integration key is invalid. Restore the original key from your private backup.');
  key = stored;
  return key;
}

// Both API and worker import this module. Refuse to start a production process
// without the shared stable key, instead of discovering it on the first export.
if (process.env.NODE_ENV === 'production') encryptionKey();

/** Stable opaque identifiers without storing the underlying private value. */
export function privateIdentifier(namespace: string, value: string) {
  return createHmac('sha256', encryptionKey()).update(namespace).update('\0').update(value).digest('hex');
}

export function encryptSecret(value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.');
}

export function decryptSecret(value: string) {
  const parts = value.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[\w-]*$/.test(part))) throw new Error('Invalid encrypted integration secret.');
  const [nonce, tag, body] = parts.map(part => Buffer.from(part, 'base64url'));
  if (nonce?.length !== 12 || tag?.length !== 16 || !body) throw new Error('Invalid encrypted integration secret.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
