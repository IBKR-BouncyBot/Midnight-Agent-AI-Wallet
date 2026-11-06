import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateStateStore } from '../services/runner/private-store.mjs';

const context = { network: 'local', contractAddress: 'ab'.repeat(32), vaultId: 'cd'.repeat(32) };
const state = () => ({ confirmed: { commitment: randomBytes(32), policySalt: randomBytes(32), coin: { nonce: randomBytes(32), value: 18446744073709551615n } }, pending: null });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'midnight-private-state-'));
  const stores = [];
  t.after(async () => { for (const item of stores) await item.close(); await rm(directory, { recursive: true, force: true }); });
  const options = { file: join(directory, 'private.enc'), key: randomBytes(32), context, initialState: state() };
  const store = await PrivateStateStore.open(options);
  stores.push(store);
  return { directory, options, store, track: (item) => stores.push(item) };
}
test('private openings and exact atomic amounts survive encrypted restart, with spending disabled until chain reconciliation', async (t) => {
  const { options, store, track } = await fixture(t);
  assert.equal(store.canSpend, false);
  const normalized = store.snapshot();
  assert.equal(normalized.confirmed.coin.value, 18446744073709551615n);
  const encrypted = await readFile(options.file);
  assert.equal(encrypted.includes(Buffer.from(options.initialState.confirmed.coin.nonce)), false);
  await store.reconcile(async (saved, scope) => { assert.deepEqual(saved, normalized); assert.deepEqual(scope, context); return true; });
  assert.equal(store.canSpend, true);
  await store.close();
  const reopened = await PrivateStateStore.open(options);
  track(reopened);
  assert.deepEqual(reopened.snapshot(), normalized);
  assert.equal(reopened.canSpend, false);
  await assert.rejects(reopened.reconcile(async () => false), /reconciled/);
  assert.equal(reopened.canSpend, false);
});
test('authenticated backup rejects wrong key, deployment and tampering; restored state requires reconciliation', async (t) => {
  const { directory, options, store, track } = await fixture(t);
  const bytes = await store.exportBackup();
  const file = join(directory, 'restored.enc');
  await assert.rejects(PrivateStateStore.restore({ ...options, bytes, file, key: randomBytes(32) }));
  await assert.rejects(PrivateStateStore.restore({ ...options, bytes, file, context: { ...context, contractAddress: 'ef'.repeat(32) } }));
  const tampered = Buffer.from(bytes); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(PrivateStateStore.restore({ ...options, bytes: tampered, file }));
  const restored = await PrivateStateStore.restore({ ...options, bytes, file });
  track(restored);
  assert.deepEqual(restored.snapshot(), store.snapshot());
  assert.equal(restored.canSpend, false);
  await assert.rejects(PrivateStateStore.restore({ ...options, bytes, file }), { code: 'EEXIST' });
});
test('prepared candidate retains confirmed openings, and concurrent checkpoints cannot race the reconciliation gate', async (t) => {
  const { store } = await fixture(t);
  const before = store.snapshot();
  const candidate = { ...before, pending: { requestId: 'request-1', state: state().confirmed, phase: 'prepared', transactionId: null } };
  await Promise.all([store.reconcile(async () => true), store.checkpoint(candidate)]);
  assert.equal(store.canSpend, false);
  assert.deepEqual(store.snapshot().confirmed, before.confirmed);
  assert.equal(store.snapshot().pending.phase, 'prepared');
});
test('second writer, unsupported state and non-test network fail closed', async (t) => {
  const { options, store } = await fixture(t);
  await assert.rejects(PrivateStateStore.open(options), { code: 'EEXIST' });
  await assert.rejects(store.checkpoint({ invalid: 1.5 }), /unsupported/);
  await assert.rejects(PrivateStateStore.open({ ...options, context: { ...context, network: 'mainnet' } }), /test-network/);
  // A failed second open must not unlink the real writer's lock.
  await assert.rejects(PrivateStateStore.open(options), { code: 'EEXIST' });
});

