import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BrowserRunnerStore, BrowserRequestJournal } from '../packages/browser-demo/stores.mjs';
import { BrowserDemoService, createInitialState, PREVIEW, merchantReceiptTotals, paymentReceiptExpectation } from '../packages/browser-demo/service.mjs';
import { createMerchantObserver } from '../packages/browser-demo/observer.mjs';
import { createMerchantReceiptVerifier } from '../packages/browser-demo/receipt-verifier.mjs';
import { createRunnerState, PaymentRunner } from '../services/runner/payment-runner.mjs';
import { requestFingerprint, scopeKey } from '../packages/protocol/index.mjs';

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

test('legacy SDK snapshot preserves the exact recipient identity used by targeted receipt verification', async () => {
  const seed = new Uint8Array(32).fill(31);
  const observer = await createMerchantObserver({ seed, network: PREVIEW });
  const verifier = createMerchantReceiptVerifier({ seed, network: 'preview' });
  let restored;
  try {
    assert.match(observer.getCoinPublicKey(), /^[0-9a-f]{64}$/);
    assert.equal(verifier.getCoinPublicKey(), observer.getCoinPublicKey());
    assert.equal(verifier.getEncryptionPublicKey(), observer.getEncryptionPublicKey());
    assert.equal(observer.summary().synced, false);
    assert.equal(Object.hasOwn(observer, 'balanceTx'), false); assert.equal(Object.hasOwn(observer, 'submitTx'), false);
    const saved = await observer.serialize();
    restored = await createMerchantObserver({ seed, network: PREVIEW, saved });
    assert.equal(restored.getCoinPublicKey(), observer.getCoinPublicKey());
    await assert.rejects(createMerchantObserver({ seed: new Uint8Array(32).fill(32), network: PREVIEW, saved }), /another identity/);
  } finally { verifier.close(); await restored?.stop(); await observer.stop(); }
});

test('recipient receipt amount is bound to the saved request and exact candidate spending delta', () => {
  const tokenId = 'ab'.repeat(32);
  const prior = { privateState: { state: { spent: 10n } } };
  const pending = { request: { amount: '40', tokenId, recipientRef: 'demo-merchant' }, candidate: { privateState: { state: { spent: 50n } } } };
  assert.equal(paymentReceiptExpectation(pending, prior, tokenId), 40n);
  for (const mutate of [value => { value.request.amount = '50'; }, value => { value.request.tokenId = 'cd'.repeat(32); },
    value => { value.request.recipientRef = 'another-merchant'; }, value => { value.candidate.privateState.state.spent = 51n; }]) {
    const changed = copy(pending); mutate(changed); assert.throws(() => paymentReceiptExpectation(changed, prior, tokenId));
  }
});

