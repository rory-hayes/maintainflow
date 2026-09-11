import { lookup } from 'node:dns/promises';
import https from 'node:https';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast'; }
  catch { return false; }
}

export async function validateDestination(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Use an HTTPS destination on port 443 without credentials.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname.length > 253 || url.href.length > 2048 || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Destination is not a public hostname.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answers;
  try {
    answers = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Destination DNS lookup timed out.')), 8_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) {
    throw new Error('Destination must resolve only to public network addresses.');
  }
  return {url, address: answers[0]!.address, family: answers[0]!.family};
}

export type PublicRequestOptions = {
  method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; maxBytes?: number;
};

/** The validated DNS answer is pinned to the socket; redirects are never followed. */
export async function publicRequest(raw: string, options: PublicRequestOptions = {}) {
  const {url, address, family} = await validateDestination(raw);
  return new Promise<{status: number; bytes: Buffer}>((resolve, reject) => {
    const request = https.request(url, {
      method: options.method || 'POST',
      headers: options.headers,
      family,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      timeout: 15_000,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > (options.maxBytes || 64 * 1024)) {
          response.destroy(new Error('Response exceeded the size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({status: response.statusCode || 0, bytes: Buffer.concat(chunks)}));
      response.on('error', reject);
    });
    const deadline = setTimeout(() => request.destroy(new Error('Destination exceeded the 15-second request deadline.')), 15_000);
    request.on('close', () => clearTimeout(deadline));
    request.on('timeout', () => request.destroy(new Error('Destination timed out.')));
    request.on('error', reject);
    request.end(options.body);
  });
}
