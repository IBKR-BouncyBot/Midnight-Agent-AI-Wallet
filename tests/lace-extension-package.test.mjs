import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyCrxPackage, inspectZip, extractZip } from '../scripts/lace-ci/verify-extension.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id = hex => [...hex].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');
const developer = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publisher = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicBytes = pair => pair.publicKey.export({ type: 'spki', format: 'der' });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files = [{ name: 'manifest.json', content: '{"name":"test fixture"}' }]) {
  const local = [], central = []; let offset = 0;
  for (const entry of files) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.content ?? ''), method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const checksum = entry.crc ?? crc32(data), size = entry.declaredSize ?? data.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(entry.flags ?? 0, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100600) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(files.length, 8); footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}
function varint(value) {
  const bytes = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
}
const field = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
function crx({ archive = zip(), developerProof = true, publisherProof = true, signedId, duplicateHeader = false } = {}) {
  const developerId = Buffer.from(sha(publicBytes(developer)).slice(0, 32), 'hex');
  const signedHeader = field(1, signedId ?? developerId), size = Buffer.alloc(4); size.writeUInt32LE(signedHeader.length);
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, signedHeader, archive]);
  const proof = (pair, kind) => field(kind, Buffer.concat([field(1, publicBytes(pair)), field(2, sign('sha256', message, pair.privateKey))]));
  const header = Buffer.concat([...(developerProof ? [proof(developer, 2)] : []), ...(publisherProof ? [proof(publisher, 3)] : []), field(10000, signedHeader), ...(duplicateHeader ? [field(10000, signedHeader)] : [])]);
  const prefix = Buffer.alloc(12); prefix.write('Cr24'); prefix.writeUInt32LE(3, 4); prefix.writeUInt32LE(header.length, 8);
  const bytes = Buffer.concat([prefix, header, archive]);
  return { bytes, pin: { extensionId: id(developerId.toString('hex')), crxBytes: bytes.length, crxSha256: sha(bytes), archiveSha256: sha(archive), publisherKeySha256: sha(publicBytes(publisher)) } };
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lace-package-test-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test('CRX3 requires independently verified developer and Web Store signatures', () => {
  const fixture = crx(), { evidence } = verifyCrxPackage(fixture.bytes, fixture.pin);
  assert.equal(evidence.developerSignatureVerified, true);
  assert.equal(evidence.webStorePublisherSignatureVerified, true);
  assert.deepEqual(evidence.proofs.map(p => p.algorithm), ['RSA-PKCS1-SHA256', 'ECDSA-SHA256']);
  for (const options of [{ developerProof: false }, { publisherProof: false }]) {
    const missing = crx(options);
    assert.throws(() => verifyCrxPackage(missing.bytes, missing.pin), /proof missing/);
  }
});
test('CRX pin binds exact bytes, developer identity, and trusted publisher key', () => {
  const { bytes, pin } = crx();
  for (const patch of [{ crxBytes: bytes.length + 1 }, { crxSha256: '00'.repeat(32) }, { archiveSha256: '00'.repeat(32) }, { extensionId: 'a'.repeat(32) }, { publisherKeySha256: '00'.repeat(32) }]) {
    assert.throws(() => verifyCrxPackage(bytes, { ...pin, ...patch }));
  }
  const mismatch = crx({ signedId: Buffer.alloc(16, 7) });
  mismatch.pin.extensionId = id('07'.repeat(16));
  assert.throws(() => verifyCrxPackage(mismatch.bytes, mismatch.pin), /Developer identity proof missing/);
});
test('archive tampering fails signatures even if untrusted hash metadata is replaced', () => {
  const { bytes, pin } = crx(); bytes[bytes.length - 1] ^= 1;
  const archive = bytes.subarray(12 + bytes.readUInt32LE(8));
  assert.throws(() => verifyCrxPackage(bytes, { ...pin, crxSha256: sha(bytes), archiveSha256: sha(archive) }), /Invalid CRX signature/);
});
test('duplicate signed header and truncated CRX framing fail closed', () => {
  const duplicate = crx({ duplicateHeader: true });
  assert.throws(() => verifyCrxPackage(duplicate.bytes, duplicate.pin), /duplicated CRX field/);
  const { bytes, pin } = crx(); bytes.writeUInt32LE(bytes.length, 8);
  assert.throws(() => verifyCrxPackage(bytes, { ...pin, crxSha256: sha(bytes) }), /header size/);
});
test('ZIP extraction preserves regular and deflated bytes in a new directory', async t => {
  const root = await temporary(t), destination = path.join(root, 'extension');
  const data = Buffer.from([0, 255, 10, 100]);
  const archive = zip([{ name: 'manifest.json', content: '{}' }, { name: 'js/', mode: 0o040700 }, { name: 'js/worker.js', content: data, method: 8 }]);
  assert.equal(inspectZip(archive).length, 3);
  assert.deepEqual(await extractZip(archive, destination), { files: 2, expandedBytes: 6 });
  assert.deepEqual(await readFile(path.join(destination, 'js/worker.js')), data);
});
test('ZIP refuses traversal, alternate separators, device paths, and ambiguous components', () => {
  for (const name of ['../outside', '/outside', 'C:/outside', 'safe\\outside', 'a/../outside', 'a//b', './b', 'a./b', 'a /b', 'con', 'LPT1.txt', 'nul/child', 'a\0b']) {
    assert.throws(() => inspectZip(zip([{ name }])), /Unsafe ZIP/);
  }
});
test('ZIP refuses links, case collisions, and parent files', () => {
  assert.throws(() => inspectZip(zip([{ name: 'link', mode: 0o120777, content: '../outside' }])), /links\/devices/);
  assert.throws(() => inspectZip(zip([{ name: 'A' }, { name: 'a' }])), /Duplicate ZIP path/);
  assert.throws(() => inspectZip(zip([{ name: 'a' }, { name: 'a/b' }])), /file\/directory collision/);
});
test('ZIP rejects encryption, unsupported compression, and excessive expanded size before writes', () => {
  for (const item of [{ flags: 1 }, { method: 99 }, { declaredSize: 64 * 1024 * 1024 + 1 }]) {
    assert.throws(() => inspectZip(zip([{ name: 'bad', ...item }])));
  }
});
test('ZIP checks both header names and rejects overlapping file ranges', () => {
  const archive = zip([{ name: 'a' }, { name: 'b' }]);
  const central = archive.readUInt32LE(archive.length - 6);
  const mismatched = Buffer.from(archive); mismatched[30] = 'x'.charCodeAt(0);
  assert.throws(() => inspectZip(mismatched), /filenames disagree/);
  const overlapping = Buffer.from(archive);
  // Distinct central names point at the same local bytes: header check must reject.
  overlapping.writeUInt32LE(0, central + 47 + 42);
  assert.throws(() => inspectZip(overlapping));
});
test('ZIP refuses bad content CRC and preserves a pre-existing output directory', async t => {
  const root = await temporary(t), destination = path.join(root, 'extension');
  await assert.rejects(extractZip(zip([{ name: 'bad', content: 'bytes', crc: 1 }]), destination), /CRC differs/);
  const existing = path.join(root, 'existing'); await mkdir(existing);
  await assert.rejects(extractZip(zip(), existing), error => error.code === 'EEXIST');
});
