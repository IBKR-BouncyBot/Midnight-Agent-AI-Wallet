import { createBrowserProver } from './provider.mjs';
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Explicit diagnostic, not an automatic page-load proof. Fixture is synthetic. */
export async function runBrowserProofProbe({ workerUrl, contractBase, fixtureUrl, contractName = 'test-token', circuit = 'mint', onStage = () => {} }) {
  const response = await fetch(fixtureUrl, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('PUBLIC_FIXTURE_UNAVAILABLE');
  const preimage = new Uint8Array(await response.arrayBuffer());
  if (!preimage.length || preimage.length > 1024 * 1024) throw new Error('INVALID_PUBLIC_FIXTURE');
  if (!['test-token','private-vault'].includes(contractName) || !['mint','pay'].includes(circuit)) throw new Error('INVALID_PROBE_CIRCUIT');
  const prover = createBrowserProver({ workerUrl, contracts: { [contractName]: contractBase }, builtinBase: './browser-builtins/', onStage });
  const started = performance.now();
  try {
    const checks = await prover.check(preimage, circuit);
    const proof = await prover.prove(preimage, circuit);
    let wrongKeyRejected = false;
    try { await prover.check(preimage, circuit === 'mint' ? 'pay' : 'mint'); } catch (error) { wrongKeyRejected = error.code === 'KEY_LOCATION_MISMATCH'; }
    if (!wrongKeyRejected) throw new Error('MISMATCHED_CIRCUIT_NOT_REJECTED');
    return { synthetic: true, execution: 'actual-zkir-v2-wasm-worker', circuit,
      constraintCheck: 'passed', checkedPublicInputs: checks.length, proofBytes: proof.length,
      proofSha256: await digest(proof), elapsedMs: Math.round(performance.now() - started), wrongKeyRejected,
      independentCryptographicVerification: 'not-performed-by-standalone-probe',
      networkSubmission: 'not-attempted', networkAcceptance: 'not-tested' };
  } finally { preimage.fill(0); prover.close(); }
}
