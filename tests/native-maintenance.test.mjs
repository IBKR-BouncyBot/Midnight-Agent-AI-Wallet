import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContractMaintenanceAuthority, sampleSigningKey, signatureVerifyingKey,
  sampleContractAddress, verifySignature,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { createDisableMaintenanceUpdate } from '../services/runner/disable-maintenance.mjs';

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
