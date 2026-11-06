import assert from 'node:assert/strict';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { rawTokenType } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { encodeRawTokenType } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import * as vaultModule from '../../contracts/managed/private-vault/contract/index.js';
import * as tokenModule from '../../contracts/managed/test-token/contract/index.js';
import { emptySpendingState, witnesses } from '../../contracts/witnesses.mjs';
import { checkPaymentPrivacy } from './privacy.mjs';
import { disableMaintenanceBeforeFunding } from '../../services/runner/disable-maintenance.mjs';
import { durablePayment } from './durable-payment.mjs';
import {
  startRun, buildLocalWallet, providersFor, compiled, recordTx, finishRun,
  random32, recipientOf, encryptionKeys, freshCoin, waitBalance, qualifyCoin, graph,
} from './harness.mjs';

const pad = text => { const value = new Uint8Array(32); value.set(new TextEncoder().encode(text)); return value; };
const bytes = value => new Uint8Array(Buffer.from(value, 'hex'));
// Distinctive integer values make binary privacy scans meaningful; tiny values
// such as40 otherwise occur in unrelated serialized metadata.
const SCALE = 1_000_000_007n;
const FUND = 100n * SCALE;
const PAY = 40n * SCALE;
const CHANGE = FUND - PAY;
const LIMIT = 70n * SCALE;
const CEILING = 50n * SCALE;
const durable = process.argv.includes('--durable');
const run = await startRun(durable ? 'durable-vault' : 'private-vault');
run.testAmounts = { fundedAtomic: FUND, paymentAtomic: PAY, changeAtomic: CHANGE, allowanceAtomic: LIMIT, ceilingAtomic: CEILING };
let success = false;
try {
  const ownerWallet = await buildLocalWallet(run, 1);
  const merchantWallet = await buildLocalWallet(run, 2);
  const tokenProviders = providersFor(run, ownerWallet, 'test-token');
  const vaultProviders = providersFor(run, ownerWallet, 'private-vault');
  const token = compiled('test-token', tokenModule);
  const vault = compiled('private-vault', vaultModule, witnesses);
  const tokenDeploy = await deployContract(tokenProviders, { compiledContract: token, privateStateId: 'token', initialPrivateState: {} });
  recordTx(run, 'test-token-deploy', tokenDeploy.deployTxData.public);
  const tokenAddress = tokenDeploy.deployTxData.public.contractAddress;
  const color = rawTokenType(pad('agent-vault:test-token:v1'), tokenAddress);
  const asset = encodeRawTokenType(color);
  const mint = await submitCallTx(tokenProviders, {
    compiledContract: token, contractAddress: tokenAddress, privateStateId: 'token', circuitId: 'mint',
    args: [recipientOf(ownerWallet), FUND, random32()],
    additionalCoinEncPublicKeyMappings: encryptionKeys(ownerWallet),
  });
  recordTx(run, 'test-token-mint-public-amount', mint.public);
  await waitBalance(ownerWallet, color, FUND);
  await waitBalance(merchantWallet, color, 0n);

  const network = pad('undeployed');
  const vaultId = random32();
  const ownerSecret = random32();
  const agentSecret = random32();
  const merchant = recipientOf(merchantWallet).bytes;
  const timestamp = new Date((await graph('{ block { timestamp } }')).block.timestamp).getTime();
  assert.ok(Number.isFinite(timestamp), 'Indexer block timestamp is invalid');
  const now = Math.floor(timestamp / 1000);
  const policy = {
    agentKey: vaultModule.pureCircuits.authorityKey(pad('agent-vault:agent:v1'), network, vaultId, agentSecret),
    asset, recipients: [merchant, random32(), new Uint8Array(32), new Uint8Array(32)],
    perPayment: CEILING, allowance: LIMIT, expiresAt: BigInt(now + 7200),
  };
  const initialPrivateState = {
    ownerSecret, agentSecret, policy, policySalt: random32(),
    state: emptySpendingState(), stateSalt: random32(), nextStateSalt: random32(), coinIndex: null,
  };
  const deployed = await deployContract(vaultProviders, {
    compiledContract: vault, privateStateId: 'vault', initialPrivateState, args: [network, vaultId],
  });
  const address = deployed.deployTxData.public.contractAddress;
  recordTx(run, 'private-vault-deploy', deployed.deployTxData.public);
  const maintenance = await disableMaintenanceBeforeFunding(vaultProviders, address, state => !vaultModule.ledger(state.data).funded);
  if (maintenance) recordTx(run, 'disable-vault-maintenance', maintenance);
  run.checks.push('Before funding, finalized maintenance removal independently verified empty committee and impossible threshold1');
  const invoke = (circuitId, args = [], extra = {}, providers = vaultProviders) => submitCallTx(providers, {
    compiledContract: vault, contractAddress: address, privateStateId: 'vault', circuitId, args, ...extra,
  });
  const queryLedger = async () => vaultModule.ledger((await vaultProviders.publicDataProvider.queryContractState(address)).data);
  recordTx(run, 'initialize-private-policy', (await invoke('initializePolicy')).public);
  const deposit = freshCoin(color, FUND);
  const funded = await invoke('fund', [deposit]);
  recordTx(run, 'fund-private-vault', funded.public);
  await waitBalance(ownerWallet, color, 0n);
  const qualifiedDeposit = await qualifyCoin(funded.public, deposit, address);
  let privateState = await vaultProviders.privateStateProvider.get('vault');
  assert.equal(privateState.state.coin.value, FUND);
  const fundingStateSalt = privateState.stateSalt;
  // A fee-paying wallet supplies no owner authority to this agent context.
  privateState = { ...privateState, ownerSecret: new Uint8Array(32), coinIndex: qualifiedDeposit.mt_index, nextStateSalt: random32() };
  await vaultProviders.privateStateProvider.set('vault', privateState);
  const request = {
    network, vault: vaultId, deployedContract: bytes(address), expectedVersion: (await queryLedger()).version,
    requestId: random32(), asset, recipient: merchant, amount: PAY,
    validFrom: BigInt(now - 60), validUntil: BigInt(now + 3600),
  };
  const beforeInvalidIndex = (await queryLedger()).stateCommitment;
  const proofsBeforeInvalidIndex = run.proofs;
  await vaultProviders.privateStateProvider.set('vault', { ...privateState, coinIndex: 18446744073709551615n });
  await assert.rejects(() => invoke('pay', [request], { additionalCoinEncPublicKeyMappings: encryptionKeys(merchantWallet) }), /invalid index into sparse merkle tree/);
  assert.equal(run.proofs, proofsBeforeInvalidIndex, 'Invalid membership should fail before proof provider invocation');
  assert.deepEqual((await queryLedger()).stateCommitment, beforeInvalidIndex);
  await vaultProviders.privateStateProvider.set('vault', privateState);
  run.checks.push('Impossible coin index rejected by real ledger spend-proof construction against indexed chain; no proof/submission and commitment unchanged');
  const paid = durable
    ? await durablePayment({ run, providers: vaultProviders, compiledContract: vault, vaultModule, address, vaultId,
      privateState, request, merchantWallet, color, paymentAmount: PAY, changeAmount: CHANGE })
    : await invoke('pay', [request], { additionalCoinEncPublicKeyMappings: encryptionKeys(merchantWallet) });
  if (durable) await vaultProviders.privateStateProvider.set('vault', paid.privateState);
  recordTx(run, 'agent-payment', paid.public);
  await waitBalance(merchantWallet, color, PAY);
  privateState = await vaultProviders.privateStateProvider.get('vault');
  assert.equal(privateState.state.spent, PAY);
  assert.equal(privateState.state.coin.value, CHANGE);
  assert.equal(privateState.state.hasCoin, true);
  if (!durable) assert.equal(privateState.coinIndex, null, 'New change must be qualified from finalized evidence');
  const qualifiedChange = await qualifyCoin(paid.public, privateState.state.coin, address);
  if (durable) assert.equal(privateState.coinIndex, qualifiedChange.mt_index, 'Runner must have persisted finalized change qualification');
  run.checks.push('Merchant wallet independently observed the exact payment amount; private change and spend accounting match');

  // Reconstruct the provider, load encrypted on-disk openings and qualify the
  // change from finalized data. This is NOT a crash-during-submission test.
  const restoredProviders = providersFor(run, ownerWallet, 'private-vault');
  restoredProviders.privateStateProvider.setContractAddress(address);
  let restored = await restoredProviders.privateStateProvider.get('vault');
  assert.deepEqual(restored.state, privateState.state);
  restored = { ...restored, coinIndex: qualifiedChange.mt_index, nextStateSalt: random32() };
  await restoredProviders.privateStateProvider.set('vault', restored);
  const commitmentBefore = (await queryLedger()).stateCommitment;
  const proofsBeforeReject = run.proofs;
  await assert.rejects(() => invoke('pay', [{ ...request, requestId: random32() }], { additionalCoinEncPublicKeyMappings: encryptionKeys(merchantWallet) }, restoredProviders), /Payment not permitted/);
  assert.equal(run.proofs, proofsBeforeReject, 'Overspend should be rejected before proof generation');
  assert.deepEqual((await queryLedger()).stateCommitment, commitmentBefore);
  await waitBalance(merchantWallet, color, PAY);
  await assert.rejects(() => invoke('pay', [request], {}, restoredProviders), /Request already used/);
  run.checks.push('A second equal payment exceeds remaining allowance and is rejected by generated contract pre-proof; chain commitment and recipient balance unchanged');
  run.checks.push('Replayed request rejected; encrypted provider reconstruction retained coin openings and accounting');

  const publicState = await vaultProviders.publicDataProvider.queryContractState(address);
  const ledger = vaultModule.ledger(publicState.data);
  assert.deepEqual(Object.keys(ledger).sort(), ['network','vaultId','owner','initialized','funded','paused','revoked','version','policyCommitment','stateCommitment','usedRequests'].sort());
  run.privacy = checkPaymentPrivacy(paid.public, publicState, {
    address, amount: PAY, allowance: LIMIT, perPayment: CEILING, spent: PAY,
    secrets: { ownerSecret, agentSecret, policySalt: initialPrivateState.policySalt, initialStateSalt: initialPrivateState.stateSalt, fundingStateSalt,
      currentStateSalt: privateState.stateSalt, depositNonce: deposit.nonce, changeNonce: privateState.state.coin.nonce, merchant, asset, agentKey: policy.agentKey },
  });
  run.checks.push('Exact public ledger fields, serialized payment/state and same-phase public transcript inspected for private openings, keys and numeric amount encodings');
  run.checks.push('Disclosure remains: network/vault identifiers, owner commitment, flags/version, policy/state commitments, request nullifiers, calls, timing; test mint amount is public');

  // Recover the entire change with OWNER authority, proving it remained in
  // contract custody and was usable after private-provider reconstruction.
  restored = await restoredProviders.privateStateProvider.get('vault');
  await restoredProviders.privateStateProvider.set('vault', { ...restored, ownerSecret, agentSecret: new Uint8Array(32), nextStateSalt: random32() });
  const withdrawal = await invoke('withdraw', [recipientOf(ownerWallet).bytes], { additionalCoinEncPublicKeyMappings: encryptionKeys(ownerWallet) }, restoredProviders);
  recordTx(run, 'owner-withdraw-remaining-change', withdrawal.public);
  await waitBalance(ownerWallet, color, CHANGE);
  await waitBalance(merchantWallet, color, PAY);
  const emptied = await restoredProviders.privateStateProvider.get('vault');
  assert.equal(emptied.state.hasCoin, false);
  assert.equal(emptied.state.spent, PAY);
  run.checks.push('Owner withdrawal finalized; owner change plus merchant payment equals funded amount, with no reusable vault coin');
  assert.ok(run.proofs >= 7, 'Missing real proof provider executions');
  success = true;
} finally {
  await finishRun(run, success);
}
