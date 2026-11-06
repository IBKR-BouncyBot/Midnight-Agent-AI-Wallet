import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isTransactionId, receipt, requestFingerprint, scopeKey, settlementEvidence, validateToolInput, WalletError } from '../../packages/protocol/index.mjs';

const queues = new WeakMap(); // Also serializes two runner objects sharing one open vault store.
const hex = /^[0-9a-f]{64}$/;
const phases = new Set(['requested', 'prepared', 'proving', 'signed', 'submitting', 'submitted', 'unresolved']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value) => value instanceof Uint8Array && value.length > 0 && value.length <= 12 * 1024 * 1024;

function bindQualifiedCandidate(candidate, observed) {
  if (!candidate || !observed || typeof candidate !== 'object' || typeof observed !== 'object') throw new Error('Missing candidate');
  const expected = structuredClone(candidate);
  const actual = structuredClone(observed);
  const expectedPrivate = Object.hasOwn(expected, 'privateState') ? expected.privateState : expected;
  const actualPrivate = Object.hasOwn(actual, 'privateState') ? actual.privateState : actual;
  if (!expectedPrivate || !actualPrivate || !Object.hasOwn(expectedPrivate, 'coinIndex') || !Object.hasOwn(actualPrivate, 'coinIndex')
      || !(actualPrivate.coinIndex === null || (typeof actualPrivate.coinIndex === 'bigint'
        && actualPrivate.coinIndex >= 0n && actualPrivate.coinIndex <= (1n << 64n) - 1n))) {
    throw new Error('Invalid coin qualification');
  }
  // Only the ledger-assigned tree position may change. In particular, observed
  // salts, spending totals, coin openings, policy/version and expected public
  // commitments cannot replace the persisted native circuit result.
  expectedPrivate.coinIndex = actualPrivate.coinIndex;
  if (!isDeepStrictEqual(expected, actual)) throw new Error('Finalized private state differs from persisted candidate');
  return expected;
}

export function createRunnerState(confirmed) {
  return { version: 1, confirmed: structuredClone(confirmed), pending: null, payments: [] };
}

/**
 * Single-vault durable backend. Adapter prepare/prove MUST NOT submit anything.
 * Only submit() may cross that boundary, once, after the signed bytes and marker
 * have been durably committed. Every subsequent retry uses observe() only.
 */
export class PaymentRunner {
  #store; #adapter; #scope; #context; #now;
  constructor({ store, adapter, scope, vaultId, now = Date.now }) {
    if (!store || !adapter || !['prepare', 'proveAndBalance', 'submit', 'observe', 'verifyConfirmed', 'verifyCoinQualification']
      .every((name) => typeof adapter[name] === 'function')) throw new TypeError('A complete staged adapter is required');
    if (!['local', 'preprod'].includes(scope?.network) || typeof scope.contractAddress !== 'string'
      || !hex.test(scope.contractAddress) || typeof vaultId !== 'string' || !hex.test(vaultId)
      || !['subject', 'agentRef', 'vaultRef'].every((key) => typeof scope[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(scope[key]))) {
      throw new TypeError('Explicit test-network runner scope required');
    }
    this.#store = store; this.#adapter = adapter; this.#scope = structuredClone(scope); this.#now = now;
    this.#context = { network: scope.network, contractAddress: scope.contractAddress, vaultId };
    this.#state();
  }
  get ready() { return true; } // Configured for reads/reconciliation; distinct from spending readiness.
  get canSubmit() { return this.#store.canSpend && this.#state().pending === null; }

  #serialized(operation) {
    const result = (queues.get(this.#store) ?? Promise.resolve()).then(operation);
    queues.set(this.#store, result.catch(() => {}));
    return result;
  }
  #state() {
    this.#assertContext();
    const state = this.#store.snapshot();
    if (state?.version !== 1 || !Object.hasOwn(state, 'confirmed') || !Array.isArray(state.payments)
        || !(state.pending === null || (state.pending && phases.has(state.pending.phase)))) {
      throw new Error('Invalid runner state; explicit recovery required');
    }
    return state;
  }
  #assertContext() {
    const actual = this.#store.deploymentContext;
    if (!actual || actual.network !== this.#context.network || actual.contractAddress !== this.#context.contractAddress
      || actual.vaultId !== this.#context.vaultId) throw new Error('Private store deployment context does not match runner');
  }
  #input(input) {
    const scope = structuredClone(input.scope);
    if (scopeKey(scope) !== scopeKey(this.#scope) || !Number.isSafeInteger(scope.expiresAt)
        || scope.expiresAt <= this.#now()) throw new WalletError('NOT_AUTHORIZED');
    const request = validateToolInput('request_payment', input.request);
    if (request.vaultRef !== scope.vaultRef || requestFingerprint(request) !== input.fingerprint
        || typeof input.paymentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.paymentId)) {
      throw new WalletError('INVALID_REQUEST');
    }
    return { scope, request, fingerprint: input.fingerprint, paymentId: input.paymentId };
  }
  #find(state, input) {
    const record = state.payments.find((item) => item.paymentId === input.paymentId
      || (item.scope === scopeKey(input.scope) && item.idempotencyKey === input.request.idempotencyKey));
    if (record && (record.scope !== scopeKey(input.scope) || record.fingerprint !== input.fingerprint
        || record.paymentId !== input.paymentId)) throw new WalletError('REQUEST_CONFLICT');
    return record;
  }
  #result(record) {
    const result = receipt(record);
    return result.status === 'finalized'
      ? { ...result, settlementEvidence: settlementEvidence(record.settlementEvidence, this.#scope, result.transactionId) }
      : result;
  }
  async #verify() {
    this.#assertContext();
    await this.#store.reconcile(async (state, context) => {
      if (context.network !== this.#context.network || context.contractAddress !== this.#context.contractAddress
          || context.vaultId !== this.#context.vaultId || state.pending !== null) return false;
      return await this.#adapter.verifyConfirmed({ confirmed: state.confirmed, context }) === true;
    });
  }
  initialize() {
    return this.#serialized(async () => {
      if (this.#state().pending !== null) return { canSpend: false, recoveryRequired: true };
      await this.#verify();
      return { canSpend: this.canSubmit, recoveryRequired: false };
    });
  }

