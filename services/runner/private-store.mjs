import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const FORMAT = 'midnight-agent-wallet:private-state:v1';
const MAX_BYTES = 16 * 1024 * 1024;
const encode = (value) => {
  if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (Array.isArray(value)) return ['array', value.map(encode)];
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return ['object', Object.entries(value).map(([key, child]) => [key, encode(child)])];
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value)))
    return ['scalar', value];
  throw new TypeError('Private state contains an unsupported value');
};
const decode = ([tag, value]) => {
  switch (tag) {
    case 'bytes': return Uint8Array.from(Buffer.from(value, 'base64'));
    case 'bigint': return BigInt(value);
    case 'array': return value.map(decode);
    case 'object': return Object.fromEntries(value.map(([key, child]) => [key, decode(child)]));
    case 'scalar': return value;
    default: throw new Error('Invalid private-state encoding');
  }
};
function contextId(context) {
  if (!context || !['local', 'preprod'].includes(context.network)
      || typeof context.contractAddress !== 'string' || !/^[0-9a-f]{64}$/.test(context.contractAddress)
      || typeof context.vaultId !== 'string' || !/^[0-9a-f]{64}$/.test(context.vaultId))
    throw new TypeError('Explicit test-network deployment context required');
  return JSON.stringify([FORMAT, context.network, context.contractAddress, context.vaultId]);
}
function encrypt(state, key, context) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(contextId(context)));
  const plaintext = Buffer.from(JSON.stringify(encode(state)));
  if (plaintext.length > MAX_BYTES - 29) throw new Error('Private-state snapshot too large');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
}
function decrypt(bytes, key, context) {
  if (bytes.length < 30 || bytes.length > MAX_BYTES || bytes[0] !== 1) throw new Error('Invalid private-state snapshot');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
  decipher.setAAD(Buffer.from(contextId(context)));
  decipher.setAuthTag(bytes.subarray(13, 29));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]);
  try { return decode(JSON.parse(plaintext.toString('utf8'))); } finally { plaintext.fill(0); }
}

/** Encrypted storage primitive, not a transaction submitter.
 * Persist confirmed openings AND any in-flight candidate/serialized transaction together.
 * The trusted runner must reconcile with chain evidence after every open/import/checkpoint.
 * A backup may be stale even when its authentication is valid.
 */
export class PrivateStateStore {
  #file; #key; #context; #state; #lock; #queue = Promise.resolve(); #ready = false; #closed = false; #generation = 0;
  static async open({ file, key, context, initialState }) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new TypeError('Expected a 32-byte storage key');
    contextId(context);
    const store = new PrivateStateStore();
    store.#file = resolve(file); store.#key = Buffer.from(key); store.#context = structuredClone(context);
    const initialSnapshot = initialState === undefined ? undefined : structuredClone(initialState);
    await mkdir(dirname(store.#file), { recursive: true, mode: 0o700 });
    try {
      store.#lock = await open(`${store.#file}.lock`, 'wx', 0o600);
      await store.#lock.writeFile(JSON.stringify({ pid: process.pid }));
      await store.#lock.sync();
      try { store.#state = decrypt(await readFile(store.#file), store.#key, store.#context); }
      catch (error) {
        if (error.code !== 'ENOENT' || initialSnapshot === undefined) throw error;
        await store.#persist(initialSnapshot);
      }
      return store;
    } catch (error) { await store.close(); throw error; }
  }
  get canSpend() { return !this.#closed && this.#ready; }
  /** Public deployment binding authenticated as AAD; never includes private state. */
  get deploymentContext() {
    return Object.freeze({ network: this.#context.network, contractAddress: this.#context.contractAddress, vaultId: this.#context.vaultId });
  }
  snapshot() {
    if (this.#closed) throw new Error('Private store closed');
    return structuredClone(this.#state);
  }
  #serialize(operation) {
    if (this.#closed) return Promise.reject(new Error('Private store closed'));
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }
  async #persist(state) {
    const bytes = encrypt(state, this.#key, this.#context);
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, this.#file);
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.#file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      this.#state = structuredClone(state);
    } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
  }
  checkpoint(state) {
    this.#ready = false; this.#generation += 1;
    let candidate;
    try { candidate = structuredClone(state); } catch (error) { return Promise.reject(error); }
    return this.#serialize(async () => { this.#ready = false; await this.#persist(candidate); });
  }
  reconcile(verifyAgainstChain) {
    if (typeof verifyAgainstChain !== 'function') throw new TypeError('Chain verifier required');
    this.#ready = false;
    const generation = ++this.#generation;
    return this.#serialize(async () => {
      this.#ready = false;
      if (await verifyAgainstChain(this.snapshot(), structuredClone(this.#context)) !== true)
        throw new Error('Private state could not be reconciled with the chain');
      // A newer checkpoint/reconciliation request (or close) invalidates this result
      // immediately, even while it is still waiting in the serialized queue.
      this.#ready = !this.#closed && generation === this.#generation;
    });
  }
  exportBackup() {
    return this.#serialize(async () => encrypt(this.#state, this.#key, this.#context));
  }
  static async restore({ bytes, file, key, context }) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new TypeError('Expected a 32-byte storage key');
    const store = new PrivateStateStore();
    store.#file = resolve(file); store.#key = Buffer.from(key); store.#context = structuredClone(context);
    let temporary;
    let handle;
    try {
      // Authenticate before creating anything; capture key/context before yielding.
      const state = decrypt(bytes, store.#key, store.#context);
      const encrypted = encrypt(state, store.#key, store.#context);
      await mkdir(dirname(store.#file), { recursive: true, mode: 0o700 });
      store.#lock = await open(`${store.#file}.lock`, 'wx', 0o600);
      await store.#lock.writeFile(JSON.stringify({ pid: process.pid }));
      await store.#lock.sync();
      temporary = `${store.#file}.${randomUUID()}.tmp`;
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(encrypted); await handle.sync(); await handle.close(); handle = null;
      // Hard-link publication is atomic and refuses an existing destination. Unlike
      // rename, it cannot overwrite a file created between a preflight check and publish.
      await link(temporary, store.#file);
      if (process.platform !== 'win32') {
        const directory = await open(dirname(store.#file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      store.#state = state;
      return store;
    } catch (error) {
      await store.close();
      throw error;
    } finally {
      await handle?.close();
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true; this.#ready = false; this.#generation += 1;
    await this.#queue;
    this.#key?.fill(0);
    if (this.#lock) { await this.#lock.close(); this.#lock = null; await unlink(`${this.#file}.lock`); }
  }
}
