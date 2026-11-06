// Mirror public proving data at build time. No wallet or witness inputs.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Zkir } from '@midnight-ntwrk/zkir-v2';
import { OFFICIAL_BUILTIN_BASE } from '../packages/browser-prover/materials.mjs';

const root = resolve(import.meta.dirname, '..');
const cache = resolve(root, '.tools/browser-public-artifacts');
const manifestFile = resolve(root, 'scripts/browser-artifacts.json');
const capture = process.argv.includes('--capture-manifest');
const manifest = capture ? { version: 1, source: OFFICIAL_BUILTIN_BASE, files: {} } : JSON.parse(await readFile(manifestFile, 'utf8'));
if (manifest.source !== OFFICIAL_BUILTIN_BASE) throw new Error('Unexpected artifact source');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function artifact(path) {
  if (!/^(?:(?:zswap|dust)\/9\/(?:spend|output|sign)\.(?:prover|verifier|bzkir)|bls_midnight_2p\d+)$/.test(path)) throw new Error('Unexpected public artifact');
  const destination = resolve(cache, path);
  const expected = manifest.files[path];
  if (!capture && !expected) throw new Error(`Unpinned artifact: ${path}`);
  let bytes;
  try { bytes = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes || (expected && digest(bytes) !== expected.sha256)) {
    const response = await fetch(new URL(path, OFFICIAL_BUILTIN_BASE), { redirect: 'error', signal: AbortSignal.timeout(180_000) });
    if (!response.ok || Number(response.headers.get('content-length')) > 256 * 1024 * 1024) throw new Error(`Public artifact unavailable: ${path}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 256 * 1024 * 1024) throw new Error('Invalid artifact size');
  }
  const actual = { bytes: bytes.length, sha256: digest(bytes) };
  if (expected && (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)) throw new Error(`Public artifact integrity mismatch: ${path}`);
  await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  if (capture) manifest.files[path] = actual;
  return bytes;
}
const sizes = new Set();
for (const key of ['zswap/9/spend', 'zswap/9/output', 'zswap/9/sign', 'dust/9/spend']) {
  const [ir] = await Promise.all(['bzkir', 'prover', 'verifier'].map(ext => artifact(`${key}.${ext}`)));
  sizes.add(Zkir.deserialize(ir).getK());
}
for (const contract of ['private-vault', 'test-token']) {
  const directory = resolve(root, 'contracts/managed', contract, 'zkir');
  for (const file of await readdir(directory)) if (file.endsWith('.bzkir')) sizes.add(Zkir.deserialize(await readFile(resolve(directory, file))).getK());
}
for (const k of [...sizes].sort((a,b) => a-b)) await artifact(`bls_midnight_2p${k}`);
if (capture) await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Verified ${Object.keys(manifest.files).length} public artifacts; SRS sizes: ${[...sizes].sort((a,b)=>a-b).join(', ')}.`);
