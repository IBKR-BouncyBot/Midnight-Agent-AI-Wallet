import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_URL, validateEnvironment, parseArgs, atomicInteger, validatePrivateMetadata, publicStepEvidence, bootstrapStorageDecision, classifyUiFailure, extractStaticControlIds,
  requireOperationBudget, newActionTransactions, waitForReadyButton, sanitizePreviewConfiguration, previewPublicHost, parseSyncStatusLabel,
  publicEndpointMetadata,isLaceViewUrl,requireRefreshPreflight } from './browser-run.mjs';

const env = { CI:'true', GITHUB_ACTIONS:'true', RUNNER_OS:'Linux', GITHUB_REPOSITORY:'IBKR-BouncyBot/Midnight-Agent-AI-Wallet', GITHUB_RUN_ID:'123', RUNNER_TEMP:'/tmp/runner' };

test('a new operation requires its full observation window plus clean-close reserve', () => {
  const clock = 1_800_000_000_000, minute = 60_000;
  for (const duration of [70 * minute, 25 * minute, 5 * minute]) {
    const boundary = clock + duration + 5 * minute;
    assert.throws(() => requireOperationBudget(boundary, duration, clock), error => error.code === 'INSUFFICIENT_OPERATION_BUDGET');
    requireOperationBudget(boundary + 1, duration, clock);
    assert.throws(() => requireOperationBudget(boundary, duration, boundary + 1), error => error.code === 'INSUFFICIENT_OPERATION_BUDGET');
  }
  // A failed preflight is retryable from the same saved progress next run. It
  // has no timer or cancellation callback that could interrupt a started action.
  requireOperationBudget(clock + 300 * minute, 70 * minute, clock);
  for (const invalid of [0, -1, Infinity, NaN, 0.5]) assert.throws(() => requireOperationBudget(clock + 300 * minute, invalid, clock));
});

test('stale completion text cannot complete an owner action without its new transaction', () => {
  const pause = '00' + '11'.repeat(32), resume = '00' + '22'.repeat(32), unrelated = '00' + '33'.repeat(32);
  assert.equal(newActionTransactions([pause], [pause], 1), null);
  assert.deepEqual(newActionTransactions([resume, pause], [pause], 1), [resume]);
  assert.equal(newActionTransactions([pause], [], 6), null, 'partial bootstrap waits for all six operations');
  assert.deepEqual(newActionTransactions([pause], [pause], 0), [], 'a rejection must add no transaction');
  for (const current of [[pause, resume, unrelated], [pause, resume, resume]])
    assert.throws(() => newActionTransactions(current, [pause], 1), error => error.code === 'UNEXPECTED_TRANSACTION_COUNT');
  assert.throws(() => newActionTransactions([pause, resume], [pause], 0), error => error.code === 'UNEXPECTED_TRANSACTION_COUNT');
});

