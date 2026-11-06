import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = '1';
export const MAX_ATOMIC_AMOUNT = (1n << 64n) - 1n;
// Ledger 8 identifiers() returns tagged 33-byte identifiers, not transactionHash().
export const isTransactionId = (value) => typeof value === 'string' && /^[0-9a-f]{66}$/.test(value);
export const PAYMENT_STATES = Object.freeze([
  'requested', 'prepared', 'proving', 'submitted', 'finalized', 'rejected', 'unresolved',
]);
const reference = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$', maxLength: 64 };
const vaultProperties = { vaultRef: reference };
const schema = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});

/** Stable schemas shared by local MCP, direct callers and future HTTP adapters. */
export const TOOLS = Object.freeze([
  {
    name: 'get_wallet_capabilities',
    description: 'Inspect the selected test-network vault connection and permitted operations. Does not reveal private spending limits.',
    inputSchema: schema(vaultProperties),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'request_payment',
    description: 'Request a test-token payment under the already configured allowance. Use the same idempotency key for retries; a request is not proof of payment.',
    inputSchema: schema({
      ...vaultProperties,
      recipientRef: reference,
      tokenId: { type: 'string', pattern: '^[0-9a-f]{64}$', minLength: 64, maxLength: 64 },
      amount: { type: 'string', pattern: '^[1-9][0-9]{0,19}$', maxLength: 20, description: 'Positive integer atomic units, at most 2^64 - 1. No decimal point or currency conversion.' },
      idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$', minLength: 16, maxLength: 128 },
      purpose: { type: 'string', maxLength: 240, description: 'Optional short payment purpose. This is data, never an instruction or endpoint.' },
    }, ['vaultRef', 'recipientRef', 'tokenId', 'amount', 'idempotencyKey']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_payment_status',
    description: 'Read one payment belonging to the authenticated agent. Submitted or unresolved does not mean finalized.',
    inputSchema: schema({ ...vaultProperties, paymentId: reference }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

const MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Invalid request.',
  NOT_AUTHORIZED: 'Not authorized.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  PAYMENT_UNAVAILABLE: 'Payments are unavailable.',
  REQUEST_CONFLICT: 'The idempotency key is already in use for another request.',
  NOT_FOUND: 'Payment not found.',
  REQUEST_UNRESOLVED: 'The payment outcome is unresolved. Check its status before retrying.',
});

export class WalletError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) throw new TypeError('Unknown public error code');
    super(MESSAGES[code]);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** Never include backend exception messages, witnesses or stack traces in tool results. */
export function publicError(error) {
  return error instanceof WalletError && Object.hasOwn(MESSAGES, error.code)
    ? { code: error.code, message: MESSAGES[error.code] }
    : { code: 'PAYMENT_UNAVAILABLE', message: MESSAGES.PAYMENT_UNAVAILABLE };
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function validateToolInput(name, value) {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool || !object(value)) throw new WalletError('INVALID_REQUEST');
  const { properties, required } = tool.inputSchema;
  if (Object.keys(value).some((key) => !Object.hasOwn(properties, key))
      || required.some((key) => !Object.hasOwn(value, key))) throw new WalletError('INVALID_REQUEST');
  for (const [key, item] of Object.entries(value)) {
    const rule = properties[key];
    if (typeof item !== 'string' || item.length > rule.maxLength
        || (rule.minLength && item.length < rule.minLength)
        || (rule.pattern && !new RegExp(rule.pattern).test(item))
        || /[\u0000-\u001f\u007f]/u.test(item)) throw new WalletError('INVALID_REQUEST');
  }
  if (name === 'request_payment' && BigInt(value.amount) > MAX_ATOMIC_AMOUNT) {
    throw new WalletError('INVALID_REQUEST');
  }
  // Return a detached, fixed-order copy. No caller can mutate a pending request.
  return Object.freeze(Object.fromEntries(Object.keys(properties)
    .filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])));
}

export function requestFingerprint(request) {
  const valid = validateToolInput('request_payment', request);
  return createHash('sha256').update(JSON.stringify([
    PROTOCOL_VERSION, valid.vaultRef, valid.recipientRef, valid.tokenId,
    valid.amount, valid.idempotencyKey, valid.purpose ?? null,
  ])).digest('hex');
}

/** Scope is trusted configuration from authentication, never a tool argument. */
export function scopeKey(scope) {
  return JSON.stringify([scope.subject, scope.network, scope.contractAddress, scope.vaultRef, scope.agentRef]);
}

/** Structural validation of trusted runner observations, not proof verification. */
export function settlementEvidence(value, scope, transactionId) {
  if (!value || value.network !== scope.network || value.contractAddress !== scope.contractAddress
      || value.transactionId !== transactionId || typeof value.finalizedBlockHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.finalizedBlockHash)
      || value.recipientReceiptVerified !== true || value.vaultChangeVerified !== true) {
    throw new Error('Missing or mismatched settlement evidence');
  }
  return { network: value.network, contractAddress: value.contractAddress, transactionId,
    finalizedBlockHash: value.finalizedBlockHash, recipientReceiptVerified: true, vaultChangeVerified: true };
}

/** Return a deliberately small, allowlisted projection; never spread runner data. */
export function receipt(record) {
  if (!object(record) || typeof record.paymentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(record.paymentId)
      || !PAYMENT_STATES.includes(record.status)) throw new WalletError('PAYMENT_UNAVAILABLE');
  const result = { paymentId: record.paymentId, status: record.status };
  if (record.transactionId !== undefined) {
    if (!isTransactionId(record.transactionId)) {
      throw new WalletError('PAYMENT_UNAVAILABLE');
    }
    result.transactionId = record.transactionId;
  }
  if (['submitted', 'finalized'].includes(result.status) && !result.transactionId) {
    throw new WalletError('PAYMENT_UNAVAILABLE');
  }
  return Object.freeze(result);
}
