/**
 * GENESIS-BEACHHEAD-EXECUTOR — Type Definitions
 * Buy-Transfer-Sell cross-exchange arbitrage executor.
 */

export interface BeachheadRequest {
  readonly id: string;
  readonly pair: string;
  readonly buyExchange: string;
  readonly sellExchange: string;
  readonly buyPrice: number;
  readonly sellPrice: number;
  readonly amount: number;
  readonly grossSpreadBps: number;
  readonly netSpreadBps: number;
}

export type TransferStatus =
  | "BUYING"
  | "BOUGHT"
  | "WITHDRAWING"
  | "TRANSFERRING"
  | "ARRIVED"
  | "SELLING"
  | "COMPLETE"
  | "FAILED"
  | "STALLED";

export interface TransferState {
  id: string;
  status: TransferStatus;
  pair: string;
  token: string;
  quoteToken: string;
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  quantity: number;
  costUsdt: number;
  buyOrderId?: string;
  withdrawalId?: string;
  depositAddress?: string;
  network?: string;
  withdrawalFee?: number;
  sellOrderId?: string;
  sellFillPrice?: number;
  realizedPnl?: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface PositionEntry {
  readonly id: string;
  readonly pair: string;
  readonly buyExchange: string;
  readonly sellExchange: string;
  readonly buyPrice: number;
  readonly sellPrice: number;
  readonly amount: number;
  readonly realizedPnl: number;
  readonly timestamp: string;
  readonly status: "COMPLETE" | "FAILED" | "STALLED" | "DRY_RUN";
  readonly durationMs: number;
}
