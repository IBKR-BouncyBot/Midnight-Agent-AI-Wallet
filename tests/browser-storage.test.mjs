import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { serializeSnapshot, deserializeSnapshot } from '../packages/browser-storage/codec.mjs';
import { createEncryption, unlockEncryption, encryptSnapshot, decryptSnapshot } from '../packages/browser-storage/crypto.mjs';
import { BrowserSnapshotStore } from '../packages/browser-storage/index.mjs';

const password = 'browser-test-only passphrase';
const context = { network: 'preview', identityId: 'public-wallet-fixture' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const code = (expected) => (error) => error.code === expected;
const state = () => ({ confirmed: { spent: 0n, opening: new Uint8Array([7, 8, 9]) }, candidate: null, pending: null });

// A controlled IndexedDB/Web Locks API double: tests commit/abort ordering and
// caller behavior, not browser engine durability or OS power-loss recovery.
class Locks {
  held = new Set();
  async request(name, options, callback) {
    assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); } finally { this.held.delete(name); }
  }
}
class MemoryIndexedDB {
  databases = new Map(); holdWrites = false; waiting = []; abortNext = false; durability = 'strict';
  heldWriteWaiters = new Set();
  open(name) {
    const request = {};
    queueMicrotask(() => {
      let stored = this.databases.get(name); const fresh = !stored;
      if (fresh) stored = { records: new Map(), hasStore: false };
      let aborted = false;
      const factory = this;
      const database = {
        closed: false,
        objectStoreNames: { contains: () => stored.hasStore },
        createObjectStore() { stored.hasStore = true; },
        close() { this.closed = true; },
        transaction(_store, mode, options) {
          if (this.closed) throw new Error('Closed test database');
          if (mode === 'readwrite') assert.deepEqual(options, { durability: 'strict' });
          return factory.transaction(stored, mode);
        },
      };
      request.result = database; request.transaction = { abort() { aborted = true; } };
      if (fresh) request.onupgradeneeded?.({ oldVersion: 0 });
      if (aborted) { request.onerror?.(); return; }
      if (fresh) this.databases.set(name, stored);
      request.onsuccess?.();
    });
    return request;
  }
  transaction(stored, mode) {
    const draft = structuredClone(stored.records); let active = true; let pending = 0; let scheduled = false;
    const transaction = { durability: this.durability, abort() {
      if (!active) return; active = false; queueMicrotask(() => transaction.onabort?.());
    } };
    const complete = () => {
      if (!active || pending) return;
      if (mode === 'readwrite' && this.abortNext) { this.abortNext = false; transaction.abort(); return; }
      active = false;
      if (mode === 'readwrite') stored.records = draft;
      transaction.oncomplete?.();
    };
    const schedule = () => {
      if (!active || pending || scheduled) return; scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (mode === 'readwrite' && this.holdWrites) {
          this.waiting.push(complete);
          for (const notify of [...this.heldWriteWaiters]) notify();
        } else complete();
      });
    };
    const operation = (perform) => {
      const request = {}; pending++;
      queueMicrotask(() => {
        if (!active) return;
        try { request.result = structuredClone(perform()); request.onsuccess?.(); }
        catch { transaction.abort(); }
        pending--; schedule();
      });
      return request;
    };
    transaction.objectStore = () => ({
      get: (key) => operation(() => draft.get(key)),
      add: (value, key) => operation(() => { if (draft.has(key)) throw new Error('Duplicate key'); draft.set(key, structuredClone(value)); }),
      put: (value, key) => operation(() => { draft.set(key, structuredClone(value)); }),
    });
    return transaction;
  }
  waitForHeldWrite() {
    if (this.waiting.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const notify = () => { clearTimeout(timer); this.heldWriteWaiters.delete(notify); resolve(); };
      const timer = setTimeout(() => {
        this.heldWriteWaiters.delete(notify); reject(new Error('Timed out waiting for the test commit boundary'));
      }, 10_000);
      this.heldWriteWaiters.add(notify);
    });
  }
  releaseWrites() { this.holdWrites = false; for (const complete of this.waiting.splice(0)) complete(); }
  records(name = 'fixture') { return this.databases.get(`midnight-agent-wallet:${name}`).records; }
}
function fixture(t) {
  const indexedDB = new MemoryIndexedDB(); const locks = new Locks(); const opened = [];
  const options = { name: 'fixture', password, context, indexedDB, locks, crypto: webcrypto };
  t.after(async () => { indexedDB.releaseWrites(); for (const store of opened) await store.close(); });
  return { indexedDB, locks, options,
    async create(extra = {}) { const store = await BrowserSnapshotStore.create({ ...options, initialState: state(), ...extra }); opened.push(store); return store; },
    async open(extra = {}) { const store = await BrowserSnapshotStore.open({ ...options, ...extra }); opened.push(store); return store; } };
}

