import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunnerState, PaymentRunner } from '../services/runner/payment-runner.mjs';
import { PrivateStateStore } from '../services/runner/private-store.mjs';
import { PaymentGateway } from '../services/mcp/gateway.mjs';
import { EncryptedRequestJournal } from '../services/mcp/journal.mjs';
import { requestFingerprint } from '../packages/protocol/index.mjs';

// Fake adapter observations below test durable orchestration only. They are not
// real proofs, transactions, recipient receipts or evidence of chain settlement.
const address = 'ab'.repeat(32), vaultId = 'cd'.repeat(32), txid = `00${'ef'.repeat(32)}`;
const scope = { subject: 'owner', agentRef: 'agent', vaultRef: 'vault', network: 'local', contractAddress: address, expiresAt: Number.MAX_SAFE_INTEGER };
const context = { network: 'local', contractAddress: address, vaultId };
const request = { vaultRef: 'vault', recipientRef: 'merchant', tokenId: 'aa'.repeat(32), amount: '7', idempotencyKey: 'runner_order_0001' };
const input = (changes = {}) => { const req = { ...request, ...(changes.request ?? {}) }; return { scope, request: req, paymentId: 'payment-1', ...changes, fingerprint: requestFingerprint(req) }; };
const opening = () => ({ state: { amount: 100n, spent: 0n, nonce: randomBytes(32) }, salt: randomBytes(32), coinIndex: 3n });
const fakeEvidence = () => ({ network: 'local', contractAddress: address, transactionId: txid,
  finalizedBlockHash: 'cc'.repeat(32), recipientReceiptVerified: true, vaultChangeVerified: true });

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'midnight-runner-test-'));
  const options = { file: join(directory, 'runner.enc'), key: randomBytes(32), context,
    initialState: createRunnerState(opening()) };
  let store = await PrivateStateStore.open(options);
  let journal;
  t.after(async () => { await store.close(); await journal?.close(); await rm(directory, { recursive: true, force: true }); });
  const counts = { prepare: 0, prove: 0, submit: 0, observe: 0, verify: 0 };
  const adapter = {
    async prepare({ confirmed }) { counts.prepare++; return {
      candidate: { ...confirmed, state: { ...confirmed.state, amount: 93n, spent: 7n }, coinIndex: null },
      unprovenBytes: new Uint8Array([10, 20, 30]),
    }; },
    async proveAndBalance() { counts.prove++; return { signedBytes: new Uint8Array([40, 50, 60]), transactionIds: [txid] }; },
    async submit() { counts.submit++; return txid; },
    async observe({ pending }) { counts.observe++; return { outcome: 'finalized', transactionId: txid,
      confirmed: { ...pending.candidate, coinIndex: 11n }, settlementEvidence: fakeEvidence() }; },
    async verifyConfirmed() { counts.verify++; return true; },
    async verifyCoinQualification({ confirmed }) { return confirmed.coinIndex === 11n; },
    ...overrides,
  };
  const runner = () => new PaymentRunner({ store, adapter, scope, vaultId });
  return { directory, options, counts, adapter, runner, get store() { return store; },
    async reopen() { await store.close(); store = await PrivateStateStore.open(options); return runner(); },
    async journal() { journal = await EncryptedRequestJournal.open(join(directory, 'requests.enc'), randomBytes(32)); return journal; },
  };
}

test('runner stores exact signed bytes and both openings before submission, then commits final state and receipt together', async (t) => {
  const f = await fixture(t);
  const original = f.store.snapshot().confirmed;
  f.adapter.submit = async ({ signedBytes, transactionIds }) => {
    f.counts.submit++;
    const durable = f.store.snapshot();
    assert.equal(durable.pending.phase, 'submitting');
    assert.deepEqual(durable.pending.signedBytes, signedBytes);
    assert.deepEqual(durable.pending.transactionIds, transactionIds);
    assert.deepEqual(durable.confirmed, original);
    assert.equal(durable.pending.candidate.state.spent, 7n);
    assert.equal(f.store.canSpend, false);
    return txid;
  };
  const runner = f.runner();
  assert.equal(runner.canSubmit, false);
  assert.deepEqual(await runner.initialize(), { canSpend: true, recoveryRequired: false });
  const result = await runner.requestPayment(input());
  assert.equal(result.status, 'finalized');
  const state = f.store.snapshot();
  assert.equal(state.confirmed.state.amount, 93n);
  assert.equal(state.confirmed.coinIndex, 11n);
  assert.equal(state.pending, null);
  assert.equal(state.payments[0].status, 'finalized');
  assert.equal(runner.canSubmit, true);
  assert.deepEqual(await (await f.reopen()).requestPayment(input()), result);
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.prove, 1); assert.equal(f.counts.submit, 1);
});

