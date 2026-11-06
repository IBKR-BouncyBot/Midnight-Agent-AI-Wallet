import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoVault, loadDemoKey } from '../services/demo/key-vault.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'midnight-demo-vault-test-'));
  const file = join(directory, 'demo.enc');
  const key = randomBytes(32);
  const opened = [];
  t.after(async () => {
    for (const vault of opened) await vault.close();
    key.fill(0);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('midnight-demo-vault-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file, key, async open(storageKey = key) {
    const vault = await DemoVault.open(file, storageKey); opened.push(vault); return vault;
  } };
}

test('demo identity and exact private data survive encrypted close/reopen without wallet rotation', async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  const original = first.snapshot();
  assert.equal(original.network, 'preview');
  assert.notDeepEqual(original.ownerSeed, original.merchantSeed);
  await first.update((state) => { state.setup.testValue = (1n << 64n) - 1n; state.setup.privateMarker = 'private-demo-marker'; });
  const ciphertext = await readFile(f.file);
  assert.equal(ciphertext.includes(Buffer.from(original.ownerSeed)), false);
  assert.equal(ciphertext.includes(Buffer.from(original.merchantSeed)), false);
  assert.equal(ciphertext.includes(Buffer.from(original.privateStorePassword)), false);
  assert.equal(ciphertext.includes(Buffer.from('private-demo-marker')), false);
  await first.close();
  const restored = await f.open();
  assert.deepEqual(restored.snapshot().ownerSeed, original.ownerSeed);
  assert.deepEqual(restored.snapshot().merchantSeed, original.merchantSeed);
  assert.deepEqual(restored.snapshot().ownerSecret, original.ownerSecret);
  assert.deepEqual(restored.snapshot().agentSecret, original.agentSecret);
  assert.deepEqual(restored.snapshot().runnerKey, original.runnerKey);
  assert.equal(restored.snapshot().setup.testValue, (1n << 64n) - 1n);
});

test('demo wrong keys and corrupted ciphertext fail without replacing existing identity', async (t) => {
  const f = await fixture(t);
  const initial = await f.open(); await initial.close();
  const original = await readFile(f.file);
  await assert.rejects(f.open(randomBytes(32)));
  assert.deepEqual(await readFile(f.file), original);
  const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1;
  await writeFile(f.file, damaged);
  await assert.rejects(f.open());
  assert.deepEqual(await readFile(f.file), damaged);
});

test('demo state excludes a second writer and returns detached snapshots', async (t) => {
  const f = await fixture(t);
  const vault = await f.open();
  await assert.rejects(f.open(), { code: 'EEXIST' });
  const snapshot = vault.snapshot(); snapshot.ownerSeed.fill(0); snapshot.setup.injected = true;
  assert.notDeepEqual(vault.snapshot().ownerSeed, snapshot.ownerSeed);
  assert.equal(vault.snapshot().setup.injected, undefined);
});

test('existing-identity open cannot recreate missing state or key metadata', async (t) => {
  const f = await fixture(t);
  await assert.rejects(DemoVault.open(f.file, f.key, { createIfMissing: false }), /identity is missing/);
  await assert.rejects(access(f.file), { code: 'ENOENT' });
  await assert.rejects(access(`${f.file}.lock`), { code: 'ENOENT' });
  await assert.rejects(loadDemoKey(f.directory, { password: 'test-only-unlock-password', createIfMissing: false }), /metadata is missing/);
  await assert.rejects(access(join(f.directory, 'key-protection.json')), { code: 'ENOENT' });
});

test('password key metadata reopens the same key and wrong passwords cannot unlock stored identity', async (t) => {
  const f = await fixture(t);
  const password = `demo-test-${randomBytes(24).toString('base64url')}`;
  const first = await loadDemoKey(f.directory, { password });
  const vault = await f.open(first.key); await vault.close();
  const restored = await loadDemoKey(f.directory, { password });
  assert.deepEqual(restored.key, first.key);
  const different = await loadDemoKey(f.directory, { password: `${password}-different` });
  assert.notDeepEqual(different.key, first.key);
  await assert.rejects(f.open(different.key));
  await assert.rejects(loadDemoKey(f.directory, { password: '' }), /password is required/);
  const metadata = await readFile(join(f.directory, 'key-protection.json'));
  assert.equal(metadata.includes(Buffer.from(password)), false);
  assert.equal(metadata.includes(Buffer.from(first.key)), false);
  first.key.fill(0); restored.key.fill(0); different.key.fill(0);
});
