import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { sealDirectory, restoreDirectory } from '../scripts/lace-ci/state.mjs';

const context = { repository: 'IBKR-BouncyBot/Midnight-Agent-AI-Wallet', network: 'preview', walletVersion: '2.5.1' };
const magic = Buffer.from('LACE-CI-STATE\0\x01');
const privateMetadata = JSON.stringify({ walletPassword: 'synthetic-wallet-password-only', appPassword: 'synthetic-app-password-only',
  walletVersion: '2.5.1', progress: { stage: 'submitted-uncertain', ids: ['00' + 'ab'.repeat(32)] } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lace-ci-state-test-')), sourceDir = join(root, 'private-session');
  await mkdir(join(sourceDir, 'profile', 'IndexedDB'), { recursive: true });
  await mkdir(join(sourceDir, 'profile', 'empty'));
  await writeFile(join(sourceDir, 'session-private.json'), privateMetadata);
  const binary = Buffer.concat([randomBytes(125_000), Buffer.alloc(150_000, 71)]);
  await writeFile(join(sourceDir, 'profile', 'IndexedDB', 'synthetic.ldb'), binary);
  return { root, sourceDir, binary, key: randomBytes(32), archiveFile: join(root, 'state.encrypted'), destinationDir: join(root, 'restored') };
}
const rejected = async (work, code) => assert.rejects(work, error => error.code === code);
const noPath = path => assert.rejects(readFile(path), error => error.code === 'ENOENT');

test('closed CI profile and uncertain progress round-trip exactly with authenticated context', async () => {
  const f = await fixture();
  try {
    const originalKey = Buffer.from(f.key);
    const sealed = await sealDirectory({ ...f, context });
    const encrypted = await readFile(f.archiveFile);
    assert.equal(encrypted.includes(Buffer.from('synthetic-wallet-password-only')), false);
    assert.equal(encrypted.includes(Buffer.from('synthetic-app-password-only')), false);
    assert.equal(encrypted.includes(Buffer.from('session-private.json')), false);
    assert.deepEqual(f.key, originalKey);
    // Independent native AES/GZIP inspection verifies the envelope, not merely
    // agreement between the production encoder and decoder.
    const headerLength = encrypted.readUInt32BE(magic.length), prefixLength = magic.length + 4 + headerLength;
    const header = JSON.parse(encrypted.subarray(magic.length + 4, prefixLength));
    assert.deepEqual(header.context, context);
    const decrypt = createDecipheriv('aes-256-gcm', f.key, Buffer.from(header.nonce, 'base64'));
    decrypt.setAAD(encrypted.subarray(0, prefixLength)); decrypt.setAuthTag(encrypted.subarray(-16));
    const body = gunzipSync(Buffer.concat([decrypt.update(encrypted.subarray(prefixLength, -16)), decrypt.final()]));
    assert.equal(body.includes(Buffer.from(privateMetadata)), true);
    const restored = await restoreDirectory({ ...f, key: f.key.toString('base64'), context });
    assert.deepEqual(restored, sealed);
    assert.equal(await readFile(join(f.destinationDir, 'session-private.json'), 'utf8'), privateMetadata);
    assert.deepEqual(await readFile(join(f.destinationDir, 'profile', 'IndexedDB', 'synthetic.ldb')), f.binary);
    assert.deepEqual(await readdir(join(f.destinationDir, 'profile', 'empty')), []);
    assert.deepEqual(await readdir(f.root), ['private-session', 'restored', 'state.encrypted']);
    assert.deepEqual(f.key, originalKey);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('wrong key, changed ciphertext and missing archive never create replacement state', async () => {
  const f = await fixture();
  try {
    await sealDirectory({ ...f, context });
    await rejected(restoreDirectory({ ...f, key: randomBytes(32), context }), 'CI_STATE_AUTHENTICATION_FAILED');
    assert.deepEqual(await readdir(f.root), ['private-session', 'state.encrypted']);
    const original = await readFile(f.archiveFile);
    for (const offset of [original.length - 1, original.length - 25]) {
      const tampered = Buffer.from(original); tampered[offset] ^= 1; await writeFile(f.archiveFile, tampered);
      await rejected(restoreDirectory({ ...f, context }), 'CI_STATE_AUTHENTICATION_FAILED');
      assert.deepEqual(await readdir(f.root), ['private-session', 'state.encrypted']);
    }
    await rm(f.archiveFile);
    await rejected(restoreDirectory({ ...f, context }), 'ENOENT');
    assert.deepEqual(await readdir(f.root), ['private-session']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('repository, Preview network and extension version are bound; destinations and archives are never overwritten', async () => {
  const f = await fixture();
  try {
    await sealDirectory({ ...f, context }); const encrypted = await readFile(f.archiveFile);
    for (const mismatch of [{ ...context, repository: 'someone/else' }, { ...context, walletVersion: '2.5.2' }]) {
      await rejected(restoreDirectory({ ...f, context: mismatch }), 'CI_STATE_CONTEXT_MISMATCH');
    }
    await rejected(restoreDirectory({ ...f, context: { ...context, network: 'mainnet' } }), 'CI_STATE_CONTEXT_INVALID');
    await rejected(restoreDirectory({ ...f, key: 'not a 32-byte canonical base64 key', context }), 'CI_STATE_KEY_INVALID');
    await assert.rejects(sealDirectory({ ...f, context }), error => error.code === 'EEXIST');
    assert.deepEqual(await readFile(f.archiveFile), encrypted);
    await mkdir(f.destinationDir); await writeFile(join(f.destinationDir, 'sentinel'), 'keep-existing');
    await rejected(restoreDirectory({ ...f, context }), 'CI_STATE_DESTINATION_EXISTS');
    assert.equal(await readFile(join(f.destinationDir, 'sentinel'), 'utf8'), 'keep-existing');
    await rejected(sealDirectory({ ...f, archiveFile: join(f.sourceDir, 'encrypted'), context }), 'CI_STATE_ARCHIVE_INSIDE_SOURCE');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

function record(kind, name = '', data = Buffer.alloc(0), declaredSize = BigInt(data.length)) {
  const path = Buffer.from(name), header = Buffer.alloc(13);
  header[0] = kind; header.writeUInt32BE(path.length, 1); header.writeBigUInt64BE(declaredSize, 5);
  return Buffer.concat([header, path, data]);
}
// Authenticated adversarial archive from an independent encoder. Authentication
// is not a license to trust paths, entry types, sizes or duplicate file names.
function forge(key, records) {
  const nonce = randomBytes(12);
  const json = Buffer.from(JSON.stringify({ schema: 'midnight-agent-lace-ci-state/v1', context,
    cipher: 'aes-256-gcm', compression: 'gzip', nonce: nonce.toString('base64') }));
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  const prefix = Buffer.concat([magic, length, json]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(prefix);
  return Buffer.concat([prefix, cipher.update(gzipSync(Buffer.concat(records))), cipher.final(), cipher.getAuthTag()]);
}
test('authenticated traversal, link types, duplicate paths, oversized files and trailing payloads fail closed', async () => {
  const f = await fixture();
  try {
    const base = [record(1, 'profile'), record(2, 'session-private.json', Buffer.from(privateMetadata))];
    for (const bad of [record(2, '../escaped', Buffer.from('unsafe')), record(2, '/escaped', Buffer.from('unsafe')),
      record(2, 'profile\\..\\escaped', Buffer.from('unsafe')), record(3, 'profile/link'),
      record(2, 'session-private.json', Buffer.from('replace')), record(2, 'profile/large', Buffer.alloc(0), 1024n ** 3n + 1n)]) {
      await writeFile(f.archiveFile, forge(f.key, [...base, bad, record(0)]));
      await assert.rejects(restoreDirectory({ ...f, context }), error => /^CI_STATE_(PATH|ARCHIVE)_INVALID$/.test(error.code));
      assert.deepEqual(await readdir(f.root), ['private-session', 'state.encrypted']);
      await noPath(join(f.root, 'escaped'));
    }
    await writeFile(f.archiveFile, forge(f.key, [...base, record(0), Buffer.from('unexpected trailing bytes')]));
    await rejected(restoreDirectory({ ...f, context }), 'CI_STATE_ARCHIVE_INVALID');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('active profile locks are refused and an incomplete state cannot be archived', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sourceDir, 'profile', 'SingletonLock'), 'synthetic-active');
    await rejected(sealDirectory({ ...f, context }), 'CI_STATE_PROFILE_NOT_CLOSED');
    await noPath(f.archiveFile);
    await rm(join(f.sourceDir, 'profile', 'SingletonLock')); await rm(join(f.sourceDir, 'session-private.json'));
    await rejected(sealDirectory({ ...f, context }), 'ENOENT'); await noPath(f.archiveFile);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('symlinks never enter a CI archive', async t => {
  const f = await fixture();
  try {
    try { await symlink(join(f.sourceDir, 'session-private.json'), join(f.sourceDir, 'profile', 'link')); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Host cannot create symlink; Linux CI exercises this case'); return; } throw error; }
    await rejected(sealDirectory({ ...f, context }), 'CI_STATE_ENTRY_INVALID'); await noPath(f.archiveFile);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('state CLI refuses non-CI use without revealing supplied secret values', () => {
  const key = randomBytes(32).toString('base64');
  const result = spawnSync(process.execPath, ['scripts/lace-ci/state.mjs', 'restore'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false', LACE_CI_STATE_KEY: key } });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'CI_STATE_ISOLATED_RUNNER_REQUIRED');
  assert.equal(result.stderr.includes(key), false);
});
