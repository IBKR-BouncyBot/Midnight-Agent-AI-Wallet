import { bytesToHex, MAX_SNAPSHOT_BYTES } from './codec.mjs';
import { BrowserStorageError, validateHeader } from './crypto.mjs';

const encoder = new TextEncoder(); const decoder = new TextDecoder('utf-8', { fatal: true });
const MAGIC = encoder.encode('MIDNIGHT_BROWSER_BACKUP\n');
const MAX_METADATA = 4096;
function unhex(value, length) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) throw new BrowserStorageError('INVALID_BACKUP');
  return Uint8Array.from({ length }, (_, i) => Number.parseInt(value.slice(i * 2, i * 2 + 2), 16));
}
/** Contains public KDF/context metadata plus authenticated ciphertext, never a plaintext snapshot. */
export function encodeBackup(header, record) {
  validateHeader(header, header.context);
  const metadata = encoder.encode(JSON.stringify({ format: 'midnight-agent-wallet:encrypted-backup', version: 1,
    header: { ...header, kdf: { ...header.kdf, salt: bytesToHex(header.kdf.salt) } }, revision: record.revision, iv: bytesToHex(record.iv) }));
  if (metadata.length > MAX_METADATA) throw new BrowserStorageError('INVALID_BACKUP');
  const bytes = new Uint8Array(MAGIC.length + 4 + metadata.length + record.ciphertext.length);
  bytes.set(MAGIC); new DataView(bytes.buffer).setUint32(MAGIC.length, metadata.length);
  bytes.set(metadata, MAGIC.length + 4); bytes.set(record.ciphertext, MAGIC.length + 4 + metadata.length);
  return bytes;
}
export function decodeBackup(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < MAGIC.length + 4 + 16
    || bytes.length > MAGIC.length + 4 + MAX_METADATA + MAX_SNAPSHOT_BYTES + 16
    || !MAGIC.every((byte, i) => bytes[i] === byte)) throw new BrowserStorageError('INVALID_BACKUP');
  try {
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length);
    const offset = MAGIC.length + 4;
    if (length > MAX_METADATA || bytes.length - offset - length < 16) throw new BrowserStorageError('INVALID_BACKUP');
    const metadata = JSON.parse(decoder.decode(bytes.subarray(offset, offset + length)));
    if (metadata.format !== 'midnight-agent-wallet:encrypted-backup' || metadata.version !== 1) throw new BrowserStorageError('INVALID_BACKUP');
    const header = { ...metadata.header, kdf: { ...metadata.header.kdf, salt: unhex(metadata.header.kdf.salt, 32) } };
    validateHeader(header, header.context);
    return { header, record: { revision: metadata.revision, iv: unhex(metadata.iv, 12), ciphertext: bytes.slice(offset + length) } };
  } catch { throw new BrowserStorageError('INVALID_BACKUP'); }
}
