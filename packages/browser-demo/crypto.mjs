import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

// Narrow compatibility surface for the shared protocol's SHA-256 fingerprints.
export function createHash(name) {
  if (name !== 'sha256') throw new Error('Unsupported browser hash');
  const state = sha256.create();
  return { update(value) { state.update(typeof value === 'string' ? new TextEncoder().encode(value) : value); return this; },
    digest(encoding) { const bytes = Buffer.from(state.digest()); return encoding ? bytes.toString(encoding) : bytes; } };
}
export const randomBytes = length => crypto.getRandomValues(new Uint8Array(length));
export const randomUUID = () => crypto.randomUUID();
export function isDeepStrictEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Uint8Array) return a.length === b.length && a.every((value, index) => value === b[index]);
  // Object.keys excludes array length and empty slots. A candidate with an
  // appended hole is still a different fixed-size Compact tuple.
  if (Array.isArray(a) && a.length !== b.length) return false;
  if (!Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype && Object.getPrototypeOf(a) !== null) return false;
  const keys = Object.keys(a), other = Object.keys(b);
  return keys.length === other.length && keys.every(key => Object.hasOwn(b, key) && isDeepStrictEqual(a[key], b[key]));
}
