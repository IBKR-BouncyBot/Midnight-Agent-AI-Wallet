/** LOCAL QA ONLY. Public, synthetic identities and placeholder proofs. Nothing
 * in this module establishes proof validity, chain acceptance, or settlement.
 * Production pages must not import it; the opt-in local probe/tests do. */
import { ContractCallPrototype, ContractOperation, CostModel, Intent, Proof, Transaction,
  ZswapChainState, ZswapInput, ZswapOutput, ZswapOffer, ZswapSecretKeys,
  communicationCommitmentRandomness, createShieldedCoinInfo } from '@midnight-ntwrk/ledger-v8';
import { createMerchantReceiptVerifier } from './receipt-verifier.mjs';

export const SYNTHETIC_MERCHANT_SEED = () => new Uint8Array(32).fill(42);
export const SYNTHETIC_TOKEN = '22'.repeat(32);
export const SYNTHETIC_VAULT = '11'.repeat(32);
const ttl = new Date('2030-01-01T00:00:00Z');

/** Native serialized fixture with deliberately INVALID placeholder proofs and
 * a fabricated finality envelope. Options exist only for negative unit tests. */
export async function createSyntheticReceiptFixture(options = {}) {
  const { network = 'preview', seed = SYNTHETIC_MERCHANT_SEED(), amount = 40n,
    asset = SYNTHETIC_TOKEN, contractAddress = SYNTHETIC_VAULT, entryPoint = 'pay',
    segment = 1, offerSegment = segment, guaranteed = false, callGuaranteed = guaranteed,
    duplicateRecipient = false, extraRecipient = false, extraContract = false,
    mismatchEffects = false, ciphertextSeed = seed, coinKeySeed = seed, prove = true } = options;
  const keys = ZswapSecretKeys.fromSeed(seed);
  const cipherKeys = ZswapSecretKeys.fromSeed(ciphertextSeed);
  const coinKeys = ZswapSecretKeys.fromSeed(coinKeySeed);
  try {
    const coin = createShieldedCoinInfo(asset, amount + 60n);
    const funded = ZswapOutput.newContractOwned(coin, 1, contractAddress);
    const [initialChain, indices] = new ZswapChainState().tryApply(ZswapOffer.fromOutput(funded));
    const chain = initialChain.postBlockUpdate(new Date('2029-01-01T00:00:00Z'));
    const physicalSegment = guaranteed ? undefined : offerSegment;
    const input = ZswapInput.newContractOwned({ ...coin, mt_index: indices.get(funded.commitment) }, physicalSegment, contractAddress, chain);
    const recipient = ZswapOutput.new(createShieldedCoinInfo(asset, amount), physicalSegment, coinKeys.coinPublicKey, cipherKeys.encryptionPublicKey);
    const change = ZswapOutput.newContractOwned(createShieldedCoinInfo(asset, 60n), physicalSegment, contractAddress);
    const outputs = [recipient, change];
    if (duplicateRecipient) outputs.push(recipient);
    if (extraRecipient) outputs.push(ZswapOutput.new(createShieldedCoinInfo(asset, 1n), physicalSegment, keys.coinPublicKey, keys.encryptionPublicKey));
    if (extraContract) outputs.push(ZswapOutput.newContractOwned(createShieldedCoinInfo(asset, 1n), physicalSegment, '55'.repeat(32)));
    let offer = ZswapOffer.fromInput(input, asset, coin.value);
    for (const output of outputs) offer = offer.merge(ZswapOffer.fromOutput(output, asset, output === change ? 60n : amount));
    const effects = {
      claimedNullifiers: [input.nullifier], claimedShieldedReceives: [change.commitment],
      claimedShieldedSpends: outputs.map(output => output.commitment), claimedContractCalls: [],
      shieldedMints: new Map(), unshieldedMints: new Map(), unshieldedInputs: new Map(),
      unshieldedOutputs: new Map(), claimedUnshieldedSpends: new Map(),
    };
    if (mismatchEffects) effects.claimedShieldedSpends = [recipient.commitment];
    const transcript = { gas: { readTime: 0n, computeTime: 0n, bytesWritten: 0n, bytesDeleted: 0n }, effects, program: [] };
    const empty = { alignment: [], value: [] };
    const call = new ContractCallPrototype(contractAddress, entryPoint, new ContractOperation(),
      callGuaranteed ? transcript : undefined, callGuaranteed ? undefined : transcript,
      [], empty, empty, communicationCommitmentRandomness(), 'synthetic-receipt-probe');
    const unproven = Transaction.fromParts(network)
      .addIntent({ tag: 'specific', value: segment }, Intent.new(ttl).addCall(call))
      .addZswapOffer(guaranteed ? { tag: 'guaranteedOnly' } : { tag: 'specific', value: offerSegment }, offer);
    // Opaque empty proof is native-parseable but NOT cryptographically valid.
    const placeholderProof = new Proof('0100').serialize();
    const tx = prove ? (await unproven.prove({ check: async () => [], prove: async () => placeholderProof }, CostModel.initialCostModel())).bind() : unproven;
    return { synthetic: true, proofValidity: 'INVALID_PLACEHOLDER', chainAcceptance: false,
      finalized: { tx, txId: tx.identifiers()[0], status: 'SucceedEntirely', blockHash: '33'.repeat(32) },
      expectedTransactionIds: tx.identifiers(), expectedAsset: asset, expectedAmount: amount,
      contractAddress, recipientCommitment: recipient.commitment };
  } finally { keys.clear(); cipherKeys.clear(); coinKeys.clear(); }
}

