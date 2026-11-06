import test from 'node:test';
import assert from 'node:assert/strict';
import { MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey,
  UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { Transaction, Intent, CostModel } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { discoverWallets, connectPreview, serializeFinalizedTransaction, restoreFinalizedTransaction } from '../packages/browser-demo/lace.mjs';

function account(network = 'preview', n = 1) {
  const coin = new ShieldedCoinPublicKey(Buffer.alloc(32, n));
  const encryption = new ShieldedEncryptionPublicKey(Buffer.alloc(32, n + 1));
  const encode = value => value.constructor.codec.encode(network, value).asString();
  return { shielded: { shieldedAddress: encode(new ShieldedAddress(coin, encryption)),
    shieldedCoinPublicKey: encode(coin), shieldedEncryptionPublicKey: encode(encryption) },
    unshielded: { unshieldedAddress: encode(new UnshieldedAddress(Buffer.alloc(32, n + 2))) } };
}

function fixture() {
  const state = { account: account(), networkId: 'preview', connected: true, config: {}, calls: [],
    balanceResponse: null, balanceError: null, submitError: null, readError: null, balances: {}, dust: { balance: 12n, cap: 30n } };
  const api = {
    async getConnectionStatus() { if (state.readError) throw state.readError; return { status: state.connected ? 'connected' : 'disconnected', networkId: state.networkId }; },
    async getConfiguration() { return { networkId: state.networkId, ...state.config }; },
    async getShieldedAddresses() { return state.account.shielded; },
    async getUnshieldedAddress() { return state.account.unshielded; },
    async getShieldedBalances() { return state.balances; },
    async getDustBalance() { return state.dust; },
    async balanceUnsealedTransaction(tx) { state.calls.push(['balance', tx]); if (state.balanceError) throw state.balanceError; return { tx: state.balanceResponse }; },
    async submitTransaction(tx) { state.calls.push(['submit', tx]); if (state.submitError) throw state.submitError; },
  };
  const wallet = { rdns: 'io.lace.wallet', name: 'Lace', apiVersion: '4.0.1', async connect(network) { state.calls.push(['connect', network]); return api; } };
  return { state, api, wallet };
}

// Native serialization fixture with an empty intent. It executes no circuit and
// is NOT evidence of payment, fee coverage, proving correctness or chain finality.
async function emptyTransactions(network = 'preview', expires = '2030-01-01T00:00:00Z') {
  const tx = Transaction.fromParts(network, undefined, undefined, Intent.new(new Date(expires)));
  const proven = await tx.prove({ check() { throw new Error('No circuit expected'); }, prove() { throw new Error('No circuit expected'); } }, CostModel.initialCostModel());
  return { proven, finalized: proven.bind() };
}
const rejects = (operation, code) => assert.rejects(operation, error => error.code === code && error.message === code);

test('API4 picker tolerates broken providers, excludes older API, and never connects automatically', () => {
  const { wallet, state } = fixture();
  const registry = { selected: wallet, old: { ...wallet, apiVersion: '3.0.0' }, malformed: { apiVersion: '4.0.1' } };
  Object.defineProperty(registry, 'broken', { enumerable: true, get() { throw new Error('private extension error'); } });
  const results = discoverWallets(registry);
  assert.equal(results.length, 1); assert.equal(results[0].wallet, wallet); assert.equal(state.calls.length, 0);
  assert.deepEqual(discoverWallets(undefined), []);
});

test('connect is read-only and binds canonical Preview shielded and unshielded identity', async () => {
  const { wallet, state } = fixture(); const session = await connectPreview({ wallet });
  assert.deepEqual(state.calls, [['connect', 'preview']]);
  assert.equal(session.context.accountId, state.account.unshielded.unshieldedAddress);
  assert.equal(session.context.unshieldedAddress, state.account.unshielded.unshieldedAddress);
  const funding = MidnightBech32m.parse(session.context.unshieldedAddress).decode(UnshieldedAddress, 'preview');
  assert.equal(funding.hexString, '03'.repeat(32));
  assert.match(session.context.unshieldedAddress, /^mn_addr_preview1/);
  assert.equal(session.context.coinPublicKeyHex, '01'.repeat(32));
  assert.equal(session.status().modeAssurance, 'unconfirmed'); assert.equal(session.status().proverModeApiVerified, false);
  await rejects(() => session.walletProvider.balanceTx(null), 'LACE_PROVER_MODE_UNCONFIRMED');
  await rejects(() => session.confirmInProcess(), 'LACE_EXPLICIT_CONFIRMATION_REQUIRED');
  await session.confirmInProcess({ confirmedByUser: true });
  assert.equal(session.status().modeAssurance, 'user-confirmed'); assert.equal(session.status().canTransact, true);
});

test('no local/remote URI or malformed reported URI is accepted even with user confirmation', async () => {
  for (const proverServerUri of ['http://localhost:6300', 'https://remote.example', '', null]) {
    const { wallet, state } = fixture(); state.config.proverServerUri = proverServerUri;
    const session = await connectPreview({ wallet });
    await rejects(() => session.confirmInProcess({ confirmedByUser: true }), 'LACE_EXTERNAL_PROVER_REJECTED');
    assert.equal(session.status().modeAssurance, 'external-rejected'); assert.equal(state.calls.length, 1);
  }
});

test('absent URI is honestly unconfirmed because API4 also hides TEE remote endpoints', async () => {
  const { wallet, state } = fixture(); state.config.proverServerUri = undefined;
  const session = await connectPreview({ wallet });
  await rejects(() => session.assertInProcess(), 'LACE_PROVER_MODE_UNCONFIRMED');
  await session.confirmInProcess({ confirmedByUser: true });
  assert.equal(session.status().proverModeApiVerified, false);
});

test('non-Lace provider, wrong network, malformed address and inconsistent shielded keys fail closed', async () => {
  let f = fixture(); f.wallet.rdns = 'com.some.wallet'; await rejects(() => connectPreview({ wallet: f.wallet }), 'LACE_API4_REQUIRED');
  f = fixture(); f.state.networkId = 'preprod'; await rejects(() => connectPreview({ wallet: f.wallet }), 'LACE_WRONG_NETWORK');
  f = fixture(); f.state.account = account('preprod'); await rejects(() => connectPreview({ wallet: f.wallet }), 'INVALID_WALLET_ADDRESS');
  f = fixture(); f.state.account.shielded.shieldedAddress += 'q'; await rejects(() => connectPreview({ wallet: f.wallet }), 'INVALID_WALLET_ADDRESS');
  f = fixture(); f.state.account.shielded.shieldedCoinPublicKey = account('preview', 9).shielded.shieldedCoinPublicKey;
  await rejects(() => connectPreview({ wallet: f.wallet }), 'WALLET_ADDRESS_KEYS_MISMATCH');
  f = fixture(); await rejects(() => connectPreview({ wallet: f.wallet, expectedAccount: account('preview', 8).unshielded.unshieldedAddress }), 'LACE_ACCOUNT_CHANGED');
});

test('account/network change or disconnect clears confirmation and permanently closes session', async () => {
  for (const change of [state => { state.account = account('preview', 8); }, state => { state.networkId = 'mainnet'; }, state => { state.connected = false; }]) {
    const { wallet, state } = fixture(); const session = await connectPreview({ wallet });
    await session.confirmInProcess({ confirmedByUser: true }); change(state);
    await assert.rejects(() => session.assertSession());
    assert.equal(session.status().modeAssurance, 'disconnected');
    await rejects(() => session.confirmInProcess({ confirmedByUser: true }), 'LACE_SESSION_CLOSED');
  }
});

test('switching to external prover clears confirmation; switching back requires fresh explicit confirmation', async () => {
  const { wallet, state } = fixture(); const session = await connectPreview({ wallet });
  await session.confirmInProcess({ confirmedByUser: true }); state.config.proverServerUri = 'https://remote.example';
  await rejects(() => session.assertInProcess(), 'LACE_EXTERNAL_PROVER_REJECTED');
  delete state.config.proverServerUri;
  await rejects(() => session.assertInProcess(), 'LACE_PROVER_MODE_UNCONFIRMED');
});

test('actual native serialization roundtrips, binding and ledger33-byte identifiers preserved', async () => {
  const { wallet, state } = fixture(); const session = await connectPreview({ wallet });
  const { proven, finalized } = await emptyTransactions(); state.balanceResponse = Buffer.from(finalized.serialize()).toString('hex');
  await session.confirmInProcess({ confirmedByUser: true });
  const balanced = await session.walletProvider.balanceTx(proven); const saved = serializeFinalizedTransaction(balanced);
  assert.deepEqual(restoreFinalizedTransaction(saved).identifiers(), balanced.identifiers());
  assert.equal(saved.transactionIds[0].length, 66);
  const result = await session.midnightProvider.submitTx(balanced);
  assert.equal(result, saved.transactionIds[0]);
  assert.equal(state.calls.find(([name]) => name === 'submit')[1], state.balanceResponse);
  await rejects(() => session.midnightProvider.submitTx(balanced), 'LACE_SUBMISSION_ALREADY_ATTEMPTED');
  await rejects(async () => restoreFinalizedTransaction({ ...saved, transactionIds: ['00' + 'ff'.repeat(32)] }), 'INVALID_TRANSACTION');
});

test('ambiguous submission is never resent by this session and raw extension errors never escape', async () => {
  const { wallet, state } = fixture(); const session = await connectPreview({ wallet });
  await session.confirmInProcess({ confirmedByUser: true }); const { finalized } = await emptyTransactions();
  state.submitError = new Error('PRIVATE WITNESS PAYLOAD');
  await rejects(() => session.midnightProvider.submitTx(finalized), 'LACE_SUBMISSION_UNCERTAIN');
  await rejects(() => session.midnightProvider.submitTx(finalized), 'LACE_SUBMISSION_ALREADY_ATTEMPTED');
  assert.equal(state.calls.filter(([name]) => name === 'submit').length, 1);
  state.readError = Object.assign(new Error('PRIVATE WITNESS PAYLOAD'), { name: 'LaceConnectionError', code: 'PRIVATE WITNESS PAYLOAD' });
  await rejects(() => session.assertSession(), 'LACE_SESSION_CHECK_FAILED');
});

test('valid native transaction for another network cannot be balanced, journaled or submitted', async () => {
  const { wallet, state } = fixture(); const session = await connectPreview({ wallet });
  await session.confirmInProcess({ confirmedByUser: true }); const { proven, finalized } = await emptyTransactions('preprod');
  await rejects(() => session.walletProvider.balanceTx(proven), 'INVALID_TRANSACTION');
  await rejects(() => session.midnightProvider.submitTx(finalized), 'INVALID_TRANSACTION');
  await rejects(async () => serializeFinalizedTransaction(finalized), 'INVALID_TRANSACTION');
  assert.equal(state.calls.length, 1);
});

test('wallet account switch during balancing rejects signed result and invalidates confirmation', async () => {
  const { wallet, state, api } = fixture(); const session = await connectPreview({ wallet });
  await session.confirmInProcess({ confirmedByUser: true }); const { proven, finalized } = await emptyTransactions();
  api.balanceUnsealedTransaction = async () => { state.account = account('preview', 9); return { tx: Buffer.from(finalized.serialize()).toString('hex') }; };
  await rejects(() => session.walletProvider.balanceTx(proven), 'LACE_ACCOUNT_CHANGED');
  assert.equal(session.status().canTransact, false);
});

test('invalid returned transaction and private balance errors are rejected without submission', async () => {
  const { wallet, state } = fixture(); const session = await connectPreview({ wallet });
  await session.confirmInProcess({ confirmedByUser: true }); const { proven } = await emptyTransactions();
  state.balanceResponse = 'not-hex'; await rejects(() => session.walletProvider.balanceTx(proven), 'INVALID_LACE_TRANSACTION');
  state.balanceError = new Error('PRIVATE WITNESS PAYLOAD'); await rejects(() => session.walletProvider.balanceTx(proven), 'LACE_BALANCE_FAILED');
  assert.equal(state.calls.filter(([name]) => name === 'submit').length, 0);
});

test('a valid signed response with a substituted intent is rejected before it can be journaled or submitted', async () => {
  const { wallet, state } = fixture(); const session = await connectPreview({ wallet });
  await session.confirmInProcess({ confirmedByUser: true });
  const { proven } = await emptyTransactions();
  const unrelated = await emptyTransactions('preview', '2031-01-01T00:00:00Z');
  state.balanceResponse = Buffer.from(unrelated.finalized.serialize()).toString('hex');
  await rejects(() => session.walletProvider.balanceTx(proven), 'LACE_TRANSACTION_CHANGED');
  assert.equal(state.calls.filter(([name]) => name === 'submit').length, 0);
});

test('close during pending session check cannot restore permission', async () => {
  const { wallet, api } = fixture(); const session = await connectPreview({ wallet });
  let release; api.getConfiguration = () => new Promise(resolve => { release = resolve; });
  const pending = session.confirmInProcess({ confirmedByUser: true }); session.close(); release({ networkId: 'preview' });
  await rejects(() => pending, 'LACE_SESSION_CLOSED'); assert.equal(session.status().canTransact, false);
});

test('balance queries remain account-bound and return bounded exact integers without proof permission', async () => {
  const { wallet, state, api } = fixture(); const session = await connectPreview({ wallet });
  const token = 'ab'.repeat(32); state.balances[token] = 37n;
  assert.equal(await session.getShieldedBalance(token), 37n);
  assert.equal(await session.getShieldedBalance('cd'.repeat(32)), 0n);
  assert.equal((await session.getPublicStatus()).dustAtomic, '12');
  assert.equal((await session.getPublicStatus()).modeAssurance, 'unconfirmed');
  state.balances[token] = '37'; await rejects(() => session.getShieldedBalance(token), 'INVALID_LACE_BALANCE');
  state.balances = null; await rejects(() => session.getShieldedBalance(token), 'INVALID_LACE_BALANCE');
  api.getShieldedBalances = async () => { state.account = account('preview', 9); return {}; };
  await rejects(() => session.getShieldedBalance(token), 'LACE_ACCOUNT_CHANGED');
});
