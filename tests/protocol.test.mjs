import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import { MAX_ATOMIC_AMOUNT, publicError, receipt, requestFingerprint, validateToolInput, WalletError } from '../packages/protocol/index.mjs';
import { PaymentGateway } from '../services/mcp/gateway.mjs';
import { EncryptedRequestJournal } from '../services/mcp/journal.mjs';
import { createMcpSession, MCP_VERSION, serveStdio } from '../services/mcp/server.mjs';

const scope = { subject: 'owner-a', network: 'local', contractAddress: 'dd'.repeat(32), vaultRef: 'vault-a', agentRef: 'agent-a', expiresAt: 100_000 };
const request = { vaultRef: 'vault-a', recipientRef: 'merchant-a', tokenId: 'aa'.repeat(32), amount: '7', idempotencyKey: 'order_000000000001' };
const txid = `00${'bb'.repeat(32)}`;
// Fabricated data for boundary tests only. This is deliberately not settlement evidence.
const fakeFinal = (paymentId) => ({ paymentId, status: 'finalized', transactionId: txid, settlementEvidence: {
  network: scope.network, contractAddress: scope.contractAddress, transactionId: txid,
  finalizedBlockHash: 'ee'.repeat(32), recipientReceiptVerified: true, vaultChangeVerified: true,
} });
const hasCode = (code) => (error) => error instanceof WalletError && error.code === code;

async function journalFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'midnight-protocol-test-'));
  const path = join(directory, 'requests.enc');
  const key = randomBytes(32);
  let journal = await EncryptedRequestJournal.open(path, key);
  t.after(async () => { await journal.close(); await rm(directory, { recursive: true, force: true }); });
  return { path, key, get journal() { return journal; }, async reopen() {
    await journal.close(); journal = await EncryptedRequestJournal.open(path, key); return journal;
  } };
}

function gateway(journal, backend, extra = {}) {
  return new PaymentGateway({ journal, backend, authenticate: async (credential) => credential === 'test-credential' ? scope : null,
    now: () => 100, ...extra });
}

test('atomic units stay exact at the vault uint64 boundary', () => {
  assert.equal(validateToolInput('request_payment', { ...request, amount: MAX_ATOMIC_AMOUNT.toString() }).amount, MAX_ATOMIC_AMOUNT.toString());
  for (const amount of ['0', '-1', '1.0', '1e2', '01', ' 1', '1 ', '1\n', (MAX_ATOMIC_AMOUNT + 1n).toString(), 7, 1.1]) {
    assert.throws(() => validateToolInput('request_payment', { ...request, amount }), hasCode('INVALID_REQUEST'));
  }
});

test('strict shape rejects URLs, authority overrides, malformed aliases and control characters', () => {
  for (const changed of [
    { endpoint: 'https://attacker.invalid' }, { agentRef: 'attacker' }, { ownerSeed: 'secret' },
    { recipientRef: 'https://merchant.invalid' }, { tokenId: 'AA'.repeat(32) },
    { purpose: 'x'.repeat(241) }, { purpose: 'send\u0000now' }, { idempotencyKey: 'short' },
  ]) assert.throws(() => validateToolInput('request_payment', { ...request, ...changed }), hasCode('INVALID_REQUEST'));
  assert.throws(() => validateToolInput('request_payment', null), hasCode('INVALID_REQUEST'));
  assert.throws(() => validateToolInput('request_payment', []), hasCode('INVALID_REQUEST'));
});

test('fingerprint is canonical and binds every payment field', () => {
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  assert.equal(requestFingerprint(request), requestFingerprint(reordered));
  for (const changed of [{ amount: '8' }, { recipientRef: 'merchant-b' }, { tokenId: 'cc'.repeat(32) },
    { vaultRef: 'vault-b' }, { idempotencyKey: 'order_000000000002' }, { purpose: 'changed' }]) {
    assert.notEqual(requestFingerprint(request), requestFingerprint({ ...request, ...changed }));
  }
});

test('auth, expiry, network and cross-vault access fail before backend work', async () => {
  const client = gateway(null);
  await assert.rejects(client.call('request_payment', request, 'wrong'), hasCode('NOT_AUTHORIZED'));
  await assert.rejects(client.call('request_payment', { ...request, vaultRef: 'vault-b' }, 'test-credential'), hasCode('NOT_AUTHORIZED'));
  for (const changed of [{ expiresAt: 100 }, { network: 'mainnet' }, { subject: undefined }]) {
    const rejected = gateway(null, undefined, { authenticate: async () => ({ ...scope, ...changed }) });
    await assert.rejects(rejected.call('request_payment', request, 'test-credential'), hasCode('NOT_AUTHORIZED'));
  }
});

test('default backend fails closed and capabilities never expose limits or credentials', async () => {
  const client = gateway(null);
  const capabilities = await client.call('get_wallet_capabilities', { vaultRef: scope.vaultRef }, 'test-credential');
  assert.equal(capabilities.paymentsAvailable, false);
  assert.equal(capabilities.network, 'local');
  assert.deepEqual(Object.keys(capabilities).sort(), ['network', 'operations', 'paymentsAvailable', 'protocolVersion', 'vaultRef']);
  await assert.rejects(client.call('request_payment', request, 'test-credential'), hasCode('PAYMENT_UNAVAILABLE'));
});

