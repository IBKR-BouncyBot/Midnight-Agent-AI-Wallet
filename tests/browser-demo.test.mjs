import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BrowserRunnerStore, BrowserRequestJournal } from '../packages/browser-demo/stores.mjs';
import { BrowserDemoService, createInitialState, PREVIEW } from '../packages/browser-demo/service.mjs';
import { createMerchantObserver } from '../packages/browser-demo/observer.mjs';
import { createRunnerState, PaymentRunner } from '../services/runner/payment-runner.mjs';
import { requestFingerprint } from '../packages/protocol/index.mjs';

const copy = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const account = 'public-preview-account-fixture';
const binding = { network: 'preview', identityId: createHash('sha256').update('preview:' + account).digest('hex') };
const context = { network: 'preview', contractAddress: 'ab'.repeat(32), vaultId: 'cd'.repeat(32) };
const scope = { ...context, subject: 'demo-owner', vaultRef: 'demo-vault', agentRef: 'demo-agent', expiresAt: Number.MAX_SAFE_INTEGER };
const confirmed = () => ({ privateState: { coinIndex: 7n, state: { spent: 0n }, opening: new Uint8Array([7, 8, 9]) } });

// Exercises substore ordering against the root's documented atomic-update API.
// Actual encryption and IndexedDB transaction tests live in browser-storage.test.mjs.
function memoryRoot(initial = createInitialState({ accountId: account })) {
  let saved = copy(initial), queue = Promise.resolve(), fail = false;
  return { context: binding,
    snapshot: () => copy(saved),
    failNextCommit() { fail = true; },
    update(change) {
      const result = queue.then(async () => {
        const draft = copy(saved); await change(draft);
        if (fail) { fail = false; throw new Error('Injected commit failure'); }
        saved = copy(draft);
      });
      queue = result.catch(() => {}); return result;
    },
    close: () => queue,
  };
}

test('fresh browser identity holds no owner wallet seed and generates independent openings', () => {
  const first = createInitialState({ accountId: account }), second = createInitialState({ accountId: account });
  assert.equal(first.accountId, account); assert.equal(first.network, 'preview');
  assert.equal(Object.hasOwn(first, 'ownerSeed'), false);
  for (const key of ['ownerSecret', 'agentSecret', 'vaultId', 'merchantSeed']) {
    assert.equal(first[key].length, 32); assert.notDeepEqual(first[key], second[key]);
  }
  assert.equal(first.uncertain, null); assert.equal(first.runner, null);
  assert.throws(() => createInitialState({ accountId: '' }));
});

test('browser runner restore is gated and cannot substitute a deployment or recreate missing history', async () => {
  const root = memoryRoot(); const store = await BrowserRunnerStore.open(root, { context, initialState: createRunnerState(confirmed()) });
  assert.equal(store.canSpend, false);
  assert.equal(await BrowserRunnerStore.open(root, { context }), store);
  await store.reconcile(async (state, actual) => { assert.deepEqual(actual, context); assert.equal(state.confirmed.privateState.coinIndex, 7n); return true; });
  assert.equal(store.canSpend, true);
  await store.close();
  const restored = await BrowserRunnerStore.open(root, { context });
  assert.equal(restored.canSpend, false);
  await assert.rejects(BrowserRunnerStore.open(root, { context: { ...context, contractAddress: 'ff'.repeat(32) } }));
  await restored.close();
  await root.update(state => { state.setup.runnerInitialized = true; state.runner = null; });
  await assert.rejects(BrowserRunnerStore.open(root, { context, initialState: createRunnerState(confirmed()) }), /Missing persisted/);
});

test('merchant snapshots cannot overwrite concurrent payment checkpoints and candidates detach before queuing', async () => {
  const root = memoryRoot(); const store = await BrowserRunnerStore.open(root, { context, initialState: createRunnerState(confirmed()) });
  const candidate = store.snapshot(); candidate.pending = { phase: 'submitting', signedBytes: new Uint8Array([1, 2, 3]) };
  const write = store.checkpoint(candidate); candidate.pending.signedBytes.fill(9);
  await Promise.all([write, root.update(state => { state.merchantSnapshot = 'actual-sdk-snapshot'; })]);
  assert.deepEqual(store.snapshot().pending.signedBytes, new Uint8Array([1, 2, 3]));
  assert.equal(root.snapshot().merchantSnapshot, 'actual-sdk-snapshot');
  assert.equal(store.canSpend, false); await store.close();
});

