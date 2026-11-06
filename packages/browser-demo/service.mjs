import { Buffer } from 'buffer';
import { createHash, isDeepStrictEqual } from './crypto.mjs';
import { createUnprovenDeployTx, createUnprovenCallTxFromInitialStates, getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { Transaction, Intent, rawTokenType, createShieldedCoinInfo } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { encodeRawTokenType, encodeShieldedCoinInfo, encodeCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { ZKConfigProvider, createProverKey, createVerifierKey, createZKIR } from '@midnight-ntwrk/midnight-js-types';
import { parseCoinPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import * as vaultModule from '../../contracts/managed/private-vault/contract/index.js';
import * as tokenModule from '../../contracts/managed/test-token/contract/index.js';
import { witnesses, emptySpendingState } from '../../contracts/witnesses.mjs';
import { createDisableMaintenanceUpdate } from '../../services/runner/disable-maintenance.mjs';
import { verifyPreviewNetwork } from '../../services/runner/test-network-config.mjs';
import { createRunnerState, PaymentRunner } from '../../services/runner/payment-runner.mjs';
import { createMidnightSdkAdapter } from '../../services/runner/midnight-sdk-adapter.mjs';
import { PaymentGateway } from '../../services/mcp/gateway.mjs';
import { publicError, receipt, settlementEvidence, requestFingerprint, scopeKey, WalletError } from '../protocol/index.mjs';
import { bounded, chainTime, qualifyCoin, verifyCoinMembership } from '../../services/demo/network.mjs';
import { createKeyMaterialProvider } from '../browser-prover/materials.mjs';
import { BrowserRunnerStore, BrowserRequestJournal } from './stores.mjs';
import { createMerchantReceiptVerifier } from './receipt-verifier.mjs';

export const PREVIEW = Object.freeze({ networkId: 'preview', node: 'https://rpc.preview.midnight.network', nodeWS: 'wss://rpc.preview.midnight.network',
  indexer: 'https://indexer.preview.midnight.network/api/v4/graphql', indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  faucet: 'https://midnight-tmnight-preview.nethermind.dev/', explorer: 'https://preview.midnightexplorer.com/' });
export function createInitialState({ accountId }) {
  if (typeof accountId !== 'string' || !accountId || accountId.length > 256) throw new Error('A connected Lace account is required');
  return { version: 1, network: 'preview', accountId, ownerSecret: crypto.getRandomValues(new Uint8Array(32)), agentSecret: crypto.getRandomValues(new Uint8Array(32)),
    vaultId: crypto.getRandomValues(new Uint8Array(32)), merchantSeed: crypto.getRandomValues(new Uint8Array(32)), setup: {}, transactions: [],
    uncertain: null, runner: null, runnerContext: null, journal: { version: 1, records: [] }, merchantSnapshot: null };
}
class BrowserZkConfigProvider extends ZKConfigProvider {
  constructor(material) { super(); this.material = material; }
  async getProverKey(key) { const value = await this.material.lookupKey(key); if (!value) throw new Error('Missing circuit'); return createProverKey(value.proverKey); }
  async getVerifierKey(key) { const value = await this.material.lookupKey(key); if (!value) throw new Error('Missing circuit'); return createVerifierKey(value.verifierKey); }
  async getZKIR(key) { const value = await this.material.lookupKey(key); if (!value) throw new Error('Missing circuit'); return createZKIR(value.ir); }
}
const random32 = () => crypto.getRandomValues(new Uint8Array(32));
const hex = (value) => Buffer.from(value).toString('hex');
const unhex = (value) => new Uint8Array(Buffer.from(value, 'hex'));
const pad = (value) => { const result = new Uint8Array(32); result.set(new TextEncoder().encode(value)); return result; };
const equal = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const identityId = accountId => createHash('sha256').update('preview:' + accountId).digest('hex');
function assertStoreBinding(store, accountId) {
  if (store.context?.network !== 'preview' || store.context?.identityId !== identityId(accountId)) throw new Error('Encrypted browser store belongs to another Lace account');
}
const recipient = (wallet) => ({ bytes: encodeCoinPublicKey(wallet.getCoinPublicKey()) });
const encryptionKeys = (wallet) => new Map([[wallet.getCoinPublicKey(), wallet.getEncryptionPublicKey()]]);
export const DEMO_AMOUNTS = Object.freeze({ funded: 100000000700n, allowance: 70000000490n, perPayment: 50000000350n });
const envelope = (privateState, ledger) => ({ privateState, stateCommitment: ledger.stateCommitment, policyCommitment: ledger.policyCommitment,
  version: ledger.version, paused: ledger.paused, revoked: ledger.revoked });

/** Historical verified payments only, never a claim about the merchant's wallet
 * balance. Legacy receipts are counted only when their preserved request,
 * fingerprint, scope and evidence agree with the confirmed cumulative spend. */
export function merchantReceiptTotals(saved) {
  const unknown = { verifiedReceivedAtomic: null, verifiedPaymentCount: 0, receiptHistoryComplete: false };
  try {
    const payments = saved.runner?.payments ?? [];
    const spent = saved.runner?.confirmed?.privateState?.state?.spent
      ?? saved.setup.confirmedEnvelope?.privateState?.state?.spent ?? saved.setup.vaultPrivate?.state?.spent ?? 0n;
    if (!Array.isArray(payments) || typeof spent !== 'bigint' || spent < 0n || spent > (1n << 64n) - 1n) return unknown;
    const scope = { subject: 'demo-owner', network: 'preview', contractAddress: saved.setup.vaultAddress, vaultRef: 'demo-vault', agentRef: 'demo-agent' };
    let total = 0n, count = 0; const ids = new Set(); const transactions = new Set();
    for (const record of payments.filter(item => item.status === 'finalized')) {
      if (record.scope !== scopeKey(scope) || ids.has(record.paymentId) || transactions.has(record.transactionId)) return unknown;
      const matches = saved.journal.records.filter(item => item.paymentId === record.paymentId && item.scope === record.scope);
      if (matches.length !== 1) return unknown;
      const journal = matches[0]; const request = journal.request;
      if (journal.idempotencyKey !== record.idempotencyKey || journal.fingerprint !== record.fingerprint
        || requestFingerprint(request) !== record.fingerprint || request.recipientRef !== 'demo-merchant'
        || request.vaultRef !== 'demo-vault' || request.tokenId !== saved.setup.tokenColor) return unknown;
      const checked = receipt(record); settlementEvidence(record.settlementEvidence, scope, checked.transactionId);
      ids.add(record.paymentId); transactions.add(record.transactionId); total += BigInt(request.amount); count++;
    }
    if (total !== spent) return unknown;
    return { verifiedReceivedAtomic: total.toString(), verifiedPaymentCount: count, receiptHistoryComplete: true };
  } catch { return unknown; }
}

export function paymentReceiptExpectation(pending, confirmed, tokenId) {
  const previous = confirmed?.privateState?.state?.spent;
  const next = pending?.candidate?.privateState?.state?.spent;
  const amount = pending?.request?.amount;
  if (pending?.request?.tokenId !== tokenId || pending.request.recipientRef !== 'demo-merchant'
    || typeof amount !== 'string' || !/^[1-9][0-9]{0,19}$/.test(amount)
    || typeof previous !== 'bigint' || typeof next !== 'bigint' || previous < 0n || next > (1n << 64n) - 1n
    || BigInt(amount) > (1n << 64n) - 1n || next - previous !== BigInt(amount)) {
    throw new Error('Pending recipient amount differs from captured private candidate');
  }
  return BigInt(amount);
}

/** Checkpoint one new administrative execution before proving and before send.
 * The callback may only prove/balance; it must never submit. A rejection from
 * that live callback proves this execution has not crossed the send boundary.
 * Restored records and every error after a signed result remain unresolved. */
export async function checkpointAdministrativeTransaction({ store, kind, data, proveAndBalance }) {
  const prepared = structuredClone({ executionId: crypto.randomUUID(), kind, phase: 'prepared', candidate: data.candidate,
    unproven: data.unproven?.serialize() ?? null, signed: data.signed?.serialize() ?? null, transactionIds: [] });
  await store.update(state => {
    if (state.uncertain || state.runner?.pending) throw new WalletError('REQUEST_UNRESOLVED');
    state.uncertain = structuredClone(prepared);
  }); // A failed/ambiguous storage commit must never enter the cancellation path.
  let signed = data.signed;
  if (!signed) {
    try { signed = await proveAndBalance(data.unproven); }
    catch (error) {
      // Only this invocation owns this exact unsigned checkpoint. Do not clear
      // a replacement, concurrent payment, restored checkpoint, or signed state.
      await store.update(state => {
        if (state.runner?.pending || !isDeepStrictEqual(state.uncertain, prepared)) throw new WalletError('REQUEST_UNRESOLVED');
        state.uncertain = null;
      }); // Completion, not a callback/request success, establishes durable clear.
      throw error;
    }
  }
  const ids = signed.identifiers();
  await store.update(state => {
    if (state.runner?.pending || !isDeepStrictEqual(state.uncertain, prepared)) throw new WalletError('REQUEST_UNRESOLVED');
    state.uncertain = { ...structuredClone(prepared), signed: signed.serialize(), transactionIds: ids, phase: 'submitting' };
  });
  return { signed, ids };
}
function compiled(name, module, supplied, assetBase) {
  return CompiledContract.make(name, module.Contract).pipe(CompiledContract.withWitnesses(supplied ?? {}),
    CompiledContract.withCompiledFileAssets(new URL(name + '/', assetBase).href));
}

export class BrowserDemoService {
  #vault; #network = PREVIEW; #owner; #merchant; #public; #providers; #compiled; #connection; #prover; #onStage; #ownerStatus; #closed = false; #closing = false; #closePromise; #active;
  #runnerStore; #runner; #gateway; #journal; #scope; #job = null; #error = null; #phase = 'wallet-not-started'; #funding; #proofs = 0; #setupComplete = false;
  static async create({ connection, store, prover, assetBase, assetHashes = {}, onStage = () => {} }) {
    if (!connection?.assertSession || !connection?.getShieldedBalance || !prover?.proveTx || !store?.update) throw new Error('Complete browser providers required');
    await connection.assertSession();
    assertStoreBinding(store, connection.context.accountId);
    const initial = store.snapshot();
    if (initial.accountId !== connection.context.accountId || initial.network !== 'preview') throw new Error('Browser identity belongs to another Lace account');
    const base = new URL(assetBase, location.href); if (base.origin !== location.origin || base.search || base.hash) throw new Error('Same-origin contract assets required');
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const demo = new BrowserDemoService(); demo.#vault = store; demo.#connection = connection; demo.#prover = prover; demo.#onStage = onStage;
    demo.#owner = { ...connection.walletProvider, getCoinPublicKey: () => connection.context.coinPublicKeyHex,
      getEncryptionPublicKey: () => connection.context.encryptionPublicKeyHex,
      submitTx: tx => connection.midnightProvider.submitTx(tx) };
    demo.#funding = connection.context.unshieldedAddress;
    demo.#compiled = { vault: compiled('private-vault', vaultModule, witnesses, base), token: compiled('test-token', tokenModule, {}, base) };
    setNetworkId('preview');
    demo.#public = indexerPublicDataProvider(PREVIEW.indexer, PREVIEW.indexerWS, globalThis.WebSocket);
    demo.#providers = {};
    const material = createKeyMaterialProvider({ pageUrl: location.href, hashes: assetHashes,
      builtinBase: new URL('../browser-builtins/', base).href,
      contracts: { 'private-vault': new URL('private-vault/', base).href, 'test-token': new URL('test-token/', base).href } });
    for (const key of ['vault', 'token']) demo.#providers[key] = { zkConfigProvider: new BrowserZkConfigProvider(material),
      publicDataProvider: demo.#public, walletProvider: connection.walletProvider, midnightProvider: connection.midnightProvider,
      proofProvider: { proveTx: async tx => { await demo.#assertSession(true); demo.#stage('proving-in-browser'); const proven = await prover.proveTx(tx); demo.#proofs++; return proven; } } };
    return demo;
  }
  async #assertSession(transact = false) {
    if (this.#closed) throw new Error('Browser service closed');
    await (transact ? this.#connection.assertInProcess() : this.#connection.assertSession());
    assertStoreBinding(this.#vault, this.#connection.context.accountId);
    if (this.#vault.snapshot().accountId !== this.#connection.context.accountId) throw new Error('Browser account changed');
  }
  async status() {
    await this.#assertSession();
    this.#ownerStatus = await this.#connection.getPublicStatus();
    const saved = this.#vault.snapshot();
    const wallet = { ...this.#ownerStatus, synced: this.#ownerStatus?.connected === true, nightAtomic: null };
    const current = this.#runnerStore?.snapshot() ?? saved.runner;
    const ps = current?.confirmed.privateState ?? saved.setup.vaultPrivate;
    const ledger = current?.confirmed;
    const busy = this.#job?.status === 'running';
    const blocked = !!saved.uncertain || !!current?.pending;
    const funded = !!saved.setup.funded;
    const ownerReady = this.#setupComplete && this.#runnerStore?.canSpend === true && funded && !blocked;
    const requiresVerification = this.#setupComplete && funded && this.#runnerStore?.canSpend === false;
    return { service: 'midnight-agent-wallet-demo', network: 'preview', phase: blocked ? 'unresolved' : this.#phase,
      keyProtection: 'browser-password-encrypted-indexeddb', proofProviderCompletions: this.#proofs,
      funding: { address: this.#funding, faucetUrl: this.#network.faucet, ...wallet, registered: BigInt(wallet.dustAtomic ?? '0') > 0n, feeSetup: 'Generate DUST in Lace' },
      vault: saved.setup.vaultAddress ? { address: saved.setup.vaultAddress, tokenId: saved.setup.tokenColor ?? null, immutable: saved.setup.immutable === true } : null,
      policy: { allowanceAtomic: DEMO_AMOUNTS.allowance.toString(), perPaymentAtomic: DEMO_AMOUNTS.perPayment.toString(),
        spentAtomic: (ps?.state.spent ?? 0n).toString(), balanceAtomic: (ps?.state.coin.value ?? 0n).toString(),
        paused: ledger?.paused ?? !funded, revoked: ledger?.revoked ?? false },
      merchant: { ready: this.#setupComplete && !!this.#merchant, verificationMode: 'finalized-output-decryption', ...merchantReceiptTotals(saved) },
      capabilities: { canSetup: !busy && !this.#setupComplete, canRegisterDust: false,
        canBootstrap: !busy && this.#setupComplete && !!this.#merchant && wallet.canTransact === true && BigInt(wallet.dustAtomic ?? '0') > 0n && !funded && !blocked,
        canPay: !busy && wallet.canTransact === true && this.#setupComplete && !!this.#merchant && !!this.#runner?.canSubmit && !!ps?.state.hasCoin && !ledger?.paused && !ledger?.revoked && !blocked,
        canPause: !busy && wallet.canTransact === true && ownerReady && !ledger?.revoked, canRevoke: !busy && wallet.canTransact === true && ownerReady && !ledger?.revoked,
        canWithdraw: !busy && wallet.canTransact === true && ownerReady && !!ps?.state.hasCoin,
        canReconcile: !busy && this.#setupComplete && (blocked || requiresVerification) && !!this.#owner },
      activeJob: this.#job ? { ...this.#job } : null,
      activity: saved.transactions.map((tx) => ({ ...tx })), latestPayment: this.#latestPayment(), lastError: this.#error,
      explorerUrl: this.#network.explorer };
  }
  startJob(action, task) {
    if (this.#closing || this.#closed || this.#job?.status === 'running') throw new WalletError('PAYMENT_UNAVAILABLE');
    const job = { id: crypto.randomUUID(), action, status: 'running', stage: 'starting' };
    this.#job = job; this.#error = null;
    this.#active = Promise.resolve().then(() => this.#assertSession()).then(task).then((result) => { job.status = 'complete'; job.stage = 'complete'; if (result) job.result = result; })
      .catch((error) => { const failedStage = job.stage; job.status = 'failed'; job.stage = 'needs-attention'; this.#error = error instanceof WalletError ? publicError(error) :
        { code: 'DEMO_ACTION_INCOMPLETE', stage: failedStage, errorType: ['Error', 'TypeError', 'RangeError', 'TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'SDK_ERROR',
          message: 'The action did not complete. Check wallet funding, browser proving, Lace and the recovery status before retrying.' }; });
    return { ...job };
  }
  #stage(value) { if (this.#job) this.#job.stage = value; try { this.#onStage(value); } catch {} }
  async setup() {
    await this.#assertSession(); if (this.#setupComplete) return;
    if (!this.#merchant) {
      this.#stage('checking-preview-network'); await verifyPreviewNetwork(this.#network);
      const saved = this.#vault.snapshot();
      this.#stage('preparing-recipient-verification');
      this.#merchant = createMerchantReceiptVerifier({ seed: saved.merchantSeed, network: this.#network.networkId });
      // Keep legacy merchantSnapshot untouched inside the encrypted root. It is
      // not replayed, converted to a fabricated cursor, or replaced by a seed.
    }
    if (this.#vault.snapshot().setup.funded) await this.#openRunner();
    this.#setupComplete = true; this.#phase = this.#runner ? 'ready' : 'recipient-ready';
  }
  async #ownerBalance(color) { await this.#assertSession(); return this.#connection.getShieldedBalance(color); }
  async #waitOwnerBalance(color, expected, ms = 180_000) {
    const end = Date.now() + ms;
    do { if (await this.#ownerBalance(color) === expected) return; await new Promise(resolve => setTimeout(resolve, 1500)); } while (Date.now() < end);
    throw new Error('Lace owner receipt not independently observed');
  }
  async #watch(id) { return bounded(this.#public.watchForTxData(id), 180_000); }
  async #execute(kind, prepared, provider = this.#providers.vault) {
    await this.#assertSession(true); this.#runnerStore?.invalidate();
    if (this.#vault.snapshot().uncertain) throw new WalletError('REQUEST_UNRESOLVED');
    this.#stage(`preparing-${kind}`);
    const data = await prepared();
    await this.#assertSession(true);
    const { signed, ids } = await checkpointAdministrativeTransaction({ store: this.#vault, kind, data,
      proveAndBalance: async unproven => this.#owner.balanceTx(await provider.proofProvider.proveTx(unproven, { timeout: 180_000 })) });
    this.#stage('submitting-to-preview');
    await this.#assertSession(true);
    const id = await bounded(this.#owner.submitTx(signed), 60_000);
    if (!ids.includes(id)) throw new Error('Unexpected submitted transaction identifier');
    await this.#vault.update((state) => { state.uncertain.transactionId = id; state.uncertain.phase = 'submitted'; });
    this.#stage('waiting-for-finality');
    const finalized = await this.#watch(id); await this.#applyAdmin(finalized); return finalized;
  }
  async #applyAdmin(tx) {
    if (tx.status !== 'SucceedEntirely') throw new Error('Transaction did not succeed entirely');
    const pending = this.#vault.snapshot().uncertain;
    if (!pending || !pending.transactionIds.includes(tx.txId)) throw new Error('Unmatched recovery transaction');
    const candidate = pending.candidate;
    if (pending.kind === 'fund' && candidate.privateState?.state?.hasCoin) {
      candidate.privateState.coinIndex = await qualifyCoin(this.#network, tx, candidate.privateState.state.coin, candidate.address);
    }
    let ledger;
    if (candidate.expected) {
      const current = await this.#public.queryZSwapAndContractState(candidate.address);
      ledger = vaultModule.ledger(current[1].data);
      if (!this.#matches(candidate.expected, ledger)) throw new Error('Finalized vault differs from generated candidate');
      if (candidate.privateState.state.hasCoin && !verifyCoinMembership(current[0], candidate.privateState.state.coin,
        candidate.privateState.coinIndex, candidate.address)) throw new Error('Vault coin cannot be independently verified');
    }
    if (pending.kind === 'disable-maintenance') {
      const state = await this.#public.queryContractState(candidate.address);
      if (state.maintenanceAuthority.committee.length !== 0 || state.maintenanceAuthority.threshold !== 1) throw new Error('Vault maintenance remains enabled');
    }
    if (pending.kind === 'mint' || pending.kind === 'owner-withdraw') {
      const saved = this.#vault.snapshot();
      this.#stage('verifying-owner-receipt');
      if (typeof candidate.ownerExpectedBalance !== 'bigint') throw new Error('Missing owner receipt baseline');
      await this.#waitOwnerBalance(saved.setup.tokenColor, candidate.ownerExpectedBalance);
    }
    this.#runnerStore?.invalidate();
    await this.#vault.update((state) => {
      if (pending.kind === 'deploy-token') { state.setup.tokenAddress = candidate.address; state.setup.tokenSigningKey = candidate.signingKey;
        state.setup.tokenColor = rawTokenType(pad('agent-vault:test-token:v1'), candidate.address); }
      else if (pending.kind === 'mint') { state.setup.minted = true; state.setup.ownerMintBaseline = candidate.ownerBaseline; }
      else if (pending.kind === 'deploy-vault') { state.setup.vaultAddress = candidate.address; state.setup.vaultSigningKey = candidate.signingKey; state.setup.vaultPrivate = candidate.privateState; }
      else if (pending.kind === 'disable-maintenance') { state.setup.immutable = true; delete state.setup.vaultSigningKey; }
      else if (pending.kind === 'initialize-policy') { state.setup.initialized = true; state.setup.vaultPrivate = candidate.privateState; }
      else if (pending.kind === 'fund') { state.setup.funded = true; state.setup.vaultPrivate = candidate.privateState;
        state.setup.confirmedEnvelope = envelope(candidate.privateState, ledger); }
      else if (pending.kind.startsWith('owner-')) { state.setup.vaultPrivate = candidate.privateState;
        state.setup.confirmedEnvelope = envelope(candidate.privateState, ledger); }
      if (pending.kind.startsWith('owner-') && state.runner) state.runner.confirmed = envelope({ ...candidate.privateState, ownerSecret: new Uint8Array(32), agentSecret: state.agentSecret }, ledger);
      if (!state.transactions.some((record) => record.transactionId === tx.txId)) state.transactions.push({ id: crypto.randomUUID(), action: pending.kind,
        status: 'finalized', transactionId: tx.txId, blockHash: tx.blockHash, blockHeight: Number(tx.blockHeight) });
      state.uncertain = null;
    });
    if (pending.kind.startsWith('owner-') && this.#runner) await this.#runner.initialize();
  }
  async #prepareCall(contract, address, circuitId, args, privateState, mappings) {
    const provider = this.#providers[contract]; const chain = await getPublicStates(this.#public, address);
    const call = await createUnprovenCallTxFromInitialStates(provider.zkConfigProvider, { compiledContract: this.#compiled[contract], contractAddress: address,
      circuitId, args, coinPublicKey: parseCoinPublicKeyToHex(this.#owner.getCoinPublicKey(), 'preview'), initialContractState: chain.contractState,
      initialZswapChainState: chain.zswapChainState, ledgerParameters: chain.ledgerParameters, initialPrivateState: privateState,
      additionalCoinEncPublicKeyMappings: mappings }, this.#owner.getEncryptionPublicKey());
    return { unproven: call.private.unprovenTx, candidate: { address, privateState: call.private.nextPrivateState,
      ...(contract === 'vault' ? { expected: envelope(null, vaultModule.ledger(call.public.nextContractState)) } : {}) } };
  }
  async bootstrap() {
    await this.#assertSession(true);
    const owner = await this.#connection.getPublicStatus();
    if (!this.#setupComplete || !this.#merchant || BigInt(owner.dustAtomic) <= 0n) throw new WalletError('PAYMENT_UNAVAILABLE');
    await verifyPreviewNetwork(this.#network);
    let saved = this.#vault.snapshot();
    if (!saved.setup.tokenAddress) await this.#execute('deploy-token', async () => {
      const tx = await createUnprovenDeployTx(this.#providers.token, { compiledContract: this.#compiled.token, initialPrivateState: {} });
      return { unproven: tx.private.unprovenTx, candidate: { address: tx.public.contractAddress, signingKey: tx.private.signingKey, privateState: tx.private.initialPrivateState } };
    }, this.#providers.token);
    saved = this.#vault.snapshot();
    if (!saved.setup.minted) await this.#execute('mint', async () => {
      const baseline = await this.#ownerBalance(saved.setup.tokenColor);
      const prepared = await this.#prepareCall('token', saved.setup.tokenAddress, 'mint', [recipient(this.#owner), DEMO_AMOUNTS.funded, random32()], {}, encryptionKeys(this.#owner));
      prepared.candidate.ownerBaseline = baseline; prepared.candidate.ownerExpectedBalance = baseline + DEMO_AMOUNTS.funded; return prepared;
    }, this.#providers.token);
    saved = this.#vault.snapshot();
    if (!saved.setup.vaultAddress) await this.#execute('deploy-vault', async () => {
      const now = await chainTime(this.#network);
      const policy = { agentKey: vaultModule.pureCircuits.authorityKey(pad('agent-vault:agent:v1'), pad('preview'), saved.vaultId, saved.agentSecret),
        asset: encodeRawTokenType(saved.setup.tokenColor), recipients: [recipient(this.#merchant).bytes, new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)],
        perPayment: DEMO_AMOUNTS.perPayment, allowance: DEMO_AMOUNTS.allowance, expiresAt: BigInt(now + 86400) };
      const ps = { ownerSecret: saved.ownerSecret, agentSecret: saved.agentSecret, policy, policySalt: random32(), state: emptySpendingState(),
        stateSalt: random32(), nextStateSalt: random32(), coinIndex: null };
      const tx = await createUnprovenDeployTx(this.#providers.vault, { compiledContract: this.#compiled.vault, initialPrivateState: ps, args: [pad('preview'), saved.vaultId] });
      return { unproven: tx.private.unprovenTx, candidate: { address: tx.public.contractAddress, signingKey: tx.private.signingKey, privateState: tx.private.initialPrivateState } };
    });
    saved = this.#vault.snapshot();
    if (!saved.setup.immutable) await this.#execute('disable-maintenance', async () => {
      const chain = await this.#public.queryContractState(saved.setup.vaultAddress);
      if (vaultModule.ledger(chain.data).funded) throw new Error('Maintenance can only be disabled before funding');
      const update = createDisableMaintenanceUpdate(saved.setup.vaultAddress, chain.maintenanceAuthority, saved.setup.vaultSigningKey);
      return { unproven: Transaction.fromParts('preview', undefined, undefined, Intent.new(new Date(Date.now() + 3_600_000)).addMaintenanceUpdate(update)),
        candidate: { address: saved.setup.vaultAddress } };
    });
    saved = this.#vault.snapshot();
    if (!saved.setup.initialized) await this.#execute('initialize-policy', () => this.#prepareCall('vault', saved.setup.vaultAddress, 'initializePolicy', [], saved.setup.vaultPrivate));
    saved = this.#vault.snapshot();
    if (!saved.setup.funded) await this.#execute('fund', () => this.#prepareCall('vault', saved.setup.vaultAddress, 'fund',
      [encodeShieldedCoinInfo(createShieldedCoinInfo(saved.setup.tokenColor, DEMO_AMOUNTS.funded))], { ...saved.setup.vaultPrivate, nextStateSalt: random32() }));
    await this.#openRunner(); this.#phase = 'ready';
    return { vaultAddress: this.#vault.snapshot().setup.vaultAddress };
  }
  #matches(expected, ledger) {
    return equal(expected.stateCommitment, ledger.stateCommitment) && equal(expected.policyCommitment, ledger.policyCommitment)
      && expected.version === ledger.version && expected.paused === ledger.paused && expected.revoked === ledger.revoked;
  }
  #latestPayment() {
    const records = this.#runnerStore?.snapshot().payments;
    const last = records?.at(-1);
    return last ? this.#publicPayment(last) : null;
  }
  #publicPayment(record) {
    const result = receipt(record);
    return result.status === 'finalized' ? { ...result,
      settlementEvidence: settlementEvidence(record.settlementEvidence, this.#scope, result.transactionId) } : result;
  }
  async #openRunner() {
    const saved = this.#vault.snapshot(); const address = saved.setup.vaultAddress;
    if (!saved.setup.funded || !address) throw new WalletError('PAYMENT_UNAVAILABLE');
    this.#scope = { subject: 'demo-owner', network: 'preview', contractAddress: address,
      vaultRef: 'demo-vault', agentRef: 'demo-agent', expiresAt: Number.MAX_SAFE_INTEGER };
    if (this.#runner) { if (!saved.uncertain?.kind.startsWith('owner-')) await this.#runner.initialize(); return; }
    if (!saved.setup.confirmedEnvelope) throw new Error('Missing native confirmed vault provenance');
    if (saved.setup.runnerInitialized && (!saved.runner || !saved.journal)) throw new Error('Missing payment recovery history');
    const initial = { ...saved.setup.confirmedEnvelope, privateState: { ...saved.setup.confirmedEnvelope.privateState,
      ownerSecret: new Uint8Array(32), agentSecret: saved.agentSecret } };
    this.#runnerStore = await BrowserRunnerStore.open(this.#vault, { context: { network: 'preview', contractAddress: address, vaultId: hex(saved.vaultId) },
      ...(saved.setup.runnerInitialized ? {} : { initialState: createRunnerState(initial) }) });
    let finalized;
    const adapter = createMidnightSdkAdapter({ providers: this.#providers.vault, compiledContract: this.#compiled.vault, networkId: 'preview',
      transactionTtl: () => new Date(Date.now() + 3_600_000),
      buildPaymentCall: async (input) => {
        await this.#assertSession(true);
        if (input.request.recipientRef !== 'demo-merchant' || input.request.tokenId !== saved.setup.tokenColor) throw new WalletError('INVALID_REQUEST');
        const now = await chainTime(this.#network); const ledger = vaultModule.ledger(input.chain.contractState.data);
        await this.#assertSession(true);
        const requestId = new Uint8Array(createHash('sha256').update(`preview:${address}:${input.paymentId}:${input.fingerprint}`).digest());
        const request = { network: pad('preview'), vault: saved.vaultId, deployedContract: unhex(address), expectedVersion: ledger.version,
          requestId, validFrom: BigInt(Math.max(0, now - 60)), validUntil: BigInt(now + 3600),
          asset: input.confirmed.privateState.policy.asset, recipient: recipient(this.#merchant).bytes, amount: BigInt(input.request.amount) };
        return { args: [request], privateState: { ...input.confirmed.privateState, nextStateSalt: random32() },
          additionalCoinEncPublicKeyMappings: encryptionKeys(this.#merchant) };
      },
      captureCandidate: ({ prepared }) => envelope(prepared.private.nextPrivateState, vaultModule.ledger(prepared.public.nextContractState)),
      verifyConfirmed: async ({ confirmed }) => {
        const current = await this.#public.queryZSwapAndContractState(address);
        if (!current || !this.#matches(confirmed, vaultModule.ledger(current[1].data))
          || current[1].maintenanceAuthority.committee.length !== 0 || current[1].maintenanceAuthority.threshold !== 1) return false;
        const ps = confirmed.privateState;
        return !ps.state.hasCoin || verifyCoinMembership(current[0], ps.state.coin, ps.coinIndex, address);
      },
      observeTransaction: async ({ pending, confirmed }) => {
        if (!pending.transactionId) return { outcome: 'unresolved' };
        finalized = await this.#watch(pending.transactionId);
        if (finalized.status !== 'SucceedEntirely' || !pending.transactionIds.includes(finalized.txId)) return { outcome: 'unresolved' };
        const ps = pending.candidate.privateState;
        this.#stage('verifying-recipient-output');
        const amount = paymentReceiptExpectation(pending, confirmed, saved.setup.tokenColor);
        const merchantReceipt = await this.#merchant.verifyReceipt({ finalized, expectedAsset: saved.setup.tokenColor, expectedAmount: amount,
          contractAddress: address, expectedTransactionIds: pending.transactionIds });
        if (merchantReceipt?.recipientReceiptVerified !== true || merchantReceipt.transactionId !== finalized.txId
          || merchantReceipt.blockHash !== finalized.blockHash || merchantReceipt.tokenId !== saved.setup.tokenColor
          || merchantReceipt.amountAtomic !== amount.toString()) throw new Error('Missing exact decrypted recipient receipt');
        if (ps.state.coin.value !== DEMO_AMOUNTS.funded - ps.state.spent) throw new Error('Unexpected vault change');
        const coinIndex = ps.state.hasCoin ? await qualifyCoin(this.#network, finalized, ps.state.coin, address) : null;
        return { outcome: 'finalized', transactionId: finalized.txId, confirmed: { ...pending.candidate, privateState: { ...ps, coinIndex } },
          settlementEvidence: { network: 'preview', contractAddress: address, transactionId: finalized.txId, finalizedBlockHash: finalized.blockHash,
            recipientReceiptVerified: true, vaultChangeVerified: true } };
      },
      verifyCoinQualification: async ({ candidate, confirmed, transactionId }) => {
        if (!finalized || finalized.txId !== transactionId) return false;
        if (!candidate.privateState.state.hasCoin) return confirmed.privateState.coinIndex === null;
        const index = await qualifyCoin(this.#network, finalized, candidate.privateState.state.coin, address);
        return index === confirmed.privateState.coinIndex;
      },
    });
    this.#runner = new PaymentRunner({ store: this.#runnerStore, adapter, scope: this.#scope, vaultId: hex(saved.vaultId) });
    this.#journal = new BrowserRequestJournal(this.#vault);
    this.#gateway = new PaymentGateway({ authenticate: async () => { await this.#assertSession(); return this.#scope; }, backend: this.#runner, journal: this.#journal });
    if (!saved.uncertain?.kind.startsWith('owner-')) await this.#runner.initialize();
    await this.#vault.update((state) => { state.setup.runnerInitialized = true; });
  }
  async requestPayment({ amount, idempotencyKey }) {
    await this.#assertSession(true);
    if (!this.#gateway || this.#vault.snapshot().uncertain) throw new WalletError('PAYMENT_UNAVAILABLE');
    this.#stage('requesting-agent-payment');
    const saved = this.#vault.snapshot();
    const result = await this.#gateway.call('request_payment', { vaultRef: 'demo-vault', recipientRef: 'demo-merchant', tokenId: saved.setup.tokenColor,
      amount, idempotencyKey }, 'local-owner-interface');
    await this.#recordPayment(result.paymentId);
    return this.getPayment(result.paymentId);
  }
  getPayment(paymentId) {
    const record = this.#runnerStore?.snapshot().payments.find((entry) => entry.paymentId === paymentId);
    if (!record) throw new WalletError('NOT_FOUND');
    return this.#publicPayment(record);
  }
  async #recordPayment(paymentId) {
    const record = this.getPayment(paymentId);
    await this.#vault.update((state) => {
      const existing = state.transactions.findIndex((entry) => entry.id === paymentId);
      const publicRecord = { id: paymentId, action: 'agent-payment', status: record.status, ...(record.transactionId ? { transactionId: record.transactionId } : {}) };
      if (record.settlementEvidence) publicRecord.blockHash = record.settlementEvidence.finalizedBlockHash;
      if (existing < 0) state.transactions.push(publicRecord); else state.transactions[existing] = publicRecord;
    });
  }
  async owner(action, body = {}) {
    await this.#assertSession(true);
    if (!this.#runnerStore || this.#runnerStore.snapshot().pending || this.#vault.snapshot().uncertain) throw new WalletError('PAYMENT_UNAVAILABLE');
    const saved = this.#vault.snapshot(); const privateState = { ...this.#runnerStore.snapshot().confirmed.privateState,
      ownerSecret: saved.ownerSecret, agentSecret: new Uint8Array(32), nextStateSalt: random32() };
    const definitions = { pause: ['setPaused', [body.paused]], revoke: ['revoke', []], withdraw: ['withdraw', [recipient(this.#owner).bytes]] };
    const selected = definitions[action]; if (!selected || (action === 'pause' && typeof body.paused !== 'boolean')) throw new WalletError('INVALID_REQUEST');
    const tx = await this.#execute(`owner-${action}`, async () => {
      const baseline = action === 'withdraw' ? await this.#ownerBalance(saved.setup.tokenColor) : null;
      const prepared = await this.#prepareCall('vault', saved.setup.vaultAddress, selected[0], selected[1], privateState, action === 'withdraw' ? encryptionKeys(this.#owner) : undefined);
      if (action === 'withdraw') { prepared.candidate.ownerBaseline = baseline; prepared.candidate.ownerExpectedBalance = baseline + privateState.state.coin.value; }
      return prepared;
    });
    return { status: 'finalized', transactionId: tx.txId };
  }
  async reconcile() {
    await this.#assertSession();
    if (!this.#setupComplete) throw new WalletError('PAYMENT_UNAVAILABLE');
    const saved = this.#vault.snapshot();
    if (saved.setup.funded && !this.#runner) await this.#openRunner();
    if (saved.uncertain) {
      const id = saved.uncertain.transactionId ?? saved.uncertain.transactionIds[0];
      if (!id) throw new WalletError('REQUEST_UNRESOLVED');
      this.#stage('reconciling-finality'); await this.#applyAdmin(await this.#watch(id));
    }
    if (this.#vault.snapshot().setup.funded) await this.#openRunner();
    const pending = this.#runnerStore?.snapshot().pending;
    if (pending) {
      await this.#gateway.call('get_payment_status', { vaultRef: 'demo-vault', paymentId: pending.paymentId }, 'local-owner-interface');
      await this.#recordPayment(pending.paymentId); return this.getPayment(pending.paymentId);
    }
    return { recovered: true };
  }
  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      // Let an existing operation finish its durable checkpoint. Never erase an
      // uncertain outcome or cancel after a send merely because the UI locks.
      await this.#active;
      let failed = false;
      this.#closed = true;
      const results = await Promise.allSettled([this.#journal?.close(), this.#runnerStore?.close()]);
      failed ||= results.some(result => result.status === 'rejected');
      try { this.#merchant?.close(); } catch { failed = true; }
      try { this.#prover.close?.(); } catch { failed = true; }
      try { this.#connection.close(); } catch { failed = true; }
      try { await this.#vault.close(); } catch { failed = true; }
      if (failed) throw new Error('Browser cleanup incomplete; preserved recovery state must be reopened');
    })();
    return this.#closePromise;
  }
}
