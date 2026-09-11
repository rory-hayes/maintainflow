import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

let key: Buffer | undefined;
function encryptionKey() {
  if (key) return key;
  const configured = process.env.INTEGRATION_ENCRYPTION_KEY;
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
  const filename = resolve(directory, 'integration-key');
  try { writeFileSync(filename, randomBytes(32), {mode: 0o600, flag: 'wx'}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stored = readFileSync(filename);
  if (stored.length !== 32) throw new Error('The local integration key is invalid. Restore the original key from your private backup.');
  key = stored;
  return key;
}

// Both API and worker import this module. Refuse to start a production process
// without the shared stable key, instead of discovering it on the first export.
if (process.env.NODE_ENV === 'production') encryptionKey();

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
