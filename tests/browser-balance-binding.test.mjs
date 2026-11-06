import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, Intent, CostModel, ContractDeploy, ContractState, ContractMaintenanceAuthority,
  MaintenanceUpdate, ReplaceAuthority, UnshieldedOffer, ZswapOutput, ZswapOffer, createShieldedCoinInfo,
  ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { assertBalancedTransaction } from '../packages/browser-demo/balance-binding.mjs';

const ttl = new Date('2030-01-01T00:00:00Z');
const contractAddress = '11'.repeat(32);
const token = '22'.repeat(32);
const assertChanged = fn => assert.throws(fn, error => error.code === 'LACE_TRANSACTION_CHANGED' && error.message === error.code);
async function empty(network = 'preview', expires = ttl, segment = 1) {
  const transaction = Transaction.fromParts(network).addIntent({ tag: 'specific', value: segment }, Intent.new(expires));
  return transaction.prove({ check() { throw new Error('No proof expected'); }, prove() { throw new Error('No proof expected'); } }, CostModel.initialCostModel());
}
function maintenance(address = contractAddress) {
  return new MaintenanceUpdate(address, [new ReplaceAuthority(new ContractMaintenanceAuthority([], 1, 1n))], 0n);
}
// Shielded-only cases use native mockProve solely to obtain structurally valid
// serialized components. They do not establish proof validity or settlement.
function shielded(coin, recipient = contractAddress, segment = 1) {
  const output = recipient === 'user'
    ? ZswapOutput.new(coin, segment, ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(3)).coinPublicKey,
      ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(3)).encryptionPublicKey)
    : ZswapOutput.newContractOwned(coin, segment, recipient);
  return Transaction.fromParts('preview').addIntent({ tag: 'specific', value: segment }, Intent.new(ttl))
    .addZswapOffer({ tag: 'specific', value: segment }, ZswapOffer.fromOutput(output)).mockProve();
}

test('native binding and wallet fee intents preserve the application projection', async () => {
  const original = await empty(); const fee = await empty('preview', new Date('2030-01-02'), 2);
  assert.doesNotThrow(() => assertBalancedTransaction(original, original.bind().merge(fee.bind())));
  assert.equal(original.intents.size, 1);
});

test('valid unrelated transaction, network, segment or expiry substitution is rejected', async () => {
  const original = await empty();
  for (const changed of [await empty('preprod'), await empty('preview', new Date('2031-01-01')),
    await empty('preview', ttl, 7)]) assertChanged(() => assertBalancedTransaction(original, changed.bind()));
});

test('native deployment and maintenance actions cannot be removed, substituted or injected', () => {
  const deployed = Transaction.fromParts('preview', undefined, undefined, Intent.new(ttl).addDeploy(new ContractDeploy(new ContractState()))).mockProve();
  const otherDeployment = Transaction.fromParts('preview', undefined, undefined, Intent.new(ttl).addDeploy(new ContractDeploy(new ContractState()))).mockProve();
  assert.doesNotThrow(() => assertBalancedTransaction(deployed, deployed));
  assertChanged(() => assertBalancedTransaction(deployed, otherDeployment));
  const first = Transaction.fromParts('preview', undefined, undefined, Intent.new(ttl).addMaintenanceUpdate(maintenance())).mockProve();
  const changed = Transaction.fromParts('preview', undefined, undefined, Intent.new(ttl).addMaintenanceUpdate(maintenance('44'.repeat(32)))).mockProve();
  assert.doesNotThrow(() => assertBalancedTransaction(first, first));
  assertChanged(() => assertBalancedTransaction(first, changed));
  const injected = Transaction.fromParts('preview').addIntent({ tag: 'specific', value: 2 }, Intent.new(ttl).addMaintenanceUpdate(maintenance())).mockProve();
  const noAction = Transaction.fromParts('preview', undefined, undefined, Intent.new(ttl)).mockProve();
  assertChanged(() => assertBalancedTransaction(noAction, noAction.merge(injected)));
});

test('unshielded original outputs remain exact while wallet change can be appended', async () => {
  const output = { value: 5n, owner: '33'.repeat(32), type: token };
  const intent = Intent.new(ttl); intent.guaranteedUnshieldedOffer = UnshieldedOffer.new([], [output], []);
  const original = await Transaction.fromParts('preview', undefined, undefined, intent).prove(
    { check() { throw 0; }, prove() { throw 0; } }, CostModel.initialCostModel());
  const changed = Transaction.deserialize('signature', 'proof', 'pre-binding', original.serialize());
  const updated = changed.intents.get(1);
  updated.guaranteedUnshieldedOffer = UnshieldedOffer.new([], [output, { ...output, value: 1n }], []);
  changed.intents = new Map([[1, updated]]);
  assert.doesNotThrow(() => assertBalancedTransaction(original, changed.bind()));
  const replacement = Transaction.deserialize('signature', 'proof', 'pre-binding', original.serialize());
  const replacedIntent = replacement.intents.get(1);
  replacedIntent.guaranteedUnshieldedOffer = UnshieldedOffer.new([], [{ ...output, value: 6n }], []);
  replacement.intents = new Map([[1, replacedIntent]]);
  assertChanged(() => assertBalancedTransaction(original, replacement.bind()));
});

test('contract coin effects cannot change commitment, owner, phase or segment', () => {
  const coin = createShieldedCoinInfo(token, 5n); const original = shielded(coin);
  assert.doesNotThrow(() => assertBalancedTransaction(original, original));
  assertChanged(() => assertBalancedTransaction(original, shielded(createShieldedCoinInfo(token, 6n))));
  assertChanged(() => assertBalancedTransaction(original, shielded(coin, '44'.repeat(32))));
  assertChanged(() => assertBalancedTransaction(original, shielded(coin, contractAddress, 2)));
  const guaranteed = Transaction.fromParts('preview', ZswapOffer.fromOutput(ZswapOutput.newContractOwned(coin, undefined, contractAddress)),
    undefined, Intent.new(ttl)).mockProve();
  assertChanged(() => assertBalancedTransaction(original, guaranteed));
});

test('wallet-owned balancing additions are permitted but extra contract-owned outputs are refused', () => {
  const original = shielded(createShieldedCoinInfo(token, 5n));
  const walletExtra = shielded(createShieldedCoinInfo(token, 2n), 'user', 2);
  assert.doesNotThrow(() => assertBalancedTransaction(original, original.merge(walletExtra)));
  const contractExtra = shielded(createShieldedCoinInfo(token, 2n), contractAddress, 2);
  assertChanged(() => assertBalancedTransaction(original, original.merge(contractExtra)));
});
