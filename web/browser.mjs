const $ = id => document.getElementById(id);
let vault = null;
let latestReceipt = null;
let sequence = 0;
const number = id => Number($(id).value);
const format = value => new Intl.NumberFormat('en').format(value);
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function event(title, description) {
  const item = document.createElement('li'); const heading = document.createElement('strong');
  const text = document.createElement('span'); const time = document.createElement('small');
  heading.textContent = title; text.textContent = description;
  time.textContent = `Simulation · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  item.append(heading, text, time); $('activity').prepend(item); $('activity-empty').hidden = true;
}
function show(screen) {
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== screen; });
  document.querySelectorAll('[data-screen]').forEach(button => {
    const active = button.dataset.screen === screen; button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
}
function render() {
  $('balance').textContent = format(vault?.balance ?? 0); $('spent').textContent = format(vault?.spent ?? 0);
  $('remaining').textContent = format(vault ? Math.max(0, vault.allowance - vault.spent) : 0);
  $('vault-state').textContent = !vault ? 'Not created' : vault.revoked ? 'Agent revoked' : vault.paused ? 'Paused by owner' : vault.expiresAt <= Date.now() ? 'Policy expired' : vault.balance === 0 ? 'Empty' : 'Active';
  $('policy-ceiling').textContent = vault ? `${format(vault.ceiling)} DEMO` : '—';
  $('policy-expiry').textContent = vault ? new Date(vault.expiresAt).toLocaleTimeString() : '—';
  $('create').disabled = Boolean(vault); $('pay').disabled = !vault;
  $('pause').disabled = !vault || vault.revoked; $('revoke').disabled = !vault || vault.revoked;
  $('pause').textContent = vault?.paused ? 'Resume agent' : 'Pause agent';
  $('withdraw').disabled = !vault || vault.balance === 0;
  $('owner-returned').textContent = `Owner has recovered ${format(vault?.returned ?? 0)} DEMO.`;
  $('download').disabled = !latestReceipt;
}
document.querySelectorAll('[data-screen]').forEach(button => button.addEventListener('click', () => show(button.dataset.screen)));
$('setup-form').addEventListener('submit', eventObject => {
  eventObject.preventDefault(); if (vault) return;
  const fund = number('fund'), allowance = number('allowance'), ceiling = number('ceiling');
  if (![fund, allowance, ceiling].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000)) return status('Choose positive whole amounts up to 1,000,000 DEMO.', true);
  if (allowance > fund || ceiling > allowance) return status('Keep the allowance within the funded amount, and the payment ceiling within the allowance.', true);
  vault = { balance: fund, spent: 0, allowance, ceiling, paused: false, revoked: false, returned: 0, expiresAt: Date.now() + number('duration') * 1000 };
  event('Practice vault created', `${format(fund)} DEMO funded. Agent allowance ${format(allowance)}; ceiling ${format(ceiling)}.`);
  status('Practice vault ready. Request an agent payment to test your policy.'); render(); show('pay');
});
$('payment-form').addEventListener('submit', eventObject => {
  eventObject.preventDefault(); if (!vault) return status('Create a practice vault first.', true);
  const amount = number('amount');
  const reason = vault.revoked ? 'The owner revoked this agent.' : vault.paused ? 'The owner paused agent payments.'
    : Date.now() >= vault.expiresAt ? 'The policy has expired.' : $('recipient').value !== 'merchant' ? 'This recipient is not approved.'
    : !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000 ? 'Choose a valid positive whole amount.'
    : amount > vault.ceiling ? 'This amount exceeds the per-payment ceiling.' : amount > vault.allowance - vault.spent ? 'This amount exceeds the remaining allowance.'
    : amount > vault.balance ? 'The vault has insufficient remaining funds.' : null;
  if (reason) { event('Request rejected', `${reason} No simulated funds moved.`); status(`${reason} The vault balance is unchanged.`, true); render(); return; }
  vault.balance -= amount; vault.spent += amount;
  latestReceipt = { type: 'midnight-agent-wallet-simulation', simulated: true, network: null, proofGenerated: false, transactionSubmitted: false,
    receiptId: `DEMO-${String(++sequence).padStart(4, '0')}`, recipient: 'Demo Merchant', amount, unit: 'DEMO', remainingBalance: vault.balance, spent: vault.spent, createdAt: new Date().toISOString() };
  event('Simulated payment accepted', `${format(amount)} DEMO to Demo Merchant. ${format(vault.allowance - vault.spent)} remains in the allowance.`);
  status(`Simulation accepted ${format(amount)} DEMO. This is a practice receipt; no network transaction occurred.`); render();
});
$('pause').addEventListener('click', () => { if (!vault || vault.revoked) return; vault.paused = !vault.paused; event(vault.paused ? 'Agent paused' : 'Agent resumed', 'Owner action in this simulation.'); status(vault.paused ? 'Agent requests are paused. Try a payment to see the rejection.' : 'Agent requests are enabled within the remaining policy.'); render(); });
$('revoke').addEventListener('click', () => { if (!vault || vault.revoked) return; vault.revoked = true; event('Agent revoked', 'Owner recovery is still available.'); status('Agent permission revoked. You can still withdraw remaining funds.'); render(); });
$('withdraw').addEventListener('click', () => { if (!vault || !vault.balance) return; const amount = vault.balance; vault.returned += amount; vault.balance = 0; event('Owner withdrawal simulated', `${format(amount)} DEMO returned to the owner.`); status(`The owner recovered ${format(amount)} DEMO. The practice vault is empty.`); render(); });
$('reset').addEventListener('click', () => { vault = null; latestReceipt = null; sequence = 0; $('activity').replaceChildren(); $('activity-empty').hidden = false; status('Demo reset. Create a new practice vault to begin again.'); render(); show('setup'); });
$('download').addEventListener('click', () => { if (!latestReceipt) return; const url = URL.createObjectURL(new Blob([JSON.stringify(latestReceipt, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${latestReceipt.receiptId}-simulation.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
setInterval(render, 1000); render();
