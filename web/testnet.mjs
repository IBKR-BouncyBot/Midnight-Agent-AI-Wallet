const $ = id => document.getElementById(id);
import { discoverWallets, connectPreview } from '../packages/browser-demo/lace.mjs';
import { BrowserSnapshotStore } from '../packages/browser-storage/index.mjs';
import { BrowserDemoService, createInitialState } from '../packages/browser-demo/service.mjs';
import { createBrowserProver } from '../packages/browser-prover/provider.mjs';
let service, store, connection, prover, wallets = [];
if (location.hash.includes('bridgeToken')) history.replaceState(null, '', location.pathname);
let connected = false, snapshot = null, commandPending = false, polling = false;
let connectionGeneration = 0;
let paymentId = null, latestReceipt = null, uncertainPayment = false;

const txIdValid = value => typeof value === 'string' && /^[0-9a-f]{66}$/.test(value);
const hashValid = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const pretty = value => integer(value) ? new Intl.NumberFormat('en').format(BigInt(value)) : 'Not observed';
const label = value => typeof value === 'string' ? value.replaceAll('-', ' ').replaceAll('_', ' ').slice(0, 100) : 'Unknown';
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function show(screen) {
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== screen; });
  document.querySelectorAll('[data-screen]').forEach(button => { const active = button.dataset.screen === screen;
    button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current'); });
}
document.querySelectorAll('[data-screen]').forEach(button => button.addEventListener('click', () => show(button.dataset.screen)));
async function api(path, body) {
  if (!service) throw new Error('CONNECT_FIRST');
  if (path === 'status') return await service.status();
  if (path.startsWith('payments/')) return service.getPayment(path.slice(9));
  const actions = { setup:()=>service.setup(), bootstrap:()=>service.bootstrap(), payments:()=>service.requestPayment(body), reconcile:()=>service.reconcile(),
    'owner/pause':()=>service.owner('pause',body), 'owner/revoke':()=>service.owner('revoke',body), 'owner/withdraw':()=>service.owner('withdraw',body) };
  if (!actions[path]) throw new Error('INVALID_ACTION');
  return service.startJob(path.replaceAll('/','-'),actions[path]);
}
const messages = {
  NO_WALLET:'No compatible Lace wallet was found. Open this page in the browser where Lace is installed and enable Midnight.',
  LACE_PROVER_MODE_UNCONFIRMED:'In Lace’s Midnight settings, select “Run in this app (WASM)”, then confirm that setting here.',
  LACE_EXTERNAL_PROVER_REJECTED:'Lace reports a separate proof server. Select “Run in this app (WASM)” in its Midnight settings and reconnect.',
  STORE_ALREADY_EXISTS:'A saved vault already exists for this Lace account. Choose “Unlock my saved session” instead.',
  STORE_NOT_FOUND:'No saved vault was found for this account. Create a new session or restore your encrypted backup.',
  SNAPSHOT_AUTHENTICATION_FAILED:'The password or encrypted backup could not be authenticated. Your existing state was not replaced.',
  STORE_IN_USE:'This vault is already open in another tab. Lock that session before opening it here.',
  STORED_IDENTITY_MISSING:'This saved session is incomplete. Restore a valid encrypted backup in a fresh browser profile.',
  CONTEXT_MISMATCH:'This backup belongs to a different Lace account or network. Connect its original Preview account.',
  INVALID_BACKUP:'Select a valid encrypted vault backup.',
  STRICT_DURABILITY_UNAVAILABLE:'This browser cannot durably save vault checkpoints. Use a current browser with durable IndexedDB support.',
  PASSWORD_LENGTH:'Use a vault password of at least 16 characters.',
  WEB_LOCKS_UNAVAILABLE:'This browser cannot safely coordinate vault storage. Use a browser with Web Locks support.',
  LACE_ACCOUNT_CHANGED:'The Lace account changed. Lock this session and reconnect with the original Preview account.',
  LACE_WRONG_NETWORK:'Select Preview in Lace and reconnect.',
  LACE_SESSION_CLOSED:'Lace disconnected. Lock this session and reconnect.',
  LACE_DISCONNECTED:'Lace disconnected. Lock this session and reconnect.',
};
function failure(error, afterAction=false) {
  const code=error?.code ?? error?.message;
  return messages[code] ?? (afterAction ? 'The action did not finish. Keep this session, check Lace and use reconciliation before retrying a payment.' : 'Could not open this vault. Check Lace’s Preview network, proving setting and storage password.');
}
function discover() {
  wallets=discoverWallets().filter(item=>item.rdns==='io.lace.wallet');
  $('wallet-select').replaceChildren(...(wallets.length?wallets.map((item,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=item.name;return option;}):[new Option('No Lace wallet found','')]));
  $('wallet-help').textContent=wallets.length?'Lace detected. Select Preview and enable “Run in this app (WASM)” in its Midnight settings.':'Open this page in the browser where Lace is installed, then refresh the wallet list.';
}
function verifiedReceipt(receipt) {
  const evidence = receipt?.settlementEvidence;
  return receipt?.status === 'finalized' && txIdValid(receipt.transactionId)
    && evidence?.network === 'preview' && evidence.transactionId === receipt.transactionId
    && hashValid(evidence.contractAddress) && evidence.contractAddress === snapshot?.vault?.address
    && hashValid(evidence.finalizedBlockHash) && evidence.recipientReceiptVerified === true
    && evidence.vaultChangeVerified === true;
}
function renderReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return;
  latestReceipt = receipt; paymentId = receipt.paymentId ?? paymentId;
  const verified = verifiedReceipt(receipt);
  if (verified || receipt.status === 'rejected') uncertainPayment = false;
  $('payment-stage').textContent = verified
    ? 'Payment finalized on Preview. The app verified the merchant receipt and qualified the vault change.'
    : receipt.status === 'finalized' ? 'The app returned a final status, but the full receipt evidence is missing. Do not treat this display as verified settlement.'
    : receipt.status === 'rejected' ? 'Payment rejected. Inspect the app record before making a new request.'
    : `Payment ${label(receipt.status)}. Settlement has not been confirmed. Use “Check pending payment” to observe the existing request.`;
  // Display a bounded public receipt projection, never arbitrary backend state.
  const publicReceipt = { paymentId: typeof receipt.paymentId === 'string' ? receipt.paymentId : undefined,
    status: label(receipt.status), transactionId: txIdValid(receipt.transactionId) ? receipt.transactionId : undefined,
    settlementVerified: verified,
    ...(verified ? { network: 'preview', contractAddress: receipt.settlementEvidence.contractAddress, finalizedBlockHash: receipt.settlementEvidence.finalizedBlockHash,
      recipientReceiptVerified: true, vaultChangeVerified: true } : {}) };
  latestReceipt = publicReceipt;
  $('receipt').textContent = JSON.stringify(publicReceipt, null, 2); $('receipt-panel').hidden = false;
}
function activityItem(item) {
  const element = document.createElement('li'); const heading = document.createElement('strong');
  heading.textContent = `${label(item.action)} · ${label(item.status)}`; element.append(heading);
  if (txIdValid(item.transactionId)) { const transaction = document.createElement('code'); transaction.textContent = item.transactionId; element.append(transaction); }
  if (Number.isSafeInteger(item.blockHeight)) { const block = document.createElement('small'); block.textContent = `Indexed block ${item.blockHeight}`; element.append(block); }
  return element;
}
function renderWalletSync(_prefix, wallet) {
  const progress=wallet?.syncProgress?.shielded;
  const known=integer(progress?.applied)&&integer(progress?.target);
  const ratio=known&&BigInt(progress.target)>0n?Math.min(100,Number(BigInt(progress.applied)*1000n/BigInt(progress.target))/10):null;
  const bar=$('merchant-sync-bar');
  if(ratio===null)bar.removeAttribute('value');else bar.value=ratio;
  $('merchant-sync-summary').textContent=wallet?.synced?'Merchant observer is up to date':ratio===null?'Waiting for private history':`${ratio.toFixed(1)}% of recipient history processed`;
  $('merchant-sync-shielded').textContent=known?`${pretty(progress.applied)} / ${pretty(progress.target)} events`:'The first synchronization can take several minutes.';
}
function render() {
  const busy = commandPending || Boolean(snapshot?.activeJob && !['complete','done','completed','succeeded','failed'].includes(snapshot.activeJob.status));
  const caps = snapshot?.capabilities ?? {};
  $('connection-label').textContent = connected ? 'Connected on this device' : 'Not connected';
  $('phase-label').textContent = connected ? label(snapshot?.phase) : 'Awaiting connection';
  $('connect').disabled = commandPending || connected; $('disconnect').disabled = !connected || busy; $('backup').disabled=!connected || busy;
  $('refresh').disabled = !connected || commandPending;
  $('setup').disabled = !connected || busy || caps.canSetup !== true;
  $('bootstrap').disabled = !connected || busy || caps.canBootstrap !== true;
  $('pay').disabled = !connected || busy || uncertainPayment || caps.canPay !== true;
  $('reconcile').disabled = !connected || busy || !(uncertainPayment || caps.canReconcile === true);
  $('owner-pause').disabled = !connected || busy || uncertainPayment || caps.canPause !== true;
  $('owner-revoke').disabled = !connected || busy || uncertainPayment || caps.canRevoke !== true;
  $('owner-withdraw').disabled = !connected || busy || uncertainPayment || caps.canWithdraw !== true;
  $('owner-pause').textContent = snapshot?.policy?.paused ? 'Resume agent' : 'Pause agent';
  const funding = snapshot?.funding;
  $('wallet-sync').hidden = !connected || !(funding?.syncProgress || snapshot?.merchant?.syncProgress);
  renderWalletSync('merchant', snapshot?.merchant);
  $('funding-panel').hidden = !connected || typeof funding?.address !== 'string';
  $('funding-address').value = connected && typeof funding?.address === 'string' ? funding.address : '';
  $('dust').textContent = pretty(funding?.dustAtomic);
  $('prover-mode').textContent = connection?.status().modeAssurance==='user-confirmed'?'WASM · confirmed by you':'Not confirmed';
  $('vault-address').textContent = connected && typeof snapshot?.vault?.address === 'string' ? snapshot.vault.address : 'Not deployed';
  const policy = snapshot?.policy;
  $('vault-balance').textContent = pretty(policy?.balanceAtomic); $('vault-spent').textContent = pretty(policy?.spentAtomic);
  $('vault-remaining').textContent = integer(policy?.allowanceAtomic) && integer(policy?.spentAtomic)
    ? pretty((BigInt(policy.allowanceAtomic) > BigInt(policy.spentAtomic) ? BigInt(policy.allowanceAtomic) - BigInt(policy.spentAtomic) : 0n).toString()) : 'Not observed';
  $('policy-note').textContent = policy ? `Per-payment ceiling: ${pretty(policy.perPaymentAtomic)} atomic units. ${policy.revoked ? 'Agent revoked.' : policy.paused ? 'Agent paused.' : 'The app checks the remaining allowance before proving.'}` : 'The app will verify the configured payment ceiling and remaining allowance.';
  $('owner-note').textContent = !snapshot?.vault ? 'Deploy and fund a vault before using owner controls.' : uncertainPayment || caps.canReconcile ? 'Reconcile the pending outcome before changing owner policy or withdrawing.' : 'Owner controls are enabled only when the app has confirmed the vault state.';
  const records = connected && Array.isArray(snapshot?.activity) ? snapshot.activity.slice(-60).reverse() : [];
  $('activity').replaceChildren(...records.slice(0, 8).map(activityItem)); $('full-activity').replaceChildren(...records.map(activityItem));
  $('activity-empty').hidden = records.length > 0;
  $('activity-explanation').textContent = records.length ? `${records.length} operation records. Submission and finality remain distinct stages.` : 'No operation records are available yet.';
  if (snapshot?.activeJob?.status === 'running' && snapshot.activeJob.stage === 'syncing-wallets') status('Synchronizing the independent recipient. Keep this page open; the first sync can take several minutes.');
  else if (snapshot?.activeJob?.status === 'running') status(`The app is ${label(snapshot.activeJob.stage || snapshot.activeJob.action)}. Wait for its recorded result before continuing.`);
  else if (!commandPending && snapshot?.activeJob?.status === 'failed') status(`The app could not complete ${label(snapshot.activeJob.action)}. Check Lace, funding and any pending recovery before retrying.`, true);
  else if (!commandPending && snapshot?.activeJob?.status === 'complete') status(`${label(snapshot.activeJob.action)} completed. Inspect its recorded result in Activity; only a verified payment receipt establishes settlement.`);
}
async function refresh() {
  if (!connected || polling) return;
  const generation = connectionGeneration;
  polling = true;
  try {
    const next = await api('status');
    if (generation !== connectionGeneration || !connected) return;
    if (next?.network !== 'preview') throw new Error('NETWORK_MISMATCH');
    snapshot = next;
    if (next.latestPayment) renderReceipt(next.latestPayment);
    else if (paymentId) {
      const receipt = await api(`payments/${encodeURIComponent(paymentId)}`);
      if (generation !== connectionGeneration || !connected) return;
      renderReceipt(receipt);
    }
    render();
  } catch (error) { if (generation === connectionGeneration && connected) {
    const code=error?.code ?? error?.message;
    if (['LACE_ACCOUNT_CHANGED','LACE_WRONG_NETWORK','LACE_SESSION_CLOSED','LACE_DISCONNECTED','LACE_EXTERNAL_PROVER_REJECTED'].includes(code)) void lockSession(failure(error));
    else status(failure(error), true);
  } }
  finally { polling = false; }
}
async function lockSession(message='Session locked. Reconnect and unlock it to continue.') {
  connectionGeneration++; connected=false; commandPending=true; snapshot=null;
  connection?.close(); prover?.close(); render(); status(message); show('connect');
  try { await service?.close(); } catch {} finally {
    try { await store?.close(); } catch {}
    service=store=prover=connection=null; paymentId=null; latestReceipt=null; uncertainPayment=false; commandPending=false;
    $('receipt-panel').hidden=true; render();
  }
}
async function connect() {
  if(connected||commandPending)return;
  const generation=++connectionGeneration;
  commandPending=true;render();
  try {
    if(!isSecureContext||!crypto.subtle||!navigator.locks||!indexedDB||typeof Worker!=='function')throw new Error('WEB_LOCKS_UNAVAILABLE');
    const selected=wallets[Number($('wallet-select').value)];
    if(!selected)throw new Error('NO_WALLET');
    if(!$('in-process').checked)throw new Error('LACE_PROVER_MODE_UNCONFIRMED');
    status('Approve the Preview connection in Lace.');
    connection=await connectPreview({wallet:selected.wallet,onStage:stage=>status(label(stage))});
    await connection.confirmInProcess({confirmedByUser:true});
    const identityId=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('preview:'+connection.context.accountId)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    const password=$('storage-password').value; $('storage-password').value='';
    const options={name:'midnight-agent-preview-'+identityId,password,context:{network:'preview',identityId}};
    const mode=$('storage-mode').value;
    if(mode==='restore') { const file=$('backup-input').files[0];if(!file||file.size>64*1024*1024)throw new Error('INVALID_BACKUP');store=await BrowserSnapshotStore.restore({...options,backup:new Uint8Array(await file.arrayBuffer())}); }
    else if(mode==='open')store=await BrowserSnapshotStore.open(options);
    else store=await BrowserSnapshotStore.create({...options,initialState:createInitialState({accountId:connection.context.accountId})});
    const buildResponse=await fetch('./browser-build.json',{credentials:'omit',redirect:'error'});if(!buildResponse.ok)throw new Error('BROWSER_BUILD_UNAVAILABLE');
    const build=await buildResponse.json();const hashes=Object.fromEntries(Object.entries(build.hashes).map(([path,hash])=>[new URL('./'+path,location.href).href,hash]));
    prover=createBrowserProver({workerUrl:'./proof-worker.mjs',contracts:{'private-vault':'./browser-contracts/private-vault/','test-token':'./browser-contracts/test-token/'},builtinBase:'./browser-builtins/',hashes,onStage:stage=>status(label(stage))});
    service=await BrowserDemoService.create({connection,store,prover,assetBase:new URL('./browser-contracts/',location.href).href,assetHashes:hashes});
    if(generation!==connectionGeneration)throw new Error('SESSION_CHANGED');
    connected=true;snapshot=await service.status();status('Lace connected. Your vault state is encrypted in this browser. Save an encrypted backup before funding.');show('vault');
  } catch(error) {try {await service?.close();}catch{} finally {try{await store?.close();}catch{} prover?.close();connection?.close();service=store=connection=prover=null;connected=false;snapshot=null;status(failure(error),true);}}
  finally {commandPending=false;render();}
}
async function command(path, body = {}) {
  if (!connected || commandPending) return;
  const generation = connectionGeneration;
  commandPending = true; render(); status('Preparing the action. Approve any transaction request in Lace.');
  try {
    const result = await api(path, body);
    if (generation !== connectionGeneration || !connected) return;
    if (typeof result?.paymentId === 'string') paymentId = result.paymentId;
    if (result?.payment) renderReceipt(result.payment);
    if (result?.receipt) renderReceipt(result.receipt);
    status('Action started. Keep this page open until its outcome is recorded.');
  } catch (error) { if (generation === connectionGeneration && connected) status(failure(error, true), true); }
  finally { if (generation === connectionGeneration) { commandPending = false; await refresh(); render(); } }
}
$('connect-form').addEventListener('submit', eventObject => { eventObject.preventDefault(); void connect(); });
$('disconnect').addEventListener('click',()=>{if(snapshot?.activeJob?.status!=='running')void lockSession();});
$('find-wallets').addEventListener('click',discover);
$('backup').addEventListener('click',async()=>{try{const bytes=await store.exportBackup();download(bytes,'agent-wallet-preview.midnight-backup','application/octet-stream');status('Encrypted backup saved. Keep its password separately.');}catch{status('The backup could not be saved. Keep this session open.',true);}});
$('refresh').addEventListener('click',()=>{void refresh();});
document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>{void command(button.dataset.command);}));
function download(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('payment-form').addEventListener('submit', eventObject => {
  eventObject.preventDefault(); if ($('pay').disabled) return;
  const amount = $('payment-amount').value.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(amount) || BigInt(amount) > (1n << 64n) - 1n) return status('Enter a positive whole atomic amount within the supported limit.', true);
  uncertainPayment = true; render();
  void command('payments', { amount, idempotencyKey: `web_${crypto.randomUUID().replaceAll('-', '')}` });
});
$('reconcile').addEventListener('click', () => { void command('reconcile'); });
$('owner-pause').addEventListener('click', () => { void command('owner/pause', { paused: !snapshot?.policy?.paused }); });
$('owner-revoke').addEventListener('click', () => { void command('owner/revoke'); });
$('owner-withdraw').addEventListener('click', () => { void command('owner/withdraw'); });
$('copy-address').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('funding-address').value); status('Preview funding address copied. Use disposable test assets only.'); } catch { status('Select and copy the funding address manually.'); } });
$('download-receipt').addEventListener('click', () => { if (!latestReceipt) return; const url = URL.createObjectURL(new Blob([JSON.stringify(latestReceipt, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'preview-payment-receipt.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
setInterval(() => { void refresh(); }, 3000); discover(); render();
window.addEventListener('midnight#ready',discover);
