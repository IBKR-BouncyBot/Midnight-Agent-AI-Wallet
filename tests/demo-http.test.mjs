import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createDemoHttpServer } from '../services/demo/server.mjs';

const token = 's'.repeat(43);
async function bridge(t) {
  const actions = [];
  const service = {
    status: () => ({ network: 'preview', capabilities: { canSetup: true } }),
    getPayment: id => ({ paymentId: id, status: 'unresolved' }),
    startJob(action, task) { actions.push(action); task(); return { id: 'job', status: 'running' }; },
    setup() {}, registerDust() {}, bootstrap() {}, reconcile() {}, requestPayment() {}, owner() {},
  };
  const app = createDemoHttpServer(service, { token, port: 0 });
  const address = await app.listen();
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${address.port}`;
  const call = (path, options = {}) => fetch(url + path, options);
  const post = (path, body = {}, extraHeaders = {}) => call(path, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  const rawStatus = (path, headers) => new Promise((resolve, reject) => {
    const incoming = request(url + path, { headers }, response => { response.resume(); resolve(response.statusCode); });
    incoming.on('error', reject); incoming.end();
  });
  return { actions, call, post, rawStatus };
}

test('demo bridge requires pairing for state and mutations and never schedules unauthorized work', async t => {
  const { call, actions } = await bridge(t);
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/api/status')).status, 401);
  assert.equal((await call('/api/setup', { method: 'POST', headers: { Authorization: `Bearer ${'x'.repeat(43)}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.deepEqual(actions, []);
});
test('demo bridge rejects foreign Origins and rebinding Host even with a valid pairing token', async t => {
  const { call, post, actions, rawStatus } = await bridge(t);
  assert.equal((await post('/api/setup', {}, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal(await rawStatus('/api/status', { Authorization: `Bearer ${token}`, Host: 'attacker.example' }), 403);
  const good = await call('/api/status', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://ibkr-bouncybot.github.io' } });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://ibkr-bouncybot.github.io');
  assert.equal(good.headers.get('access-control-allow-credentials'), null);
  assert.deepEqual(actions, []);
});
test('demo bridge preflight allows only explicit app origins, methods and headers', async t => {
  const { call } = await bridge(t);
  const headers = { Origin: 'http://127.0.0.1:17640', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' };
  assert.equal((await call('/api/setup', { method: 'OPTIONS', headers })).status, 204);
  assert.equal((await call('/api/setup', { method: 'OPTIONS', headers: { ...headers, Origin: 'null' } })).status, 403);
  assert.equal((await call('/api/setup', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Headers': 'x-extra' } })).status, 403);
});
test('demo bridge rejects invalid amounts, mainnet overrides, unknown owner fields and oversized bodies', async t => {
  const { post, actions } = await bridge(t);
  const idempotencyKey = 'request_1234567890123456';
  for (const amount of ['0', '1.5', '1e6', '18446744073709551616', 50]) {
    assert.equal((await post('/api/payments', { amount, idempotencyKey })).status, 400);
  }
  assert.equal((await post('/api/setup', { network: 'mainnet' })).status, 400);
  assert.equal((await post('/api/owner/pause', { paused: true, ownerSecret: 'not-accepted' })).status, 400);
  assert.equal((await post('/api/owner/pause', { paused: 'true' })).status, 400);
  assert.equal((await post('/api/payments', { amount: '1', idempotencyKey, extra: 'x'.repeat(8192) })).status, 413);
  assert.deepEqual(actions, []);
});
test('demo bridge acknowledges queued work without claiming transaction finality', async t => {
  const { post, actions, call } = await bridge(t);
  const response = await post('/api/payments', { amount: '40000000280', idempotencyKey: 'request_1234567890123456' });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: 'job', status: 'running' });
  assert.deepEqual(actions, ['payment']);
  const receipt = await call('/api/payments/request_123', { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await receipt.json(), { paymentId: 'request_123', status: 'unresolved' });
});
