const $ = id => document.getElementById(id);
const BRIDGE = 'http://127.0.0.1:17641';
const fromLauncher = new URLSearchParams(location.hash.slice(1)).get('bridgeToken');
if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
let token = typeof fromLauncher === 'string' ? fromLauncher : '';
let connected = false, snapshot = null, commandPending = false, polling = false;
let connectionGeneration = 0;
let paymentId = null, latestReceipt = null, uncertainPayment = false;
const tokenValid = value => /^[A-Za-z0-9_-]{32,256}$/.test(value);
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
  if (!tokenValid(token)) throw new Error('PAIRING_REQUIRED');
  const response = await fetch(`${BRIDGE}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'PAIRING_REJECTED' : 'RUNNER_REJECTED');
  return response.json();
}
function failure(error, afterAction = false) {
  if (error?.message === 'PAIRING_REJECTED') return 'The runner rejected this pairing. Reopen its current launcher link and check that this page origin is allowed.';
  if (error?.message === 'PAIRING_REQUIRED') return 'Open the private launcher link or enter the temporary pairing token from your local runner.';
  return afterAction
    ? 'The runner response was not confirmed. The action may still be running. Refresh or reconcile before requesting anything again.'
    : 'Cannot read the local runner. Keep it running on port 17641, check browser local-network permissions, and reconnect. No network success is assumed.';
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
    ? 'Payment finalized on Preview. The runner verified the merchant receipt and qualified the vault change.'
    : receipt.status === 'finalized' ? 'The runner returned a final status, but the full receipt evidence is missing. Do not treat this display as verified settlement.'
    : receipt.status === 'rejected' ? 'Payment rejected. Inspect the runner record before making a new request.'
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
function renderWalletSync(prefix, wallet) {
  const progress = wallet?.syncProgress;
  const fractions = [];
  for (const stream of ['shielded', 'dust', 'unshielded']) {
    const current = progress?.[stream];
    const known = integer(current?.applied) && integer(current?.target);
    $(`${prefix}-sync-${stream}`).textContent = known
      ? `${pretty(current.applied)} / ${pretty(current.target)}${current.synced === true ? ' · up to date' : current.connected === false ? ' · reconnecting' : ''}`
      : current?.connected === true ? 'Connected · awaiting counters' : 'Waiting for connection';
    if (stream !== 'unshielded') {
      if (known && BigInt(current.target) > 0n) {
        const ratio = Number(BigInt(current.applied) * 1000n / BigInt(current.target)) / 10;
        fractions.push(Math.min(100, Math.max(0, ratio)));
      } else if (current?.synced === true) fractions.push(100);
    }
  }
  const bar = $(`${prefix}-sync-bar`);
  const percentage = fractions.length === 2 ? Math.min(...fractions) : null;
  if (percentage === null) bar.removeAttribute('value'); else bar.value = percentage;
  const summary = wallet?.synced === true ? 'Wallet is up to date'
    : percentage === null ? 'Waiting for private history'
    : percentage >= 100 ? 'History processed · waiting for live sync'
    : `${percentage.toFixed(1)}% of private history processed`;
  $(`${prefix}-sync-summary`).textContent = summary;
  bar.setAttribute('aria-valuetext', summary);
}
function render() {
  const busy = commandPending || Boolean(snapshot?.activeJob && !['complete','done','completed','succeeded','failed'].includes(snapshot.activeJob.status));
  const caps = snapshot?.capabilities ?? {};
  $('connection-label').textContent = connected ? 'Connected on this device' : 'Not connected';
  $('phase-label').textContent = connected ? label(snapshot?.phase) : 'Awaiting connection';
  $('connect').disabled = commandPending; $('disconnect').disabled = !connected;
  $('refresh').disabled = !connected || commandPending;
  $('setup').disabled = !connected || busy || caps.canSetup !== true;
  $('register').disabled = !connected || busy || caps.canRegisterDust !== true;
  $('bootstrap').disabled = !connected || busy || caps.canBootstrap !== true;
  $('pay').disabled = !connected || busy || uncertainPayment || caps.canPay !== true;
  $('reconcile').disabled = !connected || busy || !(uncertainPayment || caps.canReconcile === true);
  $('owner-pause').disabled = !connected || busy || uncertainPayment || caps.canPause !== true;
  $('owner-revoke').disabled = !connected || busy || uncertainPayment || caps.canRevoke !== true;
  $('owner-withdraw').disabled = !connected || busy || uncertainPayment || caps.canWithdraw !== true;
  $('owner-pause').textContent = snapshot?.policy?.paused ? 'Resume agent' : 'Pause agent';
  const funding = snapshot?.funding;
  $('wallet-sync').hidden = !connected || !(funding?.syncProgress || snapshot?.merchant?.syncProgress);
  renderWalletSync('owner', funding); renderWalletSync('merchant', snapshot?.merchant);
  $('funding-panel').hidden = !connected || typeof funding?.address !== 'string';
  $('funding-address').value = connected && typeof funding?.address === 'string' ? funding.address : '';
  $('night').textContent = pretty(funding?.nightAtomic); $('dust').textContent = pretty(funding?.dustAtomic);
  $('registered').textContent = funding?.registered === true ? 'Registered' : 'Not confirmed';
  $('vault-address').textContent = connected && typeof snapshot?.vault?.address === 'string' ? snapshot.vault.address : 'Not deployed';
  const policy = snapshot?.policy;
  $('vault-balance').textContent = pretty(policy?.balanceAtomic); $('vault-spent').textContent = pretty(policy?.spentAtomic);
  $('vault-remaining').textContent = integer(policy?.allowanceAtomic) && integer(policy?.spentAtomic)
    ? pretty((BigInt(policy.allowanceAtomic) > BigInt(policy.spentAtomic) ? BigInt(policy.allowanceAtomic) - BigInt(policy.spentAtomic) : 0n).toString()) : 'Not observed';
  $('policy-note').textContent = policy ? `Per-payment ceiling: ${pretty(policy.perPaymentAtomic)} atomic units. ${policy.revoked ? 'Agent revoked.' : policy.paused ? 'Agent paused.' : 'The runner checks the remaining allowance before proving.'}` : 'The runner will verify the configured payment ceiling and remaining allowance.';
  $('owner-note').textContent = !snapshot?.vault ? 'Deploy and fund a vault before using owner controls.' : uncertainPayment || caps.canReconcile ? 'Reconcile the pending outcome before changing owner policy or withdrawing.' : 'Owner controls are enabled only when the runner has confirmed the vault state.';
  const records = connected && Array.isArray(snapshot?.activity) ? snapshot.activity.slice(-60).reverse() : [];
  $('activity').replaceChildren(...records.slice(0, 8).map(activityItem)); $('full-activity').replaceChildren(...records.map(activityItem));
  $('activity-empty').hidden = records.length > 0;
  $('activity-explanation').textContent = records.length ? `${records.length} runner records. Submission and finality remain distinct stages.` : 'No operation records are available yet.';
  if (snapshot?.activeJob?.status === 'running' && snapshot.activeJob.stage === 'syncing-wallets') status('Synchronizing owner and recipient wallet history. The first sync can take several minutes; follow the processed-event counters below.');
  else if (snapshot?.activeJob?.status === 'running') status(`Runner is ${label(snapshot.activeJob.stage || snapshot.activeJob.action)}. Wait for its recorded result before continuing.`);
  else if (!commandPending && snapshot?.activeJob?.status === 'failed') status(`The runner could not complete ${label(snapshot.activeJob.action)}. Check funding, the local prover and any pending recovery before retrying.`, true);
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
  } catch (error) { if (generation === connectionGeneration && connected) status(failure(error), true); }
  finally { polling = false; }
}
async function connect() {
  const generation = ++connectionGeneration;
  token = $('pair-token').value.trim() || token;
  $('pair-token').value = '';
  if (!tokenValid(token)) { status(failure(new Error('PAIRING_REQUIRED')), true); return; }
  commandPending = true; render();
  try {
    const next = await api('status');
    if (generation !== connectionGeneration) return;
    if (next?.network !== 'preview') throw new Error('NETWORK_MISMATCH');
    snapshot = next; connected = true;
    if (next.latestPayment) renderReceipt(next.latestPayment);
    status('Local runner connected to Preview. No new transaction was requested. Continue to prepare your test vault.'); show('vault');
  } catch (error) { if (generation === connectionGeneration) { connected = false; snapshot = null; status(failure(error), true); } }
  finally { if (generation === connectionGeneration) { commandPending = false; render(); } }
}
async function command(path, body = {}) {
  if (!connected || commandPending) return;
  const generation = connectionGeneration;
  commandPending = true; render(); status('Request sent to the local runner. Waiting for its acknowledgement…');
  try {
    const result = await api(path, body);
    if (generation !== connectionGeneration || !connected) return;
    if (typeof result?.paymentId === 'string') paymentId = result.paymentId;
    if (result?.payment) renderReceipt(result.payment);
    if (result?.receipt) renderReceipt(result.receipt);
    status('Runner accepted the request. Its status will update here; acceptance is not settlement.');
  } catch (error) { if (generation === connectionGeneration && connected) status(failure(error, true), true); }
  finally { if (generation === connectionGeneration) { commandPending = false; await refresh(); render(); } }
}
$('connect-form').addEventListener('submit', eventObject => { eventObject.preventDefault(); void connect(); });
$('disconnect').addEventListener('click', () => { connectionGeneration++; token = ''; connected = false; commandPending = false; snapshot = null; paymentId = null; latestReceipt = null; $('receipt-panel').hidden = true; $('receipt').textContent = ''; $('pair-token').value = ''; status('This tab is disconnected. An operation already sent to the runner may still complete.'); render(); show('connect'); });
document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => { void command(button.dataset.command); }));
$('refresh').addEventListener('click', () => { void refresh(); });
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
setInterval(() => { void refresh(); }, 5000); render();
if (tokenValid(token)) void connect();
