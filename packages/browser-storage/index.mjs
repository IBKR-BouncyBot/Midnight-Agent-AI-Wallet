import { cloneSnapshot } from './codec.mjs';
import { BrowserStorageError, normalizeContext, validatePassword, requireCrypto, createEncryption,
  unlockEncryption, encryptSnapshot, decryptSnapshot } from './crypto.mjs';
import { acquireWriter, openDatabase, readRecords, commitRecords } from './indexeddb.mjs';
import { encodeBackup, decodeBackup } from './backup.mjs';
export { BrowserStorageError } from './crypto.mjs';

/** Origin-local encrypted persistence. It neither authorizes spending nor sends transactions. */
export class BrowserSnapshotStore {
  #db; #key; #header; #record; #state; #crypto; #release; #queue = Promise.resolve(); #closing; #closed = false; #invalid = false;
  static create(options) { return this.#open(options, true); }
  static open(options) { return this.#open(options, false); }
  /** Authenticate before creating a database; never overwrite an existing identity. */
  static async restore({ backup, ...options }) {
    const crypto = options.crypto ?? globalThis.crypto;
    const { header, record } = decodeBackup(backup);
    const key = await unlockEncryption(options.password, header, options.context, crypto);
    const restored = await decryptSnapshot(record, key, header, crypto);
    // Fresh salt/nonce and revision zero for the new storage instance; all opaque
    // application generations, pending bytes and candidates remain unchanged.
    return BrowserSnapshotStore.create({ ...options, initialState: restored });
  }
  static async #open({ name, password, context, initialState,
    indexedDB = globalThis.indexedDB, locks = globalThis.navigator?.locks, crypto = globalThis.crypto }, create) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new BrowserStorageError('INVALID_STORE_NAME');
    const binding = normalizeContext(context); validatePassword(password); requireCrypto(crypto);
    if (!create && initialState !== undefined) throw new BrowserStorageError('OPEN_CANNOT_CREATE_IDENTITY');
    if (create && initialState === undefined) throw new BrowserStorageError('INITIAL_STATE_REQUIRED');
    const initial = create ? cloneSnapshot(initialState) : undefined;
    const store = new BrowserSnapshotStore(); store.#crypto = crypto;
    try {
      store.#release = await acquireWriter(locks, name);
      store.#db = await openDatabase(indexedDB, name, create);
      store.#db.onversionchange = () => { store.#invalid = true; store.#db.close(); };
      store.#db.onclose = () => { store.#invalid = true; };
      if (create) {
        const encryption = await createEncryption(password, binding, crypto);
        store.#header = encryption.header; store.#key = encryption.key;
        store.#record = await encryptSnapshot(initial, store.#key, store.#header, 0, crypto);
        await commitRecords(store.#db, store.#header, null, store.#record); store.#state = initial;
      } else {
        const saved = await readRecords(store.#db);
        if (!saved.header || !saved.record) throw new BrowserStorageError('STORED_IDENTITY_MISSING');
        store.#header = saved.header; store.#record = saved.record;
        store.#key = await unlockEncryption(password, saved.header, binding, crypto);
        store.#state = await decryptSnapshot(saved.record, store.#key, saved.header, crypto);
      }
      return store;
    } catch (error) { await store.close(); throw error; }
  }
  #assertOpen() {
    if (this.#closed || this.#invalid) throw new BrowserStorageError('STORE_CLOSED');
  }
  get context() { return normalizeContext(this.#header.context); }
  get revision() { this.#assertOpen(); return this.#record.revision; }
  snapshot() { this.#assertOpen(); return cloneSnapshot(this.#state); }
  #enqueue(operation) {
    try { this.#assertOpen(); } catch (error) { return Promise.reject(error); }
    const result = this.#queue.then(operation); this.#queue = result.catch(() => {}); return result;
  }
  async #persist(next) {
    if (this.#invalid) throw new BrowserStorageError('STORE_CLOSED');
    if (this.#record.revision === Number.MAX_SAFE_INTEGER) throw new BrowserStorageError('REVISION_EXHAUSTED');
    const encrypted = await encryptSnapshot(next, this.#key, this.#header, this.#record.revision + 1, this.#crypto);
    await commitRecords(this.#db, this.#header, this.#record, encrypted);
    this.#record = encrypted; this.#state = next;
  }
  /** Await this promise BEFORE broadcasting. A rejected commit leaves the old snapshot authoritative. */
  checkpoint(state) {
    let detached;
    try { detached = cloneSnapshot(state); } catch (error) { return Promise.reject(error); }
    return this.#enqueue(() => this.#persist(detached));
  }
  update(change) {
    if (typeof change !== 'function') return Promise.reject(new TypeError('Snapshot update callback required'));
    return this.#enqueue(async () => {
      const draft = cloneSnapshot(this.#state); await change(draft);
      await this.#persist(cloneSnapshot(draft));
    });
  }
  exportBackup() {
    return this.#enqueue(async () => encodeBackup(this.#header, this.#record));
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await this.#queue;
      this.#db?.close(); this.#key = undefined; this.#state = undefined;
      await this.#release?.(); this.#release = undefined;
    })();
    return this.#closing;
  }
}
