import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat, readFile, open, link, unlink } from 'node:fs/promises';
import { DemoVault, loadDemoKey } from './key-vault.mjs';
import { walletIdentity } from './wallet.mjs';

export const DEMO_ROOT = fileURLToPath(new URL('../../.local/demo-preview/', import.meta.url));
async function exists(file) {
  try { return (await stat(file)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function publishManifest(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await link(temporary, file); // Atomic no-overwrite publication on the local filesystem.
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
}

export async function initializeDemoIdentity(directory = DEMO_ROOT, keyOptions = {}) {
  const encryptedFile = path.join(directory, 'demo.enc');
  const keyFile = path.join(directory, 'key-protection.json');
  const manifestFile = path.join(directory, 'identity-public.json');
  const [hasState, hasKey, hasManifest] = await Promise.all([exists(encryptedFile), exists(keyFile), exists(manifestFile)]);
  if (!hasState && (hasKey || hasManifest)) throw new Error('Encrypted demo identity is missing; restore its backup instead of creating another wallet');
  if (hasState && !hasKey) throw new Error('Demo key metadata is missing; restore its backup');
  let manifest;
  if (hasManifest) {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest?.version !== 1 || manifest.network !== 'preview'
        || typeof manifest.ownerAddress !== 'string' || typeof manifest.merchantAddress !== 'string') {
      throw new Error('Invalid public demo identity manifest');
    }
  }
  const protectedKey = await loadDemoKey(directory, { ...keyOptions, createIfMissing: !hasKey });
  let vault;
  try {
    vault = await DemoVault.open(encryptedFile, protectedKey.key, { createIfMissing: !hasState });
    const state = vault.snapshot();
    const owner = walletIdentity(state.ownerSeed);
    const merchant = walletIdentity(state.merchantSeed);
    const expected = { version: 1, network: 'preview', ownerAddress: owner.address, merchantAddress: merchant.address };
    if (manifest && (manifest.ownerAddress !== expected.ownerAddress || manifest.merchantAddress !== expected.merchantAddress)) {
      throw new Error('Stored wallet identity differs from the public manifest; recovery is required');
    }
    // Existing installations get a manifest only from successfully decrypted
    // stored seeds. No address is disclosed before this durable binding exists.
    if (!manifest) await publishManifest(manifestFile, expected);
    return { vault, fundingAddress: owner.address, protection: protectedKey.protection };
  } catch (error) { await vault?.close(); throw error; }
  finally { protectedKey.key.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const initialized = await initializeDemoIdentity();
  try { process.stdout.write(`${JSON.stringify({ network: 'preview', fundingAddress: initialized.fundingAddress, keyProtection: initialized.protection })}\n`); }
  finally { await initialized.vault.close(); }
}
