import { receipt, scopeKey, WalletError } from '../protocol/index.mjs';

const clone = value => structuredClone(value);
const sameContext = (a, b) => a?.network === b.network && a?.contractAddress === b.contractAddress && a?.vaultId === b.vaultId;
const runnerStores = new WeakMap();

/** Substores always mutate a fresh root draft; merchant snapshots cannot overwrite a payment checkpoint. */
export class BrowserRunnerStore {
  #root; #context; #ready = false; #closed = false; #generation = 0; #queue = Promise.resolve();
  static async open(root, { context, initialState } = {}) {
    if (context?.network !== 'preview' || !/^[0-9a-f]{64}$/.test(context.contractAddress) || !/^[0-9a-f]{64}$/.test(context.vaultId)) throw new Error('Invalid browser deployment context');
    const existing = runnerStores.get(root);
    if (existing && !existing.#closed) { if (!sameContext(existing.#context, context)) throw new Error('Runner context changed'); return existing; }
    const store = new BrowserRunnerStore(); store.#root = root; store.#context = clone(context);
    await root.update(state => {
      if (state.runner !== null && state.runner !== undefined) {
        if (!sameContext(state.runnerContext, context)) throw new Error('Stored runner context differs');
      } else {
        if (state.setup.runnerInitialized || initialState === undefined) throw new Error('Missing persisted runner history');
        state.runner = clone(initialState); state.runnerContext = clone(context);
      }
    });
    runnerStores.set(root, store); return store;
  }
  get deploymentContext() { return Object.freeze(clone(this.#context)); }
  get canSpend() { return !this.#closed && this.#ready; }
  snapshot() {
    if (this.#closed) throw new Error('Runner store closed');
    const root = this.#root.snapshot();
    if (!sameContext(root.runnerContext, this.#context) || !root.runner) throw new Error('Missing or rebound runner state');
    return clone(root.runner);
  }
  invalidate() { this.#ready = false; this.#generation++; }
  #serialize(operation) {
    if (this.#closed) return Promise.reject(new Error('Runner store closed'));
    const result = this.#queue.then(operation); this.#queue = result.catch(() => {}); return result;
  }
  checkpoint(candidate) {
    this.invalidate(); const saved = clone(candidate);
    return this.#serialize(() => this.#root.update(root => {
      if (!sameContext(root.runnerContext, this.#context)) throw new Error('Runner context changed');
      if (root.uncertain) throw new WalletError('REQUEST_UNRESOLVED');
      root.runner = saved;
    }));
  }
  reconcile(verifier) {
    if (typeof verifier !== 'function') throw new TypeError('A chain verifier is required');
    this.invalidate(); const generation = this.#generation;
    return this.#serialize(async () => {
      if (await verifier(this.snapshot(), clone(this.#context)) !== true) throw new Error('Browser state reconciliation failed');
      this.#ready = !this.#closed && generation === this.#generation;
    });
  }
  async close() { this.#closed = true; this.invalidate(); await this.#queue; }
}

export class BrowserRequestJournal {
  #root; #closed = false;
  constructor(root) {
    const state = root.snapshot().journal;
    if (state?.version !== 1 || !Array.isArray(state.records)) throw new Error('Missing browser request journal');
    this.#root = root;
  }
  async #transaction(operation) {
    if (this.#closed) throw new Error('Browser journal closed');
    let result;
    await this.#root.update(root => {
      if (root.journal?.version !== 1 || !Array.isArray(root.journal.records)) throw new Error('Invalid browser journal');
      result = clone(operation(root.journal));
    });
    return result;
  }
  reserve(scope, request, fingerprint) {
    return this.#transaction(data => {
      const key = scopeKey(scope); const previous = data.records.find(record => record.scope === key && record.idempotencyKey === request.idempotencyKey);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new WalletError('REQUEST_CONFLICT'); return { created: false, record: previous }; }
      const record = { paymentId: crypto.randomUUID(), scope: key, idempotencyKey: request.idempotencyKey, fingerprint, request: clone(request), status: 'requested' };
      data.records.push(record); return { created: true, record };
    });
  }
  async get(scope, paymentId) {
    if (this.#closed) throw new Error('Browser journal closed');
    return this.#root.snapshot().journal.records.find(record => record.scope === scopeKey(scope) && record.paymentId === paymentId) ?? null;
  }
  update(scope, paymentId, patch) {
    return this.#transaction(data => {
      const record = data.records.find(item => item.scope === scopeKey(scope) && item.paymentId === paymentId);
      if (!record) throw new WalletError('NOT_FOUND');
      if (Object.keys(patch).some(key => !['status', 'transactionId', 'settlementEvidence'].includes(key))) throw new Error('Invalid journal patch');
      if (['finalized', 'rejected'].includes(record.status)) return record;
      if (record.transactionId && patch.transactionId && record.transactionId !== patch.transactionId) throw new Error('Transaction reference changed');
      if (record.status === 'submitted' && ['requested', 'prepared', 'proving'].includes(patch.status)) return record;
      receipt({ ...record, ...patch }); Object.assign(record, clone(patch)); return record;
    });
  }
  async close() { this.#closed = true; }
}
