import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ZswapInput } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { decodeQualifiedShieldedCoinInfo } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { PrivateStateStore } from '../../services/runner/private-store.mjs';
import { PaymentRunner, createRunnerState } from '../../services/runner/payment-runner.mjs';
import { createMidnightSdkAdapter } from '../../services/runner/midnight-sdk-adapter.mjs';
import { requestFingerprint } from '../../packages/protocol/index.mjs';
import { random32, encryptionKeys, qualifyCoin, waitBalance } from './harness.mjs';

const equal = (left, right) => Buffer.from(left).equals(Buffer.from(right));
const envelope = (privateState, ledger) => ({
  privateState, stateCommitment: ledger.stateCommitment,
  policyCommitment: ledger.policyCommitment, version: ledger.version,
  paused: ledger.paused, revoked: ledger.revoked,
});

/** Real network adapter test, with a deliberately lost submission response.
 * Reopening the encrypted store exercises durable reconciliation. It is not
 * an OS process-kill/power-loss test, and observations are never fabricated.
 */
export async function durablePayment({ run, providers, compiledContract, vaultModule, address,
  vaultId, privateState, request, merchantWallet, color, paymentAmount, changeAmount }) {
  const scope = { subject: 'local-test', network: 'local', contractAddress: address,
    vaultRef: 'vault', agentRef: 'agent', expiresAt: Date.now() + 3_600_000 };
  const context = { network: 'local', contractAddress: address, vaultId: Buffer.from(vaultId).toString('hex') };
  const before = await providers.publicDataProvider.queryContractState(address);
  const storeOptions = { file: path.join(run.directory, 'durable-runner.enc'), key: random32(), context,
    initialState: createRunnerState(envelope(privateState, vaultModule.ledger(before.data))) };
  let store = await PrivateStateStore.open(storeOptions);
  let finalized;
  const counts = { prepare: 0, prove: 0, submit: 0, observe: 0 };
  let persistedSignedDigest;
  const adapter = createMidnightSdkAdapter({
    providers, compiledContract, networkId: 'undeployed', transactionTtl: () => new Date(Date.now() + 3_600_000),
    async buildPaymentCall(input) {
      assert.equal(input.request.recipientRef, 'merchant');
      assert.equal(input.request.tokenId, color);
      assert.equal(input.request.amount, paymentAmount.toString());
      return { args: [request], privateState: { ...input.confirmed.privateState, nextStateSalt: random32() },
        additionalCoinEncPublicKeyMappings: encryptionKeys(merchantWallet) };
    },
    captureCandidate({ prepared }) {
      return envelope(prepared.private.nextPrivateState, vaultModule.ledger(prepared.public.nextContractState));
    },
    async verifyConfirmed({ confirmed }) {
      const current = await providers.publicDataProvider.queryZSwapAndContractState(address);
      assert.ok(current, 'Vault chain state is missing');
      const ledger = vaultModule.ledger(current[1].data);
      if (!equal(confirmed.stateCommitment, ledger.stateCommitment)
          || !equal(confirmed.policyCommitment, ledger.policyCommitment)
          || confirmed.version !== ledger.version || confirmed.paused !== ledger.paused
          || confirmed.revoked !== ledger.revoked) return false;
      const ps = confirmed.privateState;
      if (ps.state.hasCoin) {
        assert.equal(typeof ps.coinIndex, 'bigint');
        ZswapInput.newContractOwned(decodeQualifiedShieldedCoinInfo({ ...ps.state.coin, mt_index: ps.coinIndex }),
          0, address, current[0].postBlockUpdate(new Date()));
      }
      return true;
    },
    async verifyCoinQualification({ candidate, confirmed, transactionId }) {
      assert.ok(finalized && finalized.txId === transactionId, 'Missing exact finalized payment observation');
      const change = await qualifyCoin(finalized, candidate.privateState.state.coin, address);
      return confirmed.privateState.coinIndex === change.mt_index;
    },
    async observeTransaction({ pending }) {
      counts.observe++;
      finalized = await providers.publicDataProvider.watchForTxData(pending.transactionId);
      assert.equal(finalized.status, 'SucceedEntirely');
      assert.ok(pending.transactionIds.includes(finalized.txId));
      await waitBalance(merchantWallet, color, paymentAmount);
      assert.equal(pending.candidate.privateState.state.coin.value, changeAmount);
      assert.equal(pending.candidate.privateState.state.spent, paymentAmount);
      const change = await qualifyCoin(finalized, pending.candidate.privateState.state.coin, address);
      const confirmed = { ...pending.candidate, privateState: { ...pending.candidate.privateState, coinIndex: change.mt_index } };
      return { outcome: 'finalized', transactionId: finalized.txId, confirmed,
        settlementEvidence: { network: 'local', contractAddress: address, transactionId: finalized.txId,
          finalizedBlockHash: finalized.blockHash, recipientReceiptVerified: true, vaultChangeVerified: true } };
    },
  });
  const realPrepare = adapter.prepare.bind(adapter);
  adapter.prepare = async input => { counts.prepare++; return realPrepare(input); };
  const realProve = adapter.proveAndBalance.bind(adapter);
  adapter.proveAndBalance = async input => { counts.prove++; return realProve(input); };
  const realSubmit = adapter.submit.bind(adapter);
  adapter.submit = async input => {
    counts.submit++;
    const persisted = store.snapshot();
    assert.equal(persisted.pending.phase, 'submitting');
    assert.deepEqual(persisted.pending.signedBytes, input.signedBytes);
    assert.deepEqual(persisted.pending.transactionIds, input.transactionIds);
    assert.equal(persisted.confirmed.privateState.state.spent, 0n);
    assert.equal(persisted.pending.candidate.privateState.state.spent, paymentAmount);
    assert.equal(store.canSpend, false);
    persistedSignedDigest = createHash('sha256').update(input.signedBytes).digest('hex');
    assert.equal(persisted.pending.signedDigest, persistedSignedDigest);
    await realSubmit(input);
    // The transaction really crossed the node boundary; simulate only the lost
    // HTTP/WebSocket response, then require reconciliation after store reopen.
    throw new Error('TEST: response lost after real local submission');
  };
  const makeRunner = () => new PaymentRunner({ store, adapter, scope, vaultId: context.vaultId });
  const protocolRequest = { vaultRef: 'vault', recipientRef: 'merchant', tokenId: color,
    amount: paymentAmount.toString(), idempotencyKey: 'durable_local_payment_0001' };
  const input = { scope, request: protocolRequest, paymentId: 'payment-1', fingerprint: requestFingerprint(protocolRequest) };
  try {
    let runner = makeRunner();
    assert.equal((await runner.initialize()).canSpend, true);
    const first = await runner.requestPayment(input);
    assert.equal(first.status, 'unresolved', 'Lost submission response must remain unresolved');
    assert.equal(store.snapshot().pending.phase, 'submitting');
    await store.close();
    store = await PrivateStateStore.open(storeOptions);
    runner = makeRunner();
    assert.deepEqual(await runner.initialize(), { canSpend: false, recoveryRequired: true });
    const result = await runner.reconcilePayment(input);
    assert.equal(result.status, 'finalized', 'Real chain reconciliation did not finalize the payment');
    const restored = store.snapshot();
    assert.equal(restored.pending, null);
    assert.equal(restored.confirmed.privateState.state.spent, paymentAmount);
    assert.equal(typeof restored.confirmed.privateState.coinIndex, 'bigint');
    assert.deepEqual(await runner.requestPayment(input), result);
    assert.deepEqual(counts, { prepare: 1, prove: 1, submit: 1, observe: 1 });
    run.durable = { submittedOnce: true, simulatedLostSubmissionResponse: true,
      reopenedEncryptedStore: true, finalizedByRealChainObservation: true,
      repeatReturnedOriginalReceipt: true, counts, persistedSignedDigest,
      transactionId: result.transactionId, finalizedBlockHash: result.settlementEvidence.finalizedBlockHash,
      limitation: 'Store close/reopen and injected lost response; no OS process kill or power-loss test' };
    return { public: finalized, privateState: restored.confirmed.privateState };
  } finally { await store.close(); }
}
