export type Network = 'local' | 'preview' | 'preprod';
export type PaymentStatus = 'requested' | 'prepared' | 'proving' | 'submitted' | 'finalized' | 'rejected' | 'unresolved';
export interface PaymentRequest {
  vaultRef: string; recipientRef: string; tokenId: string; amount: string;
  idempotencyKey: string; purpose?: string;
}
export interface AgentScope {
  subject: string; network: Network; contractAddress: string; vaultRef: string; agentRef: string; expiresAt: number;
}
export interface PaymentReceipt { paymentId: string; status: PaymentStatus; transactionId?: string }
/** Trusted runner attestation, not a proof verified by the gateway. Never expose to the model by spreading backend data. */
export interface SettlementEvidence {
  network: Network; contractAddress: string; transactionId: string; finalizedBlockHash: string;
  recipientReceiptVerified: true; vaultChangeVerified: true;
}
export type BackendReceipt = PaymentReceipt & { settlementEvidence?: SettlementEvidence };
export interface PaymentBackend {
  readonly ready: boolean;
  /** Optional spending gate; ready may remain true to permit unresolved status reconciliation. */
  readonly canSubmit?: boolean;
  /** Submit only this request, after its journal reservation; never retry blindly. */
  requestPayment(input: { scope: AgentScope; request: PaymentRequest; fingerprint: string; paymentId: string }): Promise<BackendReceipt>;
  /** Read/reconcile only. Must not create a new payment or regenerate and resubmit. */
  reconcilePayment(input: { scope: AgentScope; request: PaymentRequest; fingerprint: string; paymentId: string; transactionId?: string }): Promise<BackendReceipt>;
}
export const PROTOCOL_VERSION: '1';
export const MAX_ATOMIC_AMOUNT: bigint;
export function isTransactionId(value: unknown): value is string;
export const PAYMENT_STATES: readonly PaymentStatus[];
export const TOOLS: readonly { name: string; description: string; inputSchema: object; annotations: object }[];
export class WalletError extends Error { constructor(code: string); code: string }
export function publicError(error: unknown): { code: string; message: string };
export function validateToolInput(name: 'request_payment', value: unknown): Readonly<PaymentRequest>;
export function validateToolInput(name: string, value: unknown): Readonly<Record<string, string>>;
export function requestFingerprint(request: PaymentRequest): string;
export function scopeKey(scope: AgentScope): string;
export function settlementEvidence(value: unknown, scope: AgentScope, transactionId: string): SettlementEvidence;
export function receipt(record: unknown): Readonly<PaymentReceipt>;
