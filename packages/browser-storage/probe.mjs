import { BrowserSnapshotStore } from './index.mjs';
import { openDatabase, readRecords } from './indexeddb.mjs';
import { serializeSnapshot } from './codec.mjs';

const error = code => Object.assign(new Error(code), { name: 'BrowserStorageProbeError', code });
const requireCheck = (value, name) => { if (!value) throw error(`PROBE_${name}_FAILED`); };
const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((byte, i) => byte === b[i]);
const sameState = (a, b) => {
  const first = serializeSnapshot(a); const second = serializeSnapshot(b);
  try { return sameBytes(first, second); } finally { first.fill(0); second.fill(0); }
};
function includesBytes(haystack, needle) {
  outer: for (let index = 0; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) if (haystack[index + offset] !== needle[offset]) continue outer;
    return true;
  }
  return false;
}
async function rejectsCode(operation, expected) {
  try { await operation(); } catch (failure) {
    requireCheck(failure?.code === expected, 'EXPECTED_REJECTION'); return;
  }
  throw error('PROBE_EXPECTED_REJECTION_FAILED');
}
function abortWrite(database, record) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('encrypted-snapshots', 'readwrite', { durability: 'strict' });
    transaction.oncomplete = () => reject(error('PROBE_ABORT_FAILED'));
    transaction.onabort = () => resolve();
    transaction.onerror = () => reject(error('PROBE_ABORT_WRITE_FAILED'));
    const write = transaction.objectStore('encrypted-snapshots').put(record, 'snapshot');
    // The write request succeeds, then the complete transaction is deliberately
    // aborted. A request success must never be treated as a durable checkpoint.
    write.onsuccess = () => transaction.abort();
  });
}
function removeOwnedDatabase(name, owned) {
  if (!owned.has(name) || !/^midnight-storage-probe-[0-9a-f-]{36}-(source|restored|rollback)$/.test(name)) {
    throw error('PROBE_CLEANUP_SCOPE_FAILED');
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(`midnight-agent-wallet:${name}`);
    request.onsuccess = () => resolve();
    request.onerror = request.onblocked = () => reject(error('PROBE_CLEANUP_FAILED'));
  });
}

/** Opt-in, loopback-only actual-browser probe. All credentials/state are freshly
 * generated disposable fixtures. Never accepts wallet inputs or returns private
 * bytes, passwords, fixture identities, or raw browser errors. */
