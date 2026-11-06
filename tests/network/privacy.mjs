import assert from 'node:assert/strict';
import { entryPointHash } from '@midnight-ntwrk/midnight-js-protocol/ledger';

function encodings(value) {
  assert.equal(typeof value, 'bigint', 'Privacy amount must be an integer');
  assert.ok(value > 0n && value < (1n << 64n), 'Privacy amount outside application bounds');
  const result = [Buffer.from(value.toString(), 'utf8')];
  for (const width of [8, 16, 32]) {
    const little = Buffer.alloc(width); let remaining = value;
    for (let i = 0; i < width; i++) { little[i] = Number(remaining & 255n); remaining >>= 8n; }
    result.push(little, Buffer.from(little).reverse());
  }
  return result;
}

function transcriptBytes(value, found = [], seen = new Set()) {
  if (value instanceof Uint8Array) { found.push(Buffer.from(value)); return found; }
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (Symbol.iterator in value) for (const item of value) transcriptBytes(item, found, seen);
  else for (const item of Object.values(value)) transcriptBytes(item, found, seen);
  return found;
}

/** Inspects a FINALIZED real transaction and public contract state. It never
 * logs private data. Literal absence is a bounded disclosure test, not a proof
 * against inference, timing correlation or every possible encoding.
 * Use distinctive test amounts to avoid coincidental matches with unrelated
 * metadata; investigate any match rather than disabling the check.
 */
export function checkPaymentPrivacy(publicTx, publicState, {
  address, amount, allowance, perPayment, spent, secrets,
}) {
  assert.equal(publicTx.status, 'SucceedEntirely', 'Privacy inspection requires successful finality');
  const tx = publicTx.tx;
  assert.ok(tx && typeof tx.serialize === 'function', 'Actual finalized transaction required');
  assert.ok(publicState && typeof publicState.serialize === 'function', 'Actual public contract state required');
  assert.ok(tx.intents instanceof Map && tx.intents.size > 0, 'Missing transaction intents');
  const offers = [
    ...(tx.guaranteedOffer ? [{ phase: 'guaranteed', segment: 0, offer: tx.guaranteedOffer }] : []),
    ...Array.from(tx.fallibleOffer ?? [], ([segment, offer]) => ({ phase: 'fallible', segment, offer })),
  ];
  assert.equal(offers.length, 1, 'Payment must use exactly one shielded offer segment');
  const { phase, segment, offer } = offers[0];
  const allActions = Array.from(tx.intents, ([intentSegment, intent]) =>
    intent.actions.map((action) => ({ intentSegment, action }))).flat();
  const calls = allActions.filter(({ action }) => 'guaranteedTranscript' in action && action.address === address);
  assert.equal(calls.length, 1, 'Expected exactly one inspected call to the vault');
  const { action: call, intentSegment } = calls[0];
  assert.equal(entryPointHash(call.entryPoint), entryPointHash('pay'), 'Inspected call is not pay');
  assert.ok(call.proof && typeof call.proof.serialize === 'function', 'Finalized payment has no serialized contract proof');
  const contractProofBytes = call.proof.serialize().length;
  assert.ok(contractProofBytes > 0, 'Finalized payment contract proof is empty');
  const transcript = phase === 'guaranteed' ? call.guaranteedTranscript : call.fallibleTranscript;
  const otherTranscript = phase === 'guaranteed' ? call.fallibleTranscript : call.guaranteedTranscript;
  assert.ok(transcript, 'Payment transcript does not match the shielded offer phase');
  assert.equal(otherTranscript, undefined, 'Payment contract effects span both phases');
  if (phase === 'fallible') assert.equal(intentSegment, segment, 'Contract and shielded offer use different fallible segments');
  assert.ok(allActions.length === 1, 'Unexpected additional contract actions in standalone payment');
  const effects = transcript.effects;
  assert.equal(effects.claimedNullifiers.length, 1, 'Expected one contract coin spend');
  assert.equal(effects.claimedShieldedSpends.length, 2, 'Expected recipient and change commitments');
  assert.equal(effects.claimedShieldedReceives.length, 1, 'Expected one change receive');
  assert.ok(effects.claimedShieldedSpends.includes(effects.claimedShieldedReceives[0]), 'Change receive is not a claimed output');
  assert.equal(effects.claimedContractCalls.length, 0, 'Unexpected cross-contract effect');

  assert.equal(offer.inputs.length, 1, 'Expected one shielded input');
  assert.equal(offer.outputs.length, 2, 'Expected two shielded outputs');
  assert.equal(offer.transients.length, 0, 'Unexpected transient shielded coin');
  assert.equal(offer.inputs[0].contractAddress, address, 'Input is not owned by vault');
  assert.equal(offer.inputs[0].nullifier, effects.claimedNullifiers[0], 'Input nullifier does not match payment transcript');
  assert.deepEqual(offer.outputs.map((o) => o.commitment).sort(), [...effects.claimedShieldedSpends].sort(), 'Output commitments do not match payment transcript');
  const change = offer.outputs.filter((o) => o.contractAddress === address);
  assert.equal(change.length, 1, 'Expected one change output in vault custody');
  assert.equal(change[0].commitment, effects.claimedShieldedReceives[0], 'Change output does not match payment receive');
  assert.equal(offer.outputs.filter((o) => o.contractAddress === undefined).length, 1, 'Expected one user-owned recipient output');

  const surfaces = [
    ['serialized transaction', [Buffer.from(tx.serialize())]],
    ['serialized contract state', [Buffer.from(publicState.serialize())]],
    [`${phase} public transcript`, transcriptBytes(transcript.program)],
  ];
  let secretCount = 0;
  for (const [label, value] of Object.entries(secrets)) {
    assert.ok(value instanceof Uint8Array && value.length === 32, 'Expected a 32-byte privacy sample');
    secretCount++;
    for (const [surface, buffers] of surfaces) {
      assert.ok(!buffers.some((buffer) => buffer.includes(Buffer.from(value))), `${label} appears in ${surface}`);
    }
  }
  for (const [label, value] of Object.entries({ amount, allowance, perPayment, spent })) {
    for (const encoding of encodings(value)) for (const [surface, buffers] of surfaces) {
      assert.ok(!buffers.some((buffer) => buffer.includes(encoding)), `${label} encoding appears in ${surface}`);
    }
  }
  return {
    inspectedContractCalls: calls.length,
    phase,
    segment,
    contractProofBytes,
    contractInputs: offer.inputs.length,
    recipientOutputs: 1,
    contractChangeOutputs: change.length,
    sampledSecretValuesAbsent: secretCount,
    amountEncodingsAbsent: ['payment', 'allowance', 'per-payment ceiling', 'spent total'],
    inspectedSurfaces: surfaces.map(([name]) => name),
    limitation: 'Literal encoding checks do not establish absence of inference or timing disclosures',
  };
}
