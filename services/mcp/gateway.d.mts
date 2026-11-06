import type { AgentScope, BackendReceipt, PaymentBackend, PaymentRequest, PaymentReceipt } from '../../packages/protocol/index.mjs';

export interface RequestRecord extends PaymentReceipt {
  scope: string; idempotencyKey: string; fingerprint: string; request: PaymentRequest;
}
export interface RequestJournal {
  reserve(scope: AgentScope, request: PaymentRequest, fingerprint: string): Promise<{ created: boolean; record: RequestRecord }>;
  get(scope: AgentScope, paymentId: string): Promise<RequestRecord | null>;
  update(scope: AgentScope, paymentId: string, patch: Omit<BackendReceipt, 'paymentId'>): Promise<RequestRecord>;
}
export interface GatewayOptions {
  authenticate(credential: unknown): Promise<AgentScope | null>;
  backend?: PaymentBackend;
  journal?: RequestJournal;
  now?: () => number;
  rateLimit?: number;
  rateWindowMs?: number;
}
export interface WalletCapabilities {
  protocolVersion: '1'; network: AgentScope['network']; vaultRef: string;
  paymentsAvailable: boolean; operations: string[];
}
export class UnconfiguredPaymentBackend implements PaymentBackend {
  readonly ready: false;
  requestPayment(...args: Parameters<PaymentBackend['requestPayment']>): Promise<never>;
  reconcilePayment(...args: Parameters<PaymentBackend['reconcilePayment']>): Promise<never>;
}
export class PaymentGateway {
  constructor(options: GatewayOptions);
  call(name: 'get_wallet_capabilities', input: { vaultRef: string }, credential: unknown): Promise<WalletCapabilities>;
  call(name: 'request_payment', input: PaymentRequest, credential: unknown): Promise<PaymentReceipt>;
  call(name: 'get_payment_status', input: { vaultRef: string; paymentId: string }, credential: unknown): Promise<PaymentReceipt>;
  call(name: string, input: unknown, credential: unknown): Promise<WalletCapabilities | PaymentReceipt>;
}
