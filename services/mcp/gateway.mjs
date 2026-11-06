import { receipt, requestFingerprint, scopeKey, settlementEvidence, validateToolInput, WalletError, TOOLS } from '../../packages/protocol/index.mjs';

const FINAL = new Set(['finalized', 'rejected']);
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const hex32 = /^[0-9a-f]{64}$/;

function backendResult(value, scope, paymentId) {
  const projected = receipt(value);
  if (projected.paymentId !== paymentId) throw new Error('Backend returned a different request');
  if (projected.status !== 'finalized') return projected;
  // This is a trusted-runner attestation, NOT cryptographic verification in the gateway.
  // The runner must derive these facts from independent network/wallet observations.
  return { ...projected, settlementEvidence: settlementEvidence(value.settlementEvidence, scope, projected.transactionId) };
}

/** Disabled by default. A browser demonstration cannot be used as this backend. */
export class UnconfiguredPaymentBackend {
  ready = false;
  async requestPayment() { throw new WalletError('PAYMENT_UNAVAILABLE'); }
  async reconcilePayment() { throw new WalletError('PAYMENT_UNAVAILABLE'); }
}

/**
 * Trusted auth callback returns { subject, network, contractAddress, vaultRef, agentRef, expiresAt }.
 * The backend receives that scope separately from model-supplied request fields.
 * A real backend MUST bind deployment/policy version/asset/recipient/amount/nonce,
 * generate the proof and reconcile finality before returning finalized.
 */
export class PaymentGateway {
  #authenticate; #backend; #journal; #now; #limit; #window; #rates = new Map(); #active = new Map();

  constructor({ authenticate, backend = new UnconfiguredPaymentBackend(), journal,
    now = Date.now, rateLimit = 30, rateWindowMs = 60_000 }) {
    if (typeof authenticate !== 'function' || !Number.isInteger(rateLimit) || rateLimit < 1
        || !Number.isInteger(rateWindowMs) || rateWindowMs < 1) throw new TypeError('Invalid gateway configuration');
    this.#authenticate = authenticate; this.#backend = backend; this.#journal = journal;
    this.#now = now; this.#limit = rateLimit; this.#window = rateWindowMs;
  }

  async #scope(credential) {
    let scope;
    try { scope = await this.#authenticate(credential); } catch { throw new WalletError('NOT_AUTHORIZED'); }
    if (!scope || !['local', 'preview', 'preprod'].includes(scope.network)
        || typeof scope.contractAddress !== 'string' || !hex32.test(scope.contractAddress)
        || !['subject', 'vaultRef', 'agentRef'].every((key) => typeof scope[key] === 'string' && id.test(scope[key]))
        || !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt <= this.#now()) {
      throw new WalletError('NOT_AUTHORIZED');
    }
    return Object.freeze({ subject: scope.subject, network: scope.network, contractAddress: scope.contractAddress, vaultRef: scope.vaultRef,
      agentRef: scope.agentRef, expiresAt: scope.expiresAt });
  }

  #rateLimit(scope) {
    const now = this.#now();
    for (const [key, bucket] of this.#rates) if (bucket.until <= now) this.#rates.delete(key);
    const key = scopeKey(scope);
    const bucket = this.#rates.get(key) ?? { count: 0, until: now + this.#window };
    if (bucket.count >= this.#limit) throw new WalletError('RATE_LIMITED');
    bucket.count += 1;
    this.#rates.set(key, bucket);
  }

  async call(name, input, credential) {
    const scope = await this.#scope(credential);
    this.#rateLimit(scope); // Invalid and rejected calls consume the same per-agent budget.
    const request = validateToolInput(name, input);
    if (request.vaultRef !== scope.vaultRef) throw new WalletError('NOT_AUTHORIZED');
    if (name === 'get_wallet_capabilities') return {
      protocolVersion: '1', network: scope.network, vaultRef: scope.vaultRef,
      paymentsAvailable: this.#backend.ready === true && this.#backend.canSubmit !== false && !!this.#journal,
      operations: TOOLS.map((tool) => tool.name),
    };
    if (!this.#journal || this.#backend.ready !== true) throw new WalletError('PAYMENT_UNAVAILABLE');
    if (name === 'get_payment_status') {
      const record = await this.#journal.get(scope, request.paymentId);
      if (!record) throw new WalletError('NOT_FOUND');
      return this.#reconcile(scope, record);
    }
    const reserved = await this.#journal.reserve(scope, request, requestFingerprint(request));
    if (!reserved.created) return this.#reconcile(scope, reserved.record);
    const work = this.#submit(scope, reserved.record);
    this.#active.set(reserved.record.paymentId, work);
    try { return await work; } finally { this.#active.delete(reserved.record.paymentId); }
  }

  async #submit(scope, record) {
    try {
      const result = backendResult(await this.#backend.requestPayment({
        scope, request: record.request, fingerprint: record.fingerprint, paymentId: record.paymentId,
      }), scope, record.paymentId);
      const { paymentId, ...patch } = result;
      return receipt(await this.#journal.update(scope, paymentId, patch));
    } catch {
      // Even a thrown request may already have reached the network. Never mark rejected or retry submission.
      return receipt(await this.#journal.update(scope, record.paymentId, { status: 'unresolved' }));
    }
  }

  async #reconcile(scope, record) {
    if (FINAL.has(record.status)) return receipt(backendResult(record, scope, record.paymentId));
    const active = this.#active.get(record.paymentId);
    if (active) return active;
    try {
      const result = backendResult(await this.#backend.reconcilePayment({
        scope, paymentId: record.paymentId, request: record.request,
        fingerprint: record.fingerprint, transactionId: record.transactionId,
      }), scope, record.paymentId);
      const { paymentId, ...patch } = result;
      return receipt(await this.#journal.update(scope, paymentId, patch));
    } catch {
      const unresolved = { status: 'unresolved', ...(record.transactionId ? { transactionId: record.transactionId } : {}) };
      return receipt(await this.#journal.update(scope, record.paymentId, unresolved));
    }
  }
}
