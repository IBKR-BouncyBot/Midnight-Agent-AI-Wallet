import { createUnprovenCallTxFromInitialStates, getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { parseCoinPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';
import { Transaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';

/**
 * Exact staged Midnight.js 4.1.1 operations. No testkit or network-test imports.
 * buildPaymentCall, captureCandidate, verifyConfirmed, verifyCoinQualification
 * and observeTransaction are REQUIRED trusted
 * application adapters; this module alone is not an operational wallet backend.
 * The configured proof provider must be local or explicitly trusted.
 */
export function createMidnightSdkAdapter({ providers, compiledContract, networkId,
  buildPaymentCall, captureCandidate, verifyConfirmed, verifyCoinQualification, observeTransaction, transactionTtl, proofTimeoutMs = 180_000 }) {
  if (!['undeployed', 'preview', 'preprod'].includes(networkId)
      || ![buildPaymentCall, captureCandidate, verifyConfirmed, verifyCoinQualification, observeTransaction, transactionTtl].every((fn) => typeof fn === 'function')
      || !Number.isSafeInteger(proofTimeoutMs) || proofTimeoutMs < 1) throw new TypeError('Complete trusted SDK configuration required');
  const assertNetwork = () => {
    // Midnight.js currently has a global network ID. Never switch it under a running vault.
    if (getNetworkId() !== networkId) throw new Error('Midnight SDK network changed');
  };
  return {
    async prepare(input) {
      assertNetwork();
      if ((input.scope.network === 'local' ? 'undeployed' : input.scope.network) !== networkId) throw new Error('Wrong SDK network');
      const chain = await getPublicStates(providers.publicDataProvider, input.scope.contractAddress);
      const call = await buildPaymentCall({ ...input, chain });
      if (!call || !Array.isArray(call.args) || !Object.hasOwn(call, 'privateState')) throw new Error('Invalid payment call');
      const prepared = await createUnprovenCallTxFromInitialStates(providers.zkConfigProvider, {
        compiledContract, contractAddress: input.scope.contractAddress, circuitId: 'pay', args: call.args,
        coinPublicKey: parseCoinPublicKeyToHex(providers.walletProvider.getCoinPublicKey(), networkId),
        initialContractState: chain.contractState, initialZswapChainState: chain.zswapChainState,
        ledgerParameters: chain.ledgerParameters, initialPrivateState: call.privateState,
        additionalCoinEncPublicKeyMappings: call.additionalCoinEncPublicKeyMappings,
      }, providers.walletProvider.getEncryptionPublicKey());
      // Never log/stringify the private result. These exact bytes go only into the
      // authenticated encrypted private store used by PaymentRunner.
      // Capture expected public commitments/version from the actual generated
      // nextContractState alongside the private candidate, so the observer can
      // bind restored openings to that exact circuit result after finality.
      const candidate = await captureCandidate({ prepared, input, call });
      if (candidate === undefined) throw new Error('Missing captured candidate');
      return { candidate,
        unprovenBytes: prepared.private.unprovenTx.serialize() };
    },
    async proveAndBalance({ unprovenBytes }) {
      assertNetwork();
      const unproven = Transaction.deserialize('signature', 'pre-proof', 'pre-binding', unprovenBytes);
      const proven = await providers.proofProvider.proveTx(unproven, { timeout: proofTimeoutMs });
      const ttl = transactionTtl();
      if (!(ttl instanceof Date) || !Number.isFinite(ttl.getTime())) throw new Error('Explicit transaction TTL required');
      const signed = await providers.walletProvider.balanceTx(proven, ttl);
      const signedBytes = signed.serialize();
      const restored = Transaction.deserialize('signature', 'proof', 'binding', signedBytes);
      if (!Buffer.from(restored.serialize()).equals(Buffer.from(signedBytes))) throw new Error('Signed transaction roundtrip mismatch');
      return { signedBytes, transactionIds: restored.identifiers() };
    },
    async submit({ signedBytes, transactionIds }) {
      assertNetwork();
      const signed = Transaction.deserialize('signature', 'proof', 'binding', signedBytes);
      const ids = signed.identifiers();
      if (ids.length !== transactionIds.length || ids.some((id, index) => id !== transactionIds[index])) throw new Error('Signed transaction identifiers changed');
      return providers.midnightProvider.submitTx(signed);
    },
    async verifyConfirmed(input) { assertNetwork(); return verifyConfirmed({ ...input, providers }); },
    async verifyCoinQualification(input) { assertNetwork(); return verifyCoinQualification({ ...input, providers }); },
    async observe(input) { assertNetwork(); return observeTransaction({ ...input, providers }); },
  };
}
