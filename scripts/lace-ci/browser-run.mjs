/** Real Lace/application UI acceptance on a disposable GitHub runner only.
 * No seed import/export, hidden wallet state, API replacement, trace or screenshot.
 * Progress prevents resending after ambiguity. Recovery requires a cleanly closed
 * encrypted profile archive; this is NOT durability against loss of the runner.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, lstat, realpath, open, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, totalmem } from 'node:os';

export const APP_URL = 'https://ibkr-bouncybot.github.io/Midnight-Agent-AI-Wallet/testnet.html';
const REPOSITORY = 'IBKR-BouncyBot/Midnight-Agent-AI-Wallet';
const EXTENSION_ID = 'gafhhkghbfjjkeiendhlofajokpaflmk';
const VERSION = '2.5.1';
const SCHEMA = 'lace-ci-private-session-v1';
const OP_TIMEOUT = 25 * 60_000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
class Stop extends Error { constructor(code) { super(code); this.code = code; } }
function requireThat(value, code) { if (!value) throw new Stop(code); }
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
  requireThat(['bootstrap', 'exercise'].includes(result.mode) && result['extension-dir'] && result['state-dir'] && result['evidence-dir'], 'INVALID_ARGUMENTS');
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
export function validatePrivateMetadata(value) {
  requireThat(value?.schema === SCHEMA && value.network === 'preview' && value.walletVersion === VERSION
    && value.appUrl === APP_URL && typeof value.walletPassword === 'string' && value.walletPassword.length >= 24
    && typeof value.appPassword === 'string' && value.appPassword.length >= 24
    && Array.isArray(value.completedSteps) && value.completedSteps.every(step => typeof step === 'string')
    && value.stepEvidence && typeof value.stepEvidence === 'object', 'PRIVATE_STATE_INVALID');
  requireThat(value.pendingAction === null, 'RESTORED_ACTION_UNRESOLVED');
  requireThat(value.bootstrapComplete === true && /^mn_addr_preview1[0-9a-z]+$/.test(value.accountId ?? ''), 'BOOTSTRAP_INCOMPLETE');
  return value;
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

export async function main(args = process.argv.slice(2), env = process.env) {
  validateEnvironment(env); // Before imports, profile access, or any browser launch.
  requireThat(process.platform === 'linux', 'LINUX_RUNNER_REQUIRED');
  const options = parseArgs(args), tempRoot = await realpath(env.RUNNER_TEMP);
  const stateDir = await containedPath(tempRoot, options['state-dir'], options.mode === 'exercise');
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
  const privateFile = path.join(stateDir, 'session-private.json');
  let metadata;
  if (options.mode === 'bootstrap') {
    requireThat(!await exists(stateDir), 'FRESH_STATE_DIRECTORY_REQUIRED');
    await mkdir(stateDir, { mode: 0o700 });
    metadata = { schema: SCHEMA, network: 'preview', walletVersion: VERSION, appUrl: APP_URL,
      walletPassword: 'CiWallet-' + randomBytes(32).toString('base64url') + '!9a',
      appPassword: 'CiVault-' + randomBytes(32).toString('base64url') + '!9a',
      createdAt: now(), bootstrapComplete: false, pendingAction: null, completedSteps: [], stepEvidence: {} };
    await atomicJson(privateFile, metadata);
  } else {
    metadata = validatePrivateMetadata(JSON.parse(await readFile(privateFile, 'utf8')));
    requireThat((await lstat(path.join(stateDir, 'profile'))).isDirectory(), 'RESTORED_PROFILE_REQUIRED');
  }
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const reportFile = path.join(evidenceDir, 'browser-run.json');
  requireThat(!await exists(reportFile), 'FRESH_EVIDENCE_REQUIRED');
  const report = { schema: 'midnight-agent-wallet-real-lace-ci-v1', startedAt: now(), mode: options.mode,
    network: 'preview', appUrl: APP_URL, walletVersion: VERSION, extensionId: EXTENSION_ID,
    extensionCrxSha256: acquisition.crxSha256, runnerSha256: digest(await readFile(new URL(import.meta.url))),
    status: 'running', stage: 'starting', operations: [], browserClosed: false, transactionsRetried: 0,
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
  const approved = new WeakSet();
  let approvals = 0;
  const origin = new URL(APP_URL).origin;
  async function auth(page) {
    const input = page.getByTestId('authentication-prompt-input-value');
    await input.waitFor({ state: 'visible', timeout: 60_000 });
    await input.fill(metadata.walletPassword);
    await page.getByTestId('authentication-prompt-button-confirm').click();
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
        unshieldedAddress: unshielded.unshieldedAddress, dustAddress: dust.dustAddress,
        // Pinned ledger-v8 nativeToken().raw is the zero 32-byte unshielded color.
        nightAtomic: String(unshieldedBalances['0'.repeat(64)] ?? 0n),
        dustAtomic: String(balance.balance), dustCapAtomic: String(balance.cap) };
    }));
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
  async function action(name, click, observe, { maxApprovals = 1, expectedTransactions = 1, timeout = OP_TIMEOUT } = {}) {
    if (metadata.completedSteps.includes(name)) { report.operations.push({ step: name, restoredCompleted: true, ...publicStepEvidence(metadata.stepEvidence[name]) }); await save(); return; }
    requireThat(metadata.pendingAction === null, 'ACTION_UNRESOLVED');
    await publicWallet(); await stage(name);
    const before = await uiPublic(), prior = transactionIds(before), startApprovals = approvals, started = Date.now();
    metadata.pendingAction = { step: name, phase: 'before-ui-click', startedAt: now(), transactionIdsBefore: prior };
    await persist(); await click();
    const result = await poll(async () => {
      await approval(maxApprovals - (approvals - startApprovals));
      const ui = await uiPublic();
      // A live checkpoint intentionally makes phase=unresolved while the job
      // runs. Only an idle unresolved state is a recovery stop.
      requireThat(!(ui.canLock && ui.phase === 'unresolved') && !ui.statusError, 'APP_ACTION_UNRESOLVED');
      const observed = await observe(ui, before);
      if (!observed) return false;
      const added = transactionIds(ui).filter(id => !prior.includes(id));
      requireThat(added.length === expectedTransactions, 'UNEXPECTED_TRANSACTION_COUNT');
      return { ...observed, transactionIds: added, walletApprovals: approvals - startApprovals, durationMs: Date.now() - started };
    }, timeout);
    metadata.stepEvidence[name] = result; metadata.completedSteps.push(name); metadata.pendingAction = null;
    await persist(); report.operations.push({ step: name, ...publicStepEvidence(result) }); await save();
  }
  async function connectApp(mode) {
    await app.locator('[data-screen="connect"]').click();
    await app.locator('#find-wallets').click();
    await poll(async () => (await app.locator('#wallet-select option').allTextContents()).some(item => item === 'Lace'), 60_000);
    await app.locator('#in-process').check(); await app.locator('#storage-mode').selectOption(mode);
    await app.locator('#storage-password').fill(metadata.appPassword); await app.locator('#connect').click();
    let authorized = false;
    await poll(async () => {
      const pages = context.pages().filter(page => page.url().startsWith(`chrome-extension://${EXTENSION_ID}/`) && page.url().includes('#/midnight-authorize-dapp'));
      requireThat(pages.length <= 1, 'MULTIPLE_CONNECTION_WINDOWS');
      if (pages[0] && !authorized && await visible(pages[0].getByTestId('dapp-connector-primary-button'))) {
        const page = pages[0]; requireThat((await page.getByTestId('dapp-info-url').textContent()).trim() === origin, 'CONNECTION_ORIGIN_MISMATCH');
        await page.getByTestId('dropdown-button').click(); await page.getByTestId('dropdown-menu-item-0').click();
        authorized = true; await page.getByTestId('dapp-connector-primary-button').click();
      }
      const label = await app.locator('#connection-label').textContent();
      if (label === 'Connected on this device') return true;
      requireThat(!await app.locator('#status').evaluate(el => el.classList.contains('error')), 'APP_CONNECTION_FAILED');
      return false;
    }, 180_000);
    const publicInfo = await publicWallet();
    requireThat(await app.locator('#funding-address').inputValue() === publicInfo.unshieldedAddress, 'APP_ACCOUNT_BINDING_FAILED');
    metadata.accountId = publicInfo.unshieldedAddress;
    metadata.publicAddresses = { unshieldedAddress: publicInfo.unshieldedAddress, dustAddress: publicInfo.dustAddress }; await persist();
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
    await wallet.getByTestId('settings-tab-btn').click();
    await wallet.getByTestId('option-list-item-network').click();
    await wallet.getByTestId('radio-button-testnet').click();
    await wallet.getByTestId('radio-button-midnight-preview').click();
    await wallet.getByTestId('network-selection-sheet-confirm-button').click();
    await wallet.getByTestId('network-selection-sheet').waitFor({ state: 'hidden' });
    await wallet.getByTestId('option-list-item-midnight').click();
    const radio = wallet.getByTestId('proof-server-in-process-radio'); await radio.click();
    requireThat(await visible(wallet.getByText('Run in this app (WASM)', { exact: true })), 'WASM_SETTING_LABEL_MISSING');
    await wallet.getByTestId('save-configuration-button').click();
    // In-process has no delegated-provider disclosure. If one appears, stop.
    await wallet.getByTestId('midnight-settings-sheet-header').waitFor({ state: 'hidden', timeout: 30_000 });
    await wallet.getByTestId('option-list-item-midnight').click();
    const checked = await radio.evaluate(el => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true'
      || el.querySelector('[aria-checked="true"]') !== null || el.querySelector('input:checked') !== null)
      || await visible(wallet.getByTestId('proof-server-in-process-radio-checkmark'));
    requireThat(checked, 'WASM_SELECTION_NOT_PERSISTED');
    report.provingSetting = { label: 'Run in this app (WASM)', selectedInRealUi: true, persistedOnReopen: true };
    await wallet.getByTestId('save-configuration-button').click();
    await wallet.getByTestId('midnight-settings-sheet-header').waitFor({ state: 'hidden' }); await save();
  }
  try {
    const { chromium } = await import('playwright');
    await stage('launch-isolated-extension');
    context = await chromium.launchPersistentContext(path.join(stateDir, 'profile'), {
      channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
      viewport: { width: 1280, height: 960 }, acceptDownloads: true, downloadsPath: path.join(stateDir, 'downloads') });
    context.setDefaultTimeout(30_000); report.chromium = context.browser()?.version() ?? 'not-exposed';
    wallet = await context.newPage(); await wallet.goto(`chrome-extension://${EXTENSION_ID}/expo/index.html`);
    if (options.mode === 'bootstrap') {
      await stage('create-fresh-disposable-wallet');
      await wallet.getByTestId('onboarding-start-create-wallet-button').waitFor({ timeout: 90_000 });
      await wallet.getByTestId('onboarding-start-create-wallet-button').click();
      await wallet.getByTestId('new-password-input-value').fill(metadata.walletPassword);
      await wallet.getByTestId('confirm-password-input-value').fill(metadata.walletPassword);
      await wallet.getByTestId('next-btn').click();
      await wallet.getByTestId('onboarding-create-wallet-toggle-cardano').click(); await delay(250);
      await wallet.getByTestId('onboarding-create-wallet-toggle-midnight').click(); await delay(250);
      await wallet.getByTestId('onboarding-create-wallet-finish-button').click();
    } else {
      await stage('unlock-exact-restored-wallet');
      await poll(async () => {
        requireThat(!await visible(wallet.getByTestId('onboarding-start-create-wallet-button')), 'RESTORED_WALLET_MISSING');
        return await visible(wallet.getByTestId('settings-tab-btn')) || await visible(wallet.getByTestId('authentication-prompt-input-value'));
      }, 90_000);
      if (await visible(wallet.getByTestId('authentication-prompt-input-value'))) await auth(wallet);
    }
    await wallet.getByTestId('settings-tab-btn').waitFor({ timeout: 180_000 });
    await stage('select-preview-and-real-wasm'); await selectWasm();
    app = await context.newPage(); await app.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    requireThat(app.url() === APP_URL, 'APP_REDIRECT_REJECTED');
    await captureHostedBuild();
    await stage('connect-genuine-lace-and-encrypted-app'); await connectApp(options.mode === 'bootstrap' ? 'create' : 'open');
    await stage('prepare-targeted-receipt-verifier'); await prepareRecipient();
    if (options.mode === 'bootstrap') {
      requireThat(transactionIds(await uiPublic()).length === 0, 'BOOTSTRAP_MUST_NOT_TRANSACT');
      metadata.bootstrapComplete = true; await persist();
      report.status = 'funding-required'; report.nextAction = 'Fund the recorded disposable Preview address; exercise restores this exact encrypted profile.';
    } else {
      await exercise(); report.status = 'passed';
    }
  } catch (error) {
    // Never forward Playwright exceptions: they may include input values or DOM.
    report.status = 'stopped'; report.stopCode = error instanceof Stop ? error.code : 'BROWSER_STEP_FAILED';
    if (report.stopCode === 'PREVIEW_NIGHT_FUNDING_REQUIRED') report.nextAction = 'Fund the recorded disposable Preview NIGHT address, then restore this exact encrypted profile. No designation or app transaction was sent.';
    report.uncertainAction = metadata.pendingAction?.step ?? null; process.exitCode = 1;
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
    const initial = await publicWallet();
    if (BigInt(initial.dustAtomic) === 0n && BigInt(initial.dustCapAtomic) === 0n) await generateDust();
    await stage('wait-for-public-dust');
    await poll(async () => BigInt((await publicWallet()).dustAtomic) > 0n, 10 * 60_000);
    await app.locator('[data-screen="vault"]').click(); await app.locator('#refresh').click();
    await action('deploy-and-fund-vault', async () => {
      requireThat(await app.locator('#bootstrap').isEnabled(), 'BOOTSTRAP_NOT_READY'); await app.locator('#bootstrap').click();
    }, async ui => {
      if (!ui.canLock || !ui.status.startsWith('bootstrap completed.')) return false;
      balances(ui, '100000000700', '0', '70000000490');
      for (const name of ['deploy token', 'mint', 'deploy vault', 'disable maintenance', 'initialize policy', 'fund'])
        requireThat(ui.activity.filter(item => item.label === name + ' · finalized' && item.transactionId).length === 1, 'BOOTSTRAP_OPERATION_MISSING');
      return { status: 'finalized', vaultAddress: ui.vaultAddress };
    }, { maxApprovals: 6, expectedTransactions: 6, timeout: 70 * 60_000 });
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
  async function payment(name, amount, accepted, balance, spent, remaining) {
    await app.locator('[data-screen="pay"]').click();
    await action(name, async () => { await app.locator('#payment-amount').fill(amount); await app.locator('#pay').click(); }, async (ui, before) => {
      if (!ui.canLock || !ui.status.startsWith('payments completed.') || ui.receipt === before.receipt) return false;
      balances(ui, balance, spent, remaining); const checked = receipt(ui, accepted);
      const added = transactionIds(ui).filter(id => !transactionIds(before).includes(id));
      requireThat(added.length === (accepted ? 1 : 0), 'UNEXPECTED_PAYMENT_TRANSACTION_COUNT');
      return { status: accepted ? 'finalized' : 'rejected', amountAtomic: amount, receipt: checked };
    }, { maxApprovals: accepted ? 1 : 0, expectedTransactions: accepted ? 1 : 0 });
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
    });
  }
  async function backupAndUnlock() {
    if (metadata.completedSteps.includes('backup-lock-unlock')) {
      report.operations.push({ step: 'backup-lock-unlock', restoredCompleted: true, ...publicStepEvidence(metadata.stepEvidence['backup-lock-unlock']) }); await save(); return;
    }
    await stage('encrypted-backup-lock-and-unlock');
    const before = await uiPublic();
    await app.locator('[data-screen="connect"]').click();
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
    await stage('generate-dust-in-real-lace');
    try { await poll(async () => BigInt((await publicWallet()).nightAtomic) > 0n, 300_000); }
    catch (error) { if (error instanceof Stop && error.code === 'OBSERVATION_TIMEOUT') throw new Stop('PREVIEW_NIGHT_FUNDING_REQUIRED'); throw error; }
    await wallet.goto(`chrome-extension://${EXTENSION_ID}/expo/index.html`);
    await wallet.getByTestId('portfolio-tab-btn').click();
    const button = wallet.getByTestId('account-card-generate-dust-button');
    await poll(async () => await visible(button), 120_000);
    requireThat(await button.count() === 1 && await button.isEnabled(), 'PREVIEW_NIGHT_FUNDING_REQUIRED');
    await button.click();
    const address = wallet.getByTestId('dust-address-input-value'); await address.waitFor();
    requireThat(await address.inputValue() === metadata.publicAddresses.dustAddress, 'DUST_RECIPIENT_MISMATCH');
    const designate = wallet.getByTestId('designate-button');
    await poll(async () => await designate.isEnabled(), 120_000);
    await designate.click(); await wallet.getByTestId('confirm-designation-button').waitFor();
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
