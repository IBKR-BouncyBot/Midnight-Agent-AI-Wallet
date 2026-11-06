// PUBLIC, SYNTHETIC CONTRACT-PROOF BENCHMARK ONLY.
// All openings below are deliberately fixed and public. This script reads no
// wallet files, submits nothing, and does not establish Zswap coin membership.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { check, Zkir } from '@midnight-ntwrk/zkir-v2';
import { Contract, ledger, pureCircuits } from '../contracts/managed/private-vault/contract/index.js';
import { emptySpendingState, witnesses } from '../contracts/witnesses.mjs';

if (process.argv.length > 2) throw new Error('This fixture accepts no input files or wallet arguments');
const fixed = value => new Uint8Array(32).fill(value);
const pad = value => { const bytes = new Uint8Array(32); bytes.set(new TextEncoder().encode(value)); return bytes; };
const digest = value => createHash('sha256').update(value).digest('hex');
const now = 1_800_000_000, network = pad('browser-proof-fixture'), vault = fixed(3), recipient = fixed(4);
const ownerSecret = fixed(1), agentSecret = fixed(2), address = '99'.repeat(32), feePayer = 'aa'.repeat(32);
const policy = { agentKey: pureCircuits.authorityKey(pad('agent-vault:agent:v1'), network, vault, agentSecret),
  asset: fixed(5), recipients: [recipient, new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)],
  perPayment: 60n, allowance: 100n, expiresAt: BigInt(now + 3600) };
let privateState = { ownerSecret, agentSecret, policy, policySalt: fixed(6), state: emptySpendingState(),
  stateSalt: fixed(7), nextStateSalt: fixed(8), coinIndex: null };
const contract = new Contract(witnesses);
let state = contract.initialState(runtime.createConstructorContext(privateState, feePayer), network, vault).currentContractState.data;
function call(name, ...args) {
  const context = runtime.createCircuitContext(address, feePayer, state, privateState, undefined, undefined, now);
  const result = contract.impureCircuits[name](context, ...args);
  state = result.context.currentQueryContext.state; privateState = result.context.currentPrivateState; return result;
}
call('initializePolicy');
privateState.nextStateSalt = fixed(10);
call('fund', { nonce: fixed(9), color: policy.asset, value: 120n });
// Deliberately synthetic index. Compact's contract circuit is benchmarked here;
// the separate Zswap membership/transfer proofs and network acceptance are not.
privateState = { ...privateState, ownerSecret: new Uint8Array(32), coinIndex: 7n, nextStateSalt: fixed(11) };
const request = { network, vault, deployedContract: fixed(0x99), expectedVersion: ledger(state).version,
  requestId: fixed(12), asset: policy.asset, recipient, amount: 40n, validFrom: BigInt(now - 10), validUntil: BigInt(now + 60) };
const result = call('pay', request);
assert.equal(privateState.state.spent, 40n); assert.equal(privateState.state.coin.value, 80n);
assert.equal(result.context.currentZswapLocalState.inputs.length, 1);
assert.equal(result.context.currentZswapLocalState.outputs.length, 2);
assert.equal(ledger(state).usedRequests.size(), 1n);
const { input, output, publicTranscript, privateTranscriptOutputs } = result.proofData;
const preimage = runtime.proofDataIntoSerializedPreimage(input, output, publicTranscript, privateTranscriptOutputs, 'pay');
const material = {}, artifacts = {};
for (const [field, path] of [['proverKey', 'keys/pay.prover'], ['verifierKey', 'keys/pay.verifier'], ['ir', 'zkir/pay.bzkir']]) {
  const data = await readFile(new URL('../contracts/managed/private-vault/' + path, import.meta.url));
  material[field] = new Uint8Array(data); artifacts[path] = { bytes: data.length, sha256: digest(data) };
}
const checked = await check(preimage, {
  async lookupKey(key) { assert.equal(key, 'pay'); return material; },
  async getParams() { throw new Error('Constraint checking must not fetch proving parameters'); },
});
const report = { schema: 'midnight-browser-prover/public-synthetic-fixture/v1', synthetic: true,
  containsLiveWalletMaterial: false, openings: 'fixed public constants in scripts/browser-pay-fixture.mjs',
  networkSubmission: 'not-attempted', coinMembership: 'synthetic index; NOT verified',
  proofScope: 'private-vault contract circuit only; excludes Zswap and fee proofs', contract: 'private-vault', circuit: 'pay',
  amount: '40', funded: '120', allowance: '100', perPayment: '60', recipient: '04'.repeat(32),
  preimageBytes: preimage.length, preimageSha256: digest(preimage), k: Zkir.deserialize(material.ir).getK(),
  nativeConstraintCheck: true, checkedInputs: checked.length, artifacts };
const directory = new URL('../.local/browser-prover-fixture/', import.meta.url);
await mkdir(fileURLToPath(directory), { recursive: true });
await writeFile(new URL('pay.preimage.bin', directory), preimage);
await writeFile(new URL('pay.fixture.json', directory), JSON.stringify(report, null, 2) + '\n');
preimage.fill(0);
console.log(JSON.stringify({ created: '.local/browser-prover-fixture/pay.preimage.bin', synthetic: true,
  circuit: report.circuit, k: report.k, preimageBytes: report.preimageBytes, nativeConstraintCheck: true, checkedInputs: report.checkedInputs }));
