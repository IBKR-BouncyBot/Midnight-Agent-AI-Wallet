// Public synthetic fixture ONLY. No wallet files, live identities or networks.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { Zkir } from '@midnight-ntwrk/zkir-v2';
import { Contract, ledger } from '../contracts/managed/test-token/contract/index.js';

if (process.argv.length > 2) throw new Error('This fixture accepts no input files or wallet arguments');
const directory = fileURLToPath(new URL('../.local/browser-prover-fixture/', import.meta.url));
const contract = new Contract({});
const ownerPublicKey = '0'.repeat(64);
const initial = contract.initialState(runtime.createConstructorContext({}, ownerPublicKey));
const context = runtime.createCircuitContext(runtime.sampleContractAddress(), ownerPublicKey, initial.currentContractState, {});
const result = contract.impureCircuits.mint(context, { bytes: new Uint8Array(32).fill(7) }, 123456789n, new Uint8Array(32).fill(9));
if (ledger(result.context.currentQueryContext.state).mintCount !== 1n) throw new Error('Synthetic contract execution failed');
const { input, output, publicTranscript, privateTranscriptOutputs } = result.proofData;
const preimage = runtime.proofDataIntoSerializedPreimage(input, output, publicTranscript, privateTranscriptOutputs, 'mint');
const ir = await readFile(new URL('../contracts/managed/test-token/zkir/mint.bzkir', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const artifacts = {};
for (const name of ['keys/mint.prover', 'keys/mint.verifier', 'zkir/mint.bzkir']) {
  const data = await readFile(new URL(`../contracts/managed/test-token/${name}`, import.meta.url));
  artifacts[name] = { bytes: data.length, sha256: digest(data) };
}
await mkdir(directory, { recursive: true });
await writeFile(new URL('../.local/browser-prover-fixture/mint.preimage.bin', import.meta.url), preimage);
const report = { schema: 'midnight-browser-prover/public-synthetic-fixture/v1', synthetic: true,
  containsLiveWalletMaterial: false, networkSubmission: 'not-attempted', contract: 'test-token', circuit: 'mint',
  recipient: '07'.repeat(32), nonce: '09'.repeat(32), amount: '123456789',
  preimageBytes: preimage.length, preimageSha256: digest(preimage), k: Zkir.deserialize(ir).getK(), artifacts };
await writeFile(new URL('../.local/browser-prover-fixture/fixture.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
preimage.fill(0);
console.log(JSON.stringify({ created: '.local/browser-prover-fixture', synthetic: true, circuit: report.circuit, k: report.k, preimageBytes: report.preimageBytes }));