test('ready controls wait for real enablement and use only nonclicking actionability trials', async () => {
  let checks = 0, trials = 0;
  const locator = { count: async () => 1, isVisible: async () => true, isEnabled: async () => ++checks > 1,
    async click(options) { assert.equal(options.trial, true); assert.equal(options.force, undefined); trials++; } };
  await waitForReadyButton(locator, 'BOOTSTRAP_NOT_READY', 2_000);
  assert.equal(checks, 2); assert.equal(trials, 1);
  await assert.rejects(waitForReadyButton({ ...locator, isEnabled: async () => false }, 'FUNDED_DUST_CONTROL_NOT_READY', 1),
    error => error.code === 'FUNDED_DUST_CONTROL_NOT_READY');
  assert.equal(trials, 1, 'a funded but disabled control is neither clicked nor reported as missing funds');
  await assert.rejects(waitForReadyButton({ ...locator, count: async () => 2 }, 'BOOTSTRAP_NOT_READY'),
    error => error.code === 'AMBIGUOUS_ACTION_CONTROL');
});
test('browser execution requires the isolated GitHub repository runner', () => {
  validateEnvironment(env);
  for (const key of Object.keys(env)) assert.throws(() => validateEnvironment({ ...env, [key]: '' }));
  assert.throws(() => validateEnvironment({ ...env, GITHUB_REPOSITORY:'attacker/fork' }));
  for (const key of ['DEBUG', 'PWDEBUG']) assert.throws(() => validateEnvironment({ ...env, [key]:'1' }));
});
test('CLI allowlists exact public app URL and known arguments', () => {
  const args = ['--mode','bootstrap','--extension-dir','e','--state-dir','s','--evidence-dir','p'];
  assert.equal(parseArgs(args).mode, 'bootstrap');
  assert.equal(parseArgs(args.map(value=>value==='bootstrap'?'resume-bootstrap':value)).mode, 'resume-bootstrap');
  for (const url of [APP_URL+'?x=1', APP_URL+'#secret', APP_URL.replace('https:', 'http:'), 'https://example.com'])
    assert.throws(() => parseArgs([...args, '--app-url', url]));
  assert.throws(() => parseArgs([...args, '--mode','exercise']));
  assert.throws(() => parseArgs([...args, '--seed','forbidden']));
});
test('atomic balances never pass through floating point or ambiguous formatting', () => {
  assert.equal(atomicInteger('18,446,744,073,709,551,615'), '18446744073709551615');
  assert.equal(atomicInteger('100000000700'), '100000000700');
  for (const value of ['01','1,00','1.0','-1','1e10','not observed',40]) assert.throws(() => atomicInteger(value));
});
test('restored ongoing or incomplete attempts fail before any browser launch', () => {
  const state = { schema:'lace-ci-private-session-v1', network:'preview', walletVersion:'2.5.1', appUrl:APP_URL,
    walletPassword:'a'.repeat(32), appPassword:'b'.repeat(32), completedSteps:[], stepEvidence:{}, pendingAction:null,
    bootstrapComplete:true, accountId:'mn_addr_preview1abc' };
  assert.equal(validatePrivateMetadata(state), state);
  for (const pendingAction of [{step:'first-payment',phase:'before-ui-click'}, {step:'first-payment',phase:'submitted'}, undefined])
    assert.throws(() => validatePrivateMetadata({ ...state, pendingAction }), /RESTORED_ACTION_UNRESOLVED/);
  assert.throws(() => validatePrivateMetadata({ ...state, bootstrapComplete:false }), /BOOTSTRAP_INCOMPLETE/);
  assert.throws(() => validatePrivateMetadata({ ...state, walletVersion:'2.5.0' }));
});
test('public evidence projection excludes arbitrary private metadata', () => {
  const result = publicStepEvidence({ status:'passed', backupBytes:400, sameAccountAndVault:true, walletPassword:'never output', seed:new Uint8Array(32), nested:{secret:1} });
  assert.deepEqual(result, { status:'passed', sameAccountAndVault:true, backupBytes:400 });
  assert.throws(() => publicStepEvidence({status:'finalized',transactionIds:['not-a-tx']}));
  assert.throws(() => publicStepEvidence({status:'finalized',receipt:{status:'finalized',settlementVerified:false}}));
});
test('bootstrap resume permits only a saved transaction-free incomplete profile', () => {
  const state = { schema:'lace-ci-private-session-v1', network:'preview', walletVersion:'2.5.1', appUrl:APP_URL,
    walletPassword:'a'.repeat(32), appPassword:'b'.repeat(32), completedSteps:[], stepEvidence:{}, pendingAction:null, bootstrapComplete:false };
  assert.equal(validatePrivateMetadata(state, 'resume-bootstrap'), state);
  for (const patch of [{pendingAction:{step:'first-payment'}},{bootstrapComplete:true},{completedSteps:['generate-dust']},
    {stepEvidence:{'first-payment':{status:'finalized'}}},{walletVersion:'2.5.0'}])
    assert.throws(()=>validatePrivateMetadata({...state,...patch},'resume-bootstrap'));
});
test('resume never replaces an existing or unauthenticated app session', () => {
  assert.equal(bootstrapStorageDecision({mode:'resume-bootstrap',openResult:'opened'}),'open');
  assert.equal(bootstrapStorageDecision({mode:'resume-bootstrap',openResult:'missing'}),'create');
  for (const openResult of ['wrong-password','failed','collision',undefined])
    assert.throws(()=>bootstrapStorageDecision({mode:'resume-bootstrap',openResult}));
  assert.throws(()=>bootstrapStorageDecision({mode:'resume-bootstrap',openResult:'missing',appSessionCreated:true}));
  assert.throws(()=>bootstrapStorageDecision({mode:'exercise',openResult:'missing'}));
});
test('UI failure diagnostics expose only fixed booleans, never raw error details', () => {
  const result = classifyUiFailure({ name:'TimeoutError', message:'Timeout 30000ms exceeded. secret-password: abc; overlay intercepts pointer events; element is not enabled; detached from DOM' });
  assert.deepEqual(result, {timeout:true,disabled:true,pointerIntercepted:true,detached:true,notVisible:false});
  assert.equal(JSON.stringify(result).includes('secret-password'),false);
  assert.deepEqual(classifyUiFailure({message:'unexpected private data'}), {timeout:false,disabled:false,pointerIntercepted:false,detached:false,notVisible:false});
});
test('control inventory allowlist comes only from bounded static public IDs', () => {
  const source = 'testID:"settings-tab-btn",testID:\'known-overlay\',testID:`static-modal`,testID:`dynamic-${secret}`,testID:computed,value:"private-password",text:"private words",testID:"settings-tab-btn"';
  assert.deepEqual(extractStaticControlIds(source), ['known-overlay','settings-tab-btn','static-modal']);
  assert.deepEqual(extractStaticControlIds('testID:"'+'a'.repeat(121)+'"'),[]);
  assert.deepEqual(extractStaticControlIds('testID:"not a control"'),[]);
});
test('public endpoint diagnostics redact credentials, query strings and unknown hosts or paths', () => {
  const valid={indexerUri:'https://blockfrost.lw.iog.io/midnight-preview/',indexerWsUri:'wss://blockfrost.lw.iog.io/midnight-preview/ws',substrateNodeUri:'https://rpc.preview.midnight.network'};
  const result=sanitizePreviewConfiguration(valid);
  assert.equal(result.matchesKnownPreviewEndpoints,true);
  assert.equal(result.substrateNodeUri,'https://rpc.preview.midnight.network/');
  for(const indexerUri of ['https://secret@blockfrost.lw.iog.io/midnight-preview/','https://blockfrost.lw.iog.io/midnight-preview/?token=secret',
    'https://blockfrost.lw.iog.io/private-secret','https://blockfrost.lw.iog.io.evil.example/midnight-preview/','http://127.0.0.1:1234/']) {
    const redacted=sanitizePreviewConfiguration({...valid,indexerUri});assert.equal(redacted.indexerUri,null);assert.equal(redacted.matchesKnownPreviewEndpoints,false);
    assert.equal(JSON.stringify(redacted).includes('secret'),false);
  }
});
test('traffic evidence contains only fixed Preview host names', () => {
  assert.equal(previewPublicHost('https://blockfrost.lw.iog.io/midnight-preview/?private=never-returned'),'blockfrost.lw.iog.io');
  assert.equal(previewPublicHost('wss://indexer.preview.midnight.network/api/v4/graphql/ws'),'indexer.preview.midnight.network');
  for(const url of ['https://unknown.example/','https://rpc.preview.midnight.network.evil.test/','not a URL','http://rpc.preview.midnight.network/'])assert.equal(previewPublicHost(url),null);
});
test('wallet sync diagnostic emits recognized states and bounded percentages only', () => {
  assert.deepEqual(parseSyncStatusLabel('Syncing (6%)'),{state:'syncing',percent:6});
  assert.deepEqual(parseSyncStatusLabel('Synced'),{state:'synced',percent:100});
  assert.deepEqual(parseSyncStatusLabel('Errortry again'),{state:'error',percent:null});
  for(const label of ['Syncing (101%)','secret wallet text','1234','Syncing (1.25%)'])assert.deepEqual(parseSyncStatusLabel(label),{state:'unrecognized',percent:null});
});
test('credential-bearing endpoint evidence exposes only known host and query presence',()=>{
  const raw={indexerUri:'https://midnight-preview.blockfrost.io/api/v0?project_id=never-output-this',
    indexerWsUri:'wss://midnight-preview.blockfrost.io/api/v0/ws?project_id=never-output-this',
    substrateNodeUri:'https://rpc.midnight-preview.blockfrost.io?project_id=never-output-this'};
  const projected=publicEndpointMetadata(raw);
  assert.deepEqual(projected.indexerUri,{knownHost:'midnight-preview.blockfrost.io',hasQuery:true});
  assert.equal(sanitizePreviewConfiguration(raw).indexerUri,null);
  assert.equal(JSON.stringify(projected).includes('never-output-this'),false);
  assert.deepEqual(publicEndpointMetadata({indexerUri:'https://private-host.invalid?secret=1'}).indexerUri,{knownHost:null,hasQuery:true});
  assert.equal(previewPublicHost('https://e.lw.iog.io/flags?private=excluded'),'e.lw.iog.io');
});
test('supported refresh is limited to known Lace views and no prior operation',()=>{
  assert.equal(isLaceViewUrl('chrome-extension://gafhhkghbfjjkeiendhlofajokpaflmk/expo/index.html'),true);
  for(const url of [APP_URL,'chrome-extension://other/expo/index.html','chrome-extension://gafhhkghbfjjkeiendhlofajokpaflmk/unknown.html'])assert.equal(isLaceViewUrl(url),false);
  const valid={pendingAction:null,completedSteps:[],operationCount:0,approvalCount:0,transactionCount:0};
  requireRefreshPreflight(valid);
  for(const patch of [{pendingAction:{step:'pay'}},{completedSteps:['generate-dust']},{operationCount:1},{approvalCount:1},{transactionCount:1}])
    assert.throws(()=>requireRefreshPreflight({...valid,...patch}),/REMOTE_CONFIG_REFRESH_REQUIRES_NO_OPERATIONS/);
});