test('timeout after actual send remains unresolved; retry reconciles without proving or sending again', async (t) => {
  const f = await fixture(t);
  f.adapter.submit = async () => { f.counts.submit++; throw new Error('network response lost'); };
  const first = await f.runner().requestPayment(input());
  assert.equal(first.status, 'unresolved');
  assert.equal(f.store.snapshot().pending.phase, 'submitting');
  const restarted = await f.reopen();
  assert.deepEqual(await restarted.initialize(), { canSpend: false, recoveryRequired: true });
  const last = await restarted.reconcilePayment(input());
  assert.equal(last.status, 'finalized');
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.prove, 1); assert.equal(f.counts.submit, 1);
});

for (const crashAt of [1, 2, 3, 4, 5, 6]) {
  test(`crash after checkpoint ${crashAt} never implicitly regenerates or resubmits after restart`, async (t) => {
    const f = await fixture(t, { async observe() { return { outcome: 'unresolved' }; } });
    const real = f.store;
    let checkpoints = 0;
    const proxy = {
      snapshot: () => real.snapshot(), reconcile: (...args) => real.reconcile(...args),
      get canSpend() { return real.canSpend; },
      get deploymentContext() { return real.deploymentContext; },
      async checkpoint(state) { await real.checkpoint(state); if (++checkpoints === crashAt) throw new Error('simulated process death'); },
    };
    const runner = new PaymentRunner({ store: proxy, adapter: f.adapter, scope, vaultId });
    await runner.requestPayment(input()).catch(() => {});
    const before = { ...f.counts };
    const restored = await f.reopen();
    const result = await restored.requestPayment(input());
    assert.equal(result.status, 'unresolved');
    assert.equal(f.counts.prepare, before.prepare);
    assert.equal(f.counts.prove, before.prove);
    assert.equal(f.counts.submit, before.submit);
    assert.equal(f.counts.submit, crashAt >= 6 ? 1 : 0);
    assert.equal(restored.canSubmit, false);
  });
}

test('persistence failure before signed transaction durability prevents network submission', async (t) => {
  const f = await fixture(t);
  const real = f.store;
  const proxy = { snapshot: () => real.snapshot(), reconcile: (...args) => real.reconcile(...args),
    get deploymentContext() { return real.deploymentContext; },
    get canSpend() { return real.canSpend; }, async checkpoint(state) {
      if (state.pending?.phase === 'signed') throw new Error('disk unavailable');
      return real.checkpoint(state);
    } };
  await assert.rejects(new PaymentRunner({ store: proxy, adapter: f.adapter, scope, vaultId }).requestPayment(input()), /disk unavailable/);
  assert.equal(f.counts.submit, 0);
  assert.equal(f.store.snapshot().pending.phase, 'proving');
  assert.equal(f.store.canSpend, false);
});

test('unresolved payment blocks a second request on the same vault, even across two runner objects', async (t) => {
  const f = await fixture(t, { async observe() { return { outcome: 'unresolved' }; } });
  const a = f.runner(), b = f.runner();
  const calls = await Promise.allSettled([
    a.requestPayment(input()),
    b.requestPayment(input({ paymentId: 'payment-2', request: { ...request, idempotencyKey: 'runner_order_0002' } })),
  ]);
  assert.equal(calls[0].value.status, 'unresolved');
  assert.equal(calls[1].status, 'rejected');
  assert.equal(f.counts.submit, 1);
});

test('same request concurrency submits once; changed amount or forged scope is refused', async (t) => {
  const f = await fixture(t);
  const runner = f.runner();
  const results = await Promise.all([runner.requestPayment(input()), runner.requestPayment(input())]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.counts.submit, 1);
  await assert.rejects(runner.requestPayment(input({ request: { ...request, amount: '8' } })), { code: 'REQUEST_CONFLICT' });
  assert.throws(() => runner.requestPayment(input({ scope: { ...scope, contractAddress: 'ff'.repeat(32) } })), { code: 'NOT_AUTHORIZED' });
});

