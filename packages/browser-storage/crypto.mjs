import { bytesToHex, serializeSnapshot, deserializeSnapshot, MAX_SNAPSHOT_BYTES } from './codec.mjs';

export const FORMAT = 'midnight-agent-wallet:browser-store';
export const VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const keysAre = (object, names) => object && Object.getPrototypeOf(object) === Object.prototype
  && Reflect.ownKeys(object).every((key) => typeof key === 'string'
    && Object.getOwnPropertyDescriptor(object, key).enumerable && 'value' in Object.getOwnPropertyDescriptor(object, key))
  && Object.keys(object).sort().join(',') === names;
export class BrowserStorageError extends Error {
  constructor(code) { super(code); this.name = 'BrowserStorageError'; this.code = code; }
}
export function requireCrypto(crypto) {
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') throw new BrowserStorageError('WEB_CRYPTO_UNAVAILABLE');
  return crypto;
}
export function normalizeContext(context) {
  if (!keysAre(context, 'identityId,network')
    || !['local', 'preview', 'preprod'].includes(context.network)
    || typeof context.identityId !== 'string' || !/^[A-Za-z0-9:_./-]{1,256}$/.test(context.identityId)) {
    throw new BrowserStorageError('INVALID_PUBLIC_CONTEXT');
  }
  return Object.freeze({ network: context.network, identityId: context.identityId });
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) throw new BrowserStorageError('PASSWORD_LENGTH');
}
export function validateHeader(header, context) {
  if (!keysAre(header, 'context,format,kdf,version') || !keysAre(header.kdf, 'hash,iterations,name,salt')
    || header.format !== FORMAT || header.version !== VERSION
    || header.kdf?.name !== 'PBKDF2' || header.kdf.hash !== 'SHA-256' || header.kdf.iterations !== PBKDF2_ITERATIONS
    || !(header.kdf.salt instanceof Uint8Array) || header.kdf.salt.length !== 32) throw new BrowserStorageError('INVALID_STORE_HEADER');
  const saved = normalizeContext(header.context); const requested = normalizeContext(context);
  if (saved.network !== requested.network || saved.identityId !== requested.identityId) throw new BrowserStorageError('CONTEXT_MISMATCH');
}
export function headerIdentity(header) {
  validateHeader(header, header.context);
  return JSON.stringify([FORMAT, VERSION, header.context.network, header.context.identityId,
    'PBKDF2', 'SHA-256', PBKDF2_ITERATIONS, bytesToHex(header.kdf.salt)]);
}
async function derive(password, header, crypto) {
  validatePassword(password); requireCrypto(crypto);
  const bytes = encoder.encode(password);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: header.kdf.salt },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { bytes.fill(0); }
}
export async function createEncryption(password, context, crypto = globalThis.crypto) {
  validatePassword(password); requireCrypto(crypto);
  const header = { format: FORMAT, version: VERSION, context: normalizeContext(context),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: crypto.getRandomValues(new Uint8Array(32)) } };
  return { header, key: await derive(password, header, crypto) };
}
export async function unlockEncryption(password, header, context, crypto = globalThis.crypto) {
  validateHeader(header, context);
  return derive(password, header, crypto);
}
function aad(header, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new BrowserStorageError('INVALID_REVISION');
  return encoder.encode(JSON.stringify([headerIdentity(header), revision]));
}
export async function encryptSnapshot(state, key, header, revision, crypto = globalThis.crypto) {
  const additionalData = aad(header, revision); const plaintext = serializeSnapshot(state);
  try {
    const iv = requireCrypto(crypto).getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, plaintext));
    return { revision, iv, ciphertext };
  } finally { plaintext.fill(0); }
}
export async function decryptSnapshot(record, key, header, crypto = globalThis.crypto) {
  if (!record || !(record.iv instanceof Uint8Array) || record.iv.length !== 12
    || !(record.ciphertext instanceof Uint8Array) || record.ciphertext.length < 16
    || record.ciphertext.length > MAX_SNAPSHOT_BYTES + 16) throw new BrowserStorageError('INVALID_ENCRYPTED_SNAPSHOT');
  const additionalData = aad(header, record.revision);
  let plaintext;
  try {
    plaintext = new Uint8Array(await requireCrypto(crypto).subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData, tagLength: 128 }, key, record.ciphertext));
    return deserializeSnapshot(plaintext);
  } catch { throw new BrowserStorageError('SNAPSHOT_AUTHENTICATION_FAILED'); }
  finally { plaintext?.fill(0); }
}
