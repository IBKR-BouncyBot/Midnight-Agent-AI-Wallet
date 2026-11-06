import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { receipt, scopeKey, WalletError } from '../../packages/protocol/index.mjs';

/**
 * Single-process encrypted request journal. A 32-byte key comes from a secret store.
 * Its exclusive lock is intentionally not broken automatically after a crash.
 * A stale lock requires operator verification that the old runner is stopped.
 * Use a local filesystem with atomic rename; no NFS/network shares.
 */
export class EncryptedRequestJournal {
  #path; #key; #lock; #data; #queue = Promise.resolve(); #closed = false;

  static async open(path, key) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new TypeError('Expected a 32-byte journal key');
    const journal = new EncryptedRequestJournal();
    journal.#path = resolve(path);
    journal.#key = Buffer.from(key);
    await mkdir(dirname(journal.#path), { recursive: true, mode: 0o700 });
    journal.#lock = await open(`${journal.#path}.lock`, 'wx', 0o600);
    try {
      await journal.#lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await journal.#lock.sync();
      try {
        const bytes = await readFile(journal.#path);
        if (bytes.length < 33 || bytes[0] !== 1) throw new Error('Invalid journal');
        const decipher = createDecipheriv('aes-256-gcm', journal.#key, bytes.subarray(1, 13));
        decipher.setAAD(Buffer.from('midnight-agent-wallet:request-journal:v1'));
        decipher.setAuthTag(bytes.subarray(13, 29));
        journal.#data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'));
        if (journal.#data.version !== 1 || !Array.isArray(journal.#data.records)) throw new Error('Invalid journal');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        journal.#data = { version: 1, records: [] };
        await journal.#save(journal.#data);
      }
      return journal;
    } catch (error) {
      await journal.close();
      throw error;
    }
  }

  async #save(data) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from('midnight-agent-wallet:request-journal:v1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const bytes = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(temporary, this.#path);
      // Node/Windows cannot fsync a directory. Use WSL/local Linux for durable live use.
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.#path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  #transaction(callback) {
    if (this.#closed) return Promise.reject(new Error('Journal is closed'));
    const operation = this.#queue.then(async () => {
      const draft = structuredClone(this.#data);
      const result = callback(draft);
      if (result.write) {
        await this.#save(draft);
        this.#data = draft;
      }
      return structuredClone(result.value);
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  reserve(scope, request, fingerprint) {
    return this.#transaction((data) => {
      const key = scopeKey(scope);
      const previous = data.records.find((record) => record.scope === key && record.idempotencyKey === request.idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new WalletError('REQUEST_CONFLICT');
        return { write: false, value: { created: false, record: previous } };
      }
      const record = {
        paymentId: randomUUID(), scope: key, idempotencyKey: request.idempotencyKey,
        fingerprint, request, status: 'requested',
      };
      data.records.push(record);
      return { write: true, value: { created: true, record } };
    });
  }

  get(scope, paymentId) {
    return this.#transaction((data) => ({
      write: false, value: data.records.find((record) => record.scope === scopeKey(scope) && record.paymentId === paymentId) ?? null,
    }));
  }

  update(scope, paymentId, patch) {
    return this.#transaction((data) => {
      const record = data.records.find((item) => item.scope === scopeKey(scope) && item.paymentId === paymentId);
      if (!record) throw new WalletError('NOT_FOUND');
      // Only a bounded receipt may be changed; never permit a patch to rebind scope/request.
      if (Object.keys(patch).some((key) => !['status', 'transactionId', 'settlementEvidence'].includes(key))) throw new Error('Invalid journal patch');
      if (['finalized', 'rejected'].includes(record.status)) return { write: false, value: record };
      if (record.transactionId && patch.transactionId && record.transactionId !== patch.transactionId) {
        throw new Error('Transaction reference cannot change');
      }
      if (record.status === 'submitted' && ['requested', 'prepared', 'proving'].includes(patch.status)) {
        return { write: false, value: record };
      }
      receipt({ ...record, ...patch });
      Object.assign(record, patch);
      return { write: true, value: record };
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    this.#key?.fill(0);
    if (this.#lock) {
      await this.#lock.close();
      await unlink(`${this.#path}.lock`);
      this.#lock = null;
    }
  }
}