test('contract construction rejection never reaches prover or submitter and retains confirmed openings', async (t) => {
  const f = await fixture(t, { async prepare() { throw new Error('private allowance detail'); } });
  const previous = f.store.snapshot().confirmed;
  const result = await f.runner().requestPayment(input());
  assert.deepEqual(result, { paymentId: 'payment-1', status: 'rejected' });
  assert.deepEqual(f.store.snapshot().confirmed, previous);
  assert.equal(f.counts.prove, 0); assert.equal(f.counts.submit, 0);
});

test('mismatched settlement observations stay unresolved and preserve original + candidate openings', async (t) => {
  const f = await fixture(t);
  f.adapter.observe = async ({ pending }) => ({ outcome: 'finalized', transactionId: txid,
    confirmed: pending.candidate, settlementEvidence: { ...fakeEvidence(), contractAddress: 'ff'.repeat(32) } });
  const previous = f.store.snapshot().confirmed;
  assert.equal((await f.runner().requestPayment(input())).status, 'unresolved');
  assert.deepEqual(f.store.snapshot().confirmed, previous);
  assert.equal(f.store.snapshot().pending.candidate.state.spent, 7n);
});

test('wrong restored deployment context prevents any proof or submission', async (t) => {
  const f = await fixture(t);
  assert.throws(() => new PaymentRunner({ store: f.store, adapter: f.adapter, scope, vaultId: 'ee'.repeat(32) }), /deployment context/);
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.submit, 0);
});

test('unrelated current-chain openings cannot replace the persisted native candidate even when verifiers return true', async (t) => {
  const f = await fixture(t);
  f.adapter.verifyConfirmed = async () => true;
  f.adapter.verifyCoinQualification = async () => true;
  f.adapter.observe = async ({ pending }) => ({ outcome: 'finalized', transactionId: txid,
    confirmed: { ...pending.candidate, coinIndex: 11n, state: { ...pending.candidate.state, spent: 99n } }, settlementEvidence: fakeEvidence() });
  const old = f.store.snapshot().confirmed;
  assert.equal((await f.runner().requestPayment(input())).status, 'unresolved');
  assert.deepEqual(f.store.snapshot().confirmed, old);
  assert.equal(f.store.snapshot().pending.candidate.state.spent, 7n);
});

test('unverified or negative coin qualification remains unresolved', async (t) => {
  const f = await fixture(t);
  f.adapter.verifyCoinQualification = async () => false;
  assert.equal((await f.runner().requestPayment(input())).status, 'unresolved');
  f.adapter.verifyCoinQualification = async () => true;
  f.adapter.observe = async ({ pending }) => ({ outcome: 'finalized', transactionId: txid,
    confirmed: { ...pending.candidate, coinIndex: -1n }, settlementEvidence: fakeEvidence() });
  assert.equal((await f.runner().reconcilePayment(input())).status, 'unresolved');
});

test('pending recovery rejects a different actual store context before adapter sees openings', async (t) => {
  const f = await fixture(t, { async observe() { return { outcome: 'unresolved' }; } });
  await f.runner().requestPayment(input());
  let observerCalls = 0;
  f.adapter.observe = async () => { observerCalls++; return { outcome: 'unresolved' }; };
  assert.throws(() => new PaymentRunner({ store: f.store, adapter: f.adapter,
    scope: { ...scope, contractAddress: 'ff'.repeat(32) }, vaultId }), /deployment context/);
  let currentContext = f.store.deploymentContext;
  const proxy = { snapshot: () => f.store.snapshot(), reconcile: (...args) => f.store.reconcile(...args),
    checkpoint: (...args) => f.store.checkpoint(...args), get canSpend() { return f.store.canSpend; },
    get deploymentContext() { return currentContext; } };
  const runner = new PaymentRunner({ store: proxy, adapter: f.adapter, scope, vaultId });
  currentContext = { ...currentContext, vaultId: 'ff'.repeat(32) };
  await assert.rejects(runner.initialize(), /deployment context/);
  await assert.rejects(runner.reconcilePayment(input()), /deployment context/);
  assert.equal(observerCalls, 0);
});

test('gateway + encrypted journal + runner are wired together while adapter remains a test double', async (t) => {
  const f = await fixture(t);
  const runner = f.runner();
  await runner.initialize();
  const gateway = new PaymentGateway({ authenticate: async () => scope, backend: runner, journal: await f.journal() });
  const result = await gateway.call('request_payment', request, 'test-only');
  assert.deepEqual(Object.keys(result).sort(), ['paymentId', 'status', 'transactionId']);
  assert.equal(result.status, 'finalized');
  assert.deepEqual(await gateway.call('request_payment', request, 'test-only'), result);
  assert.equal(f.counts.submit, 1);
});
