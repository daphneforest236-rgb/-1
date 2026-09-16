import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [algorithm, salt, expected] = String(stored).split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expectedBuffer = Buffer.from(expected, 'base64url');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

export function newOpaqueToken() { return crypto.randomBytes(32).toString('base64url'); }
export function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
