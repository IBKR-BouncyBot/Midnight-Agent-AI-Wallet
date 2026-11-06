import path from 'node:path';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { createUnprovenDeployTx, createUnprovenCallTxFromInitialStates, getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { Transaction, Intent, rawTokenType, createShieldedCoinInfo } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { encodeRawTokenType, encodeShieldedCoinInfo, encodeCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { parseCoinPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import * as vaultModule from '../../contracts/managed/private-vault/contract/index.js';
import * as tokenModule from '../../contracts/managed/test-token/contract/index.js';
import { witnesses, emptySpendingState } from '../../contracts/witnesses.mjs';
import { createDisableMaintenanceUpdate } from '../runner/disable-maintenance.mjs';
import { getTestNetworkConfig, verifyPreviewNetwork } from '../runner/test-network-config.mjs';
import { PrivateStateStore } from '../runner/private-store.mjs';
import { createRunnerState, PaymentRunner } from '../runner/payment-runner.mjs';
import { createMidnightSdkAdapter } from '../runner/midnight-sdk-adapter.mjs';
import { PaymentGateway } from '../mcp/gateway.mjs';
import { EncryptedRequestJournal } from '../mcp/journal.mjs';
import { publicError, receipt, settlementEvidence, WalletError } from '../../packages/protocol/index.mjs';
import { initializeDemoIdentity, DEMO_ROOT } from './initialize.mjs';
import { createDemoWallet } from './wallet.mjs';
import { bounded, chainTime, graph, qualifyCoin, verifyCoinMembership, waitBalance } from './network.mjs';

globalThis.WebSocket = WebSocket;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const random32 = () => new Uint8Array(randomBytes(32));
const hex = (value) => Buffer.from(value).toString('hex');
const unhex = (value) => new Uint8Array(Buffer.from(value, 'hex'));
const pad = (value) => { const result = new Uint8Array(32); result.set(new TextEncoder().encode(value)); return result; };
const equal = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const recipient = (wallet) => ({ bytes: encodeCoinPublicKey(wallet.getCoinPublicKey()) });
const encryptionKeys = (wallet) => new Map([[wallet.getCoinPublicKey(), wallet.getEncryptionPublicKey()]]);
export const DEMO_AMOUNTS = Object.freeze({ funded: 100000000700n, allowance: 70000000490n, perPayment: 50000000350n });
const envelope = (privateState, ledger) => ({ privateState, stateCommitment: ledger.stateCommitment, policyCommitment: ledger.policyCommitment,
  version: ledger.version, paused: ledger.paused, revoked: ledger.revoked });
function compiled(name, module, supplied = {}) {
  return CompiledContract.make(name, module.Contract).pipe(CompiledContract.withWitnesses(supplied),
    CompiledContract.withCompiledFileAssets(path.join(ROOT, 'contracts', 'managed', name)));
}

export class DemoService {
  #vault; #directory; #network; #owner; #merchant; #public; #providers; #compiled;
  #runnerStore; #runner; #gateway; #journal; #scope; #job = null; #error = null; #phase = 'wallet-not-started'; #timer; #protection; #funding; #proofs = 0; #setupComplete = false;
  static async create({ directory = DEMO_ROOT, proofServer } = {}) {
    const identity = await initializeDemoIdentity(directory);
    const demo = new DemoService(); demo.#vault = identity.vault; demo.#directory = directory;
    demo.#network = getTestNetworkConfig('preview', { proofServer }); demo.#funding = identity.fundingAddress; demo.#protection = identity.protection;
    demo.#compiled = { vault: compiled('private-vault', vaultModule, witnesses), token: compiled('test-token', tokenModule) };
    return demo;
  }
  status() {
    const saved = this.#vault.snapshot();
    const wallet = this.#owner?.summary() ?? { synced: false, nightAtomic: '0', dustAtomic: '0', unregistered: 0 };
    const current = this.#runnerStore?.snapshot();
    const ps = current?.confirmed.privateState ?? saved.setup.vaultPrivate;
    const ledger = current?.confirmed;
    const busy = this.#job?.status === 'running';
    const blocked = !!saved.uncertain || !!current?.pending;
    const funded = !!saved.setup.funded;
    return { service: 'midnight-agent-wallet-demo', network: 'preview', phase: blocked ? 'unresolved' : this.#phase,
      keyProtection: this.#protection, proofProviderCompletions: this.#proofs,
      funding: { address: this.#funding, faucetUrl: this.#network.faucet, ...wallet, registered: wallet.unregistered === 0 && BigInt(wallet.nightAtomic) > 0n },
      vault: saved.setup.vaultAddress ? { address: saved.setup.vaultAddress, tokenId: saved.setup.tokenColor ?? null, immutable: saved.setup.immutable === true } : null,
      policy: { allowanceAtomic: DEMO_AMOUNTS.allowance.toString(), perPaymentAtomic: DEMO_AMOUNTS.perPayment.toString(),
        spentAtomic: (ps?.state.spent ?? 0n).toString(), balanceAtomic: (ps?.state.coin.value ?? 0n).toString(),
        paused: ledger?.paused ?? !funded, revoked: ledger?.revoked ?? false },
      merchant: { balanceAtomic: (this.#merchant?.current()?.shielded.balances[saved.setup.tokenColor] ?? 0n).toString(),
        synced: this.#merchant?.summary().synced ?? false, syncProgress: this.#merchant?.summary().syncProgress ?? null },
      capabilities: { canSetup: !busy && !this.#setupComplete, canRegisterDust: !busy && wallet.synced && wallet.unregistered > 0 && !blocked,
        canBootstrap: !busy && wallet.synced && BigInt(wallet.dustAtomic) > 0n && !funded && !blocked,
        canPay: !busy && !!this.#runner?.canSubmit && !!ps?.state.hasCoin && !ledger?.paused && !ledger?.revoked && !blocked,
        canPause: !busy && funded && !blocked && !ledger?.revoked, canRevoke: !busy && funded && !blocked && !ledger?.revoked,
        canWithdraw: !busy && funded && !!ps?.state.hasCoin && !blocked, canReconcile: !busy && blocked && !!this.#owner },
      activeJob: this.#job ? { ...this.#job } : null,
      activity: saved.transactions.map((tx) => ({ ...tx })), latestPayment: this.#latestPayment(), lastError: this.#error,
      explorerUrl: this.#network.explorer };
  }
  startJob(action, task) {
    if (this.#job?.status === 'running') throw new WalletError('PAYMENT_UNAVAILABLE');
    const job = { id: randomUUID(), action, status: 'running', stage: 'starting' };
    this.#job = job; this.#error = null;
    Promise.resolve().then(task).then((result) => { job.status = 'complete'; job.stage = 'complete'; if (result) job.result = result; })
      .catch((error) => { const failedStage = job.stage; job.status = 'failed'; job.stage = 'needs-attention'; this.#error = error instanceof WalletError ? publicError(error) :
        { code: 'DEMO_ACTION_INCOMPLETE', stage: failedStage, errorType: ['Error', 'TypeError', 'RangeError', 'TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'SDK_ERROR',
          message: 'The action did not complete. Check wallet funding, the local proof server and the recovery status before retrying.' }; });
    return { ...job };
  }
  #stage(value) { if (this.#job) this.#job.stage = value; }
  async setup() {
    if (this.#setupComplete) return;
    if (this.#owner && this.#merchant && this.#providers) {
      this.#stage('syncing-wallets');
      await Promise.all([this.#owner.waitSynced(), this.#merchant.waitSynced()]);
      await this.#saveWallets();
      if (this.#vault.snapshot().setup.funded) await this.#openRunner();
      this.#setupComplete = true; this.#phase = this.#runner ? 'ready' : 'awaiting-test-funds'; return;
    }
    if (this.#owner || this.#merchant) {
      await Promise.allSettled([this.#owner?.stop(), this.#merchant?.stop()]); this.#owner = undefined; this.#merchant = undefined;
    }
    this.#stage('checking-preview-network'); await verifyPreviewNetwork(this.#network); setNetworkId('preview');
    const saved = this.#vault.snapshot();
    this.#owner = await createDemoWallet(saved.ownerSeed, this.#network, saved.walletSnapshots?.owner);
    this.#merchant = await createDemoWallet(saved.merchantSeed, this.#network, saved.walletSnapshots?.merchant);
    this.#public = indexerPublicDataProvider(this.#network.indexer, this.#network.indexerWS);
    this.#providers = {};
    for (const [key, name] of [['vault', 'private-vault'], ['token', 'test-token']]) {
      const zkConfigProvider = new NodeZkConfigProvider(path.join(ROOT, 'contracts', 'managed', name));
      const actual = httpClientProofProvider(this.#network.proofServer, zkConfigProvider);
      this.#providers[key] = { zkConfigProvider, publicDataProvider: this.#public, walletProvider: this.#owner, midnightProvider: this.#owner,
        proofProvider: { proveTx: async (...args) => { this.#stage('generating-real-proof'); const proven = await actual.proveTx(...args); this.#proofs++; return proven; } } };
    }
    this.#phase = 'syncing'; this.#stage('syncing-wallets');
    await Promise.all([this.#owner.start(), this.#merchant.start()]);
    this.#timer = setInterval(() => this.#saveWallets().catch(() => {}), 30_000); this.#timer.unref();
    await Promise.all([this.#owner.waitSynced(), this.#merchant.waitSynced()]);
    await this.#saveWallets(); this.#phase = 'awaiting-test-funds';
    if (saved.setup.funded) { await this.#openRunner(); this.#phase = 'ready'; }
    this.#setupComplete = true;
  }
  async #saveWallets() {
    if (!this.#owner || !this.#merchant) return;
    const snapshots = { owner: await this.#owner.serialize(), merchant: await this.#merchant.serialize() };
    await this.#vault.update((state) => { state.walletSnapshots = snapshots; });
  }
  async #watch(id) { return bounded(this.#public.watchForTxData(id), 180_000); }
  async #execute(kind, prepared, provider = this.#providers.vault) {
    if (this.#vault.snapshot().uncertain) throw new WalletError('REQUEST_UNRESOLVED');
    this.#stage(`preparing-${kind}`);
    const data = await prepared();
    await this.#vault.update((state) => { state.uncertain = { kind, phase: 'prepared', candidate: data.candidate,
      unproven: data.unproven?.serialize() ?? null, signed: data.signed?.serialize() ?? null, transactionIds: [] }; });
    const signed = data.signed ?? await this.#owner.balanceTx(await provider.proofProvider.proveTx(data.unproven, { timeout: 180_000 }));
    const ids = signed.identifiers();
    await this.#vault.update((state) => { state.uncertain.signed = signed.serialize(); state.uncertain.transactionIds = ids; state.uncertain.phase = 'submitting'; });
    this.#stage('submitting-to-preview');
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
    if (pending.kind === 'owner-withdraw') {
      const saved = this.#vault.snapshot();
      this.#stage('verifying-owner-receipt');
      await waitBalance(this.#owner, saved.setup.tokenColor, DEMO_AMOUNTS.funded - candidate.privateState.state.spent);
    }
    // Keep the admin recovery record until BOTH encrypted stores are advanced.
    // Repeating this checkpoint after a crash is safe and never submits again.
    if (pending.kind.startsWith('owner-') && this.#runnerStore) {
      const saved = this.#vault.snapshot();
      const current = this.#runnerStore.snapshot();
      current.confirmed = envelope({ ...candidate.privateState, ownerSecret: new Uint8Array(32), agentSecret: saved.agentSecret }, ledger);
      await this.#runnerStore.checkpoint(current); await this.#runner.initialize();
    }
    await this.#vault.update((state) => {
      if (pending.kind === 'deploy-token') { state.setup.tokenAddress = candidate.address; state.setup.tokenSigningKey = candidate.signingKey;
        state.setup.tokenColor = rawTokenType(pad('agent-vault:test-token:v1'), candidate.address); }
      else if (pending.kind === 'mint') state.setup.minted = true;
      else if (pending.kind === 'deploy-vault') { state.setup.vaultAddress = candidate.address; state.setup.vaultSigningKey = candidate.signingKey; state.setup.vaultPrivate = candidate.privateState; }
      else if (pending.kind === 'disable-maintenance') { state.setup.immutable = true; delete state.setup.vaultSigningKey; }
      else if (pending.kind === 'initialize-policy') { state.setup.initialized = true; state.setup.vaultPrivate = candidate.privateState; }
      else if (pending.kind === 'fund') { state.setup.funded = true; state.setup.vaultPrivate = candidate.privateState;
        state.setup.confirmedEnvelope = envelope(candidate.privateState, ledger); }
      else if (pending.kind.startsWith('owner-')) { state.setup.vaultPrivate = candidate.privateState;
        state.setup.confirmedEnvelope = envelope(candidate.privateState, ledger); }
      if (!state.transactions.some((record) => record.transactionId === tx.txId)) state.transactions.push({ id: randomUUID(), action: pending.kind,
        status: 'finalized', transactionId: tx.txId, blockHash: tx.blockHash, blockHeight: Number(tx.blockHeight) });
      state.uncertain = null;
    });
    await this.#saveWallets();
  }
  async registerDust() {
    if (!this.#owner) throw new WalletError('PAYMENT_UNAVAILABLE');
    const signed = await this.#owner.registerDust();
    if (!signed) return { alreadyRegistered: true };
    await this.#execute('register-dust', async () => ({ signed, candidate: {} })); this.#phase = 'waiting-for-dust';
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
    if (!this.#owner || !this.#owner.summary().synced || BigInt(this.#owner.summary().dustAtomic) <= 0n) throw new WalletError('PAYMENT_UNAVAILABLE');
    await verifyPreviewNetwork(this.#network);
    let saved = this.#vault.snapshot();
    if (!saved.setup.tokenAddress) await this.#execute('deploy-token', async () => {
      const tx = await createUnprovenDeployTx(this.#providers.token, { compiledContract: this.#compiled.token, initialPrivateState: {} });
      return { unproven: tx.private.unprovenTx, candidate: { address: tx.public.contractAddress, signingKey: tx.private.signingKey, privateState: tx.private.initialPrivateState } };
    }, this.#providers.token);
    saved = this.#vault.snapshot();
    if (!saved.setup.minted) await this.#execute('mint', () => this.#prepareCall('token', saved.setup.tokenAddress, 'mint', [recipient(this.#owner), DEMO_AMOUNTS.funded, random32()], {}, encryptionKeys(this.#owner)), this.#providers.token);
    await waitBalance(this.#owner, saved.setup.tokenColor, saved.setup.funded ? 0n : DEMO_AMOUNTS.funded);
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
    const runnerFile = path.join(this.#directory, 'runner.enc');
    if (saved.setup.runnerInitialized) {
      await access(runnerFile); await access(path.join(this.#directory, 'requests.enc'));
    } // Missing history requires explicit recovery, never replacement.
    if (!saved.setup.confirmedEnvelope) throw new Error('Missing native confirmed vault provenance');
    const initial = { ...saved.setup.confirmedEnvelope, privateState: { ...saved.setup.confirmedEnvelope.privateState,
      ownerSecret: new Uint8Array(32), agentSecret: saved.agentSecret } };
    this.#runnerStore = await PrivateStateStore.open({ file: runnerFile, key: saved.runnerKey,
      context: { network: 'preview', contractAddress: address, vaultId: hex(saved.vaultId) },
      ...(saved.setup.runnerInitialized ? {} : { initialState: createRunnerState(initial) }) });
    let finalized;
    const adapter = createMidnightSdkAdapter({ providers: this.#providers.vault, compiledContract: this.#compiled.vault, networkId: 'preview',
      transactionTtl: () => new Date(Date.now() + 3_600_000),
      buildPaymentCall: async (input) => {
        if (input.request.recipientRef !== 'demo-merchant' || input.request.tokenId !== saved.setup.tokenColor) throw new WalletError('INVALID_REQUEST');
        const now = await chainTime(this.#network); const ledger = vaultModule.ledger(input.chain.contractState.data);
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
      observeTransaction: async ({ pending }) => {
        if (!pending.transactionId) return { outcome: 'unresolved' };
        finalized = await this.#watch(pending.transactionId);
        if (finalized.status !== 'SucceedEntirely' || !pending.transactionIds.includes(finalized.txId)) return { outcome: 'unresolved' };
        const ps = pending.candidate.privateState;
        await waitBalance(this.#merchant, saved.setup.tokenColor, ps.state.spent);
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
    this.#journal = await EncryptedRequestJournal.open(path.join(this.#directory, 'requests.enc'), saved.journalKey);
    this.#gateway = new PaymentGateway({ authenticate: async () => this.#scope, backend: this.#runner, journal: this.#journal });
    if (!saved.uncertain?.kind.startsWith('owner-')) await this.#runner.initialize();
    await this.#vault.update((state) => { state.setup.runnerInitialized = true; });
  }
  async requestPayment({ amount, idempotencyKey }) {
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
    await this.#saveWallets();
  }
  async owner(action, body = {}) {
    if (!this.#runnerStore || this.#runnerStore.snapshot().pending || this.#vault.snapshot().uncertain) throw new WalletError('PAYMENT_UNAVAILABLE');
    const saved = this.#vault.snapshot(); const privateState = { ...this.#runnerStore.snapshot().confirmed.privateState,
      ownerSecret: saved.ownerSecret, agentSecret: new Uint8Array(32), nextStateSalt: random32() };
    const definitions = { pause: ['setPaused', [body.paused]], revoke: ['revoke', []], withdraw: ['withdraw', [recipient(this.#owner).bytes]] };
    const selected = definitions[action]; if (!selected || (action === 'pause' && typeof body.paused !== 'boolean')) throw new WalletError('INVALID_REQUEST');
    const tx = await this.#execute(`owner-${action}`, () => this.#prepareCall('vault', saved.setup.vaultAddress, selected[0], selected[1], privateState,
      action === 'withdraw' ? encryptionKeys(this.#owner) : undefined));
    return { status: 'finalized', transactionId: tx.txId };
  }
  async reconcile() {
    if (!this.#owner) throw new WalletError('PAYMENT_UNAVAILABLE');
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
  async close() {
    clearInterval(this.#timer);
    try { await this.#saveWallets(); } finally {
      await Promise.allSettled([this.#owner?.stop(), this.#merchant?.stop()]);
      await this.#journal?.close(); await this.#runnerStore?.close(); await this.#vault.close();
    }
  }
}
