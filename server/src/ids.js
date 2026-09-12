// Identifiers, hashing and comparison. Nothing here is clever; it is here so
// that no route reaches for node:crypto and quietly picks a different scheme.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** An opaque id. 16 bytes is 128 bits, which is not going to collide. */
export const rid = (n = 16) => randomBytes(n).toString('base64url');

export const sha256 = s => createHash('sha256').update(String(s)).digest('base64url');

/**
 * Constant time where it matters. Bearer tokens and invite codes are compared
 * by hash, so both sides are already fixed length — but a length mismatch
 * still has to be answered without a short-circuit that leaks it.
 */
export function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * A device token carries its own id: `<deviceId>.<secret>`. Without that the
 * server would have to hash the secret against every device row to find out
 * whose it is, which is both slow and a timing oracle.
 */
export const mintToken = deviceId => `${deviceId}.${randomBytes(32).toString('base64url')}`;
export function splitToken(token) {
  const i = String(token).indexOf('.');
  if (i < 1) return null;
  return { deviceId: token.slice(0, i), secret: token.slice(i + 1) };
}

/** Invite codes are read off a screen and typed, so no ambiguous characters. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function inviteCode() {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i && i % 4 === 0) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
export const normaliseCode = c => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '');
