import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rm, access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDemoIdentity } from '../services/demo/initialize.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'midnight-demo-identity-test-'));
  const options = { password: `test-${randomBytes(24).toString('base64url')}` };
  const opened = [];
  t.after(async () => {
    for (const identity of opened) await identity.vault.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('midnight-demo-identity-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, async open() { const identity = await initializeDemoIdentity(directory, options); opened.push(identity); return identity; } };
}

test('Preview identity manifest binds both persistent wallets before displaying the funding address', async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  const manifest = JSON.parse(await readFile(join(f.directory, 'identity-public.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['merchantAddress', 'network', 'ownerAddress', 'version']);
  assert.equal(manifest.network, 'preview');
  assert.equal(manifest.ownerAddress, first.fundingAddress);
  assert.match(manifest.ownerAddress, /^mn_addr_preview1/);
  assert.notEqual(manifest.ownerAddress, manifest.merchantAddress);
  await first.vault.close();
  const restored = await f.open();
  assert.equal(restored.fundingAddress, first.fundingAddress);
});

test('missing encrypted identity fails closed and never creates a replacement wallet', async (t) => {
  const f = await fixture(t); const first = await f.open(); await first.vault.close();
  const manifest = await readFile(join(f.directory, 'identity-public.json'));
  await unlink(join(f.directory, 'demo.enc'));
  await assert.rejects(f.open(), /identity is missing/);
  await assert.rejects(access(join(f.directory, 'demo.enc')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(f.directory, 'identity-public.json')), manifest);
});

test('an authenticated legacy identity gains a public manifest without changing either wallet', async (t) => {
  const f = await fixture(t); const first = await f.open(); await first.vault.close();
  const manifestFile = join(f.directory, 'identity-public.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const encryptedState = await readFile(join(f.directory, 'demo.enc'));
  await unlink(manifestFile);
  const restored = await f.open();
  assert.equal(restored.fundingAddress, first.fundingAddress);
  assert.deepEqual(JSON.parse(await readFile(manifestFile, 'utf8')), manifest);
  assert.deepEqual(await readFile(join(f.directory, 'demo.enc')), encryptedState);
});

test('missing key metadata and mismatched manifests cannot silently replace an existing identity', async (t) => {
  const f = await fixture(t); const first = await f.open(); await first.vault.close();
  const keyFile = join(f.directory, 'key-protection.json'); const keyMetadata = await readFile(keyFile);
  const state = await readFile(join(f.directory, 'demo.enc'));
  await unlink(keyFile);
  await assert.rejects(f.open(), /key metadata is missing/);
  await assert.rejects(access(keyFile), { code: 'ENOENT' });
  await writeFile(keyFile, keyMetadata);
  const manifestFile = join(f.directory, 'identity-public.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  await writeFile(manifestFile, JSON.stringify({ ...manifest, ownerAddress: manifest.merchantAddress }));
  await assert.rejects(f.open(), /differs from the public manifest/);
  assert.deepEqual(await readFile(join(f.directory, 'demo.enc')), state);
});
