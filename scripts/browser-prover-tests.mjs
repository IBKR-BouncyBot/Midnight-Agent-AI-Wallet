import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createKeyMaterialProvider } from '../packages/browser-prover/materials.mjs';

const pageUrl = 'http://127.0.0.1:17640/';
const contracts = { 'test-token': new URL('contracts/test-token/', pageUrl).href };

test('public artifact resolver allows only reviewed locations and deduplicates GET downloads', async () => {
  const requests = [];
  const provider = createKeyMaterialProvider({ pageUrl, contracts, fetchImpl: async (url, options) => {
    requests.push({ url, options }); return new Response(new Uint8Array([1, 2, 3]));
  } });
  const [first, second] = await Promise.all([provider.lookupKey('mint'), provider.lookupKey('mint')]);
  assert.equal(first.proverKey, second.proverKey); assert.equal(requests.length, 3);
  assert.ok(requests.every(({ url, options }) => url.startsWith(`${pageUrl}contracts/test-token/`)
    && options.method === 'GET' && !Object.hasOwn(options, 'body') && options.credentials === 'omit' && options.redirect === 'error'));
  assert.equal(await provider.lookupKey('../private'), undefined);
  await assert.rejects(provider.getParams(23), { code: 'UNSUPPORTED_SRS_SIZE' });
  assert.equal(requests.length, 3);
  assert.throws(() => createKeyMaterialProvider({ pageUrl, contracts: { 'test-token': 'https://untrusted.invalid/keys/' } }), { code: 'UNTRUSTED_ARTIFACT_ORIGIN' });
  assert.throws(() => createKeyMaterialProvider({ pageUrl, contracts, builtinBase: 'https://untrusted.invalid/prove' }), { code: 'UNTRUSTED_ARTIFACT_ORIGIN' });
});

test('failed/oversized public artifacts fail closed and can retry without retaining bad bytes', async () => {
  let attempts = 0;
  const provider = createKeyMaterialProvider({ pageUrl, contracts, maxAssetBytes: 2, maxCacheBytes: 2,
    fetchImpl: async () => { attempts++; return new Response(new Uint8Array(attempts <= 3 ? [1, 2, 3] : [1])); } });
  await assert.rejects(provider.lookupKey('mint'), { code: 'ARTIFACT_TOO_LARGE' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = await provider.lookupKey('mint'); assert.equal(result.proverKey.length, 1);
});

test('worker performs actual native constraint check and sanitizes a mismatched circuit request', async () => {
  // Node loads the same installed zkir implementation; actual browser execution
  // remains a separate acceptance test. All fixture values are disposable/public.
  const runtime = await import('@midnight-ntwrk/compact-runtime');
  const { Contract } = await import('../contracts/managed/test-token/contract/index.js');
  const contract = new Contract({});
  const initial = contract.initialState(runtime.createConstructorContext({}, '0'.repeat(64)));
  const context = runtime.createCircuitContext(runtime.sampleContractAddress(), '0'.repeat(64), initial.currentContractState, {});
  const result = contract.impureCircuits.mint(context, { bytes: new Uint8Array(32).fill(7) }, 123456789n, new Uint8Array(32).fill(9));
  const { input, output, publicTranscript, privateTranscriptOutputs } = result.proofData;
  const preimage = runtime.proofDataIntoSerializedPreimage(input, output, publicTranscript, privateTranscriptOutputs, 'mint');
  const saved = { fetch: globalThis.fetch, location: globalThis.location, addEventListener: globalThis.addEventListener, postMessage: globalThis.postMessage };
  const messages = []; let handle;
  try {
    globalThis.location = new URL('worker.mjs', pageUrl);
    globalThis.addEventListener = (type, callback) => { assert.equal(type, 'message'); handle = callback; };
    globalThis.postMessage = message => messages.push(message);
    globalThis.fetch = async (url, options) => {
      assert.equal(options.method, 'GET');
      const relative = new URL(url).pathname.replace('/contracts/test-token/', '');
      assert.match(relative, /^(keys\/mint\.(prover|verifier)|zkir\/mint\.bzkir)$/);
      return new Response(await readFile(new URL(`../contracts/managed/test-token/${relative}`, import.meta.url)));
    };
    await import('../packages/browser-prover/worker.mjs');
    await handle({ data: { id: 1, op: 'check', keyLocation: 'mint', preimage: Uint8Array.from(preimage), config: { contracts } } });
    const completed = messages.find(message => message.id === 1 && message.type === 'result');
    assert.ok(completed); assert.equal(completed.value.length, 28);
    await handle({ data: { id: 2, op: 'check', keyLocation: 'pay', preimage: Uint8Array.from(preimage), config: { contracts } } });
    const rejected = messages.find(message => message.id === 2 && message.type === 'error');
    assert.deepEqual(rejected, { id: 2, type: 'error', code: 'KEY_LOCATION_MISMATCH' });
    assert.ok(messages.every(message => !Object.hasOwn(message, 'preimage') && !Object.hasOwn(message, 'stack')));
  } finally { Object.assign(globalThis, saved); preimage.fill(0); }
});