test('portable encoding preserves bigint boundaries, bytes and tag-like user objects without prototype mutation', () => {
  const input = { zero: 0n, negative: -1n, max: (1n << 256n) - 1n, byteArray: new Uint8Array([0, 128, 255]),
    nested: [undefined, null, true, Number.MAX_SAFE_INTEGER, { bigint: 'not a tag', bytes: [7] }] };
  Object.defineProperty(input, '__proto__', { enumerable: true, value: { safe: 'own property' } });
  const output = deserializeSnapshot(serializeSnapshot(input));
  assert.deepEqual(output, input); assert.equal(Object.getPrototypeOf(output), Object.prototype);
  output.byteArray[0] = 23; assert.equal(input.byteArray[0], 0);
});

test('codec rejects ambiguous numbers, executable properties, cycles and malformed tagged data', () => {
  for (const value of [NaN, Infinity, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, new Date(), new Map(), new Uint16Array([1]), [ , 1]]) {
    assert.throws(() => serializeSnapshot(value));
  }
  let called = false;
  assert.throws(() => serializeSnapshot({ get secret() { called = true; return 7; } })); assert.equal(called, false);
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => serializeSnapshot(cyclic));
  const malformed = [ ['bigint', '01'], ['bytes', 'zz'], ['object', [['x', ['scalar', 1]], ['x', ['scalar', 2]]]], ['scalar', 1, 'extra'] ];
  for (const node of malformed) assert.throws(() => deserializeSnapshot(new TextEncoder().encode(JSON.stringify(['midnight-browser-snapshot:1', node]))));
});