  requestPayment(input) {
    const checked = this.#input(input);
    return this.#serialized(() => this.#request(checked));
  }
  async #request(input) {
    let state = this.#state();
    const existing = this.#find(state, input);
    if (existing) return this.#reconcile(input, state, existing);
    if (state.pending !== null) throw new WalletError('PAYMENT_UNAVAILABLE');
    await this.#verify(); // Reconcile before each new state-dependent proof, including after restart.
    if (!this.#store.canSpend) throw new WalletError('PAYMENT_UNAVAILABLE');
    state = this.#state();
    const record = { paymentId: input.paymentId, scope: scopeKey(input.scope), fingerprint: input.fingerprint,
      idempotencyKey: input.request.idempotencyKey, status: 'requested' };
    state.payments.push(record);
    state.pending = { ...input, phase: 'requested', candidate: null, unprovenBytes: null,
      signedBytes: null, signedDigest: null, transactionIds: [], transactionId: null };
    await this.#store.checkpoint(state);

    let prepared;
    try {
      prepared = await this.#adapter.prepare({ ...input, confirmed: structuredClone(state.confirmed), context: structuredClone(this.#context) });
      if (!prepared || !bytes(prepared.unprovenBytes) || !Object.hasOwn(prepared, 'candidate')) throw new Error('Invalid prepared transaction');
    } catch { return this.#rejectBeforeSubmission(state, record); }
    state.pending = { ...state.pending, phase: 'prepared', candidate: structuredClone(prepared.candidate),
      unprovenBytes: Uint8Array.from(prepared.unprovenBytes) };
    record.status = 'prepared';
    await this.#store.checkpoint(state);
    state.pending.phase = 'proving'; record.status = 'proving';
    await this.#store.checkpoint(state);

    let signed;
    try {
      signed = await this.#adapter.proveAndBalance({ ...input, unprovenBytes: Uint8Array.from(state.pending.unprovenBytes) });
      if (!signed || !bytes(signed.signedBytes) || !Array.isArray(signed.transactionIds)
          || signed.transactionIds.length < 1 || signed.transactionIds.length > 64
          || signed.transactionIds.some((id) => !isTransactionId(id))
          || new Set(signed.transactionIds).size !== signed.transactionIds.length) throw new Error('Invalid signed transaction');
    } catch { return this.#rejectBeforeSubmission(state, record); }
    state.pending = { ...state.pending, phase: 'signed', signedBytes: Uint8Array.from(signed.signedBytes),
      signedDigest: hash(signed.signedBytes), transactionIds: [...signed.transactionIds], transactionId: signed.transactionIds[0] };
    record.transactionId = signed.transactionIds[0];
    await this.#store.checkpoint(state);
    if (input.scope.expiresAt <= this.#now()) return this.#rejectBeforeSubmission(state, record);
    // Persist ambiguity BEFORE crossing the submission boundary. A crash immediately
    // after this checkpoint must never lead to implicit re-proving or resubmission.
    state.pending.phase = 'submitting'; record.status = 'unresolved';
    await this.#store.checkpoint(state);
    try {
      const persisted = this.#state().pending;
      if (hash(persisted.signedBytes) !== persisted.signedDigest) throw new Error('Signed transaction digest mismatch');
      const txId = await this.#adapter.submit({ signedBytes: Uint8Array.from(persisted.signedBytes), transactionIds: [...persisted.transactionIds] });
      if (!persisted.transactionIds.includes(txId)) throw new Error('Submission returned an unrelated transaction');
      state.pending.phase = 'submitted'; state.pending.transactionId = txId;
      record.transactionId = txId; record.status = 'submitted';
      await this.#store.checkpoint(state);
    } catch {
      // The already-persisted 'submitting' marker includes exact bytes and all IDs.
      // Do not overwrite it with a presumed rejection, even if the submitter threw.
      return this.#result({ ...record, status: 'unresolved' });
    }
    return this.#reconcile(input, state, record);
  }
  async #rejectBeforeSubmission(state, record) {
    if (['submitting', 'submitted', 'unresolved'].includes(state.pending.phase)) throw new Error('Cannot reject after submission boundary');
    record.status = 'rejected'; delete record.transactionId; state.pending = null;
    await this.#store.checkpoint(state);
    try { await this.#verify(); } catch { /* Keep spending disabled until later chain reconciliation. */ }
    return this.#result(record);
  }

  reconcilePayment(input) {
    const checked = this.#input(input);
    return this.#serialized(async () => {
      const state = this.#state();
      const record = this.#find(state, checked);
      if (!record) return { paymentId: checked.paymentId, status: 'unresolved' };
      return this.#reconcile(checked, state, record);
    });
  }
  async #reconcile(input, state, record) {
    this.#assertContext();
    if (['finalized', 'rejected'].includes(record.status)) return this.#result(record);
    if (state.pending?.paymentId !== input.paymentId) throw new Error('Missing pending recovery record');
    let observed;
    try {
      observed = await this.#adapter.observe({ ...input, pending: structuredClone(state.pending),
        confirmed: structuredClone(state.confirmed), context: structuredClone(this.#context) });
      if (observed?.outcome === 'finalized') {
        if (!state.pending.transactionIds.includes(observed.transactionId)) throw new Error('Unrelated transaction evidence');
        const evidence = settlementEvidence(observed.settlementEvidence, input.scope, observed.transactionId);
        const qualified = bindQualifiedCandidate(state.pending.candidate, observed.confirmed);
        if (await this.#adapter.verifyCoinQualification({ candidate: structuredClone(state.pending.candidate),
              confirmed: structuredClone(qualified), transactionId: observed.transactionId,
              context: structuredClone(this.#context), settlementEvidence: evidence }) !== true
            || await this.#adapter.verifyConfirmed({ confirmed: structuredClone(qualified),
              context: structuredClone(this.#context), settlementEvidence: evidence }) !== true) throw new Error('Candidate not reconciled');
        record.status = 'finalized'; record.transactionId = observed.transactionId; record.settlementEvidence = evidence;
        state.confirmed = qualified; state.pending = null;
        await this.#store.checkpoint(state); // Commit new openings + terminal receipt together.
        try { await this.#verify(); } catch { /* Payment remains final; newer chain state blocks future spending. */ }
        return this.#result(record);
      }
      // Rejection after submitting requires a specific finalized chain result AND
      // independent confirmation that the original vault state remains spendable.
      if (observed?.outcome === 'rejected' && state.pending.transactionIds.includes(observed.transactionId)
          && typeof observed.finalizedBlockHash === 'string' && hex.test(observed.finalizedBlockHash)
          && observed.noPaymentEffect === true
          && await this.#adapter.verifyConfirmed({ confirmed: structuredClone(state.confirmed), context: structuredClone(this.#context) }) === true) {
        record.status = 'rejected'; record.transactionId = observed.transactionId; state.pending = null;
        await this.#store.checkpoint(state);
        try { await this.#verify(); } catch { /* Keep gate closed. */ }
        return this.#result(record);
      }
    } catch { /* Exceptions, missing observations and timeouts are all ambiguous. */ }
    state = this.#state();
    const current = this.#find(state, input);
    // A successful final checkpoint followed by a failed gate check must remain final.
    if (current && ['finalized', 'rejected'].includes(current.status)) return this.#result(current);
    current.status = 'unresolved';
    state.pending.phase = 'unresolved';
    await this.#store.checkpoint(state);
    return this.#result(current);
  }
}
