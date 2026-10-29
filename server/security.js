/*
 * Small security helpers: password hashing, random ids, signing, and the encrypted copy of
 * incharge passwords (so the super admin can look them up).
 */
import crypto from 'node:crypto';

// ---------------------------------------------------------------- passwords
// scrypt: a slow hash on purpose, so stolen hashes are very hard to crack
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** Hash a password for storing: "scrypt$N$r$p$salt$hash". */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** Does this password match the stored hash? (constant-time comparison) */
export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** For unknown usernames: spend the same time as a real check, so attackers can't tell the difference. */
const DUMMY_HASH = hashPassword('dummy-password-for-timing');
export const burnPasswordCheck = (password) => verifyPassword(password, DUMMY_HASH);

/** A password rule shared by every form: 10+ characters with letters and numbers. */
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 128) return 'Password too long';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}

/** A random password that passes the rule (no look-alike characters such as 0/O, 1/l). */
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export function generatePassword(length = 14) {
  for (;;) {
    let out = '';
    for (let i = 0; i < Math.max(10, length); i++) out += PASSWORD_CHARS[crypto.randomInt(PASSWORD_CHARS.length)];
    if (/[a-z]/i.test(out) && /\d/.test(out)) return out;
  }
}

// ---------------------------------------------------------------- ids and signatures
export const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hmac = (key, data) => crypto.createHmac('sha256', key).update(String(data)).digest('base64url');

/** Compare two strings without leaking (through timing) how much of them matched. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** "value.signature": anyone can read the value, nobody can change it without the secret. */
export const sign = (value, secret) => `${value}.${hmac(secret, value).slice(0, 32)}`;

/** The value if the signature is right, else null. */
export function unsign(signed, secret) {
  if (typeof signed !== 'string' || signed.length > 512) return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  return safeEqual(signed.slice(i + 1), hmac(secret, value).slice(0, 32)) ? value : null;
}

/** Student IDs are compared in capitals without spaces: " uu2501 " -> "UU2501". */
export const normUuid = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

// ---------------------------------------------------------------- viewable incharge passwords
// The super admin can look up passwords they gave to incharges. They are stored encrypted
// (AES-256-GCM) with a key made from the server secret, so the database alone can't reveal them.
const viewKey = (secret) => crypto.createHash('sha256').update(`password-view|${secret}`).digest();

export function sealPassword(plain, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', viewKey(secret), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), data.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

/** The password, or null if it can't be opened (e.g. the server secret changed). */
export function openPassword(sealed, secret) {
  try {
    const [version, iv, data, tag] = String(sealed || '').split('.');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', viewKey(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