test('new checkpoint or close invalidates an older in-flight reconciliation', async () => {
  const root = memoryRoot(); const store = await BrowserRunnerStore.open(root, { context, initialState: createRunnerState(confirmed()) });
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const reconcile = store.reconcile(async () => { await held; return true; }); await tick();
  const candidate = store.snapshot(); candidate.pending = { phase: 'prepared' };
  const checkpoint = store.checkpoint(candidate); finish(); await Promise.all([reconcile, checkpoint]);
  assert.equal(store.canSpend, false);
  let release; const heldAgain = new Promise(resolve => { release = resolve; });
  const second = store.reconcile(async () => { await heldAgain; return true; }); await tick();
  const closing = store.close(); release(); await Promise.all([second, closing]);
  assert.equal(store.canSpend, false);
});

test('failed commit preserves the old openings and administrative uncertainty blocks runner writes', async () => {
  const root = memoryRoot(); const store = await BrowserRunnerStore.open(root, { context, initialState: createRunnerState(confirmed()) });
  await store.reconcile(async () => true); const before = store.snapshot();
  root.failNextCommit(); await assert.rejects(store.checkpoint({ ...before, pending: { phase: 'submitting' } }), /Injected/);
  assert.deepEqual(store.snapshot(), before); assert.equal(store.canSpend, false);
  await root.update(state => { state.uncertain = { kind: 'owner-withdraw', phase: 'submitting' }; });
  await assert.rejects(store.checkpoint(before), error => error.code === 'REQUEST_UNRESOLVED');
  assert.deepEqual(store.snapshot(), before); await store.close();
});

test('browser runner keeps signed bytes before one send and restart only observes the existing candidate', async () => {
  // This adapter tests orchestration only; its byte strings and observations are
  // synthetic and are not proofs or evidence of public-network settlement.
  const root = memoryRoot(); let store = await BrowserRunnerStore.open(root, { context, initialState: createRunnerState(confirmed()) });
  const original = store.snapshot().confirmed; const txId = '00' + 'ef'.repeat(32);
  const request = { vaultRef: scope.vaultRef, recipientRef: 'demo-merchant', tokenId: 'aa'.repeat(32), amount: '7', idempotencyKey: 'browser-order-0001' };
  const input = { scope, request, fingerprint: requestFingerprint(request), paymentId: 'payment-1' };
  const counts = { prepare: 0, prove: 0, submit: 0, observe: 0 };
  const adapter = {
    async prepare({ confirmed: prior }) { counts.prepare++; return { unprovenBytes: new Uint8Array([1, 2]),
      candidate: { privateState: { ...prior.privateState, coinIndex: null, state: { spent: 7n } } } }; },
    async proveAndBalance() { counts.prove++; return { signedBytes: new Uint8Array([3, 4, 5]), transactionIds: [txId] }; },
    async submit({ signedBytes }) {
      counts.submit++; const durable = root.snapshot().runner;
      assert.equal(durable.pending.phase, 'submitting'); assert.deepEqual(durable.pending.signedBytes, signedBytes);
      assert.deepEqual(durable.confirmed, original); assert.equal(durable.pending.candidate.privateState.state.spent, 7n);
      throw new Error('Synthetic lost response after send');
    },
    async observe({ pending }) { counts.observe++; return { outcome: 'finalized', transactionId: txId,
      confirmed: { privateState: { ...pending.candidate.privateState, coinIndex: 11n } },
      settlementEvidence: { network: 'preview', contractAddress: context.contractAddress, transactionId: txId,
        finalizedBlockHash: 'cc'.repeat(32), recipientReceiptVerified: true, vaultChangeVerified: true } }; },
    async verifyConfirmed() { return true; }, async verifyCoinQualification({ confirmed: value }) { return value.privateState.coinIndex === 11n; },
  };
  let runner = new PaymentRunner({ store, adapter, scope, vaultId: context.vaultId });
  assert.equal((await runner.requestPayment(input)).status, 'unresolved');
  await store.close(); store = await BrowserRunnerStore.open(root, { context });
  runner = new PaymentRunner({ store, adapter, scope, vaultId: context.vaultId });
  assert.deepEqual(await runner.initialize(), { canSpend: false, recoveryRequired: true });
  assert.equal((await runner.reconcilePayment(input)).status, 'finalized');
  assert.deepEqual(counts, { prepare: 1, prove: 1, submit: 1, observe: 1 });
  assert.equal(store.snapshot().confirmed.privateState.state.spent, 7n);
  assert.equal(store.snapshot().pending, null); await store.close();
});