test('rate limit counts invalid calls and expired windows recover', async () => {
  let now = 100;
  const client = gateway(null, undefined, { rateLimit: 2, rateWindowMs: 100, now: () => now });
  await assert.rejects(client.call('request_payment', { ...request, amount: '0' }, 'test-credential'), hasCode('INVALID_REQUEST'));
  await assert.rejects(client.call('request_payment', request, 'test-credential'), hasCode('PAYMENT_UNAVAILABLE'));
  await assert.rejects(client.call('get_wallet_capabilities', { vaultRef: scope.vaultRef }, 'test-credential'), hasCode('RATE_LIMITED'));
  now = 200;
  assert.equal((await client.call('get_wallet_capabilities', { vaultRef: scope.vaultRef }, 'test-credential')).paymentsAvailable, false);
});

test('journal encrypts private request data, authenticates ciphertext and excludes a second writer', async (t) => {
  const f = await journalFixture(t);
  await f.journal.reserve(scope, { ...request, purpose: 'secret-purpose-marker' }, requestFingerprint(request));
  const bytes = await readFile(f.path);
  assert.equal(bytes.includes(Buffer.from('secret-purpose-marker')), false);
  await assert.rejects(EncryptedRequestJournal.open(f.path, f.key), { code: 'EEXIST' });
  await f.journal.close();
  await assert.rejects(EncryptedRequestJournal.open(f.path, randomBytes(32)));
  bytes[bytes.length - 1] ^= 1;
  await writeFile(f.path, bytes);
  await assert.rejects(EncryptedRequestJournal.open(f.path, f.key));
});

test('durable idempotency returns original result; changed payload is rejected after restart', async (t) => {
  const f = await journalFixture(t);
  let submitted = 0;
  const backend = { ready: true, async requestPayment({ paymentId }) { submitted += 1; return fakeFinal(paymentId); } };
  const first = await gateway(f.journal, backend).call('request_payment', request, 'test-credential');
  const restarted = gateway(await f.reopen(), backend);
  assert.deepEqual(await restarted.call('request_payment', request, 'test-credential'), first);
  await assert.rejects(restarted.call('request_payment', { ...request, amount: '8' }, 'test-credential'), hasCode('REQUEST_CONFLICT'));
  assert.equal(submitted, 1);
});

test('concurrent identical requests submit once', async (t) => {
  const f = await journalFixture(t);
  let submitted = 0;
  const backend = { ready: true, async requestPayment({ paymentId }) { submitted += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { paymentId, status: 'submitted', transactionId: txid }; },
    async reconcilePayment({ paymentId }) { return { paymentId, status: 'submitted', transactionId: txid }; } };
  const client = gateway(f.journal, backend);
  const results = await Promise.all(Array.from({ length: 5 }, () => client.call('request_payment', request, 'test-credential')));
  assert.equal(new Set(results.map((result) => result.paymentId)).size, 1);
  assert.equal(submitted, 1);
});

test('timeout after submission remains unresolved and retries only reconcile', async (t) => {
  const f = await journalFixture(t);
  let submissions = 0, reconciliations = 0;
  const backend = { ready: true,
    async requestPayment() { submissions += 1; throw new Error('timeout; private allowance = 12345'); },
    async reconcilePayment({ paymentId }) { reconciliations += 1; return fakeFinal(paymentId); },
  };
  const first = await gateway(f.journal, backend).call('request_payment', request, 'test-credential');
  assert.equal(first.status, 'unresolved');
  const second = await gateway(await f.reopen(), backend).call('request_payment', request, 'test-credential');
  assert.equal(second.paymentId, first.paymentId);
  assert.equal(second.status, 'finalized');
  assert.equal(submissions, 1); assert.equal(reconciliations, 1);
});

test('crash after reservation but before submission does not auto-submit on restart', async (t) => {
  const f = await journalFixture(t);
  await f.journal.reserve(scope, request, requestFingerprint(request));
  let submitted = 0;
  const backend = { ready: true, async requestPayment() { submitted += 1; throw new Error('must not run'); }, async reconcilePayment() { throw new Error('no chain evidence'); } };
  const result = await gateway(await f.reopen(), backend).call('request_payment', request, 'test-credential');
  assert.equal(result.status, 'unresolved'); assert.equal(submitted, 0);
});

test('same key is isolated by subject/agent; other agents cannot read receipts', async (t) => {
  const f = await journalFixture(t);
  const backend = { ready: true, async requestPayment({ paymentId }) { return { paymentId, status: 'rejected' }; } };
  const first = await gateway(f.journal, backend).call('request_payment', request, 'test-credential');
  const other = gateway(f.journal, backend, { authenticate: async () => ({ ...scope, agentRef: 'agent-b' }) });
  await assert.rejects(other.call('get_payment_status', { vaultRef: scope.vaultRef, paymentId: first.paymentId }, 'test-credential'), hasCode('NOT_FOUND'));
  const second = await other.call('request_payment', request, 'test-credential');
  assert.notEqual(first.paymentId, second.paymentId);
});

