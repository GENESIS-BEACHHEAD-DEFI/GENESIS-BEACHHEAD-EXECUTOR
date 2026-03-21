/**
 * GENESIS-BEACHHEAD-EXECUTOR — Transfer Manager Service
 * State machine for buy→transfer→sell pipeline.
 *
 * States: BUYING → BOUGHT → WITHDRAWING → TRANSFERRING → ARRIVED → SELLING → COMPLETE
 * Failure at any step → FAILED (capital not lost, just stuck on one exchange)
 * Timeout after 30 min → STALLED (manual review)
 *
 * Guards:
 * - Max 1 in-flight transfer per exchange (protects $40 balance)
 * - No double-buy on same token if transfer already in-flight
 * - Dynamic profitability gate: spread must cover network fee + trading fees for THIS clip size
 */

import type { BeachheadRequest, TransferState } from "../types";
import { BeachheadClientService } from "./beachhead-client.service";
import { NetworkSelectorService } from "./network-selector.service";
import { PositionService } from "./position.service";

const TRANSFER_TIMEOUT_MS = parseInt(process.env.TRANSFER_TIMEOUT_MS || "1800000", 10);   // 30 min
const DEPOSIT_POLL_INTERVAL_MS = parseInt(process.env.DEPOSIT_POLL_INTERVAL_MS || "15000", 10); // 15s
const MAX_INFLIGHT_PER_EXCHANGE = parseInt(process.env.MAX_INFLIGHT_PER_EXCHANGE || "1", 10);

