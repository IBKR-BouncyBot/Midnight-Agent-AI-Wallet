// Wallet SDK construction/signing patterns adapted from Midnight.js testkit4.1.1
// (Midnight Foundation, Apache-2.0). No testkit runtime, test seed or secret logging.
import { HDWallet, Roles, createKeystore, ShieldedWallet, UnshieldedWallet, PublicKey,
  DustWallet, WalletFacade, InMemoryTransactionHistoryStorage, WalletEntrySchema, mergeWalletEntries } from '@midnight-ntwrk/wallet-sdk';
import { DustSecretKey, ZswapSecretKeys, LedgerParameters, unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { firstValueFrom, filter, timeout } from 'rxjs';

const derive = (seed, role) => {
  const hd = HDWallet.fromSeed(Buffer.from(seed));
  if (hd.type !== 'seedOk') throw new Error('Invalid stored wallet seed');
  try {
    const result = hd.hdWallet.selectAccount(0).selectRole(role).deriveKeyAt(0);
    if (result.type === 'keyOutOfBounds') throw new Error('Wallet key derivation failed');
    return Uint8Array.from(result.key);
  } finally { hd.hdWallet.clear(); }
};

export function walletIdentity(seed, networkId = 'preview') {
  if (networkId !== 'preview') throw new Error('Demo wallet is Preview-only');
  const shielded = derive(seed, Roles.Zswap), dust = derive(seed, Roles.Dust), unshielded = derive(seed, Roles.NightExternal);
  const keystore = createKeystore(unshielded, networkId);
  return { seeds: { shielded, dust, unshielded }, keystore,
    address: keystore.getBech32Address().asString(), keys: ZswapSecretKeys.fromSeed(shielded), dustKey: DustSecretKey.fromSeed(dust) };
}

export async function createDemoWallet(seed, network, saved) {
  const identity = walletIdentity(seed, network.networkId);
  const history = () => new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries);
  const configuration = { networkId: network.networkId,
    indexerClientConnection: { indexerHttpUrl: network.indexer, indexerWsUrl: network.indexerWS },
    // SDK 1.2's documented event batching: process the SAME historical events in
    // larger bounded batches. A positive 1ms pacing delay explicitly yields
    // between batches so historical replay cannot monopolize the API event loop.
    // Never synthesize a birthday/cursor or skip private ledger replay.
    batchUpdates: { size: 100, timeout: 5, spacing: 1 },
    provingServerUrl: new URL(network.proofServer), relayURL: new URL(network.nodeWS), txHistoryStorage: history(), costParameters: { feeBlocksMargin: 5 } };
  const shieldedBuilder = ShieldedWallet(configuration);
  const shielded = saved?.shielded ? shieldedBuilder.restore(saved.shielded) : shieldedBuilder.startWithSeed(identity.seeds.shielded);
  const unshieldedBuilder = UnshieldedWallet({ ...configuration, txHistoryStorage: history() });
  const unshielded = saved?.unshielded ? unshieldedBuilder.restore(saved.unshielded) : unshieldedBuilder.startWithPublicKey(PublicKey.fromKeyStore(identity.keystore));
  const dustBuilder = DustWallet({ ...configuration, costParameters: { ledgerParams: LedgerParameters.initialParameters(), additionalFeeOverhead: 1000n, feeBlocksMargin: 5 } });
  const dust = saved?.dust ? dustBuilder.restore(saved.dust) : dustBuilder.startWithSeed(identity.seeds.dust, LedgerParameters.initialParameters().dust);
  const wallet = await WalletFacade.init({ configuration, shielded: () => shielded, unshielded: () => unshielded, dust: () => dust });
  let latest;
  const subscription = wallet.state().subscribe({ next: (state) => { latest = state; }, error: () => {} });
  const publicProgress = (progress, unshielded = false) => ({ connected: progress.isConnected === true,
    synced: progress.isStrictlyComplete(), applied: (unshielded ? progress.appliedId : progress.appliedIndex).toString(),
    target: (unshielded ? progress.highestTransactionId : progress.highestRelevantWalletIndex).toString() });
  return {
    wallet, address: identity.address, keystore: identity.keystore,
    getCoinPublicKey: () => identity.keys.coinPublicKey,
    getEncryptionPublicKey: () => identity.keys.encryptionPublicKey,
    start: () => wallet.start(identity.keys, identity.dustKey),
    async waitSynced(ms = 1_800_000) {
      return firstValueFrom(wallet.state().pipe(filter((s) => s.shielded.state.progress.isStrictlyComplete()
        && s.unshielded.progress.isStrictlyComplete() && s.dust.state.progress.isStrictlyComplete()), timeout({ first: ms })));
    },
    current: () => latest,
    async serialize() { return { shielded: await wallet.shielded.serializeState(), unshielded: await wallet.unshielded.serializeState(), dust: await wallet.dust.serializeState() }; },
    summary() {
      if (!latest) return { synced: false, nightAtomic: '0', dustAtomic: '0', unregistered: 0 };
      const token = unshieldedToken().raw;
      return { synced: latest.shielded.state.progress.isStrictlyComplete() && latest.unshielded.progress.isStrictlyComplete() && latest.dust.state.progress.isStrictlyComplete(),
        syncProgress: { shielded: publicProgress(latest.shielded.state.progress), unshielded: publicProgress(latest.unshielded.progress, true),
          dust: publicProgress(latest.dust.state.progress) },
        nightAtomic: (latest.unshielded.balances[token] ?? 0n).toString(), dustAtomic: latest.dust.balance(new Date()).toString(),
        unregistered: latest.unshielded.availableCoins.filter((coin) => coin.utxo.type === token && coin.meta.registeredForDustGeneration === false).length };
    },
    async balanceTx(tx, ttl = new Date(Date.now() + 3_600_000)) {
      const recipe = await wallet.balanceUnboundTransaction(tx, { shieldedSecretKeys: identity.keys, dustSecretKey: identity.dustKey }, { ttl });
      const signed = await wallet.signRecipe(recipe, (data) => identity.keystore.signData(data));
      return wallet.finalizeRecipe(signed);
    },
    submitTx: (tx) => wallet.submitTransaction(tx),
    async registerDust() {
      const state = await this.waitSynced(); const token = unshieldedToken().raw;
      const coins = state.unshielded.availableCoins.filter((coin) => coin.utxo.type === token && coin.meta.registeredForDustGeneration === false);
      if (!coins.length) return null;
      const recipe = await wallet.registerNightUtxosForDustGeneration(coins, identity.keystore.getPublicKey(), (data) => identity.keystore.signData(data));
      return wallet.finalizeRecipe(recipe); // Caller durably stores signed bytes before submit.
    },
    async stop() { subscription.unsubscribe(); await wallet.stop(); },
  };
}