test('terminal state is not overwritten by a late failed reconciliation', async (t) => {
  const f = await journalFixture(t);
  const { record } = await f.journal.reserve(scope, request, requestFingerprint(request));
  await f.journal.update(scope, record.paymentId, { status: 'finalized', transactionId: txid });
  assert.equal((await f.journal.update(scope, record.paymentId, { status: 'unresolved' })).status, 'finalized');
});

test('finalized requires scoped runner evidence; a transaction hash alone is insufficient', async (t) => {
  const f = await journalFixture(t);
  const backend = { ready: true, async requestPayment({ paymentId }) {
    return { paymentId, status: 'finalized', transactionId: txid };
  } };
  assert.equal((await gateway(f.journal, backend).call('request_payment', request, 'test-credential')).status, 'unresolved');
  const wrongDeployment = { ready: true, async requestPayment({ paymentId }) {
    const result = fakeFinal(paymentId); result.settlementEvidence.contractAddress = 'ff'.repeat(32); return result;
  } };
  assert.equal((await gateway(f.journal, wrongDeployment).call('request_payment', { ...request, idempotencyKey: 'order_000000000002' }, 'test-credential')).status, 'unresolved');
});

test('request journal scopes also isolate contract deployments', async (t) => {
  const f = await journalFixture(t);
  const first = await f.journal.reserve(scope, request, requestFingerprint(request));
  const second = await f.journal.reserve({ ...scope, contractAddress: 'ff'.repeat(32) }, request, requestFingerprint(request));
  assert.notEqual(first.record.paymentId, second.record.paymentId);
});

test('persisted finalized records cannot bypass scoped settlement-evidence validation', async (t) => {
  const f = await journalFixture(t);
  const { record } = await f.journal.reserve(scope, request, requestFingerprint(request));
  await f.journal.update(scope, record.paymentId, { status: 'finalized', transactionId: txid });
  const backend = { ready: true };
  await assert.rejects(gateway(f.journal, backend).call('request_payment', request, 'test-credential'), /settlement evidence/);
});

test('receipt projection removes private fields and refuses unsupported finality', () => {
  assert.deepEqual(receipt({ paymentId: 'payment-a', status: 'rejected', seed: 'secret', reason: 'allowance=10' }), { paymentId: 'payment-a', status: 'rejected' });
  for (const invalid of [{ status: 'rejected' }, { paymentId: 'a', status: 'finalized' }, { paymentId: 'a', status: 'submitted', transactionId: 'bad' }]) {
    assert.throws(() => receipt(invalid), hasCode('PAYMENT_UNAVAILABLE'));
  }
  const error = new WalletError('NOT_AUTHORIZED'); error.message = 'secret';
  assert.equal(publicError(error).message, 'Not authorized.');
  assert.equal(JSON.stringify(publicError(new Error('secret'))).includes('secret'), false);
});

test('receipt accepts actual ledger8 tagged 33-byte IDs, not a bare 32-byte transaction hash', () => {
  const actualId = '00cf4761f8b7397f8a510fc20bf2f69f268adcc23d13f88eadeb10eab7bae37bc8';
  assert.equal(receipt({ paymentId: 'local-payment', status: 'submitted', transactionId: actualId }).transactionId, actualId);
  assert.throws(() => receipt({ paymentId: 'local-payment', status: 'submitted', transactionId: 'aa'.repeat(32) }), hasCode('PAYMENT_UNAVAILABLE'));
});

async function session() {
  const handle = createMcpSession({ gateway: gateway(null), credential: 'test-credential' });
  const initialized = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'test-agent', version: '1' },
  } });
  assert.equal(initialized.result.protocolVersion, MCP_VERSION);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  return handle;
}

test('MCP tools-only handshake and calls never expose owner tools', async () => {
  const handle = await session();
  const listed = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['get_wallet_capabilities', 'request_payment', 'get_payment_status']);
  const payment = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_payment', arguments: request } });
  assert.equal(payment.result.isError, true);
  assert.equal(payment.result.structuredContent.code, 'PAYMENT_UNAVAILABLE');
  assert.equal((await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'withdraw_owner' } })).error.code, -32602);
});

test('MCP requires initialization and rejects invalid JSON-RPC ids', async () => {
  const handle = createMcpSession({ gateway: gateway(null), credential: 'test-credential' });
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).error.code, -32000);
  assert.equal((await handle({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, -32600);
});

test('stdio processes split UTF-8 frames and rejects oversized messages', async () => {
  const output = new PassThrough(); let text = '';
  output.on('data', (chunk) => { text += chunk.toString(); });
  const bytes = Buffer.from('{"jsonrpc":"2.0","id":"é","method":"ping"}\n');
  const split = bytes.indexOf(0xc3) + 1;
  await serveStdio({ input: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]), output, handle: await session() });
  assert.equal(JSON.parse(text).id, 'é');
  await assert.rejects(serveStdio({ input: Readable.from([Buffer.from('x'.repeat(100))]), output,
    handle: await session(), maxBytes: 20 }), /maximum length/);
});
