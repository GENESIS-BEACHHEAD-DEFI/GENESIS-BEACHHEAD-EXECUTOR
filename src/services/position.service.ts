/**
 * GENESIS-BEACHHEAD-EXECUTOR — Position Service
 * Tracks Beachhead buy-transfer-sell executions and aggregate P&L.
 */

import type { PositionEntry, TransferState } from "../types";

const MAX_HISTORY = 500;

export class PositionService {
  private positions: PositionEntry[] = [];
  private totalPnl = 0;
  private totalCount = 0;
  private completeCount = 0;
  private failCount = 0;
  private stallCount = 0;

  record(transfer: TransferState): void {
    const entry: PositionEntry = {
      id: transfer.id,
      pair: transfer.pair,
      buyExchange: transfer.buyExchange,
      sellExchange: transfer.sellExchange,
      buyPrice: transfer.buyPrice,
      sellPrice: transfer.sellFillPrice ?? transfer.sellPrice,
      amount: transfer.costUsdt,
      realizedPnl: transfer.realizedPnl ?? 0,
      timestamp: new Date().toISOString(),
      status: transfer.status === "COMPLETE" ? "COMPLETE"
        : transfer.status === "STALLED" ? "STALLED"
        : transfer.status === "FAILED" ? "FAILED"
        : "DRY_RUN",
      durationMs: (transfer.completedAt ?? Date.now()) - transfer.startedAt,
    };

    this.positions.push(entry);
    if (this.positions.length > MAX_HISTORY) {
      this.positions.splice(0, this.positions.length - MAX_HISTORY);
    }

    this.totalPnl += entry.realizedPnl;
    this.totalCount++;

    if (transfer.status === "COMPLETE") this.completeCount++;
    else if (transfer.status === "STALLED") this.stallCount++;
    else this.failCount++;
  }

  getStats() {
    return {
      totalCount: this.totalCount,
      completeCount: this.completeCount,
      failCount: this.failCount,
      stallCount: this.stallCount,
      totalPnlGbp: Math.round(this.totalPnl * 100) / 100,
    };
  }

  getRecentPositions(limit = 20): PositionEntry[] {
    return this.positions.slice(-limit);
  }
}
