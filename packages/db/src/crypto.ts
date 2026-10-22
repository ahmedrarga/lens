import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

function key(secret: string): Buffer {
  if (!secret || secret.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters');
  return Buffer.from(hkdfSync('sha256', secret, 'lens-session-v1', 'github-token-encryption', 32));
}

/** AES-256-GCM; output = base64(iv[12] | tag[16] | ciphertext). */
export function encryptToken(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptToken(enc: string, secret: string): string {
  const b = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(secret), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
