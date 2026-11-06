import test from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitContext } from '@midnight-ntwrk/compact-runtime';
import { ChargedState, LedgerParameters, partitionTranscripts, PreTranscript, QueryContext, StateValue } from '@midnight-ntwrk/ledger-v8';
import { fixture, bytes, zero, NOW } from './support/native-vault.mjs';

test('compiled contract spends exact value to approved recipient and keeps change in custody', () => {
  const f = fixture(); const coin = f.fund();
  const out = f.call('pay', f.request());
  const zswap = out.context.currentZswapLocalState;
  assert.equal(zswap.inputs.length, 1);
  assert.deepEqual(zswap.inputs[0].nonce, coin.nonce);
  assert.equal(zswap.outputs.length, 2);
  const paid = zswap.outputs.find((o) => o.recipient.is_left);
  const change = zswap.outputs.find((o) => !o.recipient.is_left);
  assert.deepEqual(paid.recipient.left.bytes, f.recipient);
  assert.equal(paid.coinInfo.value, 40n);
  assert.equal(change.coinInfo.value, 80n);
  assert.equal(Buffer.from(change.recipient.right.bytes).toString('hex'), f.address);
  assert.equal(f.ps.state.spent, 40n);
  assert.equal(f.ps.state.sequence, 2n);
  assert.equal(f.ps.coinIndex, null, 'a new change coin must be qualified after settlement');
  assert.equal(f.ledger().usedRequests.size(), 1n);
});

for (const [name, change, error] of [
  ['zero amount', { amount: 0n }, /Payment not permitted/],
  ['per-payment excess', { amount: 61n }, /Payment not permitted/],
  ['wrong asset', { asset: bytes() }, /Asset mismatch/],
  ['unknown recipient', { recipient: bytes() }, /Recipient not approved/],
  ['zero recipient', { recipient: zero() }, /Recipient not approved/],
  ['wrong network', { network: bytes() }, /Deployment scope mismatch/],
  ['wrong vault', { vault: bytes() }, /Deployment scope mismatch/],
  ['wrong contract', { deployedContract: bytes() }, /Deployment scope mismatch/],
  ['stale policy', { expectedVersion: 0n }, /Stale policy version/],
  ['empty request ID', { requestId: zero() }, /Request ID required/],
  ['inverted validity', { validFrom: 99n, validUntil: 98n }, /Invalid validity period/],
  ['expired request', { validFrom: BigInt(NOW - 100), validUntil: BigInt(NOW - 1) }, /outside validity period/],
  ['future request', { validFrom: BigInt(NOW + 1), validUntil: BigInt(NOW + 10) }, /outside validity period/],
  ['request exceeds private expiry', { validUntil: BigInt(NOW + 3601) }, /Invalid validity period/],
  ['overflow amount', { amount: 1n << 64n }, /range|18446744073709551615|Uint|expected/i],
]) {
  test(`compiled payment rejects ${name} without advancing state`, () => {
    const f = fixture(); f.fund();
    const before = f.ledger().stateCommitment;
    assert.throws(() => f.call('pay', f.request(change)), error);
    assert.deepEqual(f.ledger().stateCommitment, before);
    assert.equal(f.ps.state.spent, 0n);
    assert.equal(f.ledger().usedRequests.size(), 0n);
  });
}

test('cumulative allowance accepts exact boundary then rejects overspend', () => {
  const f = fixture(); f.fund();
  f.call('pay', f.request({ amount: 60n })); f.qualifyForRuntimeOnly();
  assert.throws(() => f.call('pay', f.request({ amount: 41n })), /Payment not permitted/);
  f.call('pay', f.request({ amount: 40n })); f.qualifyForRuntimeOnly();
  assert.equal(f.ps.state.spent, 100n);
  assert.throws(() => f.call('pay', f.request({ amount: 1n })), /Payment not permitted/);
});

test('uint64 maximum allowance does not overflow during cumulative accounting', () => {
  const maximum = (1n << 64n) - 1n;
  const f = fixture({ perPayment: maximum, allowance: maximum }); f.fund(maximum);
  f.call('pay', f.request({ amount: maximum - 1n })); f.qualifyForRuntimeOnly();
  assert.equal(f.ps.state.spent, maximum - 1n);
  assert.throws(() => f.call('pay', f.request({ amount: 2n })), /Payment not permitted/);
  f.call('pay', f.request({ amount: 1n }));
  assert.equal(f.ps.state.spent, maximum);
  assert.equal(f.ps.state.hasCoin, false);
});

test('payment cannot exceed actual coin value even with a larger allowance', () => {
  const f = fixture(); f.fund(20n);
  assert.throws(() => f.call('pay', f.request({ amount: 21n })), /Insufficient vault funds/);
  const out = f.call('pay', f.request({ amount: 20n }));
  assert.equal(out.context.currentZswapLocalState.outputs.length, 1);
  assert.equal(f.ps.state.hasCoin, false);
});

