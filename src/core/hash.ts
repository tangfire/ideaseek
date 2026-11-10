import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Canonical content hash form: `sha256:<hex>`. */
export type ContentHash = `sha256:${string}`;

export function sha256Of(data: Buffer | string): ContentHash {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

export async function sha256OfFile(path: string): Promise<ContentHash> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return `sha256:${hash.digest('hex')}`;
}

export function isContentHash(value: string): value is ContentHash {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

export async function verifyFileHash(path: string, expected: ContentHash): Promise<boolean> {
  try {
    const actual = await sha256OfFile(path);
    return actual === expected;
  } catch {
    return false;
  }
}

export async function sha256OfJson(value: unknown): Promise<ContentHash> {
  return sha256Of(JSON.stringify(value));
}
