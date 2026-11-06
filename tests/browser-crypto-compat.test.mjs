import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual as nativeEqual } from 'node:util';
import { isDeepStrictEqual as browserEqual } from '../packages/browser-demo/crypto.mjs';
import { cloneSnapshot } from '../packages/browser-storage/codec.mjs';

// Exact kinds used by BrowserDemoService.envelope and the shared runner's
// candidate binding: plain objects, fixed tuples, bytes, bigint, boolean/null.
function candidate() {
  const bytes = marker => Buffer.alloc(32, marker);
  return { privateState: {
    ownerSecret: bytes(0), agentSecret: bytes(1),
    policy: { agentKey: bytes(2), asset: bytes(3), recipients: [bytes(4), bytes(0), bytes(0), bytes(0)],
      perPayment: 50000000350n, allowance: 70000000490n, expiresAt: 1800000000n },
    policySalt: bytes(5), stateSalt: bytes(6), nextStateSalt: bytes(7), coinIndex: 42n,
    state: { spent: 40000000280n, hasCoin: true, coin: { nonce: bytes(8), color: bytes(3), value: 60000000420n },
      lastRequest: bytes(9) },
  }, stateCommitment: bytes(10), policyCommitment: bytes(11), version: 1n, paused: false, revoked: false };
}
function equalLikeRunner(expected, actual) {
  // bindQualifiedCandidate in payment-runner.mjs clones both sides before its
  // native util call. Compare the browser replacement at that same boundary.
  const first = structuredClone(expected); const second = structuredClone(actual);
  const native = nativeEqual(first, second); const browser = browserEqual(first, second);
  assert.equal(browser, native); return browser;
}

test('native Buffer-backed candidate and browser persisted Uint8Arrays compare identically after runner cloning', () => {
  const captured = candidate(); const persisted = cloneSnapshot(captured);
  assert.equal(Buffer.isBuffer(captured.privateState.state.coin.nonce), true);
  assert.equal(Buffer.isBuffer(persisted.privateState.state.coin.nonce), false);
  assert.ok(persisted.privateState.state.coin.nonce instanceof Uint8Array);
  assert.equal(equalLikeRunner(captured, persisted), true);
  // Keep strict prototypes for callers that have not performed normalization.
  assert.equal(browserEqual(captured.privateState.state.coin.nonce, persisted.privateState.state.coin.nonce), false);
  assert.equal(nativeEqual(captured.privateState.state.coin.nonce, persisted.privateState.state.coin.nonce), false);
});

test('browser candidate comparison rejects changes to every security-critical opening and policy field', () => {
  const persisted = cloneSnapshot(candidate());
  const changes = [
    value => { value.privateState.state.coin.nonce[0] ^= 1; },
    value => { value.privateState.state.coin.color[0] ^= 1; },
    value => { value.privateState.state.coin.value += 1n; },
    value => { value.privateState.state.spent += 1n; },
    value => { value.privateState.stateSalt[0] ^= 1; },
    value => { value.privateState.policySalt[0] ^= 1; },
    value => { value.privateState.policy.allowance += 1n; },
    value => { value.privateState.policy.agentKey[0] ^= 1; },
    value => { value.privateState.policy.recipients[0][0] ^= 1; },
    value => { value.privateState.policy.recipients.length += 1; },
    value => { value.privateState.policy.expiresAt += 1n; },
    value => { value.stateCommitment[0] ^= 1; },
    value => { value.policyCommitment[0] ^= 1; },
    value => { value.version += 1n; },
    value => { value.paused = true; },
    value => { value.privateState.ownerSecret[0] = 1; },
  ];
  for (const change of changes) {
    const observed = structuredClone(persisted); change(observed);
    assert.equal(equalLikeRunner(persisted, observed), false);
  }
});

test('allowing only ledger coin qualification does not also allow a substituted private candidate', () => {
  const persisted = cloneSnapshot(candidate()); const observed = structuredClone(persisted);
  observed.privateState.coinIndex = 123n;
  assert.equal(equalLikeRunner(persisted, observed), false);
  const expected = structuredClone(persisted); expected.privateState.coinIndex = observed.privateState.coinIndex;
  assert.equal(equalLikeRunner(expected, observed), true);
  observed.privateState.state.coin.value -= 1n;
  assert.equal(equalLikeRunner(expected, observed), false);
});
