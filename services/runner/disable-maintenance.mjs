import assert from 'node:assert/strict';
import {
  ContractMaintenanceAuthority, MaintenanceUpdate, ReplaceAuthority,
  Intent, Transaction, signatureVerifyingKey, signData,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { submitTx } from '@midnight-ntwrk/midnight-js-contracts';

/** Construct the ledger-native equivalent of an irreversible authority removal.
 * SDK 4.1.1's submitReplaceAuthorityTx(undefined) generates a new key instead.
 * Ledger 8 documents threshold > committee size as an impossible authority.
 * The caller must explicitly select Preview; mainnet and implicit network
 * changes are rejected. Only an independently verified unfunded deployment is
 * eligible, and the deployment key is retained until chain confirmation.
 */
export function createDisableMaintenanceUpdate(address, authority, signingKey) {
  assert.equal(authority.committee.length, 1, 'Expected default single-member deployment authority');
  assert.equal(authority.threshold, 1, 'Unexpected maintenance threshold');
  assert.equal(authority.committee[0], signatureVerifyingKey(signingKey), 'Stored key does not authorize maintenance');
  assert.ok(authority.counter < 4294967295n, 'Maintenance counter exhausted');
  const disabled = new ContractMaintenanceAuthority([], 1, authority.counter + 1n);
  const unsigned = new MaintenanceUpdate(address, [new ReplaceAuthority(disabled)], authority.counter);
  return unsigned.addSignature(0n, signData(signingKey, unsigned.dataToSign));
}

export async function disableMaintenanceBeforeFunding(providers, address, isUnfunded, { networkId = 'undeployed' } = {}) {
  assert.ok(['undeployed', 'preview'].includes(networkId), 'Maintenance bootstrap requires an explicitly supported test network');
  assert.equal(getNetworkId(), networkId, 'Maintenance bootstrap network differs from configured SDK network');
  assert.equal(typeof isUnfunded, 'function', 'An unfunded-state verifier is required');
  const initial = await providers.publicDataProvider.queryContractState(address);
  assert.ok(initial, 'Contract not found');
  assert.equal(isUnfunded(initial), true, 'Disable maintenance before accepting any deposit');
  const current = initial.maintenanceAuthority;
  if (current.committee.length === 0 && current.threshold === 1) return null;
  const signingKey = await providers.privateStateProvider.getSigningKey(address);
  assert.ok(signingKey, 'Deployment signing key unavailable');
  const update = createDisableMaintenanceUpdate(address, current, signingKey);
  const intent = Intent.new(new Date(Date.now() + 3_600_000)).addMaintenanceUpdate(update);
  assert.equal(getNetworkId(), networkId, 'Maintenance bootstrap network changed during preparation');
  const tx = Transaction.fromParts(networkId, undefined, undefined, intent);
  const result = await submitTx(providers, { unprovenTx: tx });
  assert.equal(result.status, 'SucceedEntirely', 'Authority removal did not succeed entirely');
  const confirmed = await providers.publicDataProvider.queryContractState(address);
  assert.ok(confirmed, 'Cannot verify maintenance removal');
  assert.equal(confirmed.maintenanceAuthority.committee.length, 0, 'Maintenance committee is still active');
  assert.equal(confirmed.maintenanceAuthority.threshold, 1, 'Maintenance threshold was not disabled');
  assert.equal(confirmed.maintenanceAuthority.counter, current.counter + 1n, 'Unexpected maintenance counter');
  // Do not erase any key until independent on-chain inspection has succeeded.
  if (typeof providers.privateStateProvider.removeSigningKey === 'function') {
    await providers.privateStateProvider.removeSigningKey(address);
  }
  return result;
}
