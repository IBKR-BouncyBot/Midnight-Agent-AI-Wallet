import { CostModel } from '@midnight-ntwrk/ledger-v8';
import { safeError, OFFICIAL_BUILTIN_BASE } from './materials.mjs';

/** Local WASM execution only. No proof-server URL and no remote-proving fallback. */
export function createBrowserProver({ workerUrl, contracts, builtinBase = OFFICIAL_BUILTIN_BASE,
  timeoutMs = 600_000, onStage = () => {}, hashes = {} } = {}) {
  if (typeof Worker !== 'function' || typeof onStage !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) throw safeError('INVALID_PROVER_CONFIG');
  const url = new URL(workerUrl, globalThis.location.href);
  if (url.origin !== globalThis.location.origin || url.search || url.hash) throw safeError('SAME_ORIGIN_WORKER_REQUIRED');
  const config = { contracts: Object.fromEntries(Object.entries(contracts ?? {}).map(([name, base]) => [name, new URL(base, globalThis.location.href).href])),
    builtinBase: new URL(builtinBase, globalThis.location.href).href, hashes };
  let worker; let ready = false; let closed = false; let serial = Promise.resolve(); let sequence = 0; let cancelActive;
  let pendingCount = 0; let pendingBytes = 0;
  function execute(op, preimage, keyLocation, overwriteBindingInput) {
    if (closed) return Promise.reject(safeError('PROVER_CLOSED'));
    if (!(preimage instanceof Uint8Array) || preimage.length === 0 || preimage.length > 12 * 1024 * 1024
      || typeof keyLocation !== 'string' || !keyLocation || keyLocation.length > 200
      || !(overwriteBindingInput === undefined || typeof overwriteBindingInput === 'bigint')) return Promise.reject(safeError('INVALID_PROVING_INPUT'));
    if (pendingCount >= 32 || pendingBytes + preimage.length > 64 * 1024 * 1024) return Promise.reject(safeError('PROVER_QUEUE_LIMIT'));
    // Copy before queuing so caller mutation cannot change what is proved.
    const copy = Uint8Array.from(preimage);
    const byteLength = copy.length; pendingCount++; pendingBytes += byteLength;
    const task = () => new Promise((resolve, reject) => {
      if (closed) { copy.fill(0); reject(safeError('PROVER_CLOSED')); return; }
      const id = ++sequence;
      try { if (!worker) { ready = false; worker = new Worker(url, { type: 'module', name: 'midnight-local-prover' }); } }
      catch { copy.fill(0); reject(safeError('WORKER_START_FAILED')); return; }
      const active = worker; let settled = false;
      const finish = (error, value, terminate = false) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (copy.byteLength) copy.fill(0);
        active.removeEventListener('message', message); active.removeEventListener('error', failed);
        cancelActive = undefined;
        if (terminate) { active.terminate(); if (worker === active) { worker = undefined; ready = false; } }
        if (error) reject(error); else resolve(value);
      };
      const failed = event => { event.preventDefault?.(); finish(safeError('WORKER_EXECUTION_FAILED'), undefined, true); };
      let sent = false;
      const send = () => {
        if (sent || settled) return; sent = true;
        try { active.postMessage({ id, op, preimage: copy, keyLocation, overwriteBindingInput, config }, [copy.buffer]); }
        catch { if (copy.byteLength) copy.fill(0); finish(safeError('WORKER_MESSAGE_FAILED'), undefined, true); }
      };
      const message = ({ data }) => {
        if (data?.type === 'ready') { ready = true; send(); return; }
        if (data?.id !== id) return;
        if (data.type === 'stage') { if (['loading-public-key-material', 'loading-public-proving-parameters', 'checking-constraints-in-browser', 'proving-in-browser'].includes(data.stage)) { try { onStage(data.stage); } catch {} } }
        else if (data.type === 'result') {
          const valid = op === 'prove' ? data.value instanceof Uint8Array && data.value.length > 0
            : Array.isArray(data.value) && data.value.every(value => value === undefined || typeof value === 'bigint');
          finish(valid ? null : safeError('INVALID_WORKER_RESULT'), data.value, !valid);
        } else if (data.type === 'error') {
          const known = ['ARTIFACT_FETCH_FAILED', 'ARTIFACT_UNAVAILABLE', 'ARTIFACT_TOO_LARGE', 'EMPTY_ARTIFACT', 'ARTIFACT_HASH_MISMATCH',
            'UNSUPPORTED_SRS_SIZE', 'UNKNOWN_CIRCUIT', 'KEY_LOCATION_MISMATCH', 'WASM_PROVING_FAILED', 'WORKER_BUSY'];
          finish(safeError(known.includes(data.code) ? data.code : 'WASM_PROVING_FAILED'), undefined, true);
        }
      };
      const timer = setTimeout(() => finish(safeError('BROWSER_PROOF_TIMEOUT'), undefined, true), timeoutMs);
      cancelActive = () => finish(safeError('PROVER_CLOSED'), undefined, true);
      active.addEventListener('message', message); active.addEventListener('error', failed);
      if (ready) send();
    });
    const release = () => { pendingCount--; pendingBytes -= byteLength; };
    const result = serial.then(task, task).then(value => { release(); return value; }, error => { release(); throw error; });
    serial = result.catch(() => {}); return result;
  }
  const provider = { check: (preimage, key) => execute('check', preimage, key),
    prove: (preimage, key, binding) => execute('prove', preimage, key, binding),
    async proveTx(transaction) { if (closed) throw safeError('PROVER_CLOSED'); return transaction.prove(provider, CostModel.initialCostModel()); },
    close() { closed = true; cancelActive?.(); worker?.terminate(); worker = undefined; },
  };
  return provider;
}
