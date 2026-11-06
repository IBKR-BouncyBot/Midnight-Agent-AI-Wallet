/** Read-only inspection of PUBLIC indexer transaction data. Never opens a wallet
 * store, accepts a credential, reads a seed, or generates/submits a transaction.
 * The native phase/effect checks mirror tests/network/privacy.mjs without any
 * private-value samples or private receipt claim.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Transaction, entryPointHash } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { toTxStatus } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { isTransactionId } from '../packages/protocol/index.mjs';
import { getTestNetworkConfig, verifyPreviewNetwork } from '../services/runner/test-network-config.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hex32 = /^[0-9a-f]{64}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const QUERY = `query PreviewPaymentEvidence($id: HexEncoded!) {
  transactions(offset: {identifier: $id}) {
    __typename raw hash protocolVersion
    block { height hash timestamp }
    ... on RegularTransaction { identifiers transactionResult { status segments { id success } } }
  }
}`;

export function validatePublicReferences(transactionId, contractAddress) {
  if (!isTransactionId(transactionId) || typeof contractAddress !== 'string' || !hex32.test(contractAddress)) {
    throw new TypeError('A tagged 66-character transaction ID and 64-character contract address are required');
  }
}

/** Pure native inspection. It makes no network claim of its own: the CLI below
 * obtains its input exclusively from the pinned public Preview indexer. */
export function inspectPublicPayment(transaction, transactionId, contractAddress) {
  validatePublicReferences(transactionId, contractAddress);
  assert.equal(transaction?.__typename, 'RegularTransaction', 'Expected an indexed regular transaction');
  assert.equal(toTxStatus(transaction.transactionResult), 'SucceedEntirely', 'Transaction must have succeeded entirely');
  assert.ok(transaction.identifiers?.includes(transactionId), 'Indexer returned another transaction');
  assert.match(transaction.block?.hash ?? '', hex32, 'Missing finalized block hash');
  const height = String(transaction.block.height);
  assert.match(height, /^(0|[1-9][0-9]*)$/, 'Invalid finalized block height');
  assert.ok(typeof transaction.raw === 'string' && transaction.raw.length > 0 && transaction.raw.length <= 32 * 1024 * 1024
    && /^(?:[0-9a-fA-F]{2})+$/.test(transaction.raw), 'Invalid public transaction bytes');
  const raw = Buffer.from(transaction.raw, 'hex');
  const tx = Transaction.deserialize('signature', 'proof', 'binding', raw);
  assert.ok(Buffer.from(tx.serialize()).equals(raw), 'Native transaction roundtrip mismatch');
  assert.ok(tx.identifiers().includes(transactionId), 'Native identifiers do not match indexer request');
  assert.equal(tx.transactionHash(), transaction.hash, 'Native transaction hash does not match indexer');
  assert.ok(tx.intents instanceof Map && tx.intents.size > 0, 'Missing native transaction intents');
  const actions = [...tx.intents].flatMap(([intentSegment, intent]) => intent.actions.map((action) => ({ intentSegment, action })));
  const calls = actions.filter(({ action }) => 'guaranteedTranscript' in action && action.address === contractAddress);
  assert.equal(calls.length, 1, 'Expected exactly one vault call');
  assert.equal(actions.length, 1, 'Expected a standalone vault payment');
  const { action: call, intentSegment } = calls[0];
  assert.equal(entryPointHash(call.entryPoint), entryPointHash('pay'), 'The vault entry point is not pay');
  assert.ok(call.proof && typeof call.proof.serialize === 'function', 'Missing actual contract proof');
  const proof = call.proof.serialize();
  assert.ok(proof.length > 0, 'Empty contract proof');
  const offers = [
    ...(tx.guaranteedOffer ? [{ phase: 'guaranteed', segment: 0, offer: tx.guaranteedOffer }] : []),
    ...Array.from(tx.fallibleOffer ?? [], ([segment, offer]) => ({ phase: 'fallible', segment, offer })),
  ];
  assert.equal(offers.length, 1, 'Unsupported mixed shielded offer phases');
  const { phase, segment, offer } = offers[0];
  const transcript = phase === 'guaranteed' ? call.guaranteedTranscript : call.fallibleTranscript;
  assert.ok(transcript, 'Contract transcript and shielded offer phase differ');
  assert.equal(phase === 'guaranteed' ? call.fallibleTranscript : call.guaranteedTranscript, undefined, 'Contract effects span both phases');
  if (phase === 'fallible') assert.equal(intentSegment, segment, 'Contract and shielded offer segments differ');
  const effects = transcript.effects;
  assert.equal(offer.inputs.length, 1, 'Expected one vault coin input');
  assert.equal(offer.transients.length, 0, 'Unexpected transient coins');
  assert.equal(effects.claimedNullifiers.length, 1, 'Expected one contract nullifier');
  assert.equal(offer.inputs[0].contractAddress, contractAddress, 'Input is not owned by this vault');
  assert.equal(offer.inputs[0].nullifier, effects.claimedNullifiers[0], 'Input nullifier differs from contract effect');
  assert.equal(effects.claimedContractCalls.length, 0, 'Unexpected cross-contract calls');
  assert.deepEqual(offer.outputs.map((output) => output.commitment).sort(), [...effects.claimedShieldedSpends].sort(), 'Output commitments differ from contract effects');
  const change = offer.outputs.filter((output) => output.contractAddress === contractAddress);
  const recipients = offer.outputs.filter((output) => output.contractAddress === undefined);
  assert.equal(recipients.length, 1, 'Expected one user-owned recipient output');
  assert.ok(change.length <= 1 && offer.outputs.length === change.length + 1, 'Unexpected shielded output owners');
  assert.deepEqual(change.map((output) => output.commitment), [...effects.claimedShieldedReceives], 'Vault change differs from contract receive effect');
  return {
    transactionId, contractAddress, status: 'SucceedEntirely', transactionHash: transaction.hash,
    blockHash: transaction.block.hash, blockHeight: height, blockTimestamp: transaction.block.timestamp,
    protocolVersion: transaction.protocolVersion, serializedTransactionBytes: raw.length, serializedTransactionSha256: digest(raw),
    inspectedContractCalls: calls.length, entryPoint: 'pay', phase, segment,
    contractProofBytes: proof.length, contractProofSha256: digest(proof),
    contractInputs: offer.inputs.length, recipientOutputs: recipients.length, contractChangeOutputs: change.length,
    contractNullifiers: effects.claimedNullifiers.length,
  };
}

