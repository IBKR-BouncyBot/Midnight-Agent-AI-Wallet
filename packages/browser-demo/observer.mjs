import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { TransactionHistory } from '@midnight-ntwrk/wallet-sdk-shielded/v1';
import { InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';
import { firstValueFrom, filter, timeout } from 'rxjs';

/** Independent receive-only SDK observer. No owner keys, DUST wallet, signing, proving, or fabricated cursor. */
export async function createMerchantObserver({ seed, network, saved }) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32 || network.networkId !== 'preview') throw new Error('Invalid Preview observer configuration');
  const keys = ZswapSecretKeys.fromSeed(seed);
  const builder = ShieldedWallet({ networkId: 'preview',
    indexerClientConnection: { indexerHttpUrl: network.indexer, indexerWsUrl: network.indexerWS },
    batchUpdates: { size: 100, timeout: 5, spacing: 1 },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(TransactionHistory.ShieldedTransactionHistoryEntrySchema),
  });
  const wallet = saved ? builder.restore(saved) : builder.startWithSeed(seed);
  const initial = await firstValueFrom(wallet.state.pipe(timeout({ first: 10_000 })));
  if (initial.coinPublicKey.toHexString() !== keys.coinPublicKey || initial.encryptionPublicKey.toHexString() !== keys.encryptionPublicKey) {
    await wallet.stop(); throw new Error('Recipient snapshot belongs to another identity');
  }
  let latest, failure = false;
  const subscription = wallet.state.subscribe({ next(value) { latest = value; }, error() { failure = true; } });
  return {
    getCoinPublicKey: () => keys.coinPublicKey, getEncryptionPublicKey: () => keys.encryptionPublicKey,
    current: () => latest ? { shielded: latest } : undefined,
    start: () => wallet.start(keys),
    async waitSynced(ms = 1_800_000) { return firstValueFrom(wallet.state.pipe(filter(value => value.state.progress.isStrictlyComplete()), timeout({ first: ms }))); },
    serialize: () => wallet.serializeState(),
    summary() {
      const progress = latest?.state.progress;
      return { synced: !failure && !!progress?.isStrictlyComplete(),
        syncProgress: progress ? { shielded: { connected: progress.isConnected === true, synced: progress.isStrictlyComplete(),
          applied: progress.appliedIndex.toString(), target: progress.highestRelevantWalletIndex.toString() } } : null,
        observerOnly: true, requiredStreams: ['shielded'] };
    },
    async stop() { subscription.unsubscribe(); await wallet.stop(); },
  };
}
