import { check, prove } from '@midnight-ntwrk/zkir-v2';
import { createKeyMaterialProvider } from './materials.mjs';

let material; let busy = false;
const codes = new Set(['ARTIFACT_FETCH_FAILED', 'ARTIFACT_UNAVAILABLE', 'ARTIFACT_TOO_LARGE', 'EMPTY_ARTIFACT',
  'ARTIFACT_HASH_MISMATCH', 'UNSUPPORTED_SRS_SIZE', 'UNKNOWN_CIRCUIT', 'KEY_LOCATION_MISMATCH']);
globalThis.addEventListener('message', async ({ data }) => {
  if (!Number.isSafeInteger(data?.id) || !['check', 'prove'].includes(data.op)) return;
  const id = data.id;
  if (busy) { globalThis.postMessage({ id, type: 'error', code: 'WORKER_BUSY' }); return; }
  busy = true;
  let operationError;
  try {
    if (!(data.preimage instanceof Uint8Array) || data.preimage.length === 0 || data.preimage.length > 12 * 1024 * 1024
      || typeof data.keyLocation !== 'string' || data.keyLocation.length > 200
      || !(data.overwriteBindingInput === undefined || typeof data.overwriteBindingInput === 'bigint')) throw new Error('Invalid operation');
    material ??= createKeyMaterialProvider({ ...data.config, pageUrl: globalThis.location.href });
    const provider = {
      async lookupKey(key) {
        if (key !== data.keyLocation) { operationError = 'KEY_LOCATION_MISMATCH'; throw new Error('Key location mismatch'); }
        globalThis.postMessage({ id, type: 'stage', stage: 'loading-public-key-material' });
        let result;
        try { result = await material.lookupKey(key); }
        catch (error) { operationError = codes.has(error?.code) ? error.code : undefined; throw error; }
        if (!result) { operationError = 'UNKNOWN_CIRCUIT'; throw new Error('Unknown circuit'); }
        return result;
      },
      async getParams(k) {
        globalThis.postMessage({ id, type: 'stage', stage: 'loading-public-proving-parameters' });
        try { const params = await material.getParams(k); globalThis.postMessage({ id, type: 'stage', stage: 'proving-in-browser' }); return params; }
        catch (error) { operationError = codes.has(error?.code) ? error.code : undefined; throw error; }
      },
    };
    globalThis.postMessage({ id, type: 'stage', stage: data.op === 'check' ? 'checking-constraints-in-browser' : 'proving-in-browser' });
    const value = data.op === 'check' ? await check(data.preimage, provider) : await prove(data.preimage, provider, data.overwriteBindingInput);
    if (data.op === 'prove') {
      if (!(value instanceof Uint8Array) || value.length === 0) throw new Error('Empty proof');
      globalThis.postMessage({ id, type: 'result', value }, [value.buffer]);
    } else globalThis.postMessage({ id, type: 'result', value });
  } catch (error) {
    // Never forward native messages, stacks, witness preimages or arbitrary causes.
    globalThis.postMessage({ id, type: 'error', code: operationError ?? (codes.has(error?.code) ? error.code : 'WASM_PROVING_FAILED') });
  } finally { data.preimage?.fill?.(0); busy = false; }
});
// Module WASM initialization is asynchronous. Do not accept a witness preimage
// until the message handler and native runtime are both installed.
globalThis.postMessage({ type: 'ready' });
