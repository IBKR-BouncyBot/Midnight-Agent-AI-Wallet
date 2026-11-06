const FORMAT = 'midnight-browser-snapshot:1';
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = () => { throw new TypeError('Unsupported or malformed private snapshot'); };
const scalar = (value) => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0));

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/.test(hex)) fail();
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}
function encode(value, ancestors, depth) {
  if (depth > 128) fail();
  if (scalar(value)) {
    if (typeof value === 'string' && value.length > MAX_SNAPSHOT_BYTES) fail();
    return ['scalar', value];
  }
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') {
    const decimal = value.toString(); if (decimal.length > 4096) fail();
    return ['bigint', decimal];
  }
  if (value instanceof Uint8Array) {
    if (value.length > MAX_SNAPSHOT_BYTES / 2) fail();
    return ['bytes', bytesToHex(value)];
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) fail();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) fail();
      return ['array', Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) fail();
        return encode(descriptor.value, ancestors, depth + 1);
      })];
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    return ['object', Reflect.ownKeys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) fail();
      return [key, encode(descriptor.value, ancestors, depth + 1)];
    })];
  } finally { ancestors.delete(value); }
}
function decode(node, depth) {
  if (depth > 128 || !Array.isArray(node)) fail();
  if (node.length === 1 && node[0] === 'undefined') return undefined;
  if (node.length !== 2) fail();
  const [tag, value] = node;
  if (tag === 'scalar' && scalar(value)) return value;
  if (tag === 'bytes') return hexToBytes(value);
  if (tag === 'bigint' && typeof value === 'string' && value.length <= 4096 && /^(0|-?[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (tag === 'array' && Array.isArray(value)) return value.map((child) => decode(child, depth + 1));
  if (tag === 'object' && Array.isArray(value)) {
    const result = {}; const keys = new Set();
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || keys.has(pair[0])) fail();
      keys.add(pair[0]);
      Object.defineProperty(result, pair[0], { value: decode(pair[1], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  fail();
}
export function serializeSnapshot(value) {
  const bytes = encoder.encode(JSON.stringify([FORMAT, encode(value, new Set(), 0)]));
  if (bytes.length > MAX_SNAPSHOT_BYTES) { bytes.fill(0); throw new RangeError('Private snapshot is too large'); }
  return bytes;
}
export function deserializeSnapshot(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_SNAPSHOT_BYTES) fail();
  const parsed = JSON.parse(decoder.decode(bytes));
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== FORMAT) fail();
  return decode(parsed[1], 0);
}
export function cloneSnapshot(value) {
  const bytes = serializeSnapshot(value);
  try { return deserializeSnapshot(bytes); } finally { bytes.fill(0); }
}