export async function exportPreviewEvidence(transactionId, contractAddress) {
  validatePublicReferences(transactionId, contractAddress);
  const config = getTestNetworkConfig('preview');
  const identity = await verifyPreviewNetwork(config);
  const response = await fetch(config.indexer, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { id: transactionId } }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Preview indexer is unavailable');
  const result = await response.json();
  if (result.errors?.length || result.data?.transactions?.length !== 1) throw new Error('A unique finalized transaction was not found');
  const inspected = inspectPublicPayment(result.data.transactions[0], transactionId, contractAddress);
  const sourcePaths = ['scripts/export-preview-evidence.mjs', 'services/demo/service.mjs', 'services/runner/payment-runner.mjs',
    'services/runner/midnight-sdk-adapter.mjs', 'contracts/private-vault.compact'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (relative) => [relative, digest(await readFile(path.join(ROOT, relative)))])));
  return { format: 'midnight-preview-public-payment-evidence-v1', observedAt: new Date().toISOString(),
    network: 'preview', chainName: identity.chainName, indexer: config.indexer,
    ...inspected, sourceHashes,
    verificationBoundary: 'Official Preview RPC/indexer finality plus native public transaction, proof and effect inspection. No local proof re-verification or private recipient-wallet receipt check is performed by this public-only helper.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2) throw new Error('Usage: node scripts/export-preview-evidence.mjs <transaction-id> <contract-address>');
    const result = await exportPreviewEvidence(args[0], args[1]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch {
    // Never serialize an SDK exception: it can include a complete transaction.
    process.stderr.write('Public Preview inspection did not verify a successful matching payment. Check the two public IDs and finality.\n');
    process.exitCode = 1;
  }
}