export async function runBrowserStorageProbe({ enabled = false } = {}) {
  if (enabled !== true) throw error('PROBE_EXPLICIT_OPT_IN_REQUIRED');
  if (!globalThis.isSecureContext || !['http:', 'https:'].includes(globalThis.location?.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname)) {
    throw error('PROBE_LOCAL_ORIGIN_REQUIRED');
  }
  if (!globalThis.indexedDB || !globalThis.navigator?.locks || !globalThis.crypto?.subtle) throw error('PROBE_BROWSER_APIS_REQUIRED');
  const runId = crypto.randomUUID();
  const names = Object.fromEntries(['source', 'restored', 'rollback'].map(role => [role, `midnight-storage-probe-${runId}-${role}`]));
  const owned = new Set(Object.values(names));
  const stores = []; const databases = [];
  const password = `disposable-probe-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const context = { network: 'preview', identityId: `synthetic-storage-probe:${runId}` };
  const options = name => ({ name, password, context });
  const openStore = async name => { const store = await BrowserSnapshotStore.open(options(name)); stores.push(store); return store; };
  const createStore = async initialState => {
    const store = await BrowserSnapshotStore.create({ ...options(names.source), initialState }); stores.push(store); return store;
  };
  const openRaw = async name => { const database = await openDatabase(indexedDB, name, false); databases.push(database); return database; };
  const initial = { fixture: 'disposable-browser-storage-probe', marker: `private-probe-${crypto.randomUUID()}`,
    confirmed: { opening: crypto.getRandomValues(new Uint8Array(32)), spent: 0n, max: (1n << 64n) - 1n }, candidate: null, pending: null };
  let result, failure;
  try {
    const created = await createStore(initial);
    const oldestBackup = await created.exportBackup();
    await rejectsCode(() => BrowserSnapshotStore.open(options(names.source)), 'STORE_IN_USE');
    const before = created.snapshot();
    await created.update(draft => { draft.candidate = { opening: new Uint8Array([5, 6, 7]), spent: 40n }; draft.pending = { phase: 'prepared' }; });
    const prepared = created.snapshot();
    requireCheck(sameState(before.confirmed, prepared.confirmed) && prepared.pending.phase === 'prepared', 'PREPARED_CHECKPOINT');
    const signed = { ...prepared, pending: { phase: 'submitting', signedBytes: new Uint8Array([11, 22, 33]), transactionIds: ['synthetic-public-transaction-id'] } };
    let simulatedSend = false;
    await created.checkpoint(signed);
    // This is only an ordering flag: the probe has no transaction/network sender.
    simulatedSend = true;
    requireCheck(created.revision === 2 && simulatedSend, 'BEFORE_SEND_CHECKPOINT');
    const sourceDb = await openRaw(names.source);
    const storedBeforeAbort = await readRecords(sourceDb);
    requireCheck(storedBeforeAbort.record.revision === 2, 'ACTUAL_IDB_REVISION');
    requireCheck(!includesBytes(storedBeforeAbort.record.ciphertext, initial.confirmed.opening)
      && !includesBytes(storedBeforeAbort.record.ciphertext, new TextEncoder().encode(initial.marker)), 'CIPHERTEXT_LITERAL_SCAN');
    await abortWrite(sourceDb, { ...storedBeforeAbort.record, revision: 999 });
    const storedAfterAbort = await readRecords(sourceDb);
    requireCheck(sameState(storedAfterAbort, storedBeforeAbort), 'ABORT_ROLLBACK');
    sourceDb.close();
    await created.close();
    await rejectsCode(() => BrowserSnapshotStore.open({ ...options(names.source), password: `${password}-incorrect` }), 'SNAPSHOT_AUTHENTICATION_FAILED');
    const reopened = await openStore(names.source);
    requireCheck(sameState(reopened.snapshot(), signed) && reopened.revision === 2, 'REOPEN_EXACT_STATE');
    const detached = reopened.snapshot(); detached.confirmed.opening.fill(0);
    requireCheck(sameState(reopened.snapshot(), signed), 'DETACHED_SNAPSHOT');
    const backup = await reopened.exportBackup();
    requireCheck(!includesBytes(backup, initial.confirmed.opening) && !includesBytes(backup, new TextEncoder().encode(initial.marker)), 'ENCRYPTED_BACKUP_SCAN');
    const damaged = backup.slice(); damaged[damaged.length - 1] ^= 1;
    await rejectsCode(() => BrowserSnapshotStore.restore({ ...options(names.restored), backup: damaged }), 'SNAPSHOT_AUTHENTICATION_FAILED');
    await rejectsCode(() => BrowserSnapshotStore.open(options(names.restored)), 'STORE_NOT_FOUND');
    await rejectsCode(() => BrowserSnapshotStore.restore({ ...options(names.restored), context: { ...context, identityId: 'another-public-account' }, backup }), 'CONTEXT_MISMATCH');
    const restored = await BrowserSnapshotStore.restore({ ...options(names.restored), backup }); stores.push(restored);
    requireCheck(sameState(restored.snapshot(), signed), 'BACKUP_RESTORE_EXACT_STATE');
    await restored.close();
    await rejectsCode(() => BrowserSnapshotStore.restore({ ...options(names.restored), backup: oldestBackup }), 'STORE_ALREADY_EXISTS');
    const verifiedRestored = await openStore(names.restored);
    requireCheck(sameState(verifiedRestored.snapshot(), signed), 'RESTORE_NO_OVERWRITE');
    // An older authentic backup still decrypts in a fresh store. Explicitly
    // demonstrate this boundary; chain freshness cannot be proven by storage.
    const older = await BrowserSnapshotStore.restore({ ...options(names.rollback), backup: oldestBackup }); stores.push(older);
    requireCheck(sameState(older.snapshot(), initial), 'OLDER_AUTHENTIC_BACKUP_BOUNDARY');
    result = {
      format: 'midnight-browser-storage-probe-v1', success: true, execution: 'actual-browser-indexeddb-webcrypto-weblocks',
      explicitLocalOnly: true, realWalletUsed: false, transactionsSubmitted: 0,
      exactBigIntAndBytesReopened: true, exclusiveWriterRejected: true, wrongPasswordRejectedWithoutReplacement: true,
      preparedAndSignedCheckpointedBeforeSimulatedSend: true, strictDurabilityRequested: true,
      successfulRequestThenAbortedTransactionRolledBack: true, observedCommittedRevision: reopened.revision,
      ciphertextPrivateSamplesAbsent: true, encryptedBackupPrivateSamplesAbsent: true,
      corruptBackupRejectedBeforeCreation: true, wrongContextRejected: true, backupRestoredExactStateToAnotherDatabase: true,
      existingStoreProtectedFromOlderBackup: true, olderAuthenticBackupAcceptedInFreshStore: true,
      chainFreshnessVerified: false, callerChainReconciliationRequired: true,
      verificationBoundary: 'Actual browser APIs with synthetic state; no wallet, proof, chain transaction, process-kill or power-loss exercise. Cross-database restore is not a separate-origin UI migration test.',
    };
  } catch (cause) { failure = error(/^PROBE_[A-Z0-9_]+$/.test(cause?.code ?? '') ? cause.code : 'PROBE_CHECK_FAILED'); }
  finally {
    for (const database of databases) database.close();
    const closed = await Promise.allSettled(stores.map(store => store.close()));
    const removed = await Promise.allSettled([...owned].map(name => removeOwnedDatabase(name, owned)));
    if (closed.some(outcome => outcome.status !== 'fulfilled') || removed.some(outcome => outcome.status !== 'fulfilled')) failure = error('PROBE_CLEANUP_FAILED');
    initial.confirmed.opening.fill(0);
  }
  if (failure) throw failure;
  return { ...result, disposableDatabasesRemoved: owned.size };
}
