import { Transaction, ContractCall } from '@midnight-ntwrk/midnight-js-protocol/ledger';

const fail = () => { const error = new Error('LACE_TRANSACTION_CHANGED'); error.code = 'LACE_TRANSACTION_CHANGED'; throw error; };
const bytesEqual = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const emptyPreview = Transaction.fromParts('preview').eraseProofs();

// Erasure gives a mutable, no-binding native projection. It preserves contract
// actions/transcripts (including deploy/maintenance contents), order and TTL.
// Wallet balancing may append unshielded inputs/change and DUST fee interactions.
function applicationIntent(intent) {
  const projected = intent.eraseProofs().eraseSignatures();
  projected.guaranteedUnshieldedOffer = undefined;
  projected.fallibleUnshieldedOffer = undefined;
  projected.dustActions = undefined;
  return projected.serialize();
}
function consume(original, balanced, key, extraAllowed = () => true) {
  const remaining = new Map();
  for (const item of original) {
    const id = key(item); remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  for (const item of balanced) {
    const id = key(item); const count = remaining.get(id) ?? 0;
    if (count) remaining.set(id, count - 1);
    else if (!extraAllowed(item)) fail();
  }
  if ([...remaining.values()].some(count => count !== 0)) fail();
}
const inputKey = input => JSON.stringify([input.value.toString(), input.owner, input.type, input.intentHash, input.outputNo]);
const outputKey = output => JSON.stringify([output.value.toString(), output.owner, output.type]);
function unshieldedOffer(original, balanced) {
  consume(original?.inputs ?? [], balanced?.inputs ?? [], inputKey);
  consume(original?.outputs ?? [], balanced?.outputs ?? [], outputKey);
}
function shieldedOffer(original, balanced) {
  for (const group of ['inputs', 'outputs', 'transients']) {
    // Component serialization includes commitment/nullifier, encrypted recipient
    // data and exact proof. Merge preserves these original component bytes.
    consume(original?.[group] ?? [], balanced?.[group] ?? [], item => hex(item.serialize()), item => item.contractAddress === undefined);
  }
}

/** Preserve the prepared application's native intent and coin effects before
 * accepting a wallet-balanced response. This is not local proof verification.
 * Wallet-owned additions/fee selection remain the connected wallet's authority;
 * no new contract action or contract-owned coin interaction may be introduced.
 * The bounded demo does not prepare DUST actions itself (Lace owns DUST setup).
 */
export function assertBalancedTransaction(prepared, balanced) {
  try {
    if (!(prepared instanceof Transaction) || !(balanced instanceof Transaction) || prepared.rewards || balanced.rewards) fail();
    // merge is the native network compatibility check. The empty operand adds
    // no effects; erasing proofs here is only a comparison, never a submitted tx.
    prepared.eraseProofs().merge(emptyPreview); balanced.eraseProofs().merge(emptyPreview);
    const before = prepared.intents ?? new Map(); const after = balanced.intents ?? new Map();
    if (before.size === 0) fail();
    for (const [segment, original] of before) {
      const returned = after.get(segment);
      if (!returned || original.dustActions !== undefined
        || !bytesEqual(applicationIntent(original), applicationIntent(returned))) fail();
      const originalActions = original.actions; const returnedActions = returned.actions;
      if (originalActions.length !== returnedActions.length) fail();
      for (let index = 0; index < originalActions.length; index++) {
        const action = originalActions[index]; const next = returnedActions[index];
        if (action instanceof ContractCall && (!(next instanceof ContractCall)
          || !bytesEqual(action.proof.serialize(), next.proof.serialize()))) fail();
      }
      unshieldedOffer(original.guaranteedUnshieldedOffer, returned.guaranteedUnshieldedOffer);
      unshieldedOffer(original.fallibleUnshieldedOffer, returned.fallibleUnshieldedOffer);
    }
    for (const [segment, intent] of after) if (!before.has(segment) && intent.actions.length !== 0) fail();
    shieldedOffer(prepared.guaranteedOffer, balanced.guaranteedOffer);
    const originalFallible = prepared.fallibleOffer ?? new Map(); const returnedFallible = balanced.fallibleOffer ?? new Map();
    for (const segment of new Set([...originalFallible.keys(), ...returnedFallible.keys()])) {
      shieldedOffer(originalFallible.get(segment), returnedFallible.get(segment));
    }
  } catch { fail(); }
}
