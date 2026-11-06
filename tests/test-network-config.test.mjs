import assert from 'node:assert/strict';
import test from 'node:test';
import { getTestNetworkConfig, verifyPreviewNetwork } from '../services/runner/test-network-config.mjs';

test('Preview configuration pins official public endpoints and keeps proving on loopback', () => {
  const preview = getTestNetworkConfig('preview');
  assert.equal(preview.networkId, 'preview');
  assert.equal(preview.node, 'https://rpc.preview.midnight.network');
  assert.equal(preview.indexer, 'https://indexer.preview.midnight.network/api/v4/graphql');
  assert.equal(preview.proofServer, 'http://127.0.0.1:16300');
  assert.equal(Object.isFrozen(preview), true);
  for (const network of ['mainnet', 'preprod', '', undefined, '__proto__']) {
    assert.throws(() => getTestNetworkConfig(network), /explicitly/);
  }
  for (const proofServer of ['https://prover.example', 'http://127.0.0.1.example:6300',
    'http://user:pass@localhost:6300', 'http://localhost:6300/?token=x', 'http://localhost:6300/prove']) {
    assert.throws(() => getTestNetworkConfig('preview', { proofServer }), /loopback/);
  }
  assert.equal(getTestNetworkConfig('local').node, 'http://127.0.0.1:19944');
  assert.equal(getTestNetworkConfig('preview', { proofServer: 'http://[::1]:6300' }).proofServer, 'http://[::1]:6300');
});

test('Preview RPC identity mismatches and endpoint substitutions fail closed', async () => {
  const config = getTestNetworkConfig('preview');
  let calls = 0;
  const rpc = async (url, options) => {
    calls++;
    assert.equal(url, config.node);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { jsonrpc: '2.0', id: 1, method: 'system_chain', params: [] });
    return { ok: true, async json() { return { result: 'Midnight Preview' }; } };
  };
  assert.equal((await verifyPreviewNetwork(config, rpc)).chainName, 'Midnight Preview');
  await assert.rejects(verifyPreviewNetwork({ ...config, node: 'https://attacker.invalid' }, rpc), /Unexpected Preview/);
  assert.equal(calls, 1);
  await assert.rejects(verifyPreviewNetwork(config, async () => ({ ok: true, async json() { return { result: 'Midnight Mainnet' }; } })), /did not identify/);
  await assert.rejects(verifyPreviewNetwork(config, async () => ({ ok: false, status: 410 })), /HTTP 410/);
});
