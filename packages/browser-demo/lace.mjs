import { MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey,
  UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { Transaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { bech32m } from '@scure/base';
import { Buffer } from 'buffer';
import { assertBalancedTransaction } from './balance-binding.mjs';

const LACE_RDNS = 'io.lace.wallet';
const api4 = value => typeof value === 'string' && /^4\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
const safeText = (value, fallback) => typeof value === 'string' && value.length > 0 && value.length <= 100
  && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback;
class LaceConnectionError extends Error {
  constructor(code) { super(code); this.name = 'LaceConnectionError'; this.code = code; }
}
const fail = code => new LaceConnectionError(code);
const bytesToHex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const sameBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const MAX_TRANSACTION_BYTES = 12 * 1024 * 1024;

/** API4 discovery only. Render labels with textContent; wallet metadata is not identity authentication. */
export function discoverWallets(registry = globalThis.midnight) {
  if (!registry || typeof registry !== 'object') return [];
  const found = [];
  for (const id of Object.keys(registry).slice(0, 64)) {
    try {
      const wallet = registry[id];
      if (!wallet || typeof wallet.connect !== 'function' || !api4(wallet.apiVersion)) continue;
      found.push(Object.freeze({ id: safeText(id, `wallet-${found.length}`), name: safeText(wallet.name, 'Midnight wallet'),
        rdns: safeText(wallet.rdns, ''), apiVersion: wallet.apiVersion, wallet }));
    } catch { /* One broken injected provider must not hide other installed wallets. */ }
  }
  return found;
}

function decode(value, type) {
  if (typeof value !== 'string' || value.length > 256) throw fail('INVALID_WALLET_ADDRESS');
  try {
    // SDK3.1.2's parse uses Bech32's default90-character limit, shorter than a
    // shielded address. Use its same upstream codec with an explicit bound.
    const decoded = bech32m.decode(value, 256);
    if (decoded.prefix !== `mn_${type.codec.type}_preview`) throw fail('INVALID_WALLET_ADDRESS');
    const encoded = new MidnightBech32m(type.codec.type, 'preview', Buffer.from(bech32m.fromWords(decoded.words)));
    // Require a canonical checksum-valid Preview address, not just a string prefix.
    if (encoded.asString() !== value) throw fail('INVALID_WALLET_ADDRESS');
    return type.codec.decode('preview', encoded);
  } catch { throw fail('INVALID_WALLET_ADDRESS'); }
}

function publicAccount(shielded, unshielded) {
  const address = decode(shielded?.shieldedAddress, ShieldedAddress);
  const coin = decode(shielded?.shieldedCoinPublicKey, ShieldedCoinPublicKey);
  const encryption = decode(shielded?.shieldedEncryptionPublicKey, ShieldedEncryptionPublicKey);
  decode(unshielded?.unshieldedAddress, UnshieldedAddress);
  if (!address.coinPublicKey.equals(coin) || !address.encryptionPublicKey.equals(encryption)) throw fail('WALLET_ADDRESS_KEYS_MISMATCH');
  return Object.freeze({ networkId: 'preview', accountId: unshielded.unshieldedAddress,
    unshieldedAddress: unshielded.unshieldedAddress,
    shieldedAddress: shielded.shieldedAddress, coinPublicKey: shielded.shieldedCoinPublicKey,
    encryptionPublicKey: shielded.shieldedEncryptionPublicKey, coinPublicKeyHex: coin.toHexString(),
    encryptionPublicKeyHex: encryption.toHexString() });
}

function hasExternalProver(configuration) {
  // An empty string/null is not the actual in-process response and fails closed.
  return configuration.proverServerUri !== undefined;
}

function serialized(transaction, binding) {
  try {
    const bytes = transaction.serialize();
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_TRANSACTION_BYTES) throw fail('INVALID_TRANSACTION');
    const restored = Transaction.deserialize('signature', 'proof', binding, bytes);
    if (!sameBytes(bytes, restored.serialize())) throw fail('INVALID_TRANSACTION');
    // Ledger-native merge checks network equality; no undocumented binary offsets
    // or debug-string parsing. Both operands are detached proof-erased copies.
    restored.eraseProofs().merge(Transaction.fromParts('preview').eraseProofs());
    return { transaction: restored, bytes: Uint8Array.from(bytes) };
  } catch { throw fail('INVALID_TRANSACTION'); }
}

/** Exact signed bytes and ledger identifiers for a caller's durable checkpoint before submitTx. */
export function serializeFinalizedTransaction(transaction) {
  const { transaction: restored, bytes } = serialized(transaction, 'binding');
  const transactionIds = restored.identifiers();
  if (!transactionIds.length || !transactionIds.every(id => typeof id === 'string' && /^[0-9a-f]{66}$/.test(id))) throw fail('INVALID_TRANSACTION_IDS');
  return { signedBytes: bytes, transactionIds: [...transactionIds] };
}

/** Restore only the exact journaled signed transaction; never regenerate a payment after ambiguity. */
export function restoreFinalizedTransaction({ signedBytes, transactionIds } = {}) {
  try {
    if (!(signedBytes instanceof Uint8Array) || signedBytes.length > MAX_TRANSACTION_BYTES) throw fail('INVALID_TRANSACTION');
    const tx = Transaction.deserialize('signature', 'proof', 'binding', signedBytes);
    const saved = serializeFinalizedTransaction(tx);
    if (!sameBytes(saved.signedBytes, signedBytes) || !Array.isArray(transactionIds)
      || transactionIds.length !== saved.transactionIds.length || transactionIds.some((id, i) => id !== saved.transactionIds[i])) throw fail('INVALID_TRANSACTION_IDS');
    return tx;
  } catch { throw fail('INVALID_TRANSACTION'); }
}

/**
 * Lace API4 adapter, Preview only. Contract proofs stay in the page's WASM worker.
 * Lace retains wallet signing keys and proves its wallet/DUST portions itself.
 *
 * Lace2.5.0 omits proverServerUri for BOTH in-process and tee-delegated modes.
 * Source: input-output-hk/lace tag lace-extension@2.5.0,
 * packages/module/dapp-connector-midnight/src/store/dependencies/
 * midnight-dapp-connector-api.ts:415-444. The user-visible setting is
 * "On this device" / "Run in this app (WASM)", not the internal kind name.
 * Its standard API therefore cannot attest locality. confirmInProcess() MUST be
 * called only after the user confirms the actual Lace setting. Status honestly
 * reports user-confirmed, never verified. No proof request occurs on connection.
 * This adapter does not implement durable storage; checkpoint exact signed bytes
 * before submitTx and reconcile a thrown submission instead of retrying it.
 */
export async function connectPreview({ wallet, expectedAccount, onStage = () => {} } = {}) {
  if (!wallet || wallet.rdns !== LACE_RDNS || !api4(wallet.apiVersion) || typeof wallet.connect !== 'function'
    || typeof onStage !== 'function') throw fail('LACE_API4_REQUIRED');
  const stage = value => { try { onStage(value); } catch {} };
  let api;
  stage('lace-permission');
  try { api = await wallet.connect('preview'); } catch { throw fail('LACE_CONNECTION_FAILED'); }
  const methods = ['getConnectionStatus', 'getConfiguration', 'getShieldedAddresses', 'getUnshieldedAddress',
    'balanceUnsealedTransaction', 'submitTransaction', 'getShieldedBalances', 'getDustBalance'];
  if (!api || methods.some(name => typeof api[name] !== 'function')) throw fail('LACE_API4_REQUIRED');
  let closed = false, confirmed = false, busy = false, external = false, context;
  const submitted = new Set();
  async function readSession() {
    if (closed) throw fail('LACE_SESSION_CLOSED');
    try {
      const [connection, configuration, shielded, unshielded] = await Promise.all([
        api.getConnectionStatus(), api.getConfiguration(), api.getShieldedAddresses(), api.getUnshieldedAddress(),
      ]);
      if (closed) throw fail('LACE_SESSION_CLOSED');
      if (connection?.status !== 'connected') throw fail('LACE_DISCONNECTED');
      if (connection.networkId !== 'preview' || configuration?.networkId !== 'preview') throw fail('LACE_WRONG_NETWORK');
      const account = publicAccount(shielded, unshielded);
      if ((context && Object.keys(context).some(key => account[key] !== context[key]))
        || (expectedAccount !== undefined && account.accountId !== expectedAccount)) throw fail('LACE_ACCOUNT_CHANGED');
      external = hasExternalProver(configuration);
      if (external) confirmed = false;
      return account;
    } catch (error) {
      closed = true; confirmed = false;
      throw error instanceof LaceConnectionError ? error : fail('LACE_SESSION_CHECK_FAILED');
    }
  }
  context = await readSession();
  stage('lace-connected');
  const assertSession = async () => { await readSession(); return context; };
  const assertInProcess = async () => {
    await assertSession();
    if (external) throw fail('LACE_EXTERNAL_PROVER_REJECTED');
    if (!confirmed) throw fail('LACE_PROVER_MODE_UNCONFIRMED');
  };
  const status = () => Object.freeze({ connected: !closed, networkId: 'preview', accountId: context.accountId,
    modeAssurance: closed ? 'disconnected' : external ? 'external-rejected' : confirmed ? 'user-confirmed' : 'unconfirmed',
    proverModeApiVerified: false, canTransact: !closed && !external && confirmed && !busy });
  const exclusive = async operation => {
    if (busy) throw fail('LACE_OPERATION_IN_PROGRESS');
    busy = true;
    try { return await operation(); }
    catch (error) { throw error instanceof LaceConnectionError ? error : fail('LACE_OPERATION_FAILED'); }
    finally { busy = false; }
  };
  return Object.freeze({ context, status, assertSession, assertInProcess,
    async getShieldedBalance(tokenColor) {
      if (typeof tokenColor !== 'string' || !/^[0-9a-f]{64}$/.test(tokenColor)) throw fail('INVALID_TOKEN_COLOR');
      await assertSession();
      let balances;
      try { balances = await api.getShieldedBalances(); } catch { throw fail('LACE_BALANCE_QUERY_FAILED'); }
      await assertSession();
      if (!balances || typeof balances !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(balances))) throw fail('INVALID_LACE_BALANCE');
      const entry = Object.getOwnPropertyDescriptor(balances, tokenColor);
      if (entry && !Object.hasOwn(entry, 'value')) throw fail('INVALID_LACE_BALANCE');
      const value = entry === undefined ? 0n : entry.value;
      if (typeof value !== 'bigint' || value < 0n || value > (1n << 128n) - 1n) throw fail('INVALID_LACE_BALANCE');
      return value;
    },
    async getPublicStatus() {
      await assertSession();
      let dust;
      try { dust = await api.getDustBalance(); } catch { throw fail('LACE_BALANCE_QUERY_FAILED'); }
      await assertSession();
      if (![dust?.balance, dust?.cap].every(value => typeof value === 'bigint' && value >= 0n && value <= (1n << 128n) - 1n)) throw fail('INVALID_LACE_BALANCE');
      return Object.freeze({ ...status(), dustAtomic: dust.balance.toString(), dustCapAtomic: dust.cap.toString() });
    },
    async confirmInProcess({ confirmedByUser = false } = {}) {
      if (confirmedByUser !== true) throw fail('LACE_EXPLICIT_CONFIRMATION_REQUIRED');
      await assertSession();
      if (external) throw fail('LACE_EXTERNAL_PROVER_REJECTED');
      confirmed = true; return status();
    },
    walletProvider: Object.freeze({
      getCoinPublicKey: () => context.coinPublicKey,
      getEncryptionPublicKey: () => context.encryptionPublicKey,
      balanceTx: transaction => exclusive(async () => {
        await assertInProcess();
        const prepared = serialized(transaction, 'pre-binding');
        stage('lace-wallet-approval');
        let response;
        try { response = await api.balanceUnsealedTransaction(bytesToHex(prepared.bytes)); }
        catch { throw fail('LACE_BALANCE_FAILED'); }
        await assertInProcess();
        if (typeof response?.tx !== 'string' || response.tx.length > MAX_TRANSACTION_BYTES * 2
          || !/^(?:[0-9a-f]{2})+$/.test(response.tx)) throw fail('INVALID_LACE_TRANSACTION');
        const bytes = Uint8Array.from(response.tx.match(/../g), value => Number.parseInt(value, 16));
        let finalized;
        try {
          finalized = Transaction.deserialize('signature', 'proof', 'binding', bytes);
          serializeFinalizedTransaction(finalized);
          if (!sameBytes(bytes, finalized.serialize())) throw fail('INVALID_LACE_TRANSACTION');
        } catch { throw fail('INVALID_LACE_TRANSACTION'); }
        try { assertBalancedTransaction(prepared.transaction, finalized); }
        catch { throw fail('LACE_TRANSACTION_CHANGED'); }
        return finalized;
      }),
    }),
    midnightProvider: Object.freeze({
      submitTx: transaction => exclusive(async () => {
        await assertInProcess();
        const { signedBytes, transactionIds } = serializeFinalizedTransaction(transaction);
        if (transactionIds.some(id => submitted.has(id))) throw fail('LACE_SUBMISSION_ALREADY_ATTEMPTED');
        transactionIds.forEach(id => submitted.add(id));
        stage('lace-submitting');
        try { await api.submitTransaction(bytesToHex(signedBytes)); }
        catch { throw fail('LACE_SUBMISSION_UNCERTAIN'); }
        // A successful transport response is not a finalized receipt. The caller
        // must query the indexer and validate the actual contract outcome.
        await assertInProcess();
        return transactionIds[0];
      }),
    }),
    close() { closed = true; confirmed = false; },
  });
}
