import type { AgentScope, BackendReceipt, PaymentBackend, PaymentRequest, SettlementEvidence } from '../../packages/protocol/index.mjs';

export interface DeploymentContext { network: 'local' | 'preprod'; contractAddress: string; vaultId: string }
export interface RunnerInput { scope: AgentScope; request: PaymentRequest; fingerprint: string; paymentId: string }
export interface PendingPayment<C = unknown> extends RunnerInput {
  phase: 'requested' | 'prepared' | 'proving' | 'signed' | 'submitting' | 'submitted' | 'unresolved';
  candidate: C | null; unprovenBytes: Uint8Array | null; signedBytes: Uint8Array | null;
  signedDigest: string | null; transactionIds: string[]; transactionId: string | null;
}
export interface RunnerState<C = unknown> {
  version: 1; confirmed: C; pending: PendingPayment<C> | null;
  payments: Array<BackendReceipt & { scope: string; fingerprint: string; idempotencyKey: string }>;
}
export type ChainObservation<C> =
  | { outcome: 'unresolved' }
  | { outcome: 'finalized'; transactionId: string; confirmed: C; settlementEvidence: SettlementEvidence }
  | { outcome: 'rejected'; transactionId: string; finalizedBlockHash: string; noPaymentEffect: true };
export interface StagedPaymentAdapter<C = unknown> {
  /** No network submission is permitted in prepare or proveAndBalance. */
  prepare(input: RunnerInput & { confirmed: C; context: DeploymentContext }): Promise<{ candidate: C; unprovenBytes: Uint8Array }>;
  proveAndBalance(input: RunnerInput & { unprovenBytes: Uint8Array }): Promise<{ signedBytes: Uint8Array; transactionIds: string[] }>;
  /** Must submit these exact persisted bytes, with no additional balancing or proof regeneration. */
  submit(input: { signedBytes: Uint8Array; transactionIds: string[] }): Promise<string>;
  /** Read/reconcile only. Never submit from this method, including after a timeout. */
  observe(input: RunnerInput & { pending: PendingPayment<C>; confirmed: C; context: DeploymentContext }): Promise<ChainObservation<C>>;
  verifyConfirmed(input: { confirmed: C; context: DeploymentContext; settlementEvidence?: SettlementEvidence }): Promise<boolean>;
  /** Independently verify the only permitted candidate change: the final coin tree index. */
  verifyCoinQualification(input: { candidate: C; confirmed: C; transactionId: string; context: DeploymentContext; settlementEvidence: SettlementEvidence }): Promise<boolean>;
}
export interface RunnerPrivateStore<C = unknown> {
  readonly canSpend: boolean;
  readonly deploymentContext: Readonly<DeploymentContext>;
  snapshot(): RunnerState<C>;
  checkpoint(state: RunnerState<C>): Promise<void>;
  reconcile(verifier: (state: RunnerState<C>, context: DeploymentContext) => Promise<boolean>): Promise<void>;
}
export function createRunnerState<C>(confirmed: C): RunnerState<C>;
export class PaymentRunner<C = unknown> implements PaymentBackend {
  constructor(options: { store: RunnerPrivateStore<C>; adapter: StagedPaymentAdapter<C>; scope: AgentScope; vaultId: string; now?: () => number });
  readonly ready: true;
  readonly canSubmit: boolean;
  initialize(): Promise<{ canSpend: boolean; recoveryRequired: boolean }>;
  requestPayment(input: RunnerInput): Promise<BackendReceipt>;
  reconcilePayment(input: RunnerInput): Promise<BackendReceipt>;
}
