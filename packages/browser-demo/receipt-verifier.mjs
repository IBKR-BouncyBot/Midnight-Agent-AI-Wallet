import { Transaction, ContractCall, Proof, ZswapSecretKeys, ZswapLocalState,
  ZswapOutput, entryPointHash } from '@midnight-ntwrk/ledger-v8';

const hex32 = /^[0-9a-f]{64}$/;
const txId = /^00[0-9a-f]{64}$/;
const maxAmount = (1n << 64n) - 1n;
const fail = () => { const error = new Error('MERCHANT_RECEIPT_NOT_VERIFIED'); error.code = error.message; throw error; };
const requireThat = condition => { if (!condition) fail(); };
const sameSet = (left, right) => left.length === right.length
  && new Set(left).size === left.length && new Set(right).size === right.length
  && left.every(value => right.includes(value));
const bytesEqual = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const isProof = proof => proof instanceof Proof && proof.instance === 'proof' && proof.serialize().length > 0;

/** A receipt checker, not a synced wallet. It decrypts only the one recipient
 * output of an already finalized, exactly identified Preview vault payment.
 *
 * The caller MUST obtain finality from its trusted public-data provider and bind
 * expectedTransactionIds to its persisted signed transaction. This checker does
 * not independently validate proofs, consensus, block inclusion, or spendability.
 * Native scratch-state coin indices are deliberately never returned or saved.
 */
export function createMerchantReceiptVerifier({ seed, network = 'preview' } = {}) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32
    || (typeof network === 'string' ? network : network?.networkId) !== 'preview') fail();
  const seedCopy = new Uint8Array(seed);
  let keys;
  try { keys = ZswapSecretKeys.fromSeed(seedCopy); } finally { seedCopy.fill(0); }
  const coinPublicKey = keys.coinPublicKey;
  const encryptionPublicKey = keys.encryptionPublicKey;
  const requireOpen = () => requireThat(keys !== undefined);

  return Object.freeze({
    getCoinPublicKey() { requireOpen(); return coinPublicKey; },
    getEncryptionPublicKey() { requireOpen(); return encryptionPublicKey; },
    /** Verification is intentionally idempotent. Receipt accounting/deduplication
     * belongs in the durable journal, never in this transient decryption object. */
    verifyReceipt({ finalized, expectedAsset, expectedAmount, contractAddress, expectedTransactionIds } = {}) {
      try {
        requireOpen();
        requireThat(typeof expectedAsset === 'string' && hex32.test(expectedAsset)
          && typeof contractAddress === 'string' && hex32.test(contractAddress));
        requireThat(typeof expectedAmount === 'bigint' || (typeof expectedAmount === 'string' && /^[1-9][0-9]{0,19}$/.test(expectedAmount)));
        const amount = BigInt(expectedAmount);
        requireThat(amount > 0n && amount <= maxAmount);
        requireThat(Array.isArray(expectedTransactionIds) && expectedTransactionIds.length > 0
          && expectedTransactionIds.length <= 256 && expectedTransactionIds.every(id => typeof id === 'string' && txId.test(id))
          && new Set(expectedTransactionIds).size === expectedTransactionIds.length);
        requireThat(finalized?.status === 'SucceedEntirely' && typeof finalized.txId === 'string' && txId.test(finalized.txId)
          && expectedTransactionIds.includes(finalized.txId) && typeof finalized.blockHash === 'string' && hex32.test(finalized.blockHash)
          && finalized.tx instanceof Transaction);
        const raw = finalized.tx.serialize();
        requireThat(raw.length > 0 && raw.length <= 16 * 1024 * 1024);
        // Enforce actual native proof/binding markers and detach from caller data.
        const transaction = Transaction.deserialize('signature', 'proof', 'binding', raw);
        requireThat(bytesEqual(raw, transaction.serialize()) && !transaction.rewards);
        const identifiers = transaction.identifiers();
        requireThat(identifiers.includes(finalized.txId) && sameSet(identifiers, expectedTransactionIds));
        // Native compatibility check; no hand-written network-byte parsing.
        transaction.eraseProofs().merge(Transaction.fromParts('preview').eraseProofs());
        const actions = [...(transaction.intents ?? [])].flatMap(([segment, intent]) => intent.actions.map(action => ({ segment, action })));
        requireThat(actions.length === 1);
        const { segment, action: call } = actions[0];
        requireThat(call instanceof ContractCall && call.address === contractAddress
          && entryPointHash(call.entryPoint) === entryPointHash('pay') && isProof(call.proof)
          && call.guaranteedTranscript === undefined && call.fallibleTranscript !== undefined);
        requireThat(transaction.guaranteedOffer === undefined && transaction.fallibleOffer?.size === 1);
        const offer = transaction.fallibleOffer.get(segment);
        requireThat(offer !== undefined && offer.inputs.length === 1 && offer.transients.length === 0);
        const effects = call.fallibleTranscript.effects;
        requireThat(offer.inputs[0].contractAddress === contractAddress && isProof(offer.inputs[0].proof)
          && effects.claimedNullifiers.length === 1 && effects.claimedNullifiers[0] === offer.inputs[0].nullifier
          && effects.claimedContractCalls.length === 0);
        for (const field of ['shieldedMints', 'unshieldedMints', 'unshieldedInputs', 'unshieldedOutputs', 'claimedUnshieldedSpends']) {
          requireThat(effects[field] instanceof Map && effects[field].size === 0);
        }
        const recipients = offer.outputs.filter(output => output.contractAddress === undefined);
        const change = offer.outputs.filter(output => output.contractAddress === contractAddress);
        requireThat(recipients.length === 1 && change.length <= 1 && offer.outputs.length === recipients.length + change.length
          && offer.outputs.every(output => isProof(output.proof))
          && sameSet(offer.outputs.map(output => output.commitment), effects.claimedShieldedSpends)
          && sameSet(change.map(output => output.commitment), effects.claimedShieldedReceives));
        const output = recipients[0];
        // Native decryption also authenticates the decrypted coin against its
        // user-owned commitment. No global Merkle history is needed to receive.
        const received = new ZswapLocalState().applyWithChanges(keys, offer);
        const coins = received.changes.flatMap(change => change.receivedCoins);
        requireThat(coins.length === 1 && received.state.coins.size === 1);
        const coin = coins[0];
        requireThat(coin.type === expectedAsset && coin.value === amount);
        const unqualifiedCoin = { type: coin.type, nonce: coin.nonce, value: coin.value };
        requireThat(ZswapOutput.new(unqualifiedCoin, segment, coinPublicKey, encryptionPublicKey).commitment === output.commitment);
        // Deliberately omit coin nonce, scratch mt_index, wallet tree and secrets.
        return Object.freeze({ transactionId: finalized.txId, blockHash: finalized.blockHash,
          segment, tokenId: expectedAsset, amountAtomic: amount.toString(), outputCommitment: output.commitment,
          recipientReceiptVerified: true });
      } catch { fail(); }
    },
    close() { if (keys !== undefined) { keys.clear(); keys = undefined; } },
  });
}
