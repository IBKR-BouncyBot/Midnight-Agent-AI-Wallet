// Wallet/provider and shielded-coin patterns adapted from midnight-examples.
// Copyright (C) Midnight Foundation. SPDX-License-Identifier: Apache-2.0
// Modified: local-only configuration, no secret logging, bounded waits,
// random encrypted test stores, proof counters and strict index parsing.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstValueFrom, filter, timeout } from 'rxjs';
import { WebSocket } from 'ws';
import { FluentWalletBuilder, logger as testkitLogger } from '@midnight-ntwrk/testkit-js';
import { DustSecretKey, LedgerParameters, ZswapSecretKeys, ZswapOutput, createShieldedCoinInfo } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { decodeShieldedCoinInfo, encodeShieldedCoinInfo, encodeCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

globalThis.WebSocket = WebSocket;
testkitLogger.level = 'silent';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const LOCAL = Object.freeze({
  networkId: 'undeployed', walletNetworkId: 'undeployed',
  indexer: 'http://127.0.0.1:18088/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:18088/api/v4/graphql/ws',
  node: 'http://127.0.0.1:19944', nodeWS: 'ws://127.0.0.1:19944',
  proofServer: 'http://127.0.0.1:16300', faucet: '',
});
export const random32 = () => new Uint8Array(randomBytes(32));
export const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
function randomStoragePassword() {
  for (;;) {
    const value = `Local-Test-${randomBytes(32).toString('base64url')}!`;
    try { validatePassword(value); return value; } catch { /* resample */ }
  }
}

export async function startRun(name) {
  assert.ok(!process.env.MIDNIGHT_NETWORK || ['local', 'undeployed'].includes(process.env.MIDNIGHT_NETWORK), 'This harness permits the disposable local network only');
  setNetworkId('undeployed');
  const directory = path.join(ROOT, '.local', `network-${name}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const run = { directory, name, startedAt: new Date().toISOString(), proofs: 0, transactions: [], checks: [], stores: [], wallets: [] };
  const sourcePaths = [
    'contracts/private-vault.compact', 'contracts/managed/private-vault/contract/index.js',
    'contracts/managed/private-vault/keys/pay.verifier',
    'services/runner/payment-runner.mjs', 'services/runner/midnight-sdk-adapter.mjs',
    'services/runner/private-store.mjs', 'services/runner/disable-maintenance.mjs',
    'tests/network/harness.mjs', 'tests/network/private-vault.mjs',
    'tests/network/durable-payment.mjs', 'tests/network/privacy.mjs',
  ];
  run.sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
    [file, createHash('sha256').update(await readFile(path.join(ROOT, file))).digest('hex')])));
  const tip = await graph('{ block { height timestamp } }');
  assert.ok(tip.block, 'Local indexer has no block');
  console.log(`${name}: local services reachable`);
  return run;
}

export async function graph(query, variables = {}) {
  const response = await fetch(LOCAL.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.ok, true, `Indexer HTTP ${response.status}`);
  const result = await response.json();
  assert.ok(!result.errors?.length, 'Indexer query returned errors');
  assert.ok(result.data, 'Indexer query returned no data');
  return result.data;
}

export class LocalWallet {
  constructor(wallet, seeds, keystore) {
    this.wallet = wallet;
    this.keys = ZswapSecretKeys.fromSeed(seeds.shielded);
    this.dustKey = DustSecretKey.fromSeed(seeds.dust);
    this.keystore = keystore;
  }
  getCoinPublicKey() { return this.keys.coinPublicKey; }
  getEncryptionPublicKey() { return this.keys.encryptionPublicKey; }
  async balanceTx(tx, ttl = new Date(Date.now() + 3_600_000)) {
    const recipe = await this.wallet.balanceUnboundTransaction(tx, { shieldedSecretKeys: this.keys, dustSecretKey: this.dustKey }, { ttl });
    const signed = await this.wallet.signRecipe(recipe, payload => this.keystore.signData(payload));
    return this.wallet.finalizeRecipe(signed);
  }
  submitTx(tx) { return this.wallet.submitTransaction(tx); }
  stop() { return this.wallet.stop(); }
}

export async function buildLocalWallet(run, role = 1) {
  assert.ok([1, 2, 3].includes(role), 'Unknown disposable genesis role');
  // These PUBLIC development genesis seeds must never be used outside this
  // loopback-only harness. They do not identify a user wallet.
  const seed = role.toString(16).padStart(64, '0');
  const built = await FluentWalletBuilder.forEnvironment(LOCAL).withDustOptions({
    ledgerParams: LedgerParameters.initialParameters(), additionalFeeOverhead: 1_000n, feeBlocksMargin: 5,
  }).withSeed(seed).buildWithoutStarting();
  const wallet = new LocalWallet(built.wallet, built.seeds, built.keystore);
  run.wallets.push(wallet);
  await wallet.wallet.start(wallet.keys, wallet.dustKey);
  await firstValueFrom(wallet.wallet.state().pipe(filter(s =>
    s.shielded.state.progress.isStrictlyComplete() && s.unshielded.progress.isStrictlyComplete() && s.dust.state.progress.isStrictlyComplete()
  ), timeout({ first: 300_000 })));
  const deadline = Date.now() + 180_000;
  for (;;) {
    const state = await wallet.wallet.waitForSyncedState();
    const data = await graph('{ block { timestamp } }');
    const blockTime = new Date(data.block.timestamp);
    if (state.dust.availableCoins.length > 0 && state.dust.balance(blockTime) > 0n) break;
    assert.ok(Date.now() < deadline, 'Local wallet DUST did not become spendable');
    await pause(2_000);
  }
  console.log(`Disposable local wallet ${role}: synced and funded`);
  return wallet;
}

export function providersFor(run, wallet, artifactName, suffix = artifactName) {
  const zkPath = path.join(ROOT, 'contracts', 'managed', artifactName);
  const zkConfigProvider = new NodeZkConfigProvider(zkPath);
  const privateStateProvider = levelPrivateStateProvider({
    midnightDbName: path.join(run.directory, 'encrypted-state'),
    privateStateStoreName: suffix,
    signingKeyStoreName: `${suffix}-signing`,
    privateStoragePasswordProvider: () => run.storePassword ??= randomStoragePassword(),
    accountId: wallet.getCoinPublicKey(),
  });
  run.stores.push(privateStateProvider);
  const realProofProvider = httpClientProofProvider(LOCAL.proofServer, zkConfigProvider);
  const proofProvider = {
    ...realProofProvider,
    async proveTx(...args) {
      const proven = await realProofProvider.proveTx(...args);
      run.proofs++;
      console.log(`Real proof provider completed (${run.proofs})`);
      return proven;
    },
  };
  return { privateStateProvider, publicDataProvider: indexerPublicDataProvider(LOCAL.indexer, LOCAL.indexerWS), zkConfigProvider, proofProvider, walletProvider: wallet, midnightProvider: wallet };
}

export function compiled(name, module, witnesses = {}) {
  return CompiledContract.make(name, module.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(path.join(ROOT, 'contracts', 'managed', name)),
  );
}

export function freshCoin(color, value) { return encodeShieldedCoinInfo(createShieldedCoinInfo(color, value)); }
export function recipientOf(wallet) { return { bytes: encodeCoinPublicKey(wallet.getCoinPublicKey()) }; }
export function encryptionKeys(...wallets) { return new Map(wallets.map(wallet => [wallet.getCoinPublicKey(), wallet.getEncryptionPublicKey()])); }

export async function waitBalance(wallet, color, expected, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await wallet.wallet.waitForSyncedState();
    const balance = state.shielded.balances[color] ?? 0n;
    if (balance === expected) return balance;
    assert.ok(Date.now() < deadline, 'Recipient/wallet balance did not match the expected test amount');
    await pause(2_000);
  }
}

export async function qualifyCoin(tx, coin, contractAddress) {
  // The wallet may insert change first: find the contract output by its
  // cryptographic commitment, never assume output index zero.
  // SDK4.1.1 places ordinary calls in a fallible segment when there is no
  // guaranteed checkpoint. Do not assume the guaranteed offer exists.
  const offers = [];
  if (tx.tx.guaranteedOffer?.outputs.length) offers.push([0, tx.tx.guaranteedOffer]);
  for (const [segment, offer] of tx.tx.fallibleOffer ?? []) if (offer.outputs.length) offers.push([segment, offer]);
  assert.equal(offers.length, 1, 'Qualification supports exactly one populated shielded output segment; mixed-segment insertion order requires separate verification');
  const [segment, offer] = offers[0];
  const expected = ZswapOutput.newContractOwned(decodeShieldedCoinInfo(coin), segment, contractAddress).commitment;
  const outputs = offer.outputs;
  const matches = outputs.map((output, i) => output.commitment === expected ? i : -1).filter(i => i >= 0);
  assert.equal(matches.length, 1, 'Expected exactly one matching contract output');
  const data = await graph('query ($id: HexEncoded!) { transactions(offset: { identifier: $id }) { ... on RegularTransaction { zswapStartIndex } } }', { id: tx.txId });
  assert.equal(data.transactions?.length, 1, 'Expected one indexed transaction');
  const start = data.transactions[0].zswapStartIndex;
  assert.ok(typeof start === 'string' ? /^\d+$/.test(start) : Number.isSafeInteger(start), 'Missing or unsafe Zswap start index');
  return { ...coin, mt_index: BigInt(start) + BigInt(matches[0]) };
}

export function recordTx(run, label, tx) {
  assert.ok(tx.txId, 'Missing finalized transaction identifier');
  assert.equal(tx.status, 'SucceedEntirely', 'Transaction did not finalize successfully in every segment');
  run.transactions.push({ label, txId: tx.txId, status: tx.status, blockHeight: tx.blockHeight, contractAddress: tx.contractAddress });
  console.log(`${label}: indexed transaction ${tx.txId}`);
}

export async function finishRun(run, success) {
  await Promise.allSettled(run.wallets.map(wallet => wallet.stop()));
  for (const store of run.stores) if (typeof store.close === 'function') await store.close();
  const record = { name: run.name, network: 'undeployed', startedAt: run.startedAt, finishedAt: new Date().toISOString(), success, realProofProviderCompletions: run.proofs, transactions: run.transactions, checks: run.checks, testAmounts: run.testAmounts, privacy: run.privacy, durable: run.durable, sourceHashes: run.sourceHashes };
  await writeFile(path.join(run.directory, 'verification.json'), json(record));
  console.log(json(record));
  return record;
}
