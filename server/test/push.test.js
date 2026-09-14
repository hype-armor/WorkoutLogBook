import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHmac, createDecipheriv, randomBytes } from 'node:crypto';
import { aes128gcm, encryptPush, vapidHeader, newVapidKeys, sendPush } from '../src/push.js';

const unb64u = s => Buffer.from(s.replace(/\s+/g, ''), 'base64url');
const b64u = b => Buffer.from(b).toString('base64url');

// Written against the specifications, so checked against the specifications.
// These are the published examples, transcribed with their whitespace removed:
// they are the difference between "my encryptor agrees with my decryptor" and
// "this is Web Push".
describe('the published test vectors', () => {
  test('RFC 8188 §3.1 — the content coding on its own', () => {
    // "I am the walrus", a known input keying material, a known salt, and no
    // keyid. This exercises the record format and both derivations without any
    // key agreement in the way.
    const body = aes128gcm(
      unb64u('yqdlZ-tYemfogSmv7Ws5PQ'),
      Buffer.from('I am the walrus'),
      { salt: unb64u('I1BsxtFttlv3u_Oo94xnmw'), rs: 4096 });
    assert.equal(b64u(body),
      'I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg');
  });

  test('RFC 8188 §3.2 — two records and a keyid', () => {
    // The multi-record example is not something a push message may contain, so
    // what is checked here is that the header is built the way the second
    // example says: a keyid of "a1", and a record size of 25.
    const body = aes128gcm(unb64u('BO3ZVPxUlnLORbVGMpbT1Q'), Buffer.from('x'),
      { salt: unb64u('uNCkWiNYzKTnBN9ji3-qWA'), keyid: Buffer.from('a1'), rs: 25 });
    assert.equal(b64u(body.subarray(0, 16)), 'uNCkWiNYzKTnBN9ji3-qWA');
    assert.equal(body.readUInt32BE(16), 25);
    assert.equal(body.readUInt8(20), 2);
    assert.equal(body.subarray(21, 23).toString(), 'a1');
  });

  test('RFC 8291 §5 — a whole push message, byte for byte', () => {
    const subscription = {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg'
    };
    const body = encryptPush(subscription, Buffer.from('When I grow up, I want to be a watermelon'), {
      salt: 'DGv6ra1nlYgDCS1FRnbzlw',
      asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'
    });
    assert.equal(b64u(body),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
      + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
      + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  test('RFC 8291 Appendix A — the intermediate values agree too', () => {
    // Byte-for-byte agreement at the end could still hide two mistakes that
    // cancel. These are the values the appendix publishes along the way.
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
    const uaPublic = unb64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
    const shared = ecdh.computeSecret(uaPublic);
    assert.equal(b64u(shared), 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs');

    const prkKey = createHmac('sha256', unb64u('BTBZMqHH6r4Tts7J_aSIgg')).update(shared).digest();
    assert.equal(b64u(prkKey), 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k');
  });
});

// The vectors prove one message matches the specification. This proves the
// general case, by decrypting what encryptPush produces with a receiver written
// separately from it, straight out of RFC 8291 §3.4 and RFC 8188 §2. If the
// sending half drifts, this stops opening.
describe('a receiver written from the other side of the spec', () => {
  const expand = (prk, info, len) =>
    createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
      .digest().subarray(0, len);

  function receive(body, uaPrivate, authSecret) {
    const salt = body.subarray(0, 16);
    const rs = body.readUInt32BE(16);
    const idlen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);

    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(uaPrivate);
    const shared = ecdh.computeSecret(asPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = expand(createHmac('sha256', authSecret).update(shared).digest(), keyInfo, 32);

    const prk = createHmac('sha256', salt).update(ikm).digest();
    const cek = expand(prk, 'Content-Encoding: aes128gcm\0', 16);
    const nonce = expand(prk, 'Content-Encoding: nonce\0', 12);
    const gcm = createDecipheriv('aes-128-gcm', cek, nonce);
    gcm.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([gcm.update(ct.subarray(0, ct.length - 16)), gcm.final()]);

    // The last record ends with a delimiter of 2, after any zero padding.
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    assert.equal(plain[end], 2, 'padding delimiter of the last record');
    return { rs, text: plain.subarray(0, end).toString() };
  }

  test('what is sent is what comes back out', () => {
    for (const message of ['Rest complete', '', 'x'.repeat(2000), 'unicode: café · 力 · 🏋']) {
      const ua = createECDH('prime256v1');
      ua.generateKeys();
      const auth = randomBytes(16);
      const body = encryptPush(
        { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) }, Buffer.from(message));
      const out = receive(body, ua.getPrivateKey(), auth);
      assert.equal(out.text, message);
      assert.equal(out.rs, 4096);
    }
  });

  test('another subscription\'s key does not open it', () => {
    const mine = createECDH('prime256v1'); mine.generateKeys();
    const theirs = createECDH('prime256v1'); theirs.generateKeys();
    const auth = randomBytes(16);
    const body = encryptPush({ p256dh: b64u(mine.getPublicKey()), auth: b64u(auth) },
      Buffer.from('for me alone'));
    assert.throws(() => receive(body, theirs.getPrivateKey(), auth));
    // Nor does the right key with the wrong auth secret: it is mixed into the
    // derivation precisely so that the public key alone is not enough.
    assert.throws(() => receive(body, mine.getPrivateKey(), randomBytes(16)));
  });
});

describe('web push, beyond the vectors', () => {
  const subscription = {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV'
  };

  test('a fresh key pair every message', () => {
    const a = encryptPush(subscription, Buffer.from('same'));
    const b = encryptPush(subscription, Buffer.from('same'));
    assert.notEqual(b64u(a), b64u(b));
    // Not just a different salt: the keyid is a new public key each time, so
    // two messages cannot be tied to one another by it.
    assert.notEqual(b64u(a.subarray(21, 86)), b64u(b.subarray(21, 86)));
  });

  test('a subscription with the wrong shape is refused rather than encrypted badly', () => {
    assert.throws(() => encryptPush({ p256dh: b64u(Buffer.alloc(64)), auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('x')), /uncompressed P-256/);
    assert.throws(() => encryptPush({ ...subscription, auth: b64u(Buffer.alloc(8)) },
      Buffer.from('x')), /16 octets/);
  });

  test('a payload too large for one record is refused', () => {
    // A push message may contain only one record (RFC 8291 §4), so this is a
    // limit rather than a reason to split.
    assert.throws(() => encryptPush(subscription, Buffer.alloc(4096)), /one record/);
  });

  test('the vapid header carries a token and the key that signed it', () => {
    const keys = newVapidKeys();
    const header = vapidHeader(subscription.endpoint,
      { ...keys, subject: 'mailto:nobody@example.com' }, 1_760_000_000_000);
    const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
    assert.ok(m, 'header shape: ' + header);
    assert.equal(m[2], keys.publicKey);

    const [h, c, sig] = m[1].split('.');
    assert.deepEqual(JSON.parse(unb64u(h)), { typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(unb64u(c));
    // The origin, not the endpoint: one token covers every subscription on a
    // push service.
    assert.equal(claims.aud, 'https://push.example.net');
    assert.equal(claims.sub, 'mailto:nobody@example.com');
    assert.ok(claims.exp > 1_760_000_000 && claims.exp <= 1_760_000_000 + 24 * 3600);
    // ES256 signatures are the raw r||s pair. DER is what a push service
    // rejects without saying why.
    assert.equal(unb64u(sig).length, 64);
  });

  test('a generated key pair is the shape the specification asks for', () => {
    const { publicKey, privateKey } = newVapidKeys();
    assert.equal(unb64u(publicKey).length, 65);
    assert.equal(unb64u(publicKey)[0], 4, 'uncompressed point');
    assert.equal(unb64u(privateKey).length, 32);
  });

  test('what the push service says is turned into what to do about it', async () => {
    const reply = (status, headers = {}) => async () => ({
      status, headers: { get: k => headers[k.toLowerCase()] ?? null }
    });
    const vapid = { ...newVapidKeys(), subject: 'mailto:nobody@example.com' };
    const send = (status, headers) =>
      sendPush(subscription, Buffer.from('x'), vapid, { fetchImpl: reply(status, headers) });

    assert.deepEqual(await send(201), { ok: true, status: 201, gone: false, retryAfter: 0 });
    // Both mean the subscription is finished and the row should go.
    assert.equal((await send(404)).gone, true);
    assert.equal((await send(410)).gone, true);
    // This one is the moment's problem, not the subscription's.
    const busy = await send(429, { 'retry-after': '120' });
    assert.equal(busy.gone, false);
    assert.equal(busy.retryAfter, 120);
  });

  test('the request is shaped the way a push service expects', async () => {
    let seen = null;
    const vapid = { ...newVapidKeys(), subject: 'mailto:nobody@example.com' };
    await sendPush(subscription, Buffer.from('x'), vapid, {
      ttl: 90,
      fetchImpl: async (url, opts) => {
        seen = { url, ...opts };
        return { status: 201, headers: { get: () => null } };
      }
    });
    assert.equal(seen.url, subscription.endpoint);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(seen.headers.TTL, '90');
    assert.match(seen.headers.Authorization, /^vapid t=/);
    assert.equal(seen.headers['Content-Length'], String(seen.body.length));
  });
});