test('request journal reserves one idempotent payment, keeps scopes isolated and terminal receipts immutable', async () => {
  const root = memoryRoot(), journal = new BrowserRequestJournal(root);
  const request = { idempotencyKey: 'browser-request-0001', amount: '10' };
  const reservations = await Promise.all([journal.reserve(scope, request, 'fingerprint'), journal.reserve(scope, request, 'fingerprint')]);
  assert.equal(reservations.filter(value => value.created).length, 1);
  const id = reservations[0].record.paymentId; assert.equal(reservations[1].record.paymentId, id);
  await assert.rejects(journal.reserve(scope, request, 'different'), error => error.code === 'REQUEST_CONFLICT');
  assert.equal(await journal.get({ ...scope, subject: 'other-agent' }, id), null);
  const tx = 'aa'.repeat(33);
  await journal.update(scope, id, { status: 'submitted', transactionId: tx });
  await assert.rejects(journal.update(scope, id, { transactionId: 'bb'.repeat(33) }));
  await assert.rejects(journal.update(scope, id, { request: { amount: '9000' } }));
  await journal.update(scope, id, { status: 'finalized' });
  await journal.update(scope, id, { status: 'requested' });
  assert.equal((await journal.get(scope, id)).status, 'finalized'); await journal.close();
});

test('actual shielded SDK observer snapshot round-trips and rejects another recipient identity without network start', async () => {
  const seed = new Uint8Array(32).fill(31);
  const observer = await createMerchantObserver({ seed, network: PREVIEW });
  let restored;
  try {
    assert.match(observer.getCoinPublicKey(), /^[0-9a-f]{64}$/);
    assert.equal(observer.summary().synced, false);
    assert.equal(Object.hasOwn(observer, 'balanceTx'), false); assert.equal(Object.hasOwn(observer, 'submitTx'), false);
    const saved = await observer.serialize();
    restored = await createMerchantObserver({ seed, network: PREVIEW, saved });
    assert.equal(restored.getCoinPublicKey(), observer.getCoinPublicKey());
    await assert.rejects(createMerchantObserver({ seed: new Uint8Array(32).fill(32), network: PREVIEW, saved }), /another identity/);
  } finally { await restored?.stop(); await observer.stop(); }
});

function serviceFixture() {
  let changed = false;
  const connection = { context: { accountId: account, unshieldedAddress: account, coinPublicKeyHex: '11'.repeat(32), encryptionPublicKeyHex: '22'.repeat(32) },
    async assertSession() { if (changed) throw new Error('account changed'); }, async assertInProcess() { await this.assertSession(); },
    getShieldedBalance: async () => 0n, getPublicStatus: async () => ({ connected: true, canTransact: false, dustAtomic: '0' }),
    walletProvider: {}, midnightProvider: {}, close() {},
  };
  return { connection, store: memoryRoot(), prover: { proveTx() { throw new Error('must not prove'); }, close() {} },
    assetBase: 'https://wallet.example/browser-contracts/', changeAccount() { changed = true; } };
}

