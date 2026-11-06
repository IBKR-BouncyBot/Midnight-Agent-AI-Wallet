/** Real Lace/application UI acceptance on a disposable GitHub runner only.
 * No seed import/export, hidden wallet state, API replacement, trace or screenshot.
 * Progress prevents resending after ambiguity. Recovery requires a cleanly closed
 * encrypted profile archive; this is NOT durability against loss of the runner.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, lstat, realpath, open, rename, chmod, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, totalmem } from 'node:os';

export const APP_URL = 'https://ibkr-bouncybot.github.io/Midnight-Agent-AI-Wallet/testnet.html';
const REPOSITORY = 'IBKR-BouncyBot/Midnight-Agent-AI-Wallet';
const EXTENSION_ID = 'gafhhkghbfjjkeiendhlofajokpaflmk';
const VERSION = '2.5.1';
const SCHEMA = 'lace-ci-private-session-v1';
const OP_TIMEOUT = 25 * 60_000;
const BROWSER_BUDGET = 300 * 60_000;
const CLOSE_RESERVE = 5 * 60_000;
const PREVIEW_ENDPOINTS = Object.freeze({
  indexerUri: ['https://blockfrost.lw.iog.io/midnight-preview/', 'https://indexer.preview.midnight.network/api/v4/graphql'],
  indexerWsUri: ['wss://blockfrost.lw.iog.io/midnight-preview/ws', 'wss://indexer.preview.midnight.network/api/v4/graphql/ws'],
  substrateNodeUri: ['https://blockfrost.lw.iog.io/midnight-preview-rpc/', 'https://rpc.preview.midnight.network/', 'wss://rpc.preview.midnight.network/'],
});
const PREVIEW_HOSTS = Object.freeze(['blockfrost.lw.iog.io', 'indexer.preview.midnight.network', 'rpc.preview.midnight.network',
  'e.lw.iog.io', 'midnight-preview.blockfrost.io', 'rpc.midnight-preview.blockfrost.io']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
class Stop extends Error { constructor(code) { super(code); this.code = code; } }
function requireThat(value, code) { if (!value) throw new Stop(code); }
export function requireOperationBudget(deadline, operationMs, currentTime = Date.now()) {
  requireThat(Number.isSafeInteger(deadline) && Number.isSafeInteger(currentTime)
    && Number.isSafeInteger(operationMs) && operationMs > 0, 'INVALID_OPERATION_BUDGET');
  requireThat(deadline - currentTime > operationMs + CLOSE_RESERVE, 'INSUFFICIENT_OPERATION_BUDGET');
}
export function newActionTransactions(current, previous, expected) {
  requireThat(Array.isArray(current) && Array.isArray(previous) && Number.isSafeInteger(expected) && expected >= 0
    && [...current, ...previous].every(id => /^[a-f0-9]{66}$/.test(id)), 'INVALID_ACTION_TRANSACTIONS');
  const added = current.filter(id => !previous.includes(id));
  requireThat(new Set(current).size === current.length && new Set(previous).size === previous.length
    && added.length <= expected, 'UNEXPECTED_TRANSACTION_COUNT');
  return added.length === expected ? added : null;
}
export function validateEnvironment(env = process.env) {
  requireThat(env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_OS === 'Linux'
    && env.GITHUB_REPOSITORY === REPOSITORY && /^\d+$/.test(env.GITHUB_RUN_ID ?? '') && env.RUNNER_TEMP,
  'ISOLATED_GITHUB_RUNNER_REQUIRED');
  requireThat(!env.DEBUG && !env.PWDEBUG, 'DEBUG_LOGGING_MUST_BE_DISABLED');
}
export function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    requireThat(['--mode', '--extension-dir', '--state-dir', '--evidence-dir', '--app-url'].includes(key)
      && value && !value.startsWith('--') && !Object.hasOwn(result, key.slice(2)), 'INVALID_ARGUMENTS');
    result[key.slice(2)] = value;
  }
  requireThat(['bootstrap', 'resume-bootstrap', 'exercise'].includes(result.mode) && result['extension-dir'] && result['state-dir'] && result['evidence-dir'], 'INVALID_ARGUMENTS');
  requireThat((result['app-url'] ?? APP_URL) === APP_URL, 'APP_URL_NOT_ALLOWLISTED');
  return result;
}
export function atomicInteger(value) {
  requireThat(typeof value === 'string' && /^(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(value), 'INVALID_PUBLIC_AMOUNT');
  return BigInt(value.replaceAll(',', '')).toString();
}
export function publicStepEvidence(value) {
  requireThat(value && ['passed', 'finalized', 'rejected', 'public-cap-observed'].includes(value.status), 'INVALID_SAVED_STEP');
  const result = { status: value.status };
  for (const key of ['amountAtomic']) if (value[key] !== undefined) result[key] = atomicInteger(value[key]);
  for (const key of ['vaultAddress', 'backupSha256']) if (value[key] !== undefined) {
    requireThat(/^[a-f0-9]{64}$/.test(value[key]), 'INVALID_SAVED_STEP'); result[key] = value[key];
  }
  for (const key of ['sameAccountAndVault', 'paymentDisabled', 'ownDustAddress'])
    if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of ['walletApprovals', 'backupBytes', 'durationMs']) if (value[key] !== undefined) {
    requireThat(Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 64 * 1024 * 1024, 'INVALID_SAVED_STEP'); result[key] = value[key];
  }
  if (value.transactionIds !== undefined) {
    requireThat(Array.isArray(value.transactionIds) && value.transactionIds.length <= 6
      && value.transactionIds.every(id => /^[a-f0-9]{66}$/.test(id)), 'INVALID_SAVED_STEP'); result.transactionIds = [...value.transactionIds];
  }
  if (value.receipt) {
    const r = value.receipt; requireThat(['finalized', 'rejected'].includes(r.status) && typeof r.settlementVerified === 'boolean', 'INVALID_SAVED_STEP');
    result.receipt = { status: r.status, settlementVerified: r.settlementVerified };
    if (r.status === 'finalized') {
      requireThat(r.settlementVerified && /^[a-f0-9]{66}$/.test(r.transactionId) && /^[a-f0-9]{64}$/.test(r.contractAddress)
        && /^[a-f0-9]{64}$/.test(r.blockHash), 'INVALID_SAVED_STEP');
      Object.assign(result.receipt, { transactionId: r.transactionId, contractAddress: r.contractAddress, blockHash: r.blockHash });
    }
  }
  return result;
}
export function validatePrivateMetadata(value, mode = 'exercise') {
  requireThat(['resume-bootstrap', 'exercise'].includes(mode), 'INVALID_RESTORE_MODE');
  requireThat(value?.schema === SCHEMA && value.network === 'preview' && value.walletVersion === VERSION
    && value.appUrl === APP_URL && typeof value.walletPassword === 'string' && value.walletPassword.length >= 24
    && typeof value.appPassword === 'string' && value.appPassword.length >= 24
    && Array.isArray(value.completedSteps) && value.completedSteps.every(step => typeof step === 'string')
    && value.stepEvidence && typeof value.stepEvidence === 'object', 'PRIVATE_STATE_INVALID');
  requireThat(value.pendingAction === null, 'RESTORED_ACTION_UNRESOLVED');
  if (mode === 'exercise') requireThat(value.bootstrapComplete === true && /^mn_addr_preview1[0-9a-z]+$/.test(value.accountId ?? ''), 'BOOTSTRAP_INCOMPLETE');
  else {
    requireThat(value.bootstrapComplete === false && value.completedSteps.length === 0 && Object.keys(value.stepEvidence).length === 0,
      'RESUME_BOOTSTRAP_SETUP_ONLY');
    requireThat(value.accountId === undefined || /^mn_addr_preview1[0-9a-z]+$/.test(value.accountId), 'PRIVATE_STATE_INVALID');
  }
  return value;
}
export function bootstrapStorageDecision({ mode, openResult, appSessionCreated = false }) {
  requireThat(['resume-bootstrap', 'exercise'].includes(mode), 'INVALID_RESTORE_MODE');
  if (openResult === 'opened') return 'open';
  if (mode === 'resume-bootstrap' && openResult === 'missing' && !appSessionCreated) return 'create';
  throw new Stop('SAVED_APP_SESSION_REQUIRED');
}
export function classifyUiFailure(error) {
  // Playwright messages may contain passwords/DOM. Inspect transiently; emit
  // only this fixed boolean projection, never message/stack/call-log content.
  const message = typeof error?.message === 'string' ? error.message : '';
  return { timeout: error?.name === 'TimeoutError' || /Timeout [0-9]+ms exceeded/.test(message),
    disabled: /not enabled|disabled/i.test(message),
    pointerIntercepted: /intercepts pointer events|intercepted|not receiving pointer events/i.test(message),
    detached: /not attached|detached from|element was detached/i.test(message),
    notVisible: /not visible|outside of the viewport/i.test(message) };
}
export function extractStaticControlIds(source) {
  // Only literal public testID names in the official package. Dynamic
  // templates/expressions and arbitrary DOM names are deliberately excluded.
  requireThat(typeof source === 'string', 'INVALID_STATIC_CONTROL_SOURCE');
  const ids = new Set();
  for (const match of source.matchAll(/\btestID\s*:\s*(['"`])([a-zA-Z][a-zA-Z0-9:_-]{0,119})\1/g)) ids.add(match[2]);
  return [...ids].sort();
}
export function sanitizePreviewConfiguration(config) {
  const result = {};
  for (const [field, allowed] of Object.entries(PREVIEW_ENDPOINTS)) {
    let canonical = null;
    try {
      const value = new URL(config?.[field]);
      if (!value.username && !value.password && !value.search && !value.hash && !value.port
        && allowed.includes(value.href)) canonical = value.href;
    } catch { /* Unknown endpoints are redacted, never logged. */ }
    result[field] = canonical;
  }
  result.matchesKnownPreviewEndpoints = Object.keys(PREVIEW_ENDPOINTS).every(field => result[field] !== null);
  return result;
}
export function publicEndpointMetadata(config) {
  return Object.fromEntries(Object.keys(PREVIEW_ENDPOINTS).map(field=>{
    try {
      const value=new URL(config?.[field]);
      return [field,{knownHost:PREVIEW_HOSTS.includes(value.hostname)?value.hostname:null,hasQuery:Boolean(value.search)}];
    } catch { return [field,{knownHost:null,hasQuery:false}]; }
  }));
}
export function isLaceViewUrl(value) {
  try {
    const uri=new URL(value);return uri.protocol==='chrome-extension:'&&uri.hostname===EXTENSION_ID
      &&['/expo/index.html','/index.html'].includes(uri.pathname);
  } catch { return false; }
}
export function requireRefreshPreflight({pendingAction,completedSteps,operationCount,approvalCount,transactionCount}) {
  requireThat(pendingAction===null&&Array.isArray(completedSteps)&&completedSteps.length===0
    &&operationCount===0&&approvalCount===0&&transactionCount===0,'REMOTE_CONFIG_REFRESH_REQUIRES_NO_OPERATIONS');
}
export function createRetiredPreviewGuard() {
  // Run-local observations only: a restored archive never supplies a previous
  // health result. Unknown/new providers and any transient result reset this
  // narrow diagnosis; canonical health probes cannot trigger it.
  let consecutive = 0;
  return (sample, safety) => {
    const gone = target => {
      const matches = Array.isArray(sample?.health) ? sample.health.filter(item => item?.target === target) : [];
      return matches.length === 1 && matches[0].attempted === true && matches[0].reachable === true && matches[0].status === 410;
    };
    const noOperations = safety?.pendingAction === null && Array.isArray(safety.completedSteps) && safety.completedSteps.length === 0
      && safety.operationCount === 0 && safety.approvalCount === 0 && safety.transactionCount === 0 && safety.appOperationCount === 0;
    const matches = sample?.configuration?.indexerUri === PREVIEW_ENDPOINTS.indexerUri[0]
      && sample?.configuration?.substrateNodeUri === PREVIEW_ENDPOINTS.substrateNodeUri[0]
      && sample.nightAtomic === '0' && sample.dustAtomic === '0' && sample.dustCapAtomic === '0'
      && noOperations && gone('configured-indexer') && gone('configured-node');
    consecutive = matches ? consecutive + 1 : 0;
    requireThat(consecutive < 2, 'LACE_PREVIEW_ENDPOINTS_RETIRED');
    return consecutive;
  };
}
export function previewPublicHost(value) {
  try { const parsed = new URL(value); return ['https:', 'wss:'].includes(parsed.protocol) && PREVIEW_HOSTS.includes(parsed.hostname) ? parsed.hostname : null; }
  catch { return null; }
}
export function parseSyncStatusLabel(value) {
  if (value === 'Synced') return { state:'synced', percent:100 };
  if (value === 'Error' || value === 'Errortry again' || value === 'Error try again') return { state:'error', percent:null };
  const match = /^Syncing(?: \(([0-9]{1,3})%\))?$/.exec(value ?? '');
  if (match && (match[1] === undefined || Number(match[1]) <= 100)) return { state:'syncing', percent:match[1] === undefined ? null : Number(match[1]) };
  return { state:'unrecognized', percent:null };
}
async function knownExtensionControlIds(extensionDir) {
  const ids = new Set(); let totalBytes = 0, files = 0;
  // Both official extension webpack chunks and actual Expo-rendered UI.
  for (const relative of ['js', 'expo/_expo/static/js/web']) {
    const directory = path.join(extensionDir, relative);
    requireThat(!(await lstat(directory)).isSymbolicLink(), 'EXTENSION_SOURCE_SYMLINK_REJECTED');
    for (const entry of await readdir(directory, { withFileTypes:true })) {
      if (!entry.name.endsWith('.js')) continue;
      requireThat(entry.isFile() && !entry.isSymbolicLink(), 'EXTENSION_SOURCE_FILE_REQUIRED');
      const file = path.join(directory, entry.name), info = await lstat(file);
      totalBytes += info.size; files++;
      requireThat(info.size <= 64 * 1024 * 1024 && totalBytes <= 512 * 1024 * 1024 && files <= 2_000, 'EXTENSION_SOURCE_LIMIT');
      for (const id of extractStaticControlIds(await readFile(file, 'utf8'))) ids.add(id);
    }
  }
  requireThat(ids.size <= 10_000, 'EXTENSION_CONTROL_LIMIT');
  return [...ids].sort();
}
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function containedPath(root, requested, existing = false) {
  const absolute = path.resolve(requested);
  requireThat(absolute.startsWith(root + path.sep), 'RUNNER_TEMP_PATH_REQUIRED');
  // Reject symlink components, including parent directories of fresh outputs.
  let part = root;
  for (const component of path.relative(root, absolute).split(path.sep)) {
    part = path.join(part, component);
    if (await exists(part)) requireThat(!(await lstat(part)).isSymbolicLink(), 'SYMLINK_PATH_REJECTED');
  }
  if (existing) requireThat(await exists(absolute) && (await realpath(absolute)).startsWith(root + path.sep), 'EXISTING_RUNNER_PATH_REQUIRED');
  return absolute;
}
async function atomicJson(file, value) {
  const temp = file + '.new';
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file); await chmod(file, 0o600);
  const parent = await open(path.dirname(file), 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
async function poll(check, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(350); }
  throw new Stop('OBSERVATION_TIMEOUT');
}
async function visible(locator) { return locator.isVisible().catch(() => false); }
async function bounded(promise, timeout = 60_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Stop('OBSERVATION_TIMEOUT')), timeout); })]); }
  finally { clearTimeout(timer); }
}
export async function waitForReadyButton(locator, stopCode, timeout = 120_000) {
  try {
    await poll(async () => {
      const count = await locator.count(); requireThat(count <= 1, 'AMBIGUOUS_ACTION_CONTROL');
      if (count !== 1 || !await visible(locator) || !await locator.isEnabled()) return false;
      // Trial is an actionability check only; it never clicks or forces through
      // an overlay. Readiness failures occur before the pending-action marker.
      try { await locator.click({ trial:true, timeout:1_000 }); return true; }
      catch (error) { if (error?.name === 'TimeoutError') return false; throw error; }
    }, timeout);
  } catch (error) { if (error instanceof Stop && error.code === 'OBSERVATION_TIMEOUT') throw new Stop(stopCode); throw error; }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  validateEnvironment(env); // Before imports, profile access, or any browser launch.
  const operationDeadline = Date.now() + BROWSER_BUDGET;
  requireThat(process.platform === 'linux', 'LINUX_RUNNER_REQUIRED');
  const options = parseArgs(args), tempRoot = await realpath(env.RUNNER_TEMP);
  const stateDir = await containedPath(tempRoot, options['state-dir'], options.mode !== 'bootstrap');
  const evidenceDir = await containedPath(tempRoot, options['evidence-dir']);
  const extensionDir = await containedPath(tempRoot, options['extension-dir'], true);
  requireThat(![stateDir, extensionDir].some(dir => evidenceDir === dir || evidenceDir.startsWith(dir + path.sep) || dir.startsWith(evidenceDir + path.sep))
    && !stateDir.startsWith(extensionDir + path.sep) && !extensionDir.startsWith(stateDir + path.sep), 'DIRECTORIES_MUST_BE_SEPARATE');
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const identity = [...digest(Buffer.from(manifest.key ?? '', 'base64')).slice(0, 32)].map(n => String.fromCharCode(97 + Number.parseInt(n, 16))).join('');
  requireThat(manifest.version === VERSION && manifest.manifest_version === 3 && identity === EXTENSION_ID, 'EXTENSION_PIN_MISMATCH');
  const acquisition = JSON.parse(await readFile(path.join(path.dirname(extensionDir), 'verification.json'), 'utf8'));
  requireThat(acquisition.developerSignatureVerified === true && acquisition.webStorePublisherSignatureVerified === true
    && acquisition.version === VERSION && acquisition.extensionModified === false, 'EXTENSION_PROVENANCE_REQUIRED');
  const staticControlIds = await knownExtensionControlIds(extensionDir);
  const privateFile = path.join(stateDir, 'session-private.json');
  let metadata;
  if (options.mode === 'bootstrap') {
    requireThat(!await exists(stateDir), 'FRESH_STATE_DIRECTORY_REQUIRED');
    await mkdir(stateDir, { mode: 0o700 });
    metadata = { schema: SCHEMA, network: 'preview', walletVersion: VERSION, appUrl: APP_URL,
      walletPassword: 'CiWallet-' + randomBytes(32).toString('base64url') + '!9a',
      appPassword: 'CiVault-' + randomBytes(32).toString('base64url') + '!9a',
      createdAt: now(), bootstrapComplete: false, bootstrapProgress: {}, pendingAction: null, completedSteps: [], stepEvidence: {} };
    await atomicJson(privateFile, metadata);
  } else {
    metadata = validatePrivateMetadata(JSON.parse(await readFile(privateFile, 'utf8')), options.mode);
    requireThat((await lstat(path.join(stateDir, 'profile'))).isDirectory(), 'RESTORED_PROFILE_REQUIRED');
  }
  metadata.bootstrapProgress ??= {};
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const reportFile = path.join(evidenceDir, 'browser-run.json');
  requireThat(!await exists(reportFile), 'FRESH_EVIDENCE_REQUIRED');
  const report = { schema: 'midnight-agent-wallet-real-lace-ci-v1', startedAt: now(), mode: options.mode,
    network: 'preview', appUrl: APP_URL, walletVersion: VERSION, extensionId: EXTENSION_ID,
    extensionCrxSha256: acquisition.crxSha256, runnerSha256: digest(await readFile(new URL(import.meta.url))),
    status: 'running', stage: 'starting', operations: [], browserClosed: false, transactionsRetried: 0,
    restoredExistingWallet: options.mode !== 'bootstrap', walletCreationRequested: false,
    runner: { sourceCommit: /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null,
      runId: env.GITHUB_RUN_ID, node: process.version, platform: process.platform, architecture: process.arch,
      logicalCpuCount: cpus().length, cpuModel: cpus()[0]?.model, memoryBytes: totalmem() },
    mockedWallet: false, screenshotsOrTraces: false, privateDataLogged: false,
    recoveryBoundary: 'Only a successfully sealed, cleanly closed browser profile can be restored. Runner-loss durability is not asserted.',
    settlementBoundary: 'App-verified receipts and observed Lace UI; no independent consensus verification by this harness.',
    proverBoundary: 'Real UI selection plus absent reported remote prover URI. No claim that Playwright observes all extension worker traffic.' };
  const save = () => atomicJson(reportFile, report);
  const stage = async value => { report.stage = value; await save(); process.stdout.write(JSON.stringify({ stage: value, mode: options.mode }) + '\n'); };
  const persist = () => atomicJson(privateFile, metadata);
  let context, app, wallet;
  let walletUnlockAttempted = false;
  const approved = new WeakSet();
  let approvals = 0;
  const observeRetiredPreviewEndpoints = createRetiredPreviewGuard();
  const origin = new URL(APP_URL).origin;
  report.previewNetwork = { observationBoundary:'Host counters cover requests exposed by Playwright, not all extension service-worker traffic. Anonymous probes use Node fetch and do not establish wallet sync or settlement.',
    hosts:Object.fromEntries(PREVIEW_HOSTS.map(host=>[host,{requests:0,responses:0,requestFailures:0,http2xx:0,http3xx:0,http4xx:0,http5xx:0,webSocketsCreated:0,webSocketsClosed:0,webSocketErrors:0,webSocketFramesReceived:0}])) };
  function installNetworkCounters() {
    const counters = url => { const host = previewPublicHost(url); return host ? report.previewNetwork.hosts[host] : null; };
    context.on('request', request => { const item=counters(request.url()); if(item)item.requests++; });
    context.on('requestfailed', request => { const item=counters(request.url()); if(item)item.requestFailures++; });
    context.on('response', response => { const item=counters(response.url()); if(!item)return;item.responses++;const group=Math.floor(response.status()/100);if(group>=2&&group<=5)item[`http${group}xx`]++; });
    const attached = new WeakSet();
    const attach = page => {
      if(attached.has(page))return;attached.add(page);
      page.on('websocket', socket => {
        const item=counters(socket.url());if(!item)return;item.webSocketsCreated++;
        socket.on('close',()=>{item.webSocketsClosed++;});socket.on('socketerror',()=>{item.webSocketErrors++;});
        socket.on('framereceived',()=>{item.webSocketFramesReceived++;});
      });
    };
    context.on('page',attach); for(const page of context.pages())attach(page);
  }
  async function syncUiSummary() {
    // Source-confirmed public status pill; only known enums and numeric
    // percentages leave the page, never arbitrary wallet text or balances.
    const pill=wallet.getByTestId('sync-status-pill'),menu=wallet.getByTestId('main-menu-tab-btn');let opened=false;
    try {
      if(await pill.count()===0&&await visible(menu)) {
        await menu.click({trial:true,timeout:2_000});await menu.click({timeout:2_000});opened=true;
        await poll(async()=>await pill.count()>0,5_000);
      }
      const pills=await pill.allTextContents();
      return pills.slice(0,8).map(text=>parseSyncStatusLabel(text.trim()));
    } catch { return []; }
    finally {
      if(opened) {
        // Close only the same public menu we opened; never choose a sync
        // reset/retry/account action. Do not proceed to DUST with it covering UI.
        try { await menu.click({timeout:5_000}); }
        catch { throw new Stop('SYNC_DIAGNOSTIC_MENU_CLOSE_FAILED'); }
      }
    }
  }
  async function anonymousEndpointHealth(configuration) {
    const targets = [
      ['configured-indexer',configuration.indexerUri,'indexer'],
      ['configured-node',configuration.substrateNodeUri?.replace(/^wss:/,'https:'),'node'],
      ['canonical-indexer',PREVIEW_ENDPOINTS.indexerUri[1],'indexer'],
      ['canonical-node',PREVIEW_ENDPOINTS.substrateNodeUri[1],'node'],
    ];
    return Promise.all(targets.map(async ([target,endpoint,kind]) => {
      if(!endpoint)return {target,attempted:false};
      const started=Date.now();let status=null;
      try {
        const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},
          body:JSON.stringify(kind==='indexer'?{query:'{ block { height } }'}:{jsonrpc:'2.0',id:1,method:'system_chain',params:[]}),signal:AbortSignal.timeout(15_000)});
        status=response.status;
        const bytes=await response.arrayBuffer();if(bytes.byteLength>64*1024)throw new Stop('PUBLIC_HEALTH_OVERSIZE');
        const value=JSON.parse(Buffer.from(bytes).toString('utf8'));
        const height=kind==='indexer'?value?.data?.block?.height:null;
        const validHeight=(typeof height==='number'&&Number.isSafeInteger(height)&&height>=0)||(typeof height==='string'&&/^[0-9]{1,16}$/.test(height));
        return {target,attempted:true,status,reachable:true,validResponse:response.ok&&(kind==='indexer'?validHeight&&!value.errors:typeof value?.result==='string'&&!value.error),
          ...(kind==='indexer'&&validHeight?{blockHeight:String(height)}:{}),...(kind==='node'?{previewChain:typeof value?.result==='string'&&/preview/i.test(value.result)}:{}),durationMs:Date.now()-started};
      } catch(error) { return {target,attempted:true,status,reachable:status!==null,validResponse:false,
        failure:error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':status===null?'network':'invalid-response',durationMs:Date.now()-started}; }
    }));
  }
  async function fundingObservation(current) {
    const sample = {at:now(),nightAtomic:current.nightAtomic,dustAtomic:current.dustAtomic,dustCapAtomic:current.dustCapAtomic,
      configuration:current.configuration,endpointMetadata:current.endpointMetadata,syncUi:await syncUiSummary(),health:await anonymousEndpointHealth(current.configuration),
      traffic:structuredClone(report.previewNetwork.hosts)};
    report.fundingObservations ??= [];report.fundingObservations.push(sample);report.fundingObservations=report.fundingObservations.slice(-20);
    await save();process.stdout.write(JSON.stringify({stage:'observe-preview-wallet-funding',at:sample.at,
      nightAtomic:sample.nightAtomic,dustAtomic:sample.dustAtomic,dustCapAtomic:sample.dustCapAtomic,syncUi:sample.syncUi,
      configuration:sample.configuration,endpointMetadata:sample.endpointMetadata,health:sample.health,traffic:sample.traffic})+'\n');
    // Preserve both complete read-only observations before stopping. This
    // guard neither changes endpoints nor starts/retries a wallet operation.
    const ui = await uiPublic();
    observeRetiredPreviewEndpoints(sample, { pendingAction:metadata.pendingAction, completedSteps:metadata.completedSteps,
      operationCount:report.operations.length, approvalCount:approvals, transactionCount:transactionIds(ui).length,
      appOperationCount:ui.activity.length });
  }
  async function uiStep(name, task) {
    await stage(name);
    try { return await task(); }
    catch (error) {
      report.uiFailures ??= []; report.uiFailures.push({ step:name, ...classifyUiFailure(error) }); report.uiFailures = report.uiFailures.slice(-12);
      if (error instanceof Stop && error.code !== 'OBSERVATION_TIMEOUT') throw error;
      throw new Stop('UI_' + name.replaceAll('-', '_').toUpperCase() + '_FAILED');
    }
  }
  async function settingsDiagnostics() {
    if (!wallet || wallet.isClosed()) return;
    // Counts/visibility of fixed public settings controls only. No arbitrary
    // DOM text, inputs, screenshots, or wallet/profile data are inspected.
    const selectors = ['settings-tab-btn', 'option-list-item-network', 'network-selection-sheet',
      'radio-button-testnet', 'radio-button-midnight-preview', 'network-selection-sheet-confirm-button',
      'option-list-item-midnight', 'midnight-settings-sheet-header', 'proof-server-in-process-radio',
      'proof-server-in-process-radio-checkmark', 'save-configuration-button', 'authentication-prompt-body',
      'authentication-prompt-input-value', 'authentication-prompt-button-confirm', 'authentication-prompt-button-cancel'];
    const controls = {};
    for (const id of selectors) {
      const locator = wallet.getByTestId(id); const count = await locator.count().catch(() => 0);
      controls[id] = { count, visible: count === 1 && await visible(locator),
        enabled: count === 1 && await locator.isEnabled().catch(() => false) };
    }
    report.settingsControls = controls;
    // Match visible DOM IDs against the package-derived allowlist in-page.
    // The page returns only this bounded metadata projection, never text,
    // input values, HTML, unrecognized IDs, or arbitrary attributes.
    report.visibleKnownControls = await wallet.evaluate((knownIds) => {
      const known = new Set(knownIds), collected = new Map();
      for (const element of document.querySelectorAll('[data-testid]')) {
        const id = element.getAttribute('data-testid'); if (!known.has(id)) continue;
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
          || !rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0
          || rect.top >= innerHeight || rect.left >= innerWidth) continue;
        const enabled = !element.matches(':disabled') && !element.closest('[aria-disabled="true"], [disabled]');
        const old = collected.get(id);
        if (old) { old.count++; old.enabled = old.enabled && enabled; }
        else collected.set(id, { testID:id, count:1, enabled });
      }
      return [...collected.values()].sort((a,b)=>a.testID.localeCompare(b.testID)).slice(0,128);
    }, staticControlIds).catch(() => []);
    const tab = wallet.getByTestId('settings-tab-btn');
    if (await tab.count() === 1) report.settingsHitTest = await tab.evaluate((element, allowlist) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return { hasArea:false, targetHit:false, knownControl:null };
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      let current = hit, knownControl = null;
      while (current) { const id = current.getAttribute?.('data-testid'); if (allowlist.includes(id)) { knownControl = id; break; } current = current.parentElement; }
      return { hasArea:true, targetHit:hit === element || element.contains(hit), knownControl };
    }, selectors).catch(() => ({ unavailable:true }));
  }
  async function findSettingsItem(id) {
    const item = wallet.getByTestId(id);
    // Lace's GenericFlashList virtualizes offscreen cards. Scroll the real
    // settings list, not injected state, until its known card is mounted.
    for (let attempt = 0; attempt < 6; attempt++) {
      if (await item.count() === 1) { await item.scrollIntoViewIfNeeded(); return item; }
      const list = wallet.getByTestId('option-list-item-network');
      if (await visible(list)) await list.hover(); else await wallet.mouse.move(700, 650);
      await wallet.mouse.wheel(0, id === 'option-list-item-network' ? -450 : 450); await delay(300);
    }
    throw new Stop('SETTINGS_ITEM_NOT_RENDERED');
  }
  async function auth(page) {
    const input = page.getByTestId('authentication-prompt-input-value');
    await input.waitFor({ state: 'visible', timeout: 60_000 });
    await input.fill(metadata.walletPassword);
    await page.getByTestId('authentication-prompt-button-confirm').click();
    try {
      await input.waitFor({ state:'hidden', timeout:60_000 });
      await page.getByTestId('authentication-prompt-button-confirm').waitFor({ state:'hidden', timeout:60_000 });
    } catch (error) { if (!page.isClosed()) throw error; }
  }
  async function unlockWalletIfVisible() {
    if (!await visible(wallet.getByTestId('authentication-prompt-input-value'))) return false;
    requireThat(!walletUnlockAttempted, 'WALLET_UNLOCK_ALREADY_ATTEMPTED');
    walletUnlockAttempted = true;
    await auth(wallet); report.walletUnlockConfirmed = true; await save(); return true;
  }
  async function openWalletSettings() {
    await poll(async () => {
      requireThat(!await visible(wallet.getByTestId('onboarding-start-create-wallet-button')), 'RESTORED_WALLET_MISSING');
      await unlockWalletIfVisible();
      const tab = wallet.getByTestId('settings-tab-btn');
      try {
        // Visibility alone is insufficient: the delayed authentication overlay
        // can cover an already rendered settings tab. Never force this click.
        await tab.click({ trial:true, timeout:1_000 });
        await tab.click({ timeout:1_000 }); return true;
      } catch (error) {
        report.lastSettingsClickFailure = classifyUiFailure(error);
        if (error?.name !== 'TimeoutError') throw error;
        return false;
      }
    }, 60_000);
  }
  async function waitForRestoredWallet() {
    let readySince=null;
    await poll(async()=>{
      requireThat(!await visible(wallet.getByTestId('onboarding-start-create-wallet-button')),'RESTORED_WALLET_MISSING');
      if(await unlockWalletIfVisible())readySince=null;
      try {
        const readyControl=await visible(wallet.getByTestId('network-selection-sheet-cancel-button'))
          ?wallet.getByTestId('network-selection-sheet-cancel-button')
          :await visible(wallet.getByTestId('midnight-settings-sheet-header'))
            ?wallet.getByTestId('proof-server-in-process-radio'):wallet.getByTestId('settings-tab-btn');
        await readyControl.click({trial:true,timeout:1_000});
        readySince??=Date.now();return Date.now()-readySince>=1_000;
      } catch(error) {
        readySince=null;report.lastSettingsClickFailure=classifyUiFailure(error);
        if(error?.name!=='TimeoutError')throw error;return false;
      }
    },90_000);
  }
  async function publicWallet() {
    // Read only documented PUBLIC methods of the genuine injected extension.
    const result = await bounded(app.evaluate(async () => {
      const wallet = Object.values(window.midnight ?? {}).find(item => item.rdns === 'io.lace.wallet');
      if (!wallet) throw new Error('NO_WALLET');
      const api = await wallet.connect('preview');
      const [config, connection, dust, unshielded, balance, unshieldedBalances] = await Promise.all([
        api.getConfiguration(), api.getConnectionStatus(), api.getDustAddress(), api.getUnshieldedAddress(), api.getDustBalance(), api.getUnshieldedBalances()]);
      return { apiVersion: wallet.apiVersion, networkId: config.networkId, connectionStatus: connection.status,
        connectionNetwork: connection.networkId, remoteProverReported: Boolean(config.proverServerUri || config.proverURI || config.proverUri),
        configuration:{indexerUri:config.indexerUri,indexerWsUri:config.indexerWsUri,substrateNodeUri:config.substrateNodeUri},
        unshieldedAddress: unshielded.unshieldedAddress, dustAddress: dust.dustAddress,
        // Pinned ledger-v8 nativeToken().raw is the zero 32-byte unshielded color.
        nightAtomic: String(unshieldedBalances['0'.repeat(64)] ?? 0n),
        dustAtomic: String(balance.balance), dustCapAtomic: String(balance.cap) };
    }));
    result.endpointMetadata=publicEndpointMetadata(result.configuration);
    result.configuration=sanitizePreviewConfiguration(result.configuration);
    requireThat(/^4\./.test(result.apiVersion) && result.networkId === 'preview' && result.connectionNetwork === 'preview'
      && result.connectionStatus === 'connected' && result.remoteProverReported === false, 'PUBLIC_WALLET_CONTEXT_MISMATCH');
    requireThat(/^mn_addr_preview1[0-9a-z]+$/.test(result.unshieldedAddress) && /^mn_dust_preview1[0-9a-z]+$/.test(result.dustAddress), 'PUBLIC_ADDRESS_INVALID');
    atomicInteger(result.nightAtomic); atomicInteger(result.dustAtomic); atomicInteger(result.dustCapAtomic);
    if (metadata.accountId) requireThat(metadata.accountId === result.unshieldedAddress
      && metadata.publicAddresses.dustAddress === result.dustAddress, 'RESTORED_ACCOUNT_CHANGED');
    report.wallet = result; await save(); return result;
  }
  async function approval(remainingBudget) {
    const pages = context.pages().filter(page => page.url().startsWith(`chrome-extension://${EXTENSION_ID}/`) && page.url().includes('#/prove-midnight-transaction'));
    requireThat(pages.length <= 1, 'MULTIPLE_APPROVAL_WINDOWS');
    const page = pages[0]; if (!page || approved.has(page)) return;
    if (!await visible(page.getByTestId('dapp-connector-primary-button'))) return;
    requireThat(remainingBudget > 0, 'UNEXPECTED_ADDITIONAL_APPROVAL');
    requireThat((await page.getByTestId('dapp-info-url').textContent()).trim() === origin, 'APPROVAL_ORIGIN_MISMATCH');
    await publicWallet();
    // Record before approval. No second click is attempted if the page stalls.
    approved.add(page); approvals++;
    metadata.pendingAction.walletApprovals = approvals; await persist();
    await page.getByTestId('dapp-connector-primary-button').click(); await auth(page);
  }
  async function uiPublic() {
    const value = await app.evaluate(() => ({
      phase: document.getElementById('phase-label').textContent,
      statusError: document.getElementById('status').classList.contains('error'),
      status: document.getElementById('status').textContent,
      vaultAddress: document.getElementById('vault-address').textContent,
      balance: document.getElementById('vault-balance').textContent,
      spent: document.getElementById('vault-spent').textContent,
      remaining: document.getElementById('vault-remaining').textContent,
      recipient: document.getElementById('merchant-receipts').textContent,
      policy: document.getElementById('policy-note').textContent,
      canLock: !document.getElementById('disconnect').disabled,
      canPay: !document.getElementById('pay').disabled,
      canBootstrap: !document.getElementById('bootstrap').disabled,
      receipt: document.getElementById('receipt').textContent,
      activity: [...document.querySelectorAll('#full-activity li')].map(li => ({
        label: li.querySelector('strong')?.textContent, transactionId: li.querySelector('code')?.textContent }))
    }));
    return value; // Never logged wholesale: below projections are explicit.
  }
  function transactionIds(ui) {
    return ui.activity.map(item => item.transactionId).filter(Boolean).map(id => {
      requireThat(/^[a-f0-9]{66}$/.test(id), 'PUBLIC_TRANSACTION_INVALID'); return id;
    });
  }
  function balances(ui, balance, spent, remaining) {
    requireThat(atomicInteger(ui.balance) === balance && atomicInteger(ui.spent) === spent
      && atomicInteger(ui.remaining) === remaining, 'POLICY_BALANCE_MISMATCH');
  }
  function receipt(ui, finalized) {
    let value; try { value = JSON.parse(ui.receipt); } catch { throw new Stop('RECEIPT_MISSING'); }
    if (finalized) requireThat(value.status === 'finalized' && value.settlementVerified === true && value.network === 'preview'
      && value.contractAddress === ui.vaultAddress && /^[a-f0-9]{64}$/.test(value.contractAddress)
      && /^[a-f0-9]{66}$/.test(value.transactionId) && /^[a-f0-9]{64}$/.test(value.finalizedBlockHash)
      && value.recipientReceiptVerified === true && value.vaultChangeVerified === true, 'SETTLEMENT_EVIDENCE_MISSING');
    else requireThat(value.status === 'rejected' && !value.transactionId && value.settlementVerified === false, 'EXPECTED_REJECTION_MISSING');
    return { status: value.status, settlementVerified: value.settlementVerified,
      ...(finalized ? { transactionId: value.transactionId, contractAddress: value.contractAddress, blockHash: value.finalizedBlockHash } : {}) };
  }
  async function action(name, click, observe, { maxApprovals = 1, expectedTransactions = 1, timeout = OP_TIMEOUT, ready } = {}) {
    if (metadata.completedSteps.includes(name)) { report.operations.push({ step: name, restoredCompleted: true, ...publicStepEvidence(metadata.stepEvidence[name]) }); await save(); return; }
    requireThat(metadata.pendingAction === null, 'ACTION_UNRESOLVED');
    await publicWallet(); await stage(name);
    if (ready) await ready();
    const before = await uiPublic(), prior = transactionIds(before), startApprovals = approvals, started = Date.now();
    // Stop between operations only. Once an action starts, its own observation
    // timeout governs; this budget never cancels an approval or triggers resend.
    requireOperationBudget(operationDeadline, timeout);
    metadata.pendingAction = { step: name, phase: 'before-ui-click', startedAt: now(), transactionIdsBefore: prior };
    await persist(); await click();
    const result = await poll(async () => {
      await approval(maxApprovals - (approvals - startApprovals));
      const ui = await uiPublic();
      // A live checkpoint intentionally makes phase=unresolved while the job
      // runs. Only an idle unresolved state is a recovery stop.
      requireThat(!(ui.canLock && ui.phase === 'unresolved') && !ui.statusError, 'APP_ACTION_UNRESOLVED');
      const added = newActionTransactions(transactionIds(ui), prior, expectedTransactions);
      // Pause and resume share the same status text and unchanged balances.
      // Wait for this operation's newly recorded transaction before inspecting
      // its final policy; an earlier rendered completion cannot satisfy it.
      if (added === null) return false;
      const observed = await observe(ui, before);
      if (!observed) return false;
      return { ...observed, transactionIds: added, walletApprovals: approvals - startApprovals, durationMs: Date.now() - started };
    }, timeout);
    metadata.stepEvidence[name] = result; metadata.completedSteps.push(name); metadata.pendingAction = null;
    await persist(); report.operations.push({ step: name, ...publicStepEvidence(result) }); await save();
  }
  async function connectApp(mode, { allowMissing = false } = {}) {
    await uiStep('open-app-connect-panel', () => app.locator('[data-screen="connect"]').click());
    await uiStep('discover-real-lace-connector', async () => {
      await app.locator('#find-wallets').click();
      await poll(async () => {
        // Public injected metadata only. Do not read any private wallet state.
        report.connectors = await app.evaluate(() => Object.values(window.midnight ?? {})
          .filter(item => item?.rdns === 'io.lace.wallet').slice(0,8).map(item => ({
            rdns:'io.lace.wallet', name:/^lace$/i.test(item.name ?? '') ? item.name : null,
            apiVersion:/^4\.[0-9]{1,3}\.[0-9]{1,3}(?:[-+][0-9A-Za-z.-]{1,80})?$/.test(item.apiVersion ?? '') ? item.apiVersion : null,
            connectAvailable:typeof item.connect === 'function' })));
        await save();
        const candidates = report.connectors.filter(item=>item.name && item.apiVersion && item.connectAvailable);
        requireThat(candidates.length <= 1, 'MULTIPLE_LACE_CONNECTORS');
        if (!candidates.length) return false;
        const options = await app.locator('#wallet-select option').allTextContents();
        // Official 2.5.1 advertises lowercase "lace". Bind to the actual public
        // connector name instead of assuming title-case display text.
        if (!options.includes(candidates[0].name)) return false;
        await app.locator('#wallet-select').selectOption({ label:candidates[0].name }); return true;
      },60_000);
    });
    await uiStep('request-app-connection', async () => {
      await app.locator('#in-process').check(); await app.locator('#storage-mode').selectOption(mode);
      await app.locator('#storage-password').fill(metadata.appPassword); await app.locator('#connect').click();
    });
    await stage('wait-real-lace-authorization');
    let authorized = false;
    const outcome = await poll(async () => {
      const pages = context.pages().filter(page => page.url().startsWith(`chrome-extension://${EXTENSION_ID}/`) && page.url().includes('#/midnight-authorize-dapp'));
      requireThat(pages.length <= 1, 'MULTIPLE_CONNECTION_WINDOWS');
      if (pages[0] && !authorized && await visible(pages[0].getByTestId('dapp-connector-primary-button'))) {
        const page = pages[0]; requireThat((await page.getByTestId('dapp-info-url').textContent()).trim() === origin, 'CONNECTION_ORIGIN_MISMATCH');
        await page.getByTestId('dropdown-button').click(); await page.getByTestId('dropdown-menu-item-0').click();
        authorized = true; await page.getByTestId('dapp-connector-primary-button').click();
      }
      const label = await app.locator('#connection-label').textContent();
      if (label === 'Connected on this device') return 'opened';
      if (await app.locator('#status').evaluate(el => el.classList.contains('error'))) {
        const exactMissing = await app.locator('#status').textContent() === 'No saved vault was found for this account. Create a new session or restore your encrypted backup.';
        if (mode === 'open' && allowMissing && exactMissing) return 'missing';
        throw new Stop('APP_CONNECTION_FAILED');
      }
      return false;
    }, 180_000);
    if (outcome === 'missing') return outcome;
    await stage('read-connected-wallet-public-state');
    const publicInfo = await publicWallet();
    requireThat(await app.locator('#funding-address').inputValue() === publicInfo.unshieldedAddress, 'APP_ACCOUNT_BINDING_FAILED');
    metadata.accountId = publicInfo.unshieldedAddress;
    metadata.publicAddresses = { unshieldedAddress: publicInfo.unshieldedAddress, dustAddress: publicInfo.dustAddress }; await persist();
    metadata.bootstrapProgress.appSessionCreated = true; await persist();
    return 'opened';
  }
  async function prepareRecipient() {
    await app.locator('[data-screen="vault"]').click();
    if (await app.locator('#setup').isEnabled()) {
      await app.locator('#setup').click();
      await poll(async () => (await app.locator('#merchant-summary').textContent()) === 'Ready to verify payment receipts'
        && await app.locator('#disconnect').isEnabled(), 180_000);
    }
    requireThat(await app.locator('#merchant-summary').textContent() === 'Ready to verify payment receipts', 'RECIPIENT_NOT_READY');
    requireThat((await uiPublic()).phase !== 'unresolved', 'APP_RESTORED_OUTCOME_UNRESOLVED');
  }
  async function selectWasm() {
    const isSelected = async id => {
      const control=wallet.getByTestId(id);
      if(!await visible(control))return false;
      return await control.evaluate(el=>el.getAttribute('aria-selected')==='true'||el.getAttribute('aria-checked')==='true'
        ||el.querySelector('[aria-checked="true"],input:checked')!==null)
        ||await visible(wallet.getByTestId(id+'-checkmark'));
    };
    // Restored navigation may retain a settings sheet. Only known, harmless
    // settings controls are used to close it; never approve a transaction.
    if (await visible(wallet.getByTestId('network-selection-sheet-cancel-button')))
      await uiStep('dismiss-restored-network-sheet', () => wallet.getByTestId('network-selection-sheet-cancel-button').click());
    if (await visible(wallet.getByTestId('midnight-settings-sheet-header'))) {
      await uiStep('normalize-restored-wasm-setting', async () => {
        await wallet.goto(`chrome-extension://${EXTENSION_ID}/expo/index.html`);
        await wallet.getByTestId('midnight-settings-sheet-header').waitFor({ state:'hidden' });
      });
    }
    await uiStep('open-wallet-settings', openWalletSettings);
    await uiStep('open-network-sheet', async () => (await findSettingsItem('option-list-item-network')).click());
    await wallet.getByTestId('radio-button-testnet').waitFor({state:'visible'});
    if(await isSelected('radio-button-testnet')&&await isSelected('radio-button-midnight-preview')) {
      await uiStep('leave-existing-preview-network-unchanged',async()=>{
        await wallet.getByTestId('network-selection-sheet-cancel-button').click();
        await wallet.getByTestId('network-selection-sheet').waitFor({state:'hidden'});
      });
    } else {
      await uiStep('select-testnet-network', () => wallet.getByTestId('radio-button-testnet').click());
      await uiStep('select-midnight-preview', () => wallet.getByTestId('radio-button-midnight-preview').click());
      await uiStep('save-preview-network', async () => {
        await wallet.getByTestId('network-selection-sheet-confirm-button').click();
        await wallet.getByTestId('network-selection-sheet').waitFor({ state: 'hidden' });
      });
    }
    metadata.bootstrapProgress.previewSelected = true; await persist();
    await uiStep('open-midnight-proving-settings', async () => (await findSettingsItem('option-list-item-midnight')).click());
    const radio = wallet.getByTestId('proof-server-in-process-radio');
    const selected = async () => await radio.evaluate(el => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true'
      || el.querySelector('[aria-checked="true"]') !== null || el.querySelector('input:checked') !== null)
      || await visible(wallet.getByTestId('proof-server-in-process-radio-checkmark'));
    await uiStep('inspect-current-wasm-selection', () => radio.waitFor({ state:'visible' }));
    requireThat(await visible(wallet.getByText('Run in this app (WASM)', { exact: true })), 'WASM_SETTING_LABEL_MISSING');
    if (await selected()) {
      await uiStep('leave-existing-wasm-setting-unchanged', async () => {
        await wallet.goto(`chrome-extension://${EXTENSION_ID}/expo/index.html`);
        await wallet.getByTestId('midnight-settings-sheet-header').waitFor({ state:'hidden' });
        await openWalletSettings();
      });
    } else {
      await uiStep('select-in-app-wasm', () => radio.click());
      await uiStep('save-in-app-wasm', async () => {
        await wallet.getByTestId('save-configuration-button').click();
        // In-process has no delegated-provider disclosure. If one appears, stop.
        await wallet.getByTestId('midnight-settings-sheet-header').waitFor({ state: 'hidden', timeout: 30_000 });
      });
    }
    await uiStep('reopen-wasm-settings', async () => (await findSettingsItem('option-list-item-midnight')).click());
    await stage('verify-persisted-wasm-selection');
    await radio.waitFor({ state:'visible' });
    const checked = await selected();
    requireThat(checked, 'WASM_SELECTION_NOT_PERSISTED');
    report.provingSetting = { label: 'Run in this app (WASM)', selectedInRealUi: true, persistedOnReopen: true };
    metadata.bootstrapProgress.wasmSelected = true; await persist();
    await uiStep('close-verified-wasm-settings', async () => {
      // The persisted selection was just observed. Saving an unchanged value
      // can leave Lace's sheet open; normal navigation closes this read-only
      // inspection without another settings mutation or transaction action.
      await wallet.goto(`chrome-extension://${EXTENSION_ID}/expo/index.html`);
      await wallet.getByTestId('midnight-settings-sheet-header').waitFor({ state: 'hidden' });
      await wallet.getByTestId('settings-tab-btn').waitFor({ state:'visible' });
    }); await save();
  }
  try {
    const { chromium } = await import('playwright');
    await stage('launch-isolated-extension');
    context = await chromium.launchPersistentContext(path.join(stateDir, 'profile'), {
      channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
      viewport: { width: 1280, height: 960 }, locale: 'en-US', acceptDownloads: true, downloadsPath: path.join(stateDir, 'downloads') });
    installNetworkCounters();
    context.setDefaultTimeout(30_000); report.chromium = context.browser()?.version() ?? 'not-exposed';
    wallet = await context.newPage(); await wallet.goto(`chrome-extension://${EXTENSION_ID}/expo/index.html`);
    if (options.mode === 'bootstrap') {
      await stage('create-fresh-disposable-wallet');
      report.walletCreationRequested = true; await save();
      await wallet.getByTestId('onboarding-start-create-wallet-button').waitFor({ timeout: 90_000 });
      await wallet.getByTestId('onboarding-start-create-wallet-button').click();
      await wallet.getByTestId('new-password-input-value').fill(metadata.walletPassword);
      await wallet.getByTestId('confirm-password-input-value').fill(metadata.walletPassword);
      await wallet.getByTestId('next-btn').click();
      await wallet.getByTestId('onboarding-create-wallet-toggle-cardano').click(); await delay(250);
      await wallet.getByTestId('onboarding-create-wallet-toggle-midnight').click(); await delay(250);
      await wallet.getByTestId('onboarding-create-wallet-finish-button').click();
    } else {
      await uiStep('unlock-exact-restored-wallet',waitForRestoredWallet);
    }
    await wallet.getByTestId('settings-tab-btn').waitFor({ timeout: 180_000 });
    metadata.bootstrapProgress.walletCreated = true; await persist();
    await stage('select-preview-and-real-wasm'); await selectWasm();
    app = await context.newPage(); await app.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    requireThat(app.url() === APP_URL, 'APP_REDIRECT_REJECTED');
    await captureHostedBuild();
    await stage('connect-genuine-lace-and-encrypted-app');
    if (options.mode === 'resume-bootstrap') {
      const result = await connectApp('open', { allowMissing: true });
      const decision = bootstrapStorageDecision({ mode: options.mode, openResult: result, appSessionCreated: metadata.bootstrapProgress.appSessionCreated === true });
      if (decision === 'create') {
        // Only a real app's exact missing-store result permits first creation.
        // Wrong password, incompatible identity, collision and other failures stop.
        await stage('create-missing-app-session-for-existing-wallet'); await connectApp('create');
      }
    } else await connectApp(options.mode === 'bootstrap' ? 'create' : 'open');
    await stage('prepare-targeted-receipt-verifier'); await prepareRecipient();
    metadata.bootstrapProgress.recipientPrepared = true; await persist();
    if (options.mode !== 'exercise') {
      requireThat(transactionIds(await uiPublic()).length === 0, 'BOOTSTRAP_MUST_NOT_TRANSACT');
      metadata.bootstrapComplete = true; await persist();
      report.status = 'funding-required'; report.nextAction = 'Fund the recorded disposable Preview address; exercise restores this exact encrypted profile.';
    } else {
      await exercise(); report.status = 'passed';
    }
  } catch (error) {
    // Never forward Playwright exceptions: they may include input values or DOM.
    report.status = 'stopped'; report.stopCode = error instanceof Stop ? error.code : 'BROWSER_STEP_FAILED';
    await settingsDiagnostics().catch(() => {});
    if (report.stopCode === 'PREVIEW_NIGHT_NOT_OBSERVED') report.nextAction = 'The wallet API did not observe NIGHT within the read-only wait. Inspect endpoint and sync evidence; retain this exact profile. This does not imply that the confirmed funding transfer is missing. No designation or app transaction was sent.';
    if (report.stopCode === 'LACE_PREVIEW_ENDPOINTS_RETIRED') report.nextAction = 'Both configured legacy Lace Preview services returned HTTP 410 in two consecutive read-only observations. Retain this exact encrypted profile and inspect the configured and canonical health evidence. No designation or app transaction was started; no endpoint override or automatic retry was attempted. Wallet balances of zero do not establish that the confirmed funding transfer is missing.';
    report.uncertainAction = metadata.pendingAction?.step ?? null; process.exitCode = 1;
    if (report.stopCode === 'INSUFFICIENT_OPERATION_BUDGET') report.nextAction = 'Continue from this exact cleanly closed encrypted profile in a new run. No next action was started.';
  } finally {
    report.finishedAt = now();
    if (context) { try { await context.close(); report.browserClosed = true; } catch { report.status = 'stopped'; report.stopCode = 'BROWSER_CLOSE_FAILED'; process.exitCode = 1; } }
    await save();
    process.stdout.write(JSON.stringify({ status: report.status, stage: report.stage, stopCode: report.stopCode, browserClosed: report.browserClosed }) + '\n');
  }
  return report;

  async function captureHostedBuild() {
    const sources = await app.locator('script[type="module"][src]').evaluateAll(elements => elements.map(el => el.src));
    requireThat(sources.length === 1, 'HOSTED_MODULE_AMBIGUOUS');
    const moduleUrl = new URL(sources[0]);
    requireThat(moduleUrl.origin === origin && moduleUrl.pathname.startsWith('/Midnight-Agent-AI-Wallet/')
      && !moduleUrl.search && !moduleUrl.hash, 'HOSTED_MODULE_ORIGIN_MISMATCH');
    async function publicBytes(url, limit) {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      requireThat(response.ok, 'HOSTED_BUILD_FETCH_FAILED');
      const bytes = Buffer.from(await response.arrayBuffer()); requireThat(bytes.length <= limit, 'HOSTED_BUILD_OVERSIZE'); return bytes;
    }
    const [moduleBytes, buildBytes] = await Promise.all([
      publicBytes(moduleUrl.href, 32 * 1024 * 1024), publicBytes(new URL('./browser-build.json', APP_URL), 128 * 1024)]);
    const build = JSON.parse(buildBytes.toString('utf8'));
    requireThat(build.hashes && Object.values(build.hashes).every(hash => /^[a-f0-9]{64}$/.test(hash)), 'HOSTED_BUILD_HASHES_INVALID');
    report.hostedBuild = { inspectedAt: now(), moduleUrl: moduleUrl.href, moduleSha256: digest(moduleBytes),
      manifestSha256: digest(buildBytes), artifactHashes: build.hashes,
      boundary: 'These public bytes were fetched at observation time. Hosted deployment and runner source commit are recorded separately.' };
    await save();
  }

  async function exercise() {
    if(metadata.completedSteps.length===0&&!metadata.remoteConfigRefresh)await refreshRemoteConfiguration();
    else if(metadata.remoteConfigRefresh) {
      report.remoteConfigurationRefresh={attempted:false,previousAttemptRecorded:true,previousAttemptCompleted:metadata.remoteConfigRefresh.completed===true};await save();
    }
    const initial = await publicWallet();
    if (BigInt(initial.dustAtomic) === 0n && BigInt(initial.dustCapAtomic) === 0n) await generateDust();
    await stage('wait-for-public-dust');
    await poll(async () => BigInt((await publicWallet()).dustAtomic) > 0n, 10 * 60_000);
    await app.locator('[data-screen="vault"]').click(); await app.locator('#refresh').click();
    await action('deploy-and-fund-vault', () => app.locator('#bootstrap').click(), async ui => {
      if (!ui.canLock || !ui.status.startsWith('bootstrap completed.')) return false;
      balances(ui, '100000000700', '0', '70000000490');
      for (const name of ['deploy token', 'mint', 'deploy vault', 'disable maintenance', 'initialize policy', 'fund'])
        requireThat(ui.activity.filter(item => item.label === name + ' · finalized' && item.transactionId).length === 1, 'BOOTSTRAP_OPERATION_MISSING');
      return { status: 'finalized', vaultAddress: ui.vaultAddress };
    }, { maxApprovals: 6, expectedTransactions: 6, timeout: 70 * 60_000,
      ready: () => waitForReadyButton(app.locator('#bootstrap'), 'BOOTSTRAP_NOT_READY') });
    await payment('reject-per-payment-limit', '50000000351', false, '100000000700', '0', '70000000490');
    await payment('first-payment', '40000000280', true, '60000000420', '40000000280', '30000000210');
    await payment('reject-cumulative-limit', '40000000280', false, '60000000420', '40000000280', '30000000210');
    await backupAndUnlock();
    await owner('pause', '60000000420', '40000000280', '30000000210');
    await owner('resume', '60000000420', '40000000280', '30000000210');
    await payment('second-payment', '10000000070', true, '50000000350', '50000000350', '20000000140');
    await owner('revoke', '50000000350', '50000000350', '20000000140');
    await owner('withdraw', '0', '50000000350', '20000000140');
    const final = await uiPublic(); requireThat(final.recipient === '2 verified payments · 50,000,000,350 atomic units received', 'RECEIVED_TOTAL_MISMATCH');
    report.final = { balanceAtomic: atomicInteger(final.balance), spentAtomic: atomicInteger(final.spent), remainingAllowanceAtomic: atomicInteger(final.remaining), verifiedReceivedAtomic: '50000000350', paymentCount: 2, vaultAddress: final.vaultAddress };
  }
  async function refreshRemoteConfiguration() {
    const initialUi=await uiPublic();
    requireRefreshPreflight({pendingAction:metadata.pendingAction,completedSteps:metadata.completedSteps,
      operationCount:report.operations.length,approvalCount:approvals,transactionCount:transactionIds(initialUi).length});
    requireThat(initialUi.phase!=='unresolved'&&initialUi.canLock,'REMOTE_CONFIG_REFRESH_SESSION_NOT_IDLE');
    requireOperationBudget(operationDeadline,10*60_000);
    const before=await publicWallet();
    report.remoteConfigurationRefresh={startedAt:now(),method:'close-all-Lace-views-and-reopen-once',
      before:{configuration:before.configuration,endpointMetadata:before.endpointMetadata},
      sameContext:true,viewCloseCycleObserved:false,reopened:false,
      boundary:'Normal closure triggers the official extension refresh path; no flag payload is read or injected, and successful remote configuration delivery is not assumed.'};
    // Persist the one allowed attempt across archived-profile runs too. An
    // interrupted attempt never silently becomes another refresh cycle.
    metadata.remoteConfigRefresh={attemptedAt:now(),completed:false};await persist();await save();
    await uiStep('lock-app-before-supported-config-refresh',async()=>{
      await app.locator('[data-screen="connect"]').click();
      await waitForReadyButton(app.locator('#disconnect'),'CONFIG_REFRESH_APP_NOT_IDLE');
      await app.locator('#disconnect').click();
      await poll(async()=>await app.locator('#connection-label').textContent()==='Not connected'&&await app.locator('#connect').isEnabled());
    });
    await uiStep('close-all-lace-views-for-config-refresh',async()=>{
      const extensionPages=context.pages().filter(page=>page.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
      requireThat(extensionPages.length>0&&extensionPages.every(page=>isLaceViewUrl(page.url())),'UNKNOWN_LACE_VIEW_OPEN');
      requireThat(extensionPages.every(page=>!page.url().includes('prove-midnight-transaction')&&!page.url().includes('midnight-authorize-dapp')),'CONFIG_REFRESH_APPROVAL_WINDOW_OPEN');
      for(const page of extensionPages)await page.close();
      requireThat(!context.pages().some(page=>page.url().startsWith(`chrome-extension://${EXTENSION_ID}/`)),'LACE_VIEWS_STILL_OPEN');
      report.remoteConfigurationRefresh.closedViewCount=extensionPages.length;
      report.remoteConfigurationRefresh.viewCloseCycleObserved=true;await save();
    });
    await stage('wait-supported-remote-config-refresh');await delay(10_000);
    await uiStep('reopen-same-lace-wallet-after-refresh',async()=>{
      // A fresh view can require a fresh unlock. Permit it only after any
      // previous attempt actually succeeded; never retry a failed password.
      requireThat(!walletUnlockAttempted||report.walletUnlockConfirmed===true,'PREVIOUS_WALLET_UNLOCK_FAILED');
      walletUnlockAttempted=false;
      wallet=await context.newPage();await wallet.goto(`chrome-extension://${EXTENSION_ID}/expo/index.html`);
      await waitForRestoredWallet();report.remoteConfigurationRefresh.reopened=true;await save();
    });
    await stage('verify-preview-and-wasm-after-refresh');await selectWasm();
    await uiStep('reload-disconnected-app-after-refresh',async()=>{
      await app.reload({waitUntil:'domcontentloaded'});requireThat(app.url()===APP_URL,'APP_REDIRECT_REJECTED');await captureHostedBuild();
    });
    await connectApp('open');await prepareRecipient();
    const after=await publicWallet();
    const afterUi=await uiPublic();
    requireThat(transactionIds(afterUi).length===0&&afterUi.phase!=='unresolved','CONFIG_REFRESH_UNEXPECTED_TRANSACTION');
    report.remoteConfigurationRefresh.after={configuration:after.configuration,endpointMetadata:after.endpointMetadata};
    report.remoteConfigurationRefresh.publicConfigurationProjectionChanged=JSON.stringify(report.remoteConfigurationRefresh.before)!==JSON.stringify(report.remoteConfigurationRefresh.after);
    report.remoteConfigurationRefresh.samePublicAccount=true;report.remoteConfigurationRefresh.finishedAt=now();
    metadata.remoteConfigRefresh.completed=true;await persist();await save();
    process.stdout.write(JSON.stringify({stage:'supported-remote-config-refresh-observed',refresh:report.remoteConfigurationRefresh,traffic:report.previewNetwork.hosts})+'\n');
  }
  async function payment(name, amount, accepted, balance, spent, remaining) {
    await app.locator('[data-screen="pay"]').click();
    await action(name, async () => { await app.locator('#payment-amount').fill(amount); await app.locator('#pay').click(); }, async (ui, before) => {
      if (!ui.canLock || !ui.status.startsWith('payments completed.') || ui.receipt === before.receipt) return false;
      balances(ui, balance, spent, remaining); const checked = receipt(ui, accepted);
      const added = transactionIds(ui).filter(id => !transactionIds(before).includes(id));
      requireThat(added.length === (accepted ? 1 : 0), 'UNEXPECTED_PAYMENT_TRANSACTION_COUNT');
      return { status: accepted ? 'finalized' : 'rejected', amountAtomic: amount, receipt: checked };
    }, { maxApprovals: accepted ? 1 : 0, expectedTransactions: accepted ? 1 : 0,
      ready: () => waitForReadyButton(app.locator('#pay'), 'PAYMENT_CONTROL_NOT_READY') });
  }
  async function owner(kind, balance, spent, remaining) {
    await app.locator('[data-screen="owner"]').click();
    const command = kind === 'pause' || kind === 'resume' ? 'pause' : kind;
    await action('owner-' + kind, () => app.locator('#owner-' + command).click(), async ui => {
      if (!ui.canLock || !ui.status.startsWith('owner ' + command + ' completed.')) return false;
      balances(ui, balance, spent, remaining);
      if (kind === 'pause') requireThat(ui.policy.includes('Agent paused.') && !ui.canPay, 'PAUSE_NOT_ENFORCED');
      if (kind === 'resume') requireThat(!ui.policy.includes('Agent paused.') && ui.canPay, 'RESUME_NOT_ENFORCED');
      if (kind === 'revoke') requireThat(ui.policy.includes('Agent revoked.') && !ui.canPay, 'REVOCATION_NOT_ENFORCED');
      return { status: 'finalized', paymentDisabled: !ui.canPay };
    }, { ready: () => waitForReadyButton(app.locator('#owner-' + command), 'OWNER_CONTROL_NOT_READY') });
  }
  async function backupAndUnlock() {
    if (metadata.completedSteps.includes('backup-lock-unlock')) {
      report.operations.push({ step: 'backup-lock-unlock', restoredCompleted: true, ...publicStepEvidence(metadata.stepEvidence['backup-lock-unlock']) }); await save(); return;
    }
    await stage('encrypted-backup-lock-and-unlock');
    const before = await uiPublic();
    await app.locator('[data-screen="connect"]').click();
    await waitForReadyButton(app.locator('#backup'), 'BACKUP_CONTROL_NOT_READY');
    requireOperationBudget(operationDeadline, 5 * 60_000);
    metadata.pendingAction = { step: 'backup-lock-unlock', phase: 'before-ui-click', startedAt: now() }; await persist();
    const pending = app.waitForEvent('download'); await app.locator('#backup').click();
    const download = await pending; const file = path.join(stateDir, 'app-encrypted-backup.midnight-backup'); await download.saveAs(file);
    const bytes = await readFile(file); requireThat(bytes.length > 100 && bytes.length <= 64 * 1024 * 1024, 'BACKUP_SIZE_INVALID');
    await app.locator('#disconnect').click(); await poll(async () => await app.locator('#connection-label').textContent() === 'Not connected');
    await connectApp('open'); await prepareRecipient(); const after = await uiPublic();
    requireThat(before.vaultAddress === after.vaultAddress && before.balance === after.balance && before.spent === after.spent
      && before.remaining === after.remaining && before.recipient === after.recipient, 'UNLOCK_IDENTITY_STATE_CHANGED');
    metadata.completedSteps.push('backup-lock-unlock'); metadata.pendingAction = null;
    metadata.stepEvidence['backup-lock-unlock'] = { status: 'passed', backupBytes: bytes.length, backupSha256: digest(bytes), sameAccountAndVault: true };
    await persist(); report.operations.push({ step: 'backup-lock-unlock', ...publicStepEvidence(metadata.stepEvidence['backup-lock-unlock']) }); await save();
  }
  async function generateDust() {
    if (metadata.completedSteps.includes('generate-dust')) throw new Stop('EXISTING_DUST_DESIGNATION_NOT_READY');
    await stage('observe-preview-wallet-funding');
    requireOperationBudget(operationDeadline,15*60_000);
    // Portfolio navigation exposes the real status pill without restarting
    // the extension or its sync workers and without modifying settings.
    await wallet.getByTestId('portfolio-tab-btn').click();
    const deadline=Date.now()+15*60_000;let lastSample=0,observed=false;
    do {
      const current=await publicWallet();observed=BigInt(current.nightAtomic)>0n;
      if(Date.now()-lastSample>=60_000||observed){lastSample=Date.now();await fundingObservation(current);}
      if(observed)break;
      await delay(Math.min(5_000,Math.max(1,deadline-Date.now())));
    } while(Date.now()<deadline);
    requireThat(observed,'PREVIEW_NIGHT_NOT_OBSERVED');
    await stage('generate-dust-in-real-lace');
    const button = wallet.getByTestId('account-card-generate-dust-button');
    await waitForReadyButton(button, 'FUNDED_DUST_CONTROL_NOT_READY');
    requireThat(BigInt((await publicWallet()).nightAtomic) > 0n, 'PREVIEW_NIGHT_NOT_OBSERVED');
    await button.click();
    const address = wallet.getByTestId('dust-address-input-value'); await address.waitFor();
    requireThat(await address.inputValue() === metadata.publicAddresses.dustAddress, 'DUST_RECIPIENT_MISMATCH');
    const designate = wallet.getByTestId('designate-button');
    await waitForReadyButton(designate, 'DUST_DESIGNATION_NOT_READY');
    await designate.click();
    await waitForReadyButton(wallet.getByTestId('confirm-designation-button'), 'DUST_CONFIRMATION_NOT_READY');
    requireOperationBudget(operationDeadline, 25 * 60_000);
    metadata.pendingAction = { step: 'generate-dust', phase: 'before-ui-click', startedAt: now() }; await persist();
    await wallet.getByTestId('confirm-designation-button').click(); await auth(wallet);
    await poll(async () => BigInt((await publicWallet()).dustCapAtomic) > 0n, 15 * 60_000);
    metadata.completedSteps.push('generate-dust'); metadata.stepEvidence['generate-dust'] = { status: 'public-cap-observed', ownDustAddress: true };
    metadata.pendingAction = null; await persist(); report.operations.push({ step: 'generate-dust', ...publicStepEvidence(metadata.stepEvidence['generate-dust']) }); await save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(JSON.stringify({ status: 'stopped', stopCode: error instanceof Stop ? error.code : 'HARNESS_SETUP_FAILED' }) + '\n'); process.exitCode = 1; });
}
