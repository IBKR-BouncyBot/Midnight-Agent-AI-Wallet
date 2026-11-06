import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, ZswapLocalState, ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';
import { createMerchantReceiptVerifier } from '../packages/browser-demo/receipt-verifier.mjs';
import { createSyntheticReceiptFixture, runSyntheticReceiptProbe, runBrowserReceiptProbe, SYNTHETIC_MERCHANT_SEED,
  SYNTHETIC_TOKEN, SYNTHETIC_VAULT } from '../packages/browser-demo/receipt-probe.mjs';

// Every envelope in this file has FABRICATED finality and INVALID placeholder
// proofs. These tests exercise native parsing/effects/ciphertext authentication,
// not real proof verification or a successful payment on any network.
const fixture = await createSyntheticReceiptFixture();
const create = () => createMerchantReceiptVerifier({ seed: SYNTHETIC_MERCHANT_SEED() });
const rejects = fn => assert.throws(fn, error => error.code === 'MERCHANT_RECEIPT_NOT_VERIFIED'
  && error.message === error.code && error.cause === undefined);

test('exact native payment output decrypts without history and exports only bounded receipt facts', () => {
  const verifier = create();
  try {
    const receipt = verifier.verifyReceipt(fixture);
    assert.deepEqual(receipt, { transactionId: fixture.finalized.txId, blockHash: fixture.finalized.blockHash,
      segment: 1, tokenId: SYNTHETIC_TOKEN, amountAtomic: '40',
      outputCommitment: fixture.recipientCommitment, recipientReceiptVerified: true });
    assert.ok(Object.isFrozen(receipt));
    assert.deepEqual(verifier.verifyReceipt(fixture), receipt, 'reconciliation must be idempotent');
    const keys = ZswapSecretKeys.fromSeed(SYNTHETIC_MERCHANT_SEED());
    try {
      const scratch = new ZswapLocalState().applyWithChanges(keys, fixture.finalized.tx.fallibleOffer.get(1));
      const decrypted = scratch.changes.flatMap(change => change.receivedCoins);
      assert.equal(decrypted.length, 1);
      assert.ok(decrypted[0].mt_index >= 0n, 'native scratch has a synthetic index');
      for (const forbidden of ['mt_index', 'nonce', 'coin', 'state', 'balance', 'seed', 'keys']) assert.ok(!(forbidden in receipt));
    } finally { keys.clear(); }
  } finally { verifier.close(); }
});

test('factory preserves the caller seed, derives existing identity and closes idempotently', () => {
  const seed = SYNTHETIC_MERCHANT_SEED(); const original = seed.slice();
  const verifier = createMerchantReceiptVerifier({ seed, network: { networkId: 'preview' } });
  const native = ZswapSecretKeys.fromSeed(seed);
  assert.deepEqual(seed, original);
  assert.equal(verifier.getCoinPublicKey(), native.coinPublicKey);
  assert.equal(verifier.getEncryptionPublicKey(), native.encryptionPublicKey);
  native.clear(); verifier.close(); verifier.close();
  const bufferSeed = Buffer.from(original);
  const bufferVerifier = createMerchantReceiptVerifier({ seed: bufferSeed });
  bufferVerifier.close();
  assert.deepEqual(new Uint8Array(bufferSeed), original, 'Buffer.slice must not erase caller-owned seed bytes');
  rejects(() => verifier.getCoinPublicKey());
  rejects(() => verifier.getEncryptionPublicKey());
  rejects(() => verifier.verifyReceipt(fixture));
  rejects(() => createMerchantReceiptVerifier({ seed, network: 'preprod' }));
  rejects(() => createMerchantReceiptVerifier({ seed: new Uint8Array(31) }));
});

test('finality metadata must be complete, successful and match persisted/native identifiers', () => {
  const verifier = create();
  try {
    for (const change of [{ status: 'Pending' }, { status: 'FailedEntirely' }, { status: 'PartiallySucceeded' },
      { blockHash: undefined }, { blockHash: '00' }, { txId: '00' + 'ff'.repeat(32) }, { tx: {} }]) {
      rejects(() => verifier.verifyReceipt({ ...fixture, finalized: { ...fixture.finalized, ...change } }));
    }
    for (const expectedTransactionIds of [[], undefined, ['00' + 'ff'.repeat(32)],
      [fixture.finalized.txId], [...fixture.expectedTransactionIds, '00' + 'ff'.repeat(32)],
      [...fixture.expectedTransactionIds, fixture.finalized.txId]]) {
      rejects(() => verifier.verifyReceipt({ ...fixture, expectedTransactionIds }));
    }
  } finally { verifier.close(); }
});

test('wrong asset, amount, decimal format and uint64 range fail closed', () => {
  const verifier = create();
  try {
    for (const expectedAmount of [39n, 41n, 0n, -1n, 1n << 64n, '040', '4e1', 40, '']) {
      rejects(() => verifier.verifyReceipt({ ...fixture, expectedAmount }));
    }
    rejects(() => verifier.verifyReceipt({ ...fixture, expectedAsset: '44'.repeat(32) }));
    rejects(() => verifier.verifyReceipt({ ...fixture, expectedAsset: SYNTHETIC_TOKEN.toUpperCase().replace('2', 'G') }));
    assert.equal(verifier.verifyReceipt({ ...fixture, expectedAmount: '40' }).amountAtomic, '40');
  } finally { verifier.close(); }
});

