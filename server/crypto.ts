import crypto from 'node:crypto';

// Encrypts connected-account tokens at rest (AES-256-GCM). The key comes from TOKEN_ENCRYPTION_KEY,
// or JWT_SECRET if that isn't set; changing it means reconnecting accounts.
const key = crypto
  .createHash('sha256')
  .update(process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || 'dev-only-insecure-secret')
  .digest();

export function encrypt(plain: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

export function decrypt(stored: string) {
  const raw = Buffer.from(stored.replace(/^v1:/, ''), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
