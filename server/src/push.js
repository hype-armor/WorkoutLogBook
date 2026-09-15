// Web Push, written against the specifications rather than around a library:
// RFC 8188 for the aes128gcm content coding, RFC 8291 for the key agreement
// that feeds it, and RFC 8292 for identifying this server to the push service.
//
// Three RFCs is more than a dependency would have cost to add — but this is the
// only thing in the project that would have needed one, the whole of it is
// about 150 lines, and all three publish test vectors, so the implementation
// can be checked against the specification rather than against itself. Those
// vectors are in test/push.test.js.
//
// Nothing here can read a payload. The plaintext handed in is already sealed
// by the client under a key this server has never seen; this layer wraps that
// in a second envelope the push service cannot read either.
import { createECDH, createHmac, createCipheriv, randomBytes,
         createPrivateKey, sign, generateKeyPairSync } from 'node:crypto';

const CURVE = 'prime256v1';
const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = str => Buffer.from(String(str), 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** HKDF, in the two-step form the RFCs spell out. */
const extract = (salt, ikm) => hmac(salt, ikm);
function expand(prk, info, length) {
  // Every use here wants 32 octets or fewer, so one HMAC round is the whole of
  // the expand phase — which is how RFC 8188 states it too.
  if (length > 32) throw new Error('expand: one round only');
  return hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, length);
}

/**
 * RFC 8188 §2. Produces a complete body: the header block, then one record.
 *
 * One record is all a push message may contain (RFC 8291 §4), which is why the
 * sequence number is always zero and the nonce needs no exclusive-or.
 */
export function aes128gcm(ikm, plaintext, { salt = randomBytes(16), keyid = Buffer.alloc(0), rs = 4096 } = {}) {
  const prk = extract(salt, ikm);
  const cek = expand(prk, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = expand(prk, 'Content-Encoding: nonce\0', 12);

  const header = Buffer.alloc(21 + keyid.length);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(keyid.length, 20);
  Buffer.from(keyid).copy(header, 21);

  // The last — here, only — record ends with a delimiter octet of 2. Anything
  // after it would be zero padding, and this sends none.
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (padded.length + 16 > rs) throw new Error('payload larger than one record');

  const gcm = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([gcm.update(padded), gcm.final(), gcm.getAuthTag()]);
  return Buffer.concat([header, body]);
}

/**
 * RFC 8291 §3. Combines the subscription's public key and auth secret with a
 * freshly generated key pair to produce the input keying material above.
 */
export function encryptPush(subscription, plaintext, { salt, asPrivate } = {}) {
  const uaPublic = unb64u(subscription.p256dh);
  const authSecret = unb64u(subscription.auth);
  if (uaPublic.length !== 65) throw new Error('p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth must be 16 octets');

  // A new pair for every message: the public half travels as the keyid, and
  // reusing it across messages would tie them together.
  const ecdh = createECDH(CURVE);
  if (asPrivate) ecdh.setPrivateKey(unb64u(asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = expand(extract(authSecret, shared), keyInfo, 32);

  return aes128gcm(ikm, plaintext, { salt: salt ? unb64u(salt) : randomBytes(16), keyid: asPublic });
}

/* ---------- RFC 8292: saying who this server is ---------- */

/** A P-256 pair for signing, kept for the life of the deployment. */
export function newVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
  return {
    publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)),
    privateKey: b64u(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(36, 68))
  };
}

/** Raw P-256 scalar and point back into something node:crypto will sign with. */
function signingKey(privateKey, publicKey) {
  const pub = unb64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('vapid public key must be an uncompressed point');
  return createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64u(unb64u(privateKey)),
           x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }
  });
}

/**
 * The Authorization header for one push request. The audience is the origin of
 * the endpoint, not the endpoint itself, so one token covers every subscription
 * on a push service.
 */
export function vapidHeader(endpoint, { publicKey, privateKey, subject }, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  // Twelve hours: the specification caps it at twenty-four, and a token that
  // outlives the clock skew of whoever is checking it is the failure to avoid.
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const signed = `${header}.${claims}`;
  // ieee-p1363 is the raw r||s pair JWS calls for; the default DER encoding is
  // what a push service rejects without explaining why.
  const sig = sign('sha256', Buffer.from(signed),
    { key: signingKey(privateKey, publicKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signed}.${b64u(sig)}, k=${publicKey}`;
}

/**
 * Send one. Returns what happened rather than throwing, because every caller
 * wants to act on the difference between "gone" and "try later".
 */
export async function sendPush(subscription, plaintext, vapid, { ttl = 3600, urgency = 'high', fetchImpl = fetch } = {}) {
  const body = encryptPush(subscription, plaintext);
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      TTL: String(ttl),
      Urgency: urgency
    },
    body
  });
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    // 404 and 410 both mean the subscription is finished; anything else is
    // this moment's problem rather than the subscription's.
    gone: res.status === 404 || res.status === 410,
    retryAfter: Number(res.headers.get('retry-after')) || 0
  };
}