/** Real native browser execution, synthetic envelope only. Returns public timing
 * and booleans, never a real payment claim or a seed/private coin opening. */
export async function runSyntheticReceiptProbe() {
  const fixture = await createSyntheticReceiptFixture();
  const beforeKeys = performance.now();
  const verifier = createMerchantReceiptVerifier({ seed: SYNTHETIC_MERCHANT_SEED() });
  const keyDerivationMs = performance.now() - beforeKeys;
  try {
    const beforeVerify = performance.now();
    const receipt = verifier.verifyReceipt(fixture);
    const verificationMs = performance.now() - beforeVerify;
    let wrongAmountRejected = false;
    try { verifier.verifyReceipt({ ...fixture, expectedAmount: fixture.expectedAmount + 1n }); } catch { wrongAmountRejected = true; }
    const wrongKeys = createMerchantReceiptVerifier({ seed: new Uint8Array(32).fill(43) });
    let wrongRecipientRejected = false;
    try { wrongKeys.verifyReceipt(fixture); } catch { wrongRecipientRejected = true; } finally { wrongKeys.close(); }
    return { format: 'synthetic-browser-merchant-receipt-probe-v1', synthetic: true,
      proofValidity: 'INVALID_PLACEHOLDER', chainAcceptance: false, historyEventsDownloaded: 0,
      keyDerivationMs, verificationMs, matchingOutputDecrypted: receipt.outputCommitment === fixture.recipientCommitment,
      wrongAmountRejected, wrongRecipientRejected, receiptExcludesMerkleIndex: !('mt_index' in receipt),
      verificationBoundary: 'Native parsing, effect binding and authenticated recipient decryption only; fabricated finality and invalid placeholder proofs. No network or wallet connection.' };
  } finally { verifier.close(); }
}

/** The developer server exposes this probe only by an explicit opt-in bundle.
 * Keep a second runtime guard so a copied bundle cannot run on the public site. */
export async function runBrowserReceiptProbe({ enabled = false } = {}) {
  if (enabled !== true || !['http:', 'https:'].includes(globalThis.location?.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(globalThis.location?.hostname)) {
    throw new Error('LOCAL_RECEIPT_PROBE_DISABLED');
  }
  return runSyntheticReceiptProbe();
}