test('legacy merchant totals require matching terminal receipts and journal requests, never a stored wallet balance', () => {
  const saved = createInitialState({ accountId: account }); const tokenId = 'aa'.repeat(32);
  const request = { vaultRef: 'demo-vault', recipientRef: 'demo-merchant', tokenId, amount: '40', idempotencyKey: 'receipt-migration-0001' };
  const fingerprint = requestFingerprint(request); const scoped = scopeKey(scope); const transactionId = '00' + 'ee'.repeat(32);
  saved.setup = { funded: true, vaultAddress: context.contractAddress, tokenColor: tokenId };
  saved.runner = { confirmed: { privateState: { state: { spent: 40n } } }, payments: [{ paymentId: 'payment-1', scope: scoped,
    idempotencyKey: request.idempotencyKey, fingerprint, status: 'finalized', transactionId,
    settlementEvidence: { network: 'preview', contractAddress: context.contractAddress, transactionId, finalizedBlockHash: 'ff'.repeat(32),
      recipientReceiptVerified: true, vaultChangeVerified: true } }] };
  saved.journal.records = [{ paymentId: 'payment-1', scope: scoped, idempotencyKey: request.idempotencyKey, fingerprint, request, status: 'submitted' }];
  // A crash between terminal runner commit and journal status update is safe:
  // the request is immutable and the runner's terminal evidence is authoritative.
  saved.merchantSnapshot = 'opaque-legacy-full-wallet-state';
  assert.deepEqual(merchantReceiptTotals(saved), { verifiedReceivedAtomic: '40', verifiedPaymentCount: 1, receiptHistoryComplete: true });
  const before = copy(saved);
  for (const mutate of [value => { value.journal.records = []; }, value => { value.journal.records[0].request.amount = '41'; },
    value => { value.runner.confirmed.privateState.state.spent = 41n; }, value => { value.runner.payments.push(copy(value.runner.payments[0])); },
    value => { value.runner.payments[0].settlementEvidence.recipientReceiptVerified = false; }]) {
    const changed = copy(saved); mutate(changed); assert.equal(merchantReceiptTotals(changed).verifiedReceivedAtomic, null);
  }
  assert.deepEqual(saved, before);
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

test('receipt-verifier setup retains the exact existing identity and opaque legacy history without replay', async () => {
  const previousLocation = globalThis.location, previousFetch = globalThis.fetch;
  globalThis.location = new URL('https://wallet.example/testnet/');
  const calls = []; let service;
  globalThis.fetch = async (url, options) => {
    calls.push(String(url)); assert.equal(String(url), PREVIEW.node);
    assert.equal(JSON.parse(options.body).method, 'system_chain');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'Midnight Preview' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const fixture = serviceFixture();
    await fixture.store.update(state => {
      state.merchantSnapshot = 'opaque-existing-SDK-snapshot-do-not-replay-or-replace';
      state.uncertain = { kind: 'deploy-token', phase: 'submitting', signed: new Uint8Array([1, 2, 3]), transactionIds: ['00' + 'ee'.repeat(32)] };
      state.journal.records = [{ paymentId: 'saved-request', status: 'requested' }];
    });
    const before = fixture.store.snapshot(); service = await BrowserDemoService.create(fixture);
    await service.setup(); const status = await service.status();
    assert.equal(status.merchant.ready, true); assert.equal(status.merchant.verificationMode, 'finalized-output-decryption');
    assert.equal(Object.hasOwn(status.merchant, 'synced'), false); assert.equal(Object.hasOwn(status.merchant, 'balanceAtomic'), false);
    assert.equal(status.capabilities.canBootstrap, false); assert.equal(status.phase, 'unresolved');
    assert.deepEqual(calls, [PREVIEW.node]); assert.deepEqual(fixture.store.snapshot(), before);
    await service.close(); assert.deepEqual(fixture.store.snapshot(), before);
  } finally {
    await service?.close(); globalThis.fetch = previousFetch;
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
  }
});

test('already-funded pending browser sessions reopen the runner without replacing candidate or replaying merchant history', async () => {
  const previousLocation = globalThis.location, previousFetch = globalThis.fetch;
  globalThis.location = new URL('https://wallet.example/testnet/'); let service;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url)); assert.equal(String(url), PREVIEW.node);
    return new Response(JSON.stringify({ result: 'Midnight Preview' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const fixture = serviceFixture();
    await fixture.store.update(state => {
      const envelope = { privateState: { ownerSecret: new Uint8Array(32), agentSecret: state.agentSecret, coinIndex: 7n,
        state: { spent: 0n, hasCoin: true, coin: { value: 100n } } } };
      state.setup = { funded: true, vaultAddress: context.contractAddress, tokenColor: 'aa'.repeat(32), runnerInitialized: true, confirmedEnvelope: envelope };
      state.runnerContext = { network: 'preview', contractAddress: context.contractAddress, vaultId: Buffer.from(state.vaultId).toString('hex') };
      state.runner = createRunnerState(envelope);
      state.runner.pending = { phase: 'submitted', signedBytes: new Uint8Array([4, 5, 6]), transactionIds: ['00' + 'ee'.repeat(32)],
        candidate: { privateState: { coinIndex: null, state: { spent: 40n } } }, request: { amount: '40' } };
      state.merchantSnapshot = 'preserved-legacy-observer-snapshot';
      state.journal.records = [{ paymentId: 'retained-payment', status: 'submitted' }];
    });
    const before = fixture.store.snapshot(); service = await BrowserDemoService.create(fixture);
    await service.setup(); const status = await service.status();
    assert.equal(status.merchant.ready, true); assert.equal(status.capabilities.canPay, false); assert.equal(status.capabilities.canReconcile, true);
    assert.deepEqual(urls, [PREVIEW.node]); assert.deepEqual(fixture.store.snapshot(), before);
  } finally {
    await service?.close(); globalThis.fetch = previousFetch;
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
  }
});

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
