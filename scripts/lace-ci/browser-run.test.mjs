import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_URL, validateEnvironment, parseArgs, atomicInteger, validatePrivateMetadata, publicStepEvidence, bootstrapStorageDecision, classifyUiFailure } from './browser-run.mjs';

const env = { CI:'true', GITHUB_ACTIONS:'true', RUNNER_OS:'Linux', GITHUB_REPOSITORY:'IBKR-BouncyBot/Midnight-Agent-AI-Wallet', GITHUB_RUN_ID:'123', RUNNER_TEMP:'/tmp/runner' };
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
