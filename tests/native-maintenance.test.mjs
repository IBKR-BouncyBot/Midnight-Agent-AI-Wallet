import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContractMaintenanceAuthority, sampleSigningKey, signatureVerifyingKey,
  sampleContractAddress, verifySignature,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createDisableMaintenanceUpdate, disableMaintenanceBeforeFunding } from '../services/runner/disable-maintenance.mjs';

test('native maintenance replacement encodes impossible threshold and authenticates current authority', () => {
  const key = sampleSigningKey();
  const authority = new ContractMaintenanceAuthority([signatureVerifyingKey(key)], 1, 0n);
  const update = createDisableMaintenanceUpdate(sampleContractAddress(), authority, key);
  assert.equal(update.counter, 0n);
  assert.equal(update.signatures.length, 1);
  assert.equal(update.signatures[0][0], 0n);
  assert.equal(verifySignature(signatureVerifyingKey(key), update.dataToSign, update.signatures[0][1]), true);
  const disabled = ContractMaintenanceAuthority.deserialize(update.updates[0].authority.serialize());
  assert.equal(disabled.committee.length, 0);
  assert.equal(disabled.threshold, 1);
  assert.equal(disabled.counter, 1n);
});

test('maintenance removal rejects wrong signer, non-default authority and counter overflow', () => {
  const key = sampleSigningKey(); const other = sampleSigningKey(); const address = sampleContractAddress();
  const authority = new ContractMaintenanceAuthority([signatureVerifyingKey(key)], 1, 0n);
  assert.throws(() => createDisableMaintenanceUpdate(address, authority, other), /does not authorize/);
  assert.throws(() => createDisableMaintenanceUpdate(address, new ContractMaintenanceAuthority([], 1), key), /single-member/);
  assert.throws(() => createDisableMaintenanceUpdate(address, new ContractMaintenanceAuthority([signatureVerifyingKey(key)], 1, 4294967295n), key), /counter exhausted/);
});

test('maintenance bootstrap requires explicit matching Preview selection and rejects mainnet before reading state', async () => {
  let queries = 0;
  const providers = { publicDataProvider: { async queryContractState() {
    queries++;
    return { maintenanceAuthority: new ContractMaintenanceAuthority([], 1, 1n) };
  } } };
  const address = sampleContractAddress();
  setNetworkId('preview');
  try {
    await assert.rejects(disableMaintenanceBeforeFunding(providers, address, () => true), /network differs/);
    await assert.rejects(disableMaintenanceBeforeFunding(providers, address, () => true, { networkId: 'mainnet' }), /supported test network/);
    assert.equal(queries, 0);
    assert.equal(await disableMaintenanceBeforeFunding(providers, address, () => true, { networkId: 'preview' }), null);
    assert.equal(queries, 1);
    await assert.rejects(disableMaintenanceBeforeFunding(providers, address, () => false, { networkId: 'preview' }), /before accepting any deposit/);
  } finally { setNetworkId('undeployed'); }
});
