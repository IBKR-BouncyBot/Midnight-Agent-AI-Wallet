import assert from 'node:assert/strict';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import * as hello from '../../contracts/managed/upstream-hello/contract/index.js';
import { startRun, buildLocalWallet, providersFor, compiled, recordTx, finishRun } from './harness.mjs';

// The unchanged upstream hello-world contract is the environment baseline.
// This proves the real toolchain/ledger route, not confidential wallet custody.
const run = await startRun('upstream-smoke');
let success = false;
try {
  const wallet = await buildLocalWallet(run);
  const providers = providersFor(run, wallet, 'upstream-hello');
  const contract = compiled('upstream-hello', hello);
  const deployed = await deployContract(providers, { compiledContract: contract, privateStateId: 'hello', initialPrivateState: {} });
  recordTx(run, 'upstream-deploy', deployed.deployTxData.public);
  const address = deployed.deployTxData.public.contractAddress;
  const call = await submitCallTx(providers, { compiledContract: contract, contractAddress: address, privateStateId: 'hello', circuitId: 'storeMessage', args: ['Local Midnight wallet feasibility baseline'] });
  recordTx(run, 'upstream-store-message', call.public);
  const state = await providers.publicDataProvider.queryContractState(address);
  assert.equal(hello.ledger(state.data).message, 'Local Midnight wallet feasibility baseline');
  assert.ok(run.proofs > 0, 'No real proof provider completion observed');
  run.checks.push('Unchanged upstream generated contract deployed and storeMessage independently queried from indexer');
  success = true;
} finally {
  await finishRun(run, success);
}