test('a stale in-flight verifier cannot briefly enable spending after a newer checkpoint', async (t) => {
  const { store } = await fixture(t);
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const verification = store.reconcile(async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return true;
  });
  await entered;
  const changed = { ...store.snapshot(), pending: { phase: 'prepared' } };
  const checkpoint = store.checkpoint(changed);
  const observedAtVerification = verification.then(() => store.canSpend);
  release();
  assert.equal(await observedAtVerification, false);
  await checkpoint;
  assert.equal(store.canSpend, false);
  await store.reconcile(async () => true);
  assert.equal(store.canSpend, true);
});

test('new reconciliation invalidates old success while the new verifier is pending', async (t) => {
  const { store } = await fixture(t);
  let releaseFirst, releaseSecond, enteredFirst, enteredSecond;
  const firstStarted = new Promise((resolve) => { enteredFirst = resolve; });
  const secondStarted = new Promise((resolve) => { enteredSecond = resolve; });
  const first = store.reconcile(async () => { enteredFirst(); await new Promise((resolve) => { releaseFirst = resolve; }); return true; });
  await firstStarted;
  const second = store.reconcile(async () => { enteredSecond(); await new Promise((resolve) => { releaseSecond = resolve; }); return true; });
  const observedAtFirst = first.then(() => store.canSpend);
  releaseFirst();
  assert.equal(await observedAtFirst, false);
  await secondStarted;
  assert.equal(store.canSpend, false);
  releaseSecond(); await second;
  assert.equal(store.canSpend, true);
});

test('opening snapshots caller-owned initial state and context before yielding', async (t) => {
  const { directory, options, track } = await fixture(t);
  const original = state(); const expected = structuredClone(original);
  const suppliedContext = { ...context };
  const file = join(directory, 'detached.enc');
  const opening = PrivateStateStore.open({ ...options, file, context: suppliedContext, initialState: original });
  original.confirmed.coin.value = 1n; suppliedContext.contractAddress = 'ef'.repeat(32);
  const detached = await opening; track(detached);
  assert.deepEqual(detached.snapshot(), expected);
  await detached.close();
  const restarted = await PrivateStateStore.open({ ...options, file }); track(restarted);
  assert.deepEqual(restarted.snapshot(), expected);
});

test('restore respects a writer lock before creating its destination', async (t) => {
  const { directory, options, store } = await fixture(t);
  const file = join(directory, 'locked-restore.enc');
  const lockBytes = Buffer.from('existing-writer-lock');
  await writeFile(`${file}.lock`, lockBytes);
  await assert.rejects(PrivateStateStore.restore({ ...options, bytes: await store.exportBackup(), file }), { code: 'EEXIST' });
  await assert.rejects(access(file), { code: 'ENOENT' });
  assert.deepEqual(await readFile(`${file}.lock`), lockBytes);
});

test('restore never overwrites an unlocked existing destination', async (t) => {
  const { directory, options, store } = await fixture(t);
  const file = join(directory, 'occupied.enc');
  const originalBytes = Buffer.from('preserve-existing-file');
  await writeFile(file, originalBytes);
  await assert.rejects(PrivateStateStore.restore({ ...options, bytes: await store.exportBackup(), file }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(file), originalBytes);
});

test('corrupt existing snapshots are never replaced by the initial-state fallback', async (t) => {
  const { directory, options } = await fixture(t);
  const file = join(directory, 'corrupt.enc');
  const damaged = Buffer.from('corrupt-private-state');
  await writeFile(file, damaged);
  await assert.rejects(PrivateStateStore.open({ ...options, file }), /Invalid private-state/);
  assert.deepEqual(await readFile(file), damaged);
});

test('read-only public deployment context exposes only the authenticated binding', async (t) => {
  const { store } = await fixture(t);
  assert.deepEqual(store.deploymentContext, context);
  assert.equal(Object.isFrozen(store.deploymentContext), true);
  assert.throws(() => { store.deploymentContext.vaultId = 'ff'.repeat(32); }, TypeError);
  assert.deepEqual(store.deploymentContext, context);
});
