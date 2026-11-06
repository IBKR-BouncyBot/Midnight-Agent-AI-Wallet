import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MCP_VERSION } from './server.mjs';

/** Deterministic transport probe; neither an AI client nor a payment simulator. */
export function runScriptedInspection() {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'scripted-inspection-agent', version: '1' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'get_wallet_capabilities', arguments: { vaultRef: 'local-inspection' },
    } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'request_payment', arguments: { vaultRef: 'local-inspection', recipientRef: 'test-recipient',
        tokenId: '00'.repeat(32), amount: '1', idempotencyKey: 'scripted_probe_0001' },
    } },
  ];
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./stdio.mjs', import.meta.url))], {
    input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`, encoding: 'utf8',
    timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, 'Inspection process must exit successfully');
  assert.equal(child.stderr, '', 'Inspection process must not emit diagnostics');
  const responses = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses.length, 4);
  assert.equal(responses[0].result.protocolVersion, MCP_VERSION);
  assert.equal(responses[1].result.tools.length, 3);
  assert.equal(responses[2].result.structuredContent.paymentsAvailable, false);
  assert.equal(responses[3].result.isError, true);
  assert.equal(responses[3].result.structuredContent.code, 'PAYMENT_UNAVAILABLE');
  return { mode: 'scripted-inspection-only', protocol: MCP_VERSION, tools: 3,
    paymentsAvailable: false, paymentRequest: 'PAYMENT_UNAVAILABLE',
    aiClientExercised: false, proofGenerated: false, paymentSettled: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(runScriptedInspection(), null, 2)}\n`);
}