test('fee payer identity grants no agent authority and cannot redirect a payment', () => {
  const f = fixture(); f.fund();
  const good = f.ps.agentSecret;
  f.ps = { ...f.ps, agentSecret: bytes() };
  assert.throws(() => f.call('pay', f.request()), /Agent authorization required/);
  f.ps = { ...f.ps, agentSecret: good, ownerSecret: zero() };
  f.coinPublicKey = Buffer.from(bytes()).toString('hex');
  const out = f.call('pay', f.request());
  assert.deepEqual(out.context.currentZswapLocalState.outputs[0].recipient.left.bytes, f.recipient);
});

test('agent cannot call owner administration, fund or withdraw', () => {
  const f = fixture(); const coin = f.fund();
  f.ps = { ...f.ps, ownerSecret: zero() };
  for (const [name, args] of [
    ['setPaused', [true]], ['revoke', []], ['withdraw', [f.recipient]],
    ['replacePolicy', [f.ps.policy, bytes()]], ['fund', [coin]], ['initializePolicy', []],
  ]) assert.throws(() => f.call(name, ...args), /Owner authorization required/);
});

test('tampered policy opening or coin opening is rejected', () => {
  const f = fixture(); f.fund();
  const original = structuredClone(f.ps);
  f.ps.policy.allowance = 999n;
  assert.throws(() => f.call('pay', f.request()), /Invalid policy opening/);
  f.ps = structuredClone(original); f.ps.state.coin.value += 1n;
  assert.throws(() => f.call('pay', f.request()), /Invalid or stale state opening/);
  f.ps = structuredClone(original); f.ps.stateSalt = bytes();
  assert.throws(() => f.call('pay', f.request()), /Invalid or stale state opening/);
});

test('same request cannot pay twice, including after an owner policy replacement', () => {
  const f = fixture(); f.fund(); const request = f.request();
  f.call('pay', request); f.qualifyForRuntimeOnly();
  assert.throws(() => f.call('pay', request), /Request already used/);
  f.call('replacePolicy', { ...f.ps.policy, allowance: 110n }, bytes());
  assert.throws(() => f.call('pay', { ...request, expectedVersion: f.ledger().version }), /Request already used/);
  assert.equal(f.ps.state.spent, 40n);
});

test('stale private state cannot authorize a competing payment', () => {
  const f = fixture(); f.fund(); const old = structuredClone(f.ps);
  f.call('pay', f.request({ amount: 60n }));
  f.ps = { ...old, nextStateSalt: bytes() };
  assert.throws(() => f.call('pay', f.request({ amount: 60n })), /Invalid or stale state opening/);
});

test('on-chain VM transcript verifier rejects a second independently prepared spend', () => {
  const f = fixture(); f.fund();
  const before = f.state;
  const ctx = createCircuitContext(f.address, f.coinPublicKey, before, { ...f.ps, nextStateSalt: bytes() }, undefined, undefined, f.time);
  const competing = f.contract.impureCircuits.pay(ctx, f.request({ amount: 60n }));
  const transcript = {
    // A generous VM budget; this test verifies reads/effects, not fee estimation.
    gas: { readTime: 10n ** 15n, computeTime: 10n ** 15n, bytesWritten: 10n ** 15n, bytesDeleted: 10n ** 15n },
    effects: competing.context.currentQueryContext.effects,
    program: competing.proofData.publicTranscript,
  };
  const original = createCircuitContext(f.address, f.coinPublicKey, before, f.ps, undefined, undefined, f.time);
  assert.doesNotThrow(() => original.currentQueryContext.runTranscript(transcript, original.costModel));
  f.call('pay', f.request({ amount: 60n }));
  const current = createCircuitContext(f.address, f.coinPublicKey, f.state, f.ps, undefined, undefined, f.time);
  assert.throws(() => current.currentQueryContext.runTranscript(transcript, current.costModel), /mismatch.*read/);
  assert.equal(f.ps.state.spent, 60n);
});

