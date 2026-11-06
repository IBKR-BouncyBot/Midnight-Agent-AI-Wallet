/** Acquire and inspect a pinned PUBLIC extension. Never runs browser/extension
 * code, accesses a browser profile, creates a wallet, or sends a transaction. */
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify, constants } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const extensionId = hex => [...hex].map(n => String.fromCharCode(97 + Number.parseInt(n, 16))).join('');
const MAX_CRX = 128 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_UNPACKED = 512 * 1024 * 1024;

function protobufFields(data) {
  let offset = 0;
  function integer() {
    let value = 0, shift = 0;
    while (offset < data.length && shift < 49) {
      const byte = data[offset++]; value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error('Invalid CRX protobuf integer');
  }
  const fields = [];
  while (offset < data.length) {
    const tag = integer(), field = Math.floor(tag / 8), wire = tag & 7;
    assert.ok(field > 0 && wire === 2, 'Unexpected CRX protobuf field');
    const size = integer();
    assert.ok(offset + size <= data.length, 'Truncated CRX protobuf field');
    fields.push([field, data.subarray(offset, offset + size)]); offset += size;
  }
  return fields;
}
function one(fields, number) {
  const values = fields.filter(([field]) => field === number);
  assert.equal(values.length, 1, 'Missing or duplicated CRX field'); return values[0][1];
}

/** CRX3 signature verification follows Chromium's signed-byte framing and
 * RSA-PKCS1-SHA256/ECDSA-SHA256 algorithms. Trust pins are supplied explicitly
 * for deterministic tests; the CLI always loads its checked-in extension.json. */
export function verifyCrxPackage(bytes, pin) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.length <= MAX_CRX, 'Invalid CRX size');
  assert.equal(bytes.length, pin.crxBytes, 'Pinned CRX size differs');
  assert.equal(hash(bytes), pin.crxSha256, 'Pinned CRX hash differs');
  assert.equal(bytes.subarray(0, 4).toString(), 'Cr24', 'Not a CRX');
  assert.equal(bytes.readUInt32LE(4), 3, 'Only CRX3 is supported');
  const headerSize = bytes.readUInt32LE(8);
  assert.ok(headerSize > 0 && headerSize <= 1_048_576 && 12 + headerSize < bytes.length, 'Invalid CRX header size');
  const fields = protobufFields(bytes.subarray(12, 12 + headerSize));
  const signedHeader = one(fields, 10000), idBytes = one(protobufFields(signedHeader), 1);
  assert.equal(idBytes.length, 16, 'Invalid CRX identity');
  const id = extensionId(idBytes.toString('hex'));
  assert.equal(id, pin.extensionId, 'Wrong extension identity');
  const archive = bytes.subarray(12 + headerSize);
  assert.equal(hash(archive), pin.archiveSha256, 'Pinned archive hash differs');
  assert.ok(archive.length >= 22 && archive.readUInt32LE(0) === 0x04034b50, 'Missing ZIP archive');
  const signedSize = Buffer.alloc(4); signedSize.writeUInt32LE(signedHeader.length);
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\0'), signedSize, signedHeader, archive]);
  const proofs = fields.filter(([field]) => field === 2 || field === 3).map(([field, data]) => {
    const proof = protobufFields(data), publicBytes = one(proof, 1), signature = one(proof, 2);
    const key = createPublicKey({ key: publicBytes, type: 'spki', format: 'der' });
    assert.equal(key.asymmetricKeyType, field === 2 ? 'rsa' : 'ec', 'Wrong signature key type');
    const verified = verify('sha256', message, field === 2 ? { key, padding: constants.RSA_PKCS1_PADDING } : key, signature);
    assert.equal(verified, true, 'Invalid CRX signature');
    const keyHash = hash(publicBytes);
    return { algorithm: field === 2 ? 'RSA-PKCS1-SHA256' : 'ECDSA-SHA256', publicKeySha256: keyHash,
      developerIdMatches: keyHash.slice(0, 32) === idBytes.toString('hex'),
      chromiumWebStorePublisherKey: keyHash === pin.publisherKeySha256, signatureVerified: verified };
  });
  assert.ok(proofs.some(proof => proof.developerIdMatches), 'Developer identity proof missing');
  assert.ok(proofs.some(proof => proof.chromiumWebStorePublisherKey), 'Chromium Web Store publisher proof missing');
  return { archive, evidence: { extensionId: id, crxVersion: 3, crxBytes: bytes.length, crxSha256: hash(bytes),
    archiveBytes: archive.length, archiveSha256: hash(archive), developerSignatureVerified: true,
    webStorePublisherSignatureVerified: true, proofs } };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
  return i >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function safeName(bytes) {
  const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(name.length && name.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(name) && !name.startsWith('/'), 'Unsafe ZIP path');
  const parts = name.replace(/\/$/, '').split('/');
  assert.ok(parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe ZIP path component');
  return name;
}

/** Read a bounded ordinary ZIP central directory. Refuses ZIP64, links, device
 * files, ambiguous names, overlapping data, encrypted entries and path escapes. */
export function inspectZip(archive) {
  assert.ok(Buffer.isBuffer(archive) && archive.length >= 22 && archive.length <= MAX_CRX, 'Invalid ZIP size');
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65_557); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50 && i + 22 + archive.readUInt16LE(i + 20) === archive.length) { end = i; break; }
  }
  assert.ok(end >= 0, 'ZIP directory footer missing');
  assert.equal(archive.readUInt16LE(end + 4), 0); assert.equal(archive.readUInt16LE(end + 6), 0);
  const count = archive.readUInt16LE(end + 10), centralSize = archive.readUInt32LE(end + 12), centralStart = archive.readUInt32LE(end + 16);
  assert.ok(count > 0 && count <= 10_000 && count === archive.readUInt16LE(end + 8), 'Invalid ZIP entry count');
  assert.equal(centralStart + centralSize, end, 'Invalid ZIP directory bounds');
  const entries = [], names = new Set(), ranges = []; let offset = centralStart, total = 0;
  for (let i = 0; i < count; i++) {
    assert.ok(offset + 46 <= end && archive.readUInt32LE(offset) === 0x02014b50, 'Invalid ZIP directory entry');
    const flags = archive.readUInt16LE(offset + 8), method = archive.readUInt16LE(offset + 10), crc = archive.readUInt32LE(offset + 16);
    const compressed = archive.readUInt32LE(offset + 20), size = archive.readUInt32LE(offset + 24);
    const nameSize = archive.readUInt16LE(offset + 28), extraSize = archive.readUInt16LE(offset + 30), commentSize = archive.readUInt16LE(offset + 32);
    const attributes = archive.readUInt32LE(offset + 38), local = archive.readUInt32LE(offset + 42);
    assert.ok(offset + 46 + nameSize + extraSize + commentSize <= end, 'Truncated ZIP entry');
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameSize), name = safeName(nameBytes), folded = name.toLowerCase().replace(/\/$/, '');
    assert.ok(!names.has(folded), 'Duplicate ZIP path'); names.add(folded);
    assert.ok((flags & 1) === 0 && [0, 8].includes(method) && archive.readUInt16LE(offset + 34) === 0, 'Unsupported ZIP entry');
    const type = (attributes >>> 16) & 0o170000, directory = name.endsWith('/');
    assert.ok(type === 0 || type === (directory ? 0o040000 : 0o100000), 'ZIP links/devices are forbidden');
    assert.ok(size <= MAX_FILE && compressed <= MAX_CRX && (total += size) <= MAX_UNPACKED && (!directory || size === 0), 'ZIP expansion limit exceeded');
    assert.ok(local + 30 <= centralStart && archive.readUInt32LE(local) === 0x04034b50, 'Invalid ZIP local header');
    assert.equal(archive.readUInt16LE(local + 6), flags); assert.equal(archive.readUInt16LE(local + 8), method);
    const localNameSize = archive.readUInt16LE(local + 26), localExtraSize = archive.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameSize + localExtraSize;
    assert.ok(dataStart + compressed <= centralStart, 'ZIP data outside archive');
    assert.ok(nameBytes.equals(archive.subarray(local + 30, local + 30 + localNameSize)), 'ZIP filenames disagree');
    if (!(flags & 8)) {
      assert.equal(archive.readUInt32LE(local + 14), crc); assert.equal(archive.readUInt32LE(local + 18), compressed); assert.equal(archive.readUInt32LE(local + 22), size);
    }
    ranges.push([local, dataStart + compressed]); entries.push({ name, directory, method, crc, size, compressed, dataStart });
    offset += 46 + nameSize + extraSize + commentSize;
  }
  assert.equal(offset, end, 'Extra ZIP directory data');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] >= ranges[i - 1][1], 'Overlapping ZIP entries');
  const files = new Set(entries.filter(entry => !entry.directory).map(entry => entry.name.toLowerCase()));
  for (const entry of entries) {
    const parts = entry.name.toLowerCase().replace(/\/$/, '').split('/');
    for (let i = 1; i < parts.length; i++) assert.ok(!files.has(parts.slice(0, i).join('/')), 'ZIP file/directory collision');
  }
  return entries;
}
function contents(archive, entry) {
  const compressed = archive.subarray(entry.dataStart, entry.dataStart + entry.compressed);
  const bytes = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
  assert.equal(bytes.length, entry.size, 'ZIP expanded size differs'); assert.equal(crc32(bytes), entry.crc, 'ZIP CRC differs'); return bytes;
}
export async function extractZip(archive, destination) {
  const entries = inspectZip(archive), root = path.resolve(destination);
  // A fresh root excludes planted symlinks and prevents overwriting any profile.
  await mkdir(root);
  for (const entry of entries) {
    const file = path.resolve(root, ...entry.name.split('/'));
    assert.ok(file.startsWith(root + path.sep), 'ZIP destination escaped');
    if (entry.directory) { await mkdir(file, { recursive: true }); continue; }
    const bytes = contents(archive, entry); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  }
  return { files: entries.filter(entry => !entry.directory).length, expandedBytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
}
async function download(pin) {
  let url = pin.downloadUrl;
  for (let redirect = 0; redirect < 4; redirect++) {
    const parsed = new URL(url);
    assert.ok(parsed.protocol === 'https:' && !parsed.username && !parsed.password && pin.allowedDownloadOrigins.includes(parsed.origin), 'Untrusted download origin');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      assert.ok(response.headers.get('location'), 'Missing redirect URL'); url = new URL(response.headers.get('location'), url).href; await response.body?.cancel(); continue;
    }
    assert.equal(response.status, 200, 'Package download failed');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= pin.crxBytes && size <= MAX_CRX, 'Downloaded package exceeds pin'); chunks.push(chunk); }
    return Buffer.concat(chunks, size);
  }
  throw new Error('Too many package redirects');
}
export async function acquireVerifiedExtension({ out, crx } = {}) {
  assert.ok(typeof out === 'string' && out.length > 0, 'A fresh output directory is required');
  const pin = JSON.parse(await readFile(new URL('./extension.json', import.meta.url), 'utf8'));
  if (crx) assert.equal((await stat(crx)).size, pin.crxBytes, 'Local CRX size differs');
  const bytes = crx ? await readFile(crx) : await download(pin);
  const { archive, evidence } = verifyCrxPackage(bytes, pin);
  const entries = inspectZip(archive), manifestEntry = entries.find(entry => entry.name === 'manifest.json');
  assert.ok(manifestEntry && !manifestEntry.directory && manifestEntry.size <= 128 * 1024, 'Manifest missing');
  const manifest = JSON.parse(contents(archive, manifestEntry).toString('utf8'));
  assert.equal(manifest.name, 'Lace'); assert.equal(manifest.version, pin.version); assert.equal(manifest.manifest_version, 3);
  assert.equal(extensionId(hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)), pin.extensionId, 'Manifest identity differs');
  const root = path.resolve(out); await mkdir(root);
  const extensionPath = path.join(root, 'extension'); const extracted = await extractZip(archive, extensionPath);
  const provenance = { format: 'lace-official-extension-verification-v1', acquiredAt: new Date().toISOString(),
    ...evidence, version: manifest.version, manifestVersion: manifest.manifest_version, extensionPath, ...extracted,
    storeUrl: pin.storeUrl, downloadUrl: pin.downloadUrl, sourceBoundary: pin.sourceBoundary, sources: pin.sources,
    extensionModified: false, extensionLoaded: false, walletCreated: false, transactionSubmitted: false };
  await writeFile(path.join(root, 'verification.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
  return provenance;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const name = args.shift(), value = args.shift();
      assert.ok(['--out', '--crx'].includes(name) && value && !value.startsWith('--') && !(name.slice(2) in options), 'Usage: verify-extension.mjs --out <fresh-directory> [--crx <verified-cache-file>]');
      options[name.slice(2)] = value;
    }
    console.log(JSON.stringify(await acquireVerifiedExtension(options), null, 2));
  } catch (error) { console.error(`Extension verification failed: ${error.message}`); process.exitCode = 1; }
}