test('wrong recipient and ciphertext encrypted to another key are refused', async () => {
  const wrong = createMerchantReceiptVerifier({ seed: new Uint8Array(32).fill(43) });
  const verifier = create();
  try {
    rejects(() => wrong.verifyReceipt(fixture));
    const wrongCipher = await createSyntheticReceiptFixture({ ciphertextSeed: new Uint8Array(32).fill(43) });
    rejects(() => verifier.verifyReceipt(wrongCipher));
    // Correct encryption key, wrong coin owner: decryption alone is not enough.
    const differentOwner = await createSyntheticReceiptFixture({ coinKeySeed: new Uint8Array(32).fill(43) });
    rejects(() => verifier.verifyReceipt(differentOwner));
  } finally { wrong.close(); verifier.close(); }
});

test('another network, vault, or entry point cannot satisfy a payment receipt', async () => {
  const verifier = create();
  try {
    const network = await createSyntheticReceiptFixture({ network: 'preprod' });
    rejects(() => verifier.verifyReceipt(network));
    const wrongEntryPoint = await createSyntheticReceiptFixture({ entryPoint: 'withdraw' });
    rejects(() => verifier.verifyReceipt(wrongEntryPoint));
    const wrongVault = await createSyntheticReceiptFixture({ contractAddress: '66'.repeat(32) });
    rejects(() => verifier.verifyReceipt({ ...wrongVault, contractAddress: SYNTHETIC_VAULT }));
  } finally { verifier.close(); }
});

test('guaranteed effects, cross-segment offers, and mismatched effect claims are refused', async () => {
  const verifier = create();
  try {
    for (const options of [{ guaranteed: true }, { callGuaranteed: true }, { offerSegment: 2 }, { mismatchEffects: true }]) {
      const changed = await createSyntheticReceiptFixture(options);
      rejects(() => verifier.verifyReceipt(changed));
    }
  } finally { verifier.close(); }
});

test('duplicate, extra merchant and unrelated contract outputs are refused', async () => {
  const verifier = create();
  try {
    // Native offer assembly itself refuses a duplicate commitment before the
    // serialized verifier boundary; two distinct recipient outputs reach it.
    await assert.rejects(createSyntheticReceiptFixture({ duplicateRecipient: true }), /non-disjoint coin sets/);
    for (const options of [{ extraRecipient: true }, { extraContract: true }]) {
      const changed = await createSyntheticReceiptFixture(options);
      rejects(() => verifier.verifyReceipt(changed));
    }
  } finally { verifier.close(); }
});

test('unproven markers and tampered serialized transaction bytes are refused', async () => {
  const verifier = create();
  try {
    const unproven = await createSyntheticReceiptFixture({ prove: false });
    rejects(() => verifier.verifyReceipt(unproven));
    const copied = Transaction.deserialize('signature', 'proof', 'binding', fixture.finalized.tx.serialize());
    const malformed = copied.serialize().slice(0, -1);
    copied.serialize = () => malformed;
    rejects(() => verifier.verifyReceipt({ ...fixture, finalized: { ...fixture.finalized, tx: copied } }));
  } finally { verifier.close(); }
});

test('a different valid-looking payment cannot be substituted for saved signed transaction IDs', async () => {
  const unrelated = await createSyntheticReceiptFixture();
  const verifier = create();
  try {
    assert.notEqual(unrelated.finalized.txId, fixture.finalized.txId);
    rejects(() => verifier.verifyReceipt({ ...unrelated, expectedTransactionIds: fixture.expectedTransactionIds }));
  } finally { verifier.close(); }
});

test('browser-compatible probe reports synthetic boundaries and positive/negative checks honestly', async () => {
  const result = await runSyntheticReceiptProbe();
  assert.equal(result.synthetic, true);
  assert.equal(result.proofValidity, 'INVALID_PLACEHOLDER');
  assert.equal(result.chainAcceptance, false);
  assert.equal(result.historyEventsDownloaded, 0);
  for (const field of ['matchingOutputDecrypted', 'wrongAmountRejected', 'wrongRecipientRejected', 'receiptExcludesMerkleIndex']) assert.equal(result[field], true);
  assert.ok(result.keyDerivationMs >= 0 && result.verificationMs >= 0);
});

test('browser probe refuses absent opt-in and any public origin', async () => {
  const previous = globalThis.location;
  try {
    globalThis.location = { protocol: 'http:', hostname: '127.0.0.1' };
    await assert.rejects(runBrowserReceiptProbe(), /LOCAL_RECEIPT_PROBE_DISABLED/);
    globalThis.location = { protocol: 'https:', hostname: 'example.github.io' };
    await assert.rejects(runBrowserReceiptProbe({ enabled: true }), /LOCAL_RECEIPT_PROBE_DISABLED/);
    globalThis.location = { protocol: 'http:', hostname: '127.0.0.1' };
    assert.equal((await runBrowserReceiptProbe({ enabled: true })).matchingOutputDecrypted, true);
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});