test('real ledger partition keeps payment accounting and coin effects in one fallible transcript', () => {
  const f = fixture(); f.fund();
  const initial = createCircuitContext(f.address, f.coinPublicKey, f.state, f.ps, undefined, undefined, f.time);
  const out = f.contract.impureCircuits.pay(initial, f.request());
  // Same onchain-runtime -> ledger conversion used by compact-js ContractExecutable.
  let context = new QueryContext(new ChargedState(StateValue.decode(initial.currentQueryContext.state.state.encode())), f.address);
  context.block = initial.currentQueryContext.block;
  context.effects = initial.currentQueryContext.effects;
  for (const [commitment, index] of out.context.currentQueryContext.comIndices) context = context.insertCommitment(commitment, index);
  const partitions = partitionTranscripts([new PreTranscript(context, out.proofData.publicTranscript)], LedgerParameters.initialParameters());
  assert.equal(partitions.length, 1);
  const [guaranteed, fallible] = partitions[0];
  assert.equal(guaranteed, undefined);
  assert.ok(fallible);
  assert.deepEqual(fallible.program, out.proofData.publicTranscript);
  assert.equal(fallible.effects.claimedNullifiers.length, 1);
  assert.equal(fallible.effects.claimedShieldedSpends.length, 2);
  assert.equal(fallible.effects.claimedShieldedReceives.length, 1);
  const applied = context.runTranscript(fallible, LedgerParameters.initialParameters().transactionCostModel.runtimeCostModel);
  assert.deepEqual(applied.state.state.encode(), out.context.currentQueryContext.state.state.encode());
  // This checks real partitioning/VM behavior, not proof verification or rollback
  // of a failed shielded transfer on a node; those require separate network tests.
});

test('pause, resume and revoke invalidate prepared policy versions', () => {
  const f = fixture(); f.fund(); const request = f.request();
  f.call('setPaused', true);
  assert.throws(() => f.call('pay', request), /Vault unavailable/);
  f.call('setPaused', false);
  assert.throws(() => f.call('pay', request), /Stale policy version/);
  f.call('revoke');
  assert.throws(() => f.call('pay', f.request()), /Vault unavailable/);
  assert.throws(() => f.call('setPaused', false), /Vault unavailable/);
  assert.throws(() => f.call('replacePolicy', f.ps.policy, bytes()), /Revocation is permanent/);
  f.call('withdraw', f.recipient);
  assert.equal(f.ps.state.hasCoin, false);
});

test('policy replacement preserves spend accounting, asset and state', () => {
  const f = fixture(); f.fund();
  f.call('pay', f.request()); f.qualifyForRuntimeOnly();
  assert.throws(() => f.call('replacePolicy', { ...f.ps.policy, allowance: 30n, perPayment: 20n }, bytes()), /Allowance below spent total/);
  assert.throws(() => f.call('replacePolicy', { ...f.ps.policy, asset: bytes() }, bytes()), /Asset cannot change/);
  const stateCommitment = f.ledger().stateCommitment;
  f.call('replacePolicy', { ...f.ps.policy, perPayment: 50n, allowance: 110n }, bytes());
  assert.equal(f.ps.state.spent, 40n);
  assert.deepEqual(f.ledger().stateCommitment, stateCommitment);
  f.call('pay', f.request({ amount: 50n })); f.qualifyForRuntimeOnly();
  assert.throws(() => f.call('pay', f.request({ amount: 21n })), /Payment not permitted/);
});

test('missing qualification fails closed and repeated funding cannot reset allowance', () => {
  const f = fixture(); const coin = f.fund();
  f.ps.coinIndex = null;
  assert.throws(() => f.call('pay', f.request()), /Coin qualification required/);
  assert.throws(() => f.call('fund', coin), /Vault already funded/);
});

function allBytes(value, found = [], seen = new Set()) {
  if (value instanceof Uint8Array) { found.push(Buffer.from(value)); return found; }
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (Symbol.iterator in value) { for (const item of value) allBytes(item, found, seen); }
  else { for (const item of Object.values(value)) allBytes(item, found, seen); }
  return found;
}
function integerBytes(value, length) {
  const bytes = Buffer.alloc(length); let remaining = value;
  for (let i = 0; i < length; i++) { bytes[i] = Number(remaining & 255n); remaining >>= 8n; }
  return bytes;
}

test('public ledger and generated public transcript omit private openings and payment amounts', () => {
  const amount = 987654321012345n, allowance = 987654321098765n;
  const f = fixture({ perPayment: amount, allowance });
  const coin = f.fund(98765432101234567n);
  const privateBefore = structuredClone(f.ps);
  const out = f.call('pay', f.request({ amount }));
  const publicBytes = allBytes([f.ledger(), out.proofData.publicTranscript]);
  for (const secret of [
    privateBefore.ownerSecret, privateBefore.agentSecret, privateBefore.policySalt,
    privateBefore.stateSalt, privateBefore.nextStateSalt, coin.nonce, f.recipient,
    privateBefore.policy.asset, integerBytes(amount, 8), integerBytes(allowance, 8),
  ]) {
    assert.ok(!publicBytes.some((value) => value.includes(Buffer.from(secret))), 'private value found in generated public data');
  }
  assert.equal(f.ledger().usedRequests.size(), 1n);
});
