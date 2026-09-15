const { test, expect } = require('@playwright/test');
const { FILE_URL, phone } = require('./helpers');

// Pure functions over WebCrypto: no server, no storage, nothing the app calls
// yet. What is being checked is mostly that the failures fail — a server that
// holds every ciphertext is assumed hostile, and most of these assertions are
// about what it cannot do with them.
test.describe('vault keys and sealing', () => {
  let ctx, page;

  test.beforeAll(async ({ browser }) => {
    ctx = await phone(browser);
    page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
  });
  test.afterAll(async () => { await ctx.close(); });

  // Runs in the page, where `vault` and real WebCrypto are. Returns whatever
  // the body returns; a rejection is reported as {threw: message}.
  const run = (fn, arg) => page.evaluate(async ([src, a]) => {
    try { return await (new Function('a', 'return (' + src + ')(a)'))(a); }
    catch (e) { return { threw: String(e && e.message || e) }; }
  }, [fn.toString(), arg ?? null]);

  test('a master key comes back through the passphrase that wrapped it', async () => {
    const r = await run(async () => {
      const mk = vault.newKey();
      const row = await vault.factorFromPassphrase(mk, 'correct horse battery staple');
      const back = await vault.openWithPassphrase(row, 'correct horse battery staple');
      return { same: b64u(mk) === b64u(back), bits: mk.length * 8,
               kdf: row.kdf, iter: row.iter,
               // the key itself is never in the row, only a wrapped copy
               leaks: JSON.stringify(row).includes(b64u(mk)) };
    });
    expect(r.same).toBe(true);
    expect(r.bits).toBe(256);
    expect(r.kdf).toBe('pbkdf2-sha256');
    expect(r.iter).toBeGreaterThanOrEqual(600000);
    expect(r.leaks).toBe(false);
  });

  test('the wrong passphrase does not open it', async () => {
    const r = await run(async () => {
      const row = await vault.factorFromPassphrase(vault.newKey(), 'right');
      return vault.openWithPassphrase(row, 'wrong');
    });
    expect(r.threw).toBeTruthy();
  });

  // The same passphrase typed on two keyboards can arrive as two different
  // byte strings. Deriving two different keys from it would lock someone out
  // with the right answer in their hands.
  test('the same passphrase in two Unicode forms is the same passphrase', async () => {
    const r = await run(async () => {
      const composed = 'café latte';           // é as one code point
      const decomposed = 'café latte';        // e + combining acute
      if (composed === decomposed) return { bogus: true };
      const row = await vault.factorFromPassphrase(vault.newKey(), composed);
      const back = await vault.openWithPassphrase(row, decomposed);
      return { opened: back.length === 32 };
    });
    expect(r.bogus).toBeUndefined();
    expect(r.opened).toBe(true);
  });

  // Enrolling a second factor must not re-encrypt anything, which is only true
  // if both wrap the very same key.
  test('a passphrase and a passkey open the same vault', async () => {
    const r = await run(async () => {
      const mk = vault.newKey();
      const prf = crypto.getRandomValues(new Uint8Array(32));   // what PRF returns
      const byPhrase = await vault.factorFromPassphrase(mk, 'a passphrase');
      const byKey = await vault.factorFromPrf(mk, prf);
      const one = await vault.openWithPassphrase(byPhrase, 'a passphrase');
      const two = await vault.openWithPrf(byKey, prf);
      return { agree: b64u(one) === b64u(two) && b64u(one) === b64u(mk),
               // two wraps of one key are not the same bytes
               distinct: byPhrase.mk !== byKey.mk };
    });
    expect(r.agree).toBe(true);
    expect(r.distinct).toBe(true);
  });

  test('a different passkey does not open it', async () => {
    const r = await run(async () => {
      const row = await vault.factorFromPrf(vault.newKey(), crypto.getRandomValues(new Uint8Array(32)));
      return vault.openWithPrf(row, crypto.getRandomValues(new Uint8Array(32)));
    });
    expect(r.threw).toBeTruthy();
  });

  test('raising the iteration count does not strand an older wrapped key', async () => {
    const r = await run(async () => {
      // A row written when the count was lower still says so, and is opened
      // with what it says rather than with today's default.
      const mk = vault.newKey();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const row = { kind: 'passphrase', kdf: 'pbkdf2-sha256', iter: 120000, salt: b64u(salt),
                    mk: await vault.wrapKey(mk, await vault.passphraseKek('old', salt, 120000)) };
      const back = await vault.openWithPassphrase(row, 'old');
      return { same: b64u(back) === b64u(mk) };
    });
    expect(r.same).toBe(true);
  });

  test('each subkey is its own key, and the same key every time', async () => {
    const r = await run(async () => {
      const mk = vault.newKey();
      const raw = async k => b64u(await crypto.subtle.exportKey('raw', k).catch(() => new ArrayBuffer(0)));
      const a = await vault.subkeys(mk), b = await vault.subkeys(mk);
      const other = await vault.subkeys(vault.newKey());
      // Not extractable, so compare what they do rather than what they are.
      const mark = ks => vault.addr(ks.addr, 'set:probe');
      return { stable: await mark(a) === await mark(b),
               differs: await mark(a) !== await mark(other),
               extractable: (await raw(a.data)).length > 0 };
    });
    expect(r.stable).toBe(true);
    expect(r.differs).toBe(true);
    // A key that can be read out of the page is a key that can be exfiltrated
    // by anything that gets a script in.
    expect(r.extractable).toBe(false);
  });

  test('a record round-trips, and two seals of it never look alike', async () => {
    const r = await run(async () => {
      const ks = await vault.subkeys(vault.newKey());
      const value = { id: 'x1', e: 'Romanian deadlift', w: 185, r: 8, rir: 1 };
      const addr = await vault.addr(ks.addr, 'set:x1');
      const hlc = '0000000abc:0000:7f2a91bc';
      const one = await vault.seal(ks.data, addr, hlc, value);
      const two = await vault.seal(ks.data, addr, hlc, value);
      const back = await vault.unseal(ks.data, addr, hlc, one);
      return { back, fresh: one !== two, hidden: !one.includes('deadlift'),
               alsoOpens: JSON.stringify(await vault.unseal(ks.data, addr, hlc, two)) === JSON.stringify(value) };
    });
    expect(r.back).toEqual({ id: 'x1', e: 'Romanian deadlift', w: 185, r: 8, rir: 1 });
    // A fixed IV would make two identical sets visibly identical on the server.
    expect(r.fresh).toBe(true);
    expect(r.hidden).toBe(true);
    expect(r.alsoOpens).toBe(true);
  });

  // The server holds every ciphertext. These are the two edits it could make
  // without being able to read any of them.
  test('a record moved into another record\'s slot does not open', async () => {
    const r = await run(async () => {
      const ks = await vault.subkeys(vault.newKey());
      const hlc = '0000000abc:0000:7f2a91bc';
      const mine = await vault.addr(ks.addr, 'set:x1');
      const theirs = await vault.addr(ks.addr, 'set:x2');
      const blob = await vault.seal(ks.data, mine, hlc, { w: 185 });
      return vault.unseal(ks.data, theirs, hlc, blob);
    });
    expect(r.threw).toBeTruthy();
  });

  test('an old version put back under a newer clock does not open', async () => {
    const r = await run(async () => {
      const ks = await vault.subkeys(vault.newKey());
      const addr = await vault.addr(ks.addr, 'set:x1');
      const blob = await vault.seal(ks.data, addr, '0000000abc:0000:7f2a91bc', { w: 185 });
      return vault.unseal(ks.data, addr, '0000000fff:0000:7f2a91bc', blob);
    });
    expect(r.threw).toBeTruthy();
  });

  test('a ciphertext with a byte changed does not open', async () => {
    const r = await run(async () => {
      const ks = await vault.subkeys(vault.newKey());
      const addr = await vault.addr(ks.addr, 'set:x1');
      const hlc = '0000000abc:0000:7f2a91bc';
      const raw = unb64u(await vault.seal(ks.data, addr, hlc, { w: 185 }));
      raw[raw.length - 3] ^= 1;
      return vault.unseal(ks.data, addr, hlc, b64u(raw));
    });
    expect(r.threw).toBeTruthy();
  });

  test('an address is the same on two devices and says nothing about the record', async () => {
    const r = await run(async () => {
      const mk = vault.newKey();
      // The same vault opened on a second phone: same master key, so the same
      // addressing key, so the same address for the same record.
      const phoneKs = await vault.subkeys(mk), tabletKs = await vault.subkeys(mk);
      const strangerKs = await vault.subkeys(vault.newKey());
      const at = (ks, k) => vault.addr(ks.addr, k);
      const mine = await at(phoneKs, 'set:x1');
      return {
        agree: mine === await at(tabletKs, 'set:x1'),
        notShared: mine !== await at(strangerKs, 'set:x1'),
        distinct: mine !== await at(phoneKs, 'set:x2'),
        // A set, a setting and the program are all the same shape on the wire.
        sameShape: new Set(await Promise.all(
          ['set:x1', 'cfg:units', 'program', 'day:2026-09-12']
            .map(k => at(phoneKs, k).then(v => v.length)))).size === 1,
        opaque: !mine.includes('set') && !mine.includes('x1')
      };
    });
    expect(r.agree).toBe(true);
    expect(r.notShared).toBe(true);
    expect(r.distinct).toBe(true);
    expect(r.sameShape).toBe(true);
    expect(r.opaque).toBe(true);
  });

  // A server that cannot read the log cannot check a password either, so
  // "unlocked" has to be something derived from the key itself.
  test('every factor proves unlocked with the same secret, and it gives nothing away', async () => {
    const r = await run(async () => {
      const mk = vault.newKey();
      const prf = crypto.getRandomValues(new Uint8Array(32));
      const byPhrase = await vault.factorFromPassphrase(mk, 'a passphrase');
      const byKey = await vault.factorFromPrf(mk, prf);
      const want = await vault.authSecret(mk);
      const viaPhrase = await vault.authSecret(await vault.openWithPassphrase(byPhrase, 'a passphrase'));
      const viaKey = await vault.authSecret(await vault.openWithPrf(byKey, prf));
      return {
        agree: viaPhrase === want && viaKey === want,
        // A different vault is a different secret.
        unique: want !== await vault.authSecret(vault.newKey()),
        // One-way: what the server stores is not the key, and not a subkey.
        notTheKey: want !== b64u(mk),
        notASubkey: want !== await vault.addr((await vault.subkeys(mk)).addr, 'set:x1')
      };
    });
    expect(r.agree).toBe(true);
    expect(r.unique).toBe(true);
    expect(r.notTheKey).toBe(true);
    expect(r.notASubkey).toBe(true);
  });

  // Every record the app already knows how to name can be sealed and read back.
  test('the whole record space seals and opens', async () => {
    const r = await run(async () => {
      const ks = await vault.subkeys(vault.newKey());
      const out = [];
      for (const [key, value] of records(db)) {
        const addr = await vault.addr(ks.addr, key);
        const hlc = db.rev[key]?.h || '0000000000:0000:00000000';
        const back = await vault.unseal(ks.data, addr, hlc,
          await vault.seal(ks.data, addr, hlc, value));
        out.push(JSON.stringify(back) === JSON.stringify(value ?? null));
      }
      return { count: out.length, allBack: out.every(Boolean) };
    });
    expect(r.count).toBeGreaterThan(5);
    expect(r.allBack).toBe(true);
  });
});
