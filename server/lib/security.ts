import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_PARAMS);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export const randomToken = (prefix = '') => prefix + crypto.randomBytes(32).toString('base64url');

export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 200) return 'Password is too long';
  return null;
}

export function validateUsername(name: string): string | null {
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(name)) return 'Username must be 2-40 characters: letters, numbers, _ . -';
  return null;
}