test('WebCrypto encryption agrees with independent Node PBKDF2/AES-GCM and produces a nonexportable key', async () => {
  const crypto = { subtle: webcrypto.subtle, getRandomValues(array) { for (let i = 0; i < array.length; i++) array[i] = i; return array; } };
  const { header, key } = await createEncryption(password, context, crypto);
  assert.equal(key.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', key));
  const encrypted = await encryptSnapshot({ amount: 18446744073709551615n }, key, header, 7, crypto);
  const salt = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const derived = pbkdf2Sync(password, salt, 600_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', derived, Buffer.from(Array.from({ length: 12 }, (_, i) => i)));
  const identity = JSON.stringify(['midnight-agent-wallet:browser-store', 1, 'preview', 'public-wallet-fixture', 'PBKDF2', 'SHA-256', 600000, salt.toString('hex')]);
  cipher.setAAD(Buffer.from(JSON.stringify([identity, 7])));
  const plaintext = Buffer.from('["midnight-browser-snapshot:1",["object",[["amount",["bigint","18446744073709551615"]]]]]');
  const expected = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  assert.deepEqual(encrypted.ciphertext, new Uint8Array(expected)); derived.fill(0);
});

test('wrong password, changed deployment context, revision and ciphertext cannot authenticate', async () => {
  const { header, key } = await createEncryption(password, context, webcrypto);
  const original = state(); const encrypted = await encryptSnapshot(original, key, header, 0, webcrypto);
  assert.deepEqual(await decryptSnapshot(encrypted, key, header, webcrypto), original);
  const wrongKey = await unlockEncryption(`${password}-wrong`, header, context, webcrypto);
  await assert.rejects(decryptSnapshot(encrypted, wrongKey, header, webcrypto), code('SNAPSHOT_AUTHENTICATION_FAILED'));
  await assert.rejects(unlockEncryption(password, header, { ...context, network: 'preprod' }, webcrypto), code('CONTEXT_MISMATCH'));
  await assert.rejects(decryptSnapshot({ ...encrypted, revision: 1 }, key, header, webcrypto), code('SNAPSHOT_AUTHENTICATION_FAILED'));
  const tampered = structuredClone(encrypted); tampered.ciphertext[0] ^= 1;
  await assert.rejects(decryptSnapshot(tampered, key, header, webcrypto), code('SNAPSHOT_AUTHENTICATION_FAILED'));
  const rebound = { ...header, context: { ...context, identityId: 'another-wallet' } };
  await assert.rejects(decryptSnapshot(encrypted, key, rebound, webcrypto), code('SNAPSHOT_AUTHENTICATION_FAILED'));
});

test('open never creates missing identities; explicit create never replaces an existing identity', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.open(), code('STORE_NOT_FOUND')); assert.equal(f.indexedDB.databases.size, 0);
  const created = await f.create(); const original = structuredClone(f.indexedDB.records()); await created.close();
  await assert.rejects(f.create(), code('STORE_ALREADY_EXISTS'));
  await assert.rejects(f.open({ password: `${password}-wrong` }), code('SNAPSHOT_AUTHENTICATION_FAILED'));
  assert.deepEqual(f.indexedDB.records(), original);
  const reopened = await f.open(); assert.deepEqual(reopened.snapshot(), state());
  const detached = reopened.snapshot(); detached.confirmed.opening.fill(0); assert.deepEqual(reopened.snapshot(), state());
});

test('exclusive writer is held for the store lifetime, and unavailable Web Locks fail closed', async (t) => {
  const f = fixture(t); const first = await f.create();
  await assert.rejects(f.open(), code('STORE_IN_USE'));
  await first.close(); const second = await f.open(); assert.deepEqual(second.context, context);
  await assert.rejects(f.create({ name: 'unsupported', locks: {} }), code('WEB_LOCKS_UNAVAILABLE'));
  assert.equal(f.indexedDB.databases.has('midnight-agent-wallet:unsupported'), false);
});

test('checkpoint promises wait for atomic completion before the caller may submit signed bytes', async (t) => {
  const f = fixture(t); const store = await f.create(); const confirmed = store.snapshot().confirmed;
  const prepared = { confirmed, candidate: { spent: 40n, opening: new Uint8Array([3, 4]) }, pending: { phase: 'prepared' } };
  await store.checkpoint(prepared);
  f.indexedDB.holdWrites = true;
  const signed = { ...prepared, pending: { phase: 'submitting', signedBytes: new Uint8Array([11, 22, 33]), transactionIds: ['public-tx-id'] } };
  let submitted = false; const checkpoint = store.checkpoint(signed).then(() => { submitted = true; });
  await f.indexedDB.waitForHeldWrite();
  assert.equal(f.indexedDB.waiting.length, 1); assert.equal(submitted, false);
  assert.equal(store.snapshot().pending.phase, 'prepared');
  f.indexedDB.releaseWrites(); await checkpoint; assert.equal(submitted, true);
  assert.equal(store.revision, 2); await store.close();
  const recovered = await f.open(); assert.deepEqual(recovered.snapshot(), signed);
  assert.deepEqual(recovered.snapshot().confirmed, confirmed);
});

test('aborted commits preserve confirmed/candidate snapshot and cannot trigger a send', async (t) => {
  const f = fixture(t); const store = await f.create(); const before = structuredClone(f.indexedDB.records());
  f.indexedDB.abortNext = true; let sent = false;
  await assert.rejects(store.checkpoint({ ...state(), pending: { phase: 'submitting', signedBytes: new Uint8Array([1]) } }).then(() => { sent = true; }), code('CHECKPOINT_FAILED'));
  assert.equal(sent, false); assert.deepEqual(store.snapshot(), state()); assert.equal(store.revision, 0);
  assert.deepEqual(f.indexedDB.records(), before);
  await store.close(); assert.deepEqual((await f.open()).snapshot(), state());
});