export class TransferManagerService {
  private transfers: Map<string, TransferState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private client: BeachheadClientService,
    private netSelector: NetworkSelectorService,
    private positions: PositionService,
  ) {}

  /**
   * Start the deposit polling loop.
   */
  startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollTransfers(), DEPOSIT_POLL_INTERVAL_MS);
    console.log(`[TRANSFER] Polling started — interval=${DEPOSIT_POLL_INTERVAL_MS}ms timeout=${TRANSFER_TIMEOUT_MS}ms`);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Check if we can accept a new trade for this request.
   */
  canAccept(request: BeachheadRequest): { ok: boolean; reason?: string } {
    const buyEx = request.buyExchange.toLowerCase();
    const sellEx = request.sellExchange.toLowerCase();

    if (!this.client.isExchangeConfigured(buyEx)) {
      return { ok: false, reason: `${request.buyExchange} not configured` };
    }
    if (!this.client.isExchangeConfigured(sellEx)) {
      return { ok: false, reason: `${request.sellExchange} not configured` };
    }

    const token = this.client.extractBaseToken(request.pair);

    // Check no in-flight transfer for same token
    for (const t of this.transfers.values()) {
      if (this.isInFlight(t) && t.token === token) {
        return { ok: false, reason: `${token} already in-flight (id=${t.id})` };
      }
    }

    // Check max in-flight per exchange (buy side — that's where we spend USDT)
    const buyInflight = this.countInflight(buyEx);
    if (buyInflight >= MAX_INFLIGHT_PER_EXCHANGE) {
      return { ok: false, reason: `${request.buyExchange} has ${buyInflight} in-flight (max ${MAX_INFLIGHT_PER_EXCHANGE})` };
    }

    return { ok: true };
  }

  /**
   * Execute the full buy→transfer→sell pipeline.
   */
  async execute(request: BeachheadRequest): Promise<TransferState> {
    const token = this.client.extractBaseToken(request.pair);
    const quoteToken = this.client.extractQuoteToken(request.pair);

    const state: TransferState = {
      id: request.id,
      status: "BUYING",
      pair: request.pair,
      token,
      quoteToken,
      buyExchange: request.buyExchange.toLowerCase(),
      sellExchange: request.sellExchange.toLowerCase(),
      buyPrice: request.buyPrice,
      sellPrice: request.sellPrice,
      quantity: 0,
      costUsdt: request.amount,
      startedAt: Date.now(),
    };

    this.transfers.set(request.id, state);
    console.log(`[TRANSFER] START id=${request.id} ${token} buy@${request.buyExchange} sell@${request.sellExchange} spread=${request.grossSpreadBps}bps`);

    // ── Step 1: BUY ──
    try {
      const buyResult = await this.client.marketBuy(
        state.buyExchange,
        request.pair,
        request.amount,
      );
      state.buyOrderId = buyResult.orderId;
      state.quantity = buyResult.quantity;
      state.buyPrice = buyResult.avgPrice;
      state.status = "BOUGHT";
      console.log(`[TRANSFER] BOUGHT id=${request.id} ${buyResult.quantity} ${token} @ ${buyResult.avgPrice}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown";
      state.status = "FAILED";
      state.error = `BUY_FAILED: ${msg}`;
      state.completedAt = Date.now();
      console.error(`[TRANSFER] BUY_FAILED id=${request.id} — ${msg}`);
      this.positions.record(state);
      return state;
    }

    // ── Step 2: Find network + profitability check + get deposit address ──
    try {
      const buyInstance = this.client.getInstance(state.buyExchange);
      const sellInstance = this.client.getInstance(state.sellExchange);
      if (!buyInstance || !sellInstance) throw new Error("Exchange instance missing");

      const netResult = await this.netSelector.getPreferredNetwork(token, buyInstance, sellInstance);
      if (!netResult) {
        state.status = "FAILED";
        state.error = "NO_CHEAP_NETWORK: no shared TRC20/SOL/BEP20 network found";
        state.completedAt = Date.now();
        console.error(`[TRANSFER] NO_NETWORK id=${request.id} ${token} — holding on ${state.buyExchange}`);
        this.positions.record(state);
        return state;
      }

      // ── Dynamic profitability gate ──
      // Now we know the EXACT network, calculate if this trade is still profitable
      const minBps = this.netSelector.calculateMinSpreadBps(request.amount, netResult.network);
      if (request.grossSpreadBps < minBps) {
        state.status = "FAILED";
        state.error = `UNPROFITABLE: ${request.grossSpreadBps.toFixed(0)}bps < ${minBps}bps min for ${netResult.network} @ $${request.amount} clip (fee=$${netResult.estimatedFeeUsd})`;
        state.completedAt = Date.now();
        console.log(
          `[TRANSFER] UNPROFITABLE id=${request.id} ${token} — ` +
          `spread=${request.grossSpreadBps.toFixed(0)}bps < min=${minBps}bps ` +
          `(net=${netResult.network}, fee=$${netResult.estimatedFeeUsd}, clip=$${request.amount})`,
        );
        this.positions.record(state);
        return state;
      }

      state.network = netResult.network;

      const deposit = await this.client.getDepositAddress(state.sellExchange, token, netResult.network);
      state.depositAddress = deposit.address;
      console.log(`[TRANSFER] DEPOSIT_ADDR id=${request.id} ${state.sellExchange} → ${deposit.address} (${netResult.network})`);

      // ── Step 3: WITHDRAW ──
      state.status = "WITHDRAWING";
      const withdrawal = await this.client.withdraw(
        state.buyExchange,
        token,
        state.quantity,
        deposit.address,
        netResult.network,
        deposit.tag,
      );
      state.withdrawalId = withdrawal.withdrawalId;
      state.withdrawalFee = withdrawal.fee;
      state.status = "TRANSFERRING";
      console.log(`[TRANSFER] TRANSFERRING id=${request.id} ${state.quantity} ${token} via ${netResult.network}`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown";
      state.status = "FAILED";
      state.error = `WITHDRAW_FAILED: ${msg}`;
      state.completedAt = Date.now();
      console.error(`[TRANSFER] WITHDRAW_FAILED id=${request.id} — ${msg} (tokens on ${state.buyExchange}, not lost)`);
      this.positions.record(state);
      return state;
    }

    // Transfer now in-flight — polling loop handles the rest
    return state;
  }

  /**
   * Background polling loop — checks TRANSFERRING states for deposit arrival.
   */
  private async pollTransfers(): Promise<void> {
    for (const [id, state] of this.transfers) {
      if (state.status !== "TRANSFERRING") continue;

      if (Date.now() - state.startedAt > TRANSFER_TIMEOUT_MS) {
        state.status = "STALLED";
        state.error = `TIMEOUT: ${TRANSFER_TIMEOUT_MS}ms elapsed — manual review needed`;
        state.completedAt = Date.now();
        console.error(`[TRANSFER] STALLED id=${id} ${state.token} — timeout after ${TRANSFER_TIMEOUT_MS}ms`);
        this.positions.record(state);
        continue;
      }

      try {
        const depositCheck = await this.client.checkDeposit(
          state.sellExchange,
          state.token,
          state.startedAt,
          state.quantity - (state.withdrawalFee || 0),
        );

        if (!depositCheck.arrived) continue;

        state.status = "ARRIVED";
        const sellQuantity = depositCheck.actualAmount ?? (state.quantity - (state.withdrawalFee || 0));
        console.log(`[TRANSFER] ARRIVED id=${id} ${sellQuantity} ${state.token} on ${state.sellExchange}`);

        state.status = "SELLING";
        try {
          const sellResult = await this.client.marketSell(
            state.sellExchange,
            state.pair,
            sellQuantity,
          );
          state.sellOrderId = sellResult.orderId;
          state.sellFillPrice = sellResult.avgPrice;

          const buyTotal = state.costUsdt;
          const sellTotal = sellResult.totalReceived;
          state.realizedPnl = Math.round((sellTotal - buyTotal) * 100) / 100;

          state.status = "COMPLETE";
          state.completedAt = Date.now();
          const durationSec = ((state.completedAt - state.startedAt) / 1000).toFixed(0);
          console.log(
            `[TRANSFER] COMPLETE id=${id} ${state.token} — ` +
            `bought $${buyTotal.toFixed(2)} sold $${sellTotal.toFixed(2)} ` +
            `pnl=$${state.realizedPnl.toFixed(2)} duration=${durationSec}s`,
          );
          this.positions.record(state);

        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown";
          state.status = "FAILED";
          state.error = `SELL_FAILED: ${msg} (tokens on ${state.sellExchange}, sell manually)`;
          state.completedAt = Date.now();
          console.error(`[TRANSFER] SELL_FAILED id=${id} — ${msg}`);
          this.positions.record(state);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown";
        console.log(`[TRANSFER] POLL_ERROR id=${id} — ${msg}`);
      }
    }
  }

  getAllTransfers(): TransferState[] {
    return Array.from(this.transfers.values());
  }

  getInflightTransfers(): TransferState[] {
    return Array.from(this.transfers.values()).filter((t) => this.isInFlight(t));
  }

  private isInFlight(t: TransferState): boolean {
    return ["BUYING", "BOUGHT", "WITHDRAWING", "TRANSFERRING", "ARRIVED", "SELLING"].includes(t.status);
  }

  private countInflight(exchange: string): number {
    let count = 0;
    for (const t of this.transfers.values()) {
      if (this.isInFlight(t) && (t.buyExchange === exchange || t.sellExchange === exchange)) {
        count++;
      }
    }
    return count;
  }
}
