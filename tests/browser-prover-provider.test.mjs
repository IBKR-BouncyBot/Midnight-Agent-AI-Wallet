import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserProver } from '../packages/browser-prover/provider.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const code = expected => error => error.code === expected && error.message === expected;
function fixture(t) {
  const previous = new Map(['Worker', 'location'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const instances = []; const provers = [];
  class WorkerDouble {
    listeners = new Map(); posted = []; terminated = false;
    constructor(url, options) { this.url = url.href; this.options = options; instances.push(this); }
    addEventListener(type, callback) { const callbacks = this.listeners.get(type) ?? new Set(); callbacks.add(callback); this.listeners.set(type, callbacks); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    emit(data) { for (const callback of [...(this.listeners.get('message') ?? [])]) callback({ data }); }
    error() { for (const callback of [...(this.listeners.get('error') ?? [])]) callback({ message: 'PRIVATE NATIVE DIAGNOSTIC', preventDefault() {} }); }
    postMessage(value, transfer) {
      // Use real structured-clone transfer: the provider's copied preimage is
      // detached as it would be at the browser's worker boundary.
      this.posted.push(structuredClone(value, { transfer }));
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { value: WorkerDouble, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: new URL('https://wallet.example/app/'), configurable: true });
  t.after(() => {
    for (const prover of provers) prover.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  return { instances, create(options = {}) {
    const prover = createBrowserProver({ workerUrl: './proof-worker.mjs', contracts: { 'test-token': './contracts/' }, ...options });
    provers.push(prover); return prover;
  } };
}

test('worker startup waits for ready, captures immutable input, and sends each queued task once', async t => {
  const f = fixture(t); const prover = f.create();
  const input = new Uint8Array([1, 2, 3]);
  const first = prover.prove(input, 'mint'); input.fill(9);
  const second = prover.check(new Uint8Array([4, 5]), 'mint');
  await tick(); assert.equal(f.instances.length, 1);
  const worker = f.instances[0]; assert.equal(worker.posted.length, 0);
  worker.emit({ type: 'ready' }); worker.emit({ type: 'ready' });
  assert.equal(worker.posted.length, 1); assert.deepEqual(worker.posted[0].preimage, new Uint8Array([1, 2, 3]));
  assert.deepEqual(input, new Uint8Array([9, 9, 9]));
  worker.emit({ id: worker.posted[0].id, type: 'result', value: new Uint8Array([7]) });
  assert.deepEqual(await first, new Uint8Array([7])); await tick();
  assert.equal(worker.posted.length, 2); assert.equal(f.instances.length, 1);
  assert.equal(worker.posted[1].op, 'check');
  worker.emit({ id: worker.posted[1].id, type: 'result', value: [undefined, 3n] });
  assert.deepEqual(await second, [undefined, 3n]);
});

test('close before worker readiness rejects active and queued requests without posting witnesses', async t => {
  const f = fixture(t); const prover = f.create();
  const active = prover.prove(new Uint8Array([1]), 'mint');
  const queued = prover.check(new Uint8Array([2]), 'mint');
  const rejectActive = assert.rejects(active, code('PROVER_CLOSED'));
  const rejectQueued = assert.rejects(queued, code('PROVER_CLOSED'));
  await tick(); const worker = f.instances[0]; prover.close(); worker.emit({ type: 'ready' });
  await Promise.all([rejectActive, rejectQueued]);
  assert.equal(worker.posted.length, 0); assert.equal(worker.terminated, true);
  await assert.rejects(prover.prove(new Uint8Array([3]), 'mint'), code('PROVER_CLOSED'));
});

test('worker diagnostics and stages are projected; failure restarts with a fresh readiness handshake', async t => {
  const f = fixture(t); const stages = []; const prover = f.create({ onStage: stage => stages.push(stage) });
  const first = prover.prove(new Uint8Array([1]), 'mint');
  const rejection = assert.rejects(first, code('WASM_PROVING_FAILED'));
  await tick(); const worker = f.instances[0]; worker.emit({ type: 'ready' }); const id = worker.posted[0].id;
  worker.emit({ id: id + 1, type: 'result', value: new Uint8Array([8]) });
  worker.emit({ id, type: 'stage', stage: 'PRIVATE NATIVE DIAGNOSTIC' });
  worker.emit({ id, type: 'stage', stage: 'proving-in-browser' });
  worker.emit({ id, type: 'error', code: 'PRIVATE NATIVE DIAGNOSTIC', message: 'WITNESS' });
  await rejection; assert.deepEqual(stages, ['proving-in-browser']); assert.equal(worker.terminated, true);
  const retry = prover.check(new Uint8Array([2]), 'mint'); await tick();
  assert.equal(f.instances.length, 2); const fresh = f.instances[1]; assert.equal(fresh.posted.length, 0);
  fresh.emit({ type: 'ready' }); fresh.emit({ id: fresh.posted[0].id, type: 'result', value: [] });
  assert.deepEqual(await retry, []);
});

test('a worker that never becomes ready times out without receiving a witness', async t => {
  const f = fixture(t); const prover = f.create({ timeoutMs: 1000 });
  await assert.rejects(prover.prove(new Uint8Array([1]), 'mint'), code('BROWSER_PROOF_TIMEOUT'));
  assert.equal(f.instances[0].posted.length, 0); assert.equal(f.instances[0].terminated, true);
});

test('cross-origin workers and excessive queued witness data are rejected before dispatch', async t => {
  const f = fixture(t);
  assert.throws(() => f.create({ workerUrl: 'https://foreign.example/worker.mjs' }), code('SAME_ORIGIN_WORKER_REQUIRED'));
  const prover = f.create(); const outstanding = [];
  for (let index = 0; index < 32; index++) outstanding.push(assert.rejects(prover.check(new Uint8Array([index]), 'mint'), code('PROVER_CLOSED')));
  await assert.rejects(prover.check(new Uint8Array([33]), 'mint'), code('PROVER_QUEUE_LIMIT'));
  prover.close(); await Promise.all(outstanding);
  assert.ok(f.instances.every(worker => worker.posted.length === 0 && worker.terminated));
});