test('missing records, external ciphertext changes and unsupported durability are not silently overwritten', async (t) => {
  const f = fixture(t); const store = await f.create();
  const record = f.indexedDB.records().get('snapshot'); record.ciphertext[0] ^= 1;
  await assert.rejects(store.checkpoint(state()), code('STORED_STATE_CHANGED')); assert.equal(store.revision, 0);
  await store.close(); await assert.rejects(f.open(), code('SNAPSHOT_AUTHENTICATION_FAILED'));
  f.indexedDB.records().delete('snapshot');
  await assert.rejects(f.open(), code('STORED_IDENTITY_MISSING')); await assert.rejects(f.create(), code('STORE_ALREADY_EXISTS'));
  const noDurability = fixture(t); noDurability.indexedDB.durability = undefined;
  await assert.rejects(noDurability.create(), code('STRICT_DURABILITY_UNAVAILABLE'));
});

test('queued updates preserve both changes and close waits for accepted checkpoints', async (t) => {
  const f = fixture(t); const store = await f.create();
  const first = store.update(async (draft) => { await tick(); draft.confirmed.spent += 1n; });
  const second = store.update((draft) => { draft.confirmed.spent += 2n; });
  const closing = store.close();
  await assert.rejects(store.checkpoint(state()), code('STORE_CLOSED'));
  await Promise.all([first, second, closing]);
  const reopened = await f.open(); assert.equal(reopened.snapshot().confirmed.spent, 3n); assert.equal(reopened.revision, 2);
});

test('encrypted backup migrates exact pending state across origins without exporting private plaintext', async (t) => {
  const source = fixture(t); const original = await source.create();
  const pending = { ...state(), merchantViewerSeed: new Uint8Array(32).fill(41), marker: 'private unique fixture marker',
    candidate: { remaining: 60n }, pending: { phase: 'submitting', signedBytes: new Uint8Array([1, 2, 3]), transactionIds: ['known-tx'] } };
  await original.checkpoint(pending);
  const backup = await original.exportBackup();
  assert.equal(Buffer.from(backup).includes(Buffer.from(pending.marker)), false);
  assert.equal(Buffer.from(backup).includes(Buffer.from(pending.merchantViewerSeed)), false);
  const destination = fixture(t);
  const imported = await BrowserSnapshotStore.restore({ ...destination.options, backup });
  try { assert.deepEqual(imported.snapshot(), pending); assert.equal(imported.revision, 0); }
  finally { await imported.close(); }
  assert.deepEqual((await destination.open()).snapshot(), pending);
});

test('backup authentication precedes database creation and restore refuses existing identities', async (t) => {
  const source = fixture(t); const original = await source.create(); const backup = await original.exportBackup();
  const destination = fixture(t);
  await assert.rejects(BrowserSnapshotStore.restore({ ...destination.options, backup, password: `${password}-wrong` }), code('SNAPSHOT_AUTHENTICATION_FAILED'));
  await assert.rejects(BrowserSnapshotStore.restore({ ...destination.options, backup, context: { ...context, identityId: 'other-account' } }), code('CONTEXT_MISMATCH'));
  const damaged = backup.slice(); damaged[damaged.length - 1] ^= 1;
  await assert.rejects(BrowserSnapshotStore.restore({ ...destination.options, backup: damaged }), code('SNAPSHOT_AUTHENTICATION_FAILED'));
  assert.equal(destination.indexedDB.databases.size, 0);
  const existing = await destination.create(); await existing.close();
  const before = structuredClone(destination.indexedDB.records());
  await assert.rejects(BrowserSnapshotStore.restore({ ...destination.options, backup }), code('STORE_ALREADY_EXISTS'));
  assert.deepEqual(destination.indexedDB.records(), before);
});
