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

// ── First Strike Protocol (Section 47 Phase 0) ──
// Pre-flight simulation result — proves profit before committing capital.
// "The failure never existed."

export interface FirstStrikeSimulation {
  readonly id: string;
  readonly pair: string;
  readonly buyExchange: string;
  readonly sellExchange: string;
  readonly verdict: "GO" | "NO_GO";
  readonly reason: string;

  // Live order book snapshot
  readonly liveBuyPrice: number;       // Current best ask on buy exchange
  readonly liveSellPrice: number;      // Current best bid on sell exchange
  readonly liveSpreadBps: number;      // Spread from LIVE data (not cached ARB data)

  // Simulated execution
  readonly simulatedBuyCost: number;   // What we'd actually pay (with slippage)
  readonly simulatedSellReceived: number; // What we'd actually get (with slippage)
  readonly buySlippageBps: number;     // Slippage on buy side
  readonly sellSlippageBps: number;    // Slippage on sell side

  // Fee breakdown
  readonly tradingFeesUsd: number;     // Buy + sell exchange fees
  readonly networkFeeUsd: number;      // Estimated withdrawal/transfer fee
  readonly totalCostsUsd: number;      // All costs combined

  // The verdict
  readonly expectedProfitUsd: number;  // Net after ALL costs
  readonly expectedProfitBps: number;  // Net profit as bps of clip
  readonly clipSizeUsd: number;

  // Timing
  readonly simulatedAt: string;
  readonly simulationDurationMs: number;
}

export interface FirstStrikeStats {
  readonly totalSimulations: number;
  readonly goCount: number;
  readonly noGoCount: number;
  readonly abortRate: string;            // "XX.X%"
  readonly avgExpectedProfitUsd: number; // Average of GO verdicts
  readonly totalSavedFromLoss: number;   // Count of NO_GO that would have lost money
  readonly reasons: Record<string, number>; // NO_GO reason breakdown
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