test('browser service rejects wrong encrypted account context and foreign asset origins before work', async () => {
  const previous = globalThis.location; globalThis.location = new URL('https://wallet.example/testnet/');
  try {
    const fixture = serviceFixture(); fixture.store.context = { ...binding, identityId: 'different' };
    await assert.rejects(BrowserDemoService.create(fixture), /another Lace account/);
    const foreign = serviceFixture(); foreign.assetBase = 'https://foreign.example/contracts/';
    await assert.rejects(BrowserDemoService.create(foreign), /Same-origin/);
  } finally { if (previous === undefined) delete globalThis.location; else globalThis.location = previous; }
});

test('browser jobs are exclusive, errors omit secrets, and account changes reject the action before its callback', async () => {
  const previous = globalThis.location; globalThis.location = new URL('https://wallet.example/testnet/');
  let service;
  try {
    const fixture = serviceFixture(); service = await BrowserDemoService.create(fixture);
    let release; const held = new Promise(resolve => { release = resolve; });
    service.startJob('fixture', async () => { await held; throw new Error('secret-private-opening-fixture'); });
    assert.throws(() => service.startJob('second', () => {}), error => error.code === 'PAYMENT_UNAVAILABLE');
    release(); await tick();
    const status = await service.status(); assert.equal(status.activeJob.status, 'failed');
    assert.equal(status.funding.address, account);
    assert.equal(JSON.stringify(status).includes('secret-private-opening-fixture'), false);
    assert.equal(Object.hasOwn(status, 'ownerSecret'), false); assert.equal(status.capabilities.canSetup, true);
    fixture.changeAccount(); let called = false;
    service.startJob('changed-account', () => { called = true; }); await tick();
    assert.equal(called, false); await assert.rejects(service.status(), /account changed/);
  } finally { await service?.close(); if (previous === undefined) delete globalThis.location; else globalThis.location = previous; }
});

test('restored funded profile does not expose owner actions or reconciliation before setup', async () => {
  const previous = globalThis.location; globalThis.location = new URL('https://wallet.example/testnet/');
  let service;
  try {
    const fixture = serviceFixture(); fixture.connection.getPublicStatus = async () => ({ connected: true, canTransact: true, dustAtomic: '100' });
    await fixture.store.update(state => { state.setup = { funded: true, vaultAddress: context.contractAddress,
      vaultPrivate: { state: { spent: 0n, hasCoin: true, coin: { value: 100n } } } }; state.uncertain = { kind: 'owner-withdraw' }; });
    service = await BrowserDemoService.create(fixture);
    const status = await service.status();
    for (const capability of ['canPay', 'canPause', 'canRevoke', 'canWithdraw', 'canReconcile']) assert.equal(status.capabilities[capability], false);
    assert.equal(status.capabilities.canSetup, true); assert.equal(status.phase, 'unresolved');
    await assert.rejects(service.reconcile(), error => error.code === 'PAYMENT_UNAVAILABLE');
  } finally { await service?.close(); if (previous === undefined) delete globalThis.location; else globalThis.location = previous; }
});

test('closing waits for the active operation and releases storage even when another cleanup fails', async () => {
  const previous = globalThis.location; globalThis.location = new URL('https://wallet.example/testnet/');
  try {
    const fixture = serviceFixture(); let rootClosed = false, connectionClosed = false;
    fixture.store.close = async () => { rootClosed = true; };
    fixture.connection.close = () => { connectionClosed = true; };
    fixture.prover.close = () => { throw new Error('synthetic cleanup failure'); };
    const service = await BrowserDemoService.create(fixture);
    let release; const held = new Promise(resolve => { release = resolve; });
    service.startJob('fixture', async () => { await held; await fixture.store.update(state => { state.uncertain = { phase: 'submitting' }; }); });
    await tick(); const closing = service.close(); assert.equal(service.close(), closing);
    await tick(); assert.equal(rootClosed, false); release();
    await assert.rejects(closing, /cleanup incomplete/);
    assert.equal(rootClosed, true); assert.equal(connectionClosed, true); assert.equal(fixture.store.snapshot().uncertain.phase, 'submitting');
  } finally { if (previous === undefined) delete globalThis.location; else globalThis.location = previous; }
});
