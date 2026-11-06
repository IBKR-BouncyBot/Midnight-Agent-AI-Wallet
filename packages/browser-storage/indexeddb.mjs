import { BrowserStorageError, headerIdentity } from './crypto.mjs';

const STORE = 'encrypted-snapshots';
const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((byte, i) => byte === b[i]);
const sameRecord = (a, b) => a && b && a.revision === b.revision && sameBytes(a.iv, b.iv) && sameBytes(a.ciphertext, b.ciphertext);

export async function acquireWriter(locks, name) {
  if (typeof locks?.request !== 'function') throw new BrowserStorageError('WEB_LOCKS_UNAVAILABLE');
  let acquired, failed, release;
  const granted = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
  const held = new Promise((resolve) => { release = resolve; });
  const request = Promise.resolve().then(() => locks.request(`midnight-browser-store:${name}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) throw new BrowserStorageError('STORE_IN_USE');
    acquired(); await held;
  }));
  request.catch(failed);
  await granted;
  return async () => { release(); await request; };
}

export function openDatabase(indexedDB, name, create) {
  if (typeof indexedDB?.open !== 'function') return Promise.reject(new BrowserStorageError('INDEXED_DB_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    let created = false; let stopped = false;
    const fail = (code) => { stopped = true; reject(new BrowserStorageError(code)); };
    const request = indexedDB.open(`midnight-agent-wallet:${name}`, 1);
    request.onblocked = () => fail('DATABASE_BLOCKED');
    request.onupgradeneeded = (event) => {
      if (stopped || !create || event.oldVersion !== 0) {
        request.transaction.abort(); fail(create ? 'STORE_ALREADY_EXISTS' : 'STORE_NOT_FOUND'); return;
      }
      request.result.createObjectStore(STORE); created = true;
    };
    request.onerror = () => fail('DATABASE_OPEN_FAILED');
    request.onsuccess = () => {
      const db = request.result;
      if (stopped) { db.close(); return; }
      if (create && !created) { db.close(); fail('STORE_ALREADY_EXISTS'); return; }
      if (!db.objectStoreNames.contains(STORE)) { db.close(); fail('INVALID_DATABASE_SCHEMA'); return; }
      resolve(db);
    };
  });
}

export function readRecords(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    const header = store.get('header'); const snapshot = store.get('snapshot');
    transaction.oncomplete = () => resolve({ header: header.result, record: snapshot.result });
    transaction.onabort = transaction.onerror = () => reject(new BrowserStorageError('DATABASE_READ_FAILED'));
  });
}

/** Encrypt BEFORE entering this transaction. IndexedDB transactions cannot wait for WebCrypto. */
export function commitRecords(db, header, previous, next) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    let failure;
    const fail = (code) => { failure = new BrowserStorageError(code); transaction.abort(); };
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(failure ?? new BrowserStorageError('CHECKPOINT_FAILED'));
    if (transaction.durability !== 'strict') { fail('STRICT_DURABILITY_UNAVAILABLE'); return; }
    const store = transaction.objectStore(STORE);
    const headerRead = store.get('header'); const snapshotRead = store.get('snapshot');
    let reads = 0;
    const apply = () => {
      if (++reads !== 2) return;
      try {
        if (previous === null) {
          if (headerRead.result !== undefined || snapshotRead.result !== undefined) { fail('STORE_ALREADY_EXISTS'); return; }
          store.add(header, 'header'); store.add(next, 'snapshot');
        } else {
          if (!headerRead.result || headerIdentity(headerRead.result) !== headerIdentity(header)
            || !sameRecord(snapshotRead.result, previous)) { fail('STORED_STATE_CHANGED'); return; }
          store.put(next, 'snapshot');
        }
      } catch { fail('INVALID_STORED_STATE'); }
    };
    headerRead.onsuccess = apply; snapshotRead.onsuccess = apply;
  });
}
