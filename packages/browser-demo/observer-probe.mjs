import { createMerchantObserver } from './observer.mjs';

const PREVIEW = Object.freeze({ networkId: 'preview',
  indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws' });
const fail = code => Object.assign(new Error(code), { code });
let running = false;

/** Opt-in localhost QA only. Never fund this deliberately public synthetic identity.
 * Starts the real SDK receive-only observer from genesis; no fabricated cursor,
 * Lace connection, owner wallet, proof, signing, storage write, or transaction.
 */
export async function runBrowserObserverProbe({ enabled = false, onStage = () => {} } = {}) {
  const page = globalThis.location;
  if (enabled !== true || !page || !['http:', 'https:'].includes(page.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(page.hostname)) throw fail('LOCAL_OBSERVER_PROBE_DISABLED');
  if (typeof onStage !== 'function') throw fail('INVALID_OBSERVER_PROBE_CONFIG');
  if (running) throw fail('OBSERVER_PROBE_ALREADY_RUNNING');
  running = true;
  const stage = value => { try { onStage(value); } catch {} };
  const deadline = Date.now() + 90_000;
  let observer, report, failure;
  async function within(promise, milliseconds = Math.max(1, deadline - Date.now())) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('OBSERVER_PROBE_TIMEOUT')), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }
  try {
    stage('creating-public-synthetic-observer');
    // Fixed, publicly disclosed bytes. This is not an owner seed or saved profile.
    observer = await within(createMerchantObserver({ seed: new Uint8Array(32).fill(42), network: PREVIEW }));
    stage('connecting-receive-only-observer');
    await within(observer.start());
    stage('waiting-for-real-history-progress');
    let observed;
    while (Date.now() < deadline) {
      const progress = observer.current()?.shielded.state.progress;
      if (progress?.isConnected === true && typeof progress.appliedIndex === 'bigint' && progress.appliedIndex > 0n) {
        observed = { connected: true, appliedIndex: progress.appliedIndex.toString(),
          targetIndex: progress.highestRelevantWalletIndex.toString(), strictlyCompleteAtObservation: progress.isStrictlyComplete() };
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!observed) throw fail('OBSERVER_PROBE_TIMEOUT');
    stage('serializing-observed-sdk-state');
    const snapshot = await within(observer.serialize());
    if (typeof snapshot !== 'string' || snapshot.length === 0) throw fail('INVALID_OBSERVER_SNAPSHOT');
    report = { schema: 'midnight-browser-observer-probe/v1', network: 'preview', synthetic: true, receiveOnly: true,
      ...observed, snapshotBytes: new TextEncoder().encode(snapshot).length,
      historyFreshnessVerified: false, receiptVerified: false, transactionSubmitted: false };
  } catch (error) {
    failure = fail(['OBSERVER_PROBE_TIMEOUT', 'INVALID_OBSERVER_SNAPSHOT'].includes(error?.code) ? error.code : 'OBSERVER_PROBE_FAILED');
  } finally {
    stage('stopping-receive-only-observer');
    try { if (observer) await within(observer.stop(), 10_000); }
    catch { failure = fail('OBSERVER_PROBE_CLEANUP_FAILED'); }
    running = false;
  }
  if (failure) throw failure;
  stage('observer-probe-complete');
  return Object.freeze({ ...report, stopped: true });
}
