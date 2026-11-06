// Public artifact locations follow the installed Midnight wallet-sdk-prover-client
// 1.2.3 WasmProver.makeDefaultKeyMaterialProvider (Apache-2.0, Midnight Foundation).
// This module downloads public artifacts only. Witnesses are never sent to fetch.
export const OFFICIAL_BUILTIN_BASE = 'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/';
export const BUILTIN_KEY_VERSION = 9;
export const CONTRACT_CIRCUITS = Object.freeze({
  'private-vault': ['initializePolicy', 'fund', 'pay', 'setPaused', 'revoke', 'replacePolicy', 'withdraw'],
  'test-token': ['mint'],
});
const builtinPaths = Object.freeze({
  'midnight/zswap/spend': 'zswap/9/spend', 'midnight/zswap/output': 'zswap/9/output',
  'midnight/zswap/sign': 'zswap/9/sign', 'midnight/dust/spend': 'dust/9/spend',
});
export const safeError = code => Object.assign(new Error(code), { code });
const hexDigest = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');

export function createKeyMaterialProvider({ contracts, pageUrl, builtinBase = OFFICIAL_BUILTIN_BASE,
  fetchImpl = globalThis.fetch, maxAssetBytes = 256 * 1024 * 1024, maxCacheBytes = 384 * 1024 * 1024,
  assetTimeoutMs = 120_000, hashes = {} } = {}) {
  const page = new URL(pageUrl);
  if (!['https:', 'http:'].includes(page.protocol) || typeof fetchImpl !== 'function') throw safeError('INVALID_MATERIAL_CONFIG');
  const baseUrl = value => {
    const url = new URL(value, page);
    if (url.username || url.password || url.search || url.hash) throw safeError('INVALID_ARTIFACT_URL');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
  };
  const builtins = baseUrl(builtinBase);
  if (builtins.origin !== page.origin && builtins.href !== OFFICIAL_BUILTIN_BASE) throw safeError('UNTRUSTED_ARTIFACT_ORIGIN');
  if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1 || maxAssetBytes > 512 * 1024 * 1024
    || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < maxAssetBytes || maxCacheBytes > 1024 * 1024 * 1024
    || !Number.isSafeInteger(assetTimeoutMs) || assetTimeoutMs < 1000 || assetTimeoutMs > 300_000) throw safeError('INVALID_MATERIAL_LIMITS');
  const custom = new Map();
  for (const [contract, value] of Object.entries(contracts ?? {})) {
    if (!Object.hasOwn(CONTRACT_CIRCUITS, contract)) throw safeError('UNKNOWN_CONTRACT');
    const base = baseUrl(value);
    if (base.origin !== page.origin) throw safeError('UNTRUSTED_ARTIFACT_ORIGIN');
    for (const circuit of CONTRACT_CIRCUITS[contract]) custom.set(circuit, base);
  }
  const cache = new Map(); let cachedBytes = 0;
  async function load(url) {
    const key = url.href;
    if (cache.has(key)) return cache.get(key).promise;
    const entry = { bytes: 0, promise: null };
    entry.promise = (async () => {
      let response;
      try { response = await fetchImpl(key, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(assetTimeoutMs) }); }
      catch { throw safeError('ARTIFACT_FETCH_FAILED'); }
      if (!response.ok || !response.body) throw safeError('ARTIFACT_UNAVAILABLE');
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > maxAssetBytes) { await response.body.cancel(); throw safeError('ARTIFACT_TOO_LARGE'); }
      const reader = response.body.getReader(); const chunks = []; let length = 0;
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break;
          length += value.length; if (length > maxAssetBytes) { await reader.cancel(); throw safeError('ARTIFACT_TOO_LARGE'); } chunks.push(value); }
      } catch (error) { if (error?.code === 'ARTIFACT_TOO_LARGE') throw error; throw safeError('ARTIFACT_FETCH_FAILED'); }
      if (!length) throw safeError('EMPTY_ARTIFACT');
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (Object.hasOwn(hashes, key)) {
        if (!/^[0-9a-f]{64}$/.test(hashes[key]) || hexDigest(await crypto.subtle.digest('SHA-256', bytes)) !== hashes[key]) throw safeError('ARTIFACT_HASH_MISMATCH');
      }
      entry.bytes = length; cachedBytes += length;
      for (const [older, record] of cache) {
        if (cachedBytes <= maxCacheBytes) break;
        if (older !== key && record.bytes > 0) { cache.delete(older); cachedBytes -= record.bytes; }
      }
      return bytes;
    })().catch(error => { cache.delete(key); throw error?.code ? error : safeError('ARTIFACT_FETCH_FAILED'); });
    cache.set(key, entry); return entry.promise;
  }
  return {
    async lookupKey(keyLocation) {
      let urls;
      if (custom.has(keyLocation)) {
        const base = custom.get(keyLocation);
        urls = [`keys/${keyLocation}.prover`, `keys/${keyLocation}.verifier`, `zkir/${keyLocation}.bzkir`].map(value => new URL(value, base));
      } else if (Object.hasOwn(builtinPaths, keyLocation)) {
        urls = ['prover', 'verifier', 'bzkir'].map(extension => new URL(`${builtinPaths[keyLocation]}.${extension}`, builtins));
      } else return undefined;
      const [proverKey, verifierKey, ir] = await Promise.all(urls.map(load));
      return { proverKey, verifierKey, ir };
    },
    async getParams(k) {
      if (!Number.isInteger(k) || k < 1 || k > 22) throw safeError('UNSUPPORTED_SRS_SIZE');
      return load(new URL(`bls_midnight_2p${k}`, builtins));
    },
    clear() { cache.clear(); cachedBytes = 0; },
  };
}
