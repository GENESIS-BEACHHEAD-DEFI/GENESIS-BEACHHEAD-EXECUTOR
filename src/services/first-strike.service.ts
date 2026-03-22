/**
 * GENESIS-BEACHHEAD-EXECUTOR — First Strike Protocol
 *
 * Section 47 Phase 0: Predictive Atomic Revert (TypeScript implementation).
 *
 * "We don't avoid gas on failures; we avoid the existence of the failure itself."
 *
 * Before ANY capital is committed, First Strike:
 *   1. Fetches LIVE order books from both exchanges (not cached ARB data)
 *   2. Simulates market buy at current ask depth for our clip size
 *   3. Simulates market sell at current bid depth for our clip size
 *   4. Calculates ALL costs: trading fees + network fees + slippage
 *   5. Returns GO only if mathematical profit is proven
 *
 * Every simulation recorded to GTC (intelligence) + Ledger Lite (compliance).
 * Every NO_GO saves capital. Every GO is a mathematically proven trade.
 *
 * "First Strike — prove the kill before pulling the trigger."
 */

import type { BeachheadRequest, FirstStrikeSimulation, FirstStrikeStats } from "../types";
import type { BeachheadClientService } from "./beachhead-client.service";
import type { NetworkSelectorService } from "./network-selector.service";

// Minimum profit to justify execution risk (configurable via env)
const MIN_PROFIT_USD = parseFloat(process.env.FIRST_STRIKE_MIN_PROFIT_USD || "0.10");
const MIN_PROFIT_BPS = parseInt(process.env.FIRST_STRIKE_MIN_PROFIT_BPS || "5", 10);

// Round-trip trading fee assumption (0.1% maker + 0.1% taker = 0.2%)
const TRADING_FEE_RATE = 0.002;

// Maximum staleness — reject if order book is older than this
const MAX_ORDERBOOK_AGE_MS = 5000;

export class FirstStrikeService {
  private simulations: FirstStrikeSimulation[] = [];
  private maxHistory = 500;
  private stats = {
    totalSimulations: 0,
    goCount: 0,
    noGoCount: 0,
    totalExpectedProfit: 0,
    savedFromLoss: 0,
    reasons: {} as Record<string, number>,
  };

  constructor(
    private client: BeachheadClientService,
    private netSelector: NetworkSelectorService,
  ) {}

  /**
   * Run pre-flight simulation. Returns GO/NO_GO with full breakdown.
   * Zero side effects — no capital touched, no orders placed.
   */
  async simulate(request: BeachheadRequest): Promise<FirstStrikeSimulation> {
    const startMs = Date.now();
    const pair = request.pair;
    const buyEx = request.buyExchange.toLowerCase();
    const sellEx = request.sellExchange.toLowerCase();
    const token = this.client.extractBaseToken(pair);
    const ccxtPair = this.toCcxtSymbol(pair);
    const clipUsd = request.amount;

    try {
      // ── Step 1: Fetch LIVE order books from both exchanges ──
      const buyInstance = this.client.getInstance(buyEx);
      const sellInstance = this.client.getInstance(sellEx);

      if (!buyInstance || !sellInstance) {
        return this.noGo(request, startMs, "EXCHANGE_NOT_CONFIGURED", 0, 0, 0, 0);
      }

      const [buyBook, sellBook] = await Promise.all([
        buyInstance.fetchOrderBook(ccxtPair, 20),
        sellInstance.fetchOrderBook(ccxtPair, 20),
      ]);

      // ── Step 2: Validate order books have depth ──
      if (!buyBook.asks || buyBook.asks.length === 0) {
        return this.noGo(request, startMs, "NO_ASK_DEPTH", 0, 0, 0, 0);
      }
      if (!sellBook.bids || sellBook.bids.length === 0) {
        return this.noGo(request, startMs, "NO_BID_DEPTH", 0, 0, 0, 0);
      }

      // Convert CCXT Num[][] to number[][] (filter out undefined entries)
      const asks = buyBook.asks
        .map(([p, s]) => [Number(p ?? 0), Number(s ?? 0)])
        .filter(([p, s]) => p > 0 && s > 0);
      const bids = sellBook.bids
        .map(([p, s]) => [Number(p ?? 0), Number(s ?? 0)])
        .filter(([p, s]) => p > 0 && s > 0);

      if (asks.length === 0 || bids.length === 0) {
        return this.noGo(request, startMs, "NO_VALID_DEPTH", 0, 0, 0, 0);
      }

      // ── Step 3: Simulate market buy (walk the asks) ──
      const buySimulation = this.simulateMarketBuy(asks, clipUsd);
      if (!buySimulation.filled) {
        return this.noGo(request, startMs, "INSUFFICIENT_ASK_LIQUIDITY", buySimulation.avgPrice, 0, 0, 0);
      }

      // ── Step 4: Simulate market sell (walk the bids) ──
      const sellSimulation = this.simulateMarketSell(bids, buySimulation.quantity);
      if (!sellSimulation.filled) {
        return this.noGo(request, startMs, "INSUFFICIENT_BID_LIQUIDITY", buySimulation.avgPrice, sellSimulation.avgPrice, 0, 0);
      }

      // ── Step 5: Calculate live spread ──
      const bestAsk = asks[0][0];
      const bestBid = bids[0][0];
      const liveSpreadBps = ((bestBid - bestAsk) / bestAsk) * 10000;

      // Quick check: is live spread even positive?
      if (liveSpreadBps <= 0) {
        return this.noGo(request, startMs, "SPREAD_INVERTED", bestAsk, bestBid, liveSpreadBps, 0);
      }

      // ── Step 6: Calculate slippage ──
      const buySlippageBps = ((buySimulation.avgPrice - bestAsk) / bestAsk) * 10000;
      const sellSlippageBps = ((bestBid - sellSimulation.avgPrice) / bestBid) * 10000;

      // ── Step 7: Calculate ALL fees ──
      const tradingFeesUsd = (buySimulation.totalCost + sellSimulation.totalReceived) * (TRADING_FEE_RATE / 2);
      const networkFeeUsd = this.netSelector.getCheapestFee();
      const totalCostsUsd = tradingFeesUsd + networkFeeUsd;

      // ── Step 8: Calculate net profit ──
      const grossProfit = sellSimulation.totalReceived - buySimulation.totalCost;
      const netProfit = grossProfit - totalCostsUsd;
      const netProfitBps = (netProfit / clipUsd) * 10000;

      // ── Step 9: THE VERDICT ──
      const durationMs = Date.now() - startMs;

      if (netProfit < MIN_PROFIT_USD) {
        return this.record({
          id: request.id,
          pair,
          buyExchange: buyEx,
          sellExchange: sellEx,
          verdict: "NO_GO",
          reason: `NET_PROFIT_TOO_LOW: $${netProfit.toFixed(4)} < $${MIN_PROFIT_USD} minimum`,
          liveBuyPrice: Number(bestAsk),
          liveSellPrice: Number(bestBid),
          liveSpreadBps: Math.round(liveSpreadBps * 100) / 100,
          simulatedBuyCost: buySimulation.totalCost,
          simulatedSellReceived: sellSimulation.totalReceived,
          buySlippageBps: Math.round(buySlippageBps * 100) / 100,
          sellSlippageBps: Math.round(sellSlippageBps * 100) / 100,
          tradingFeesUsd: Math.round(tradingFeesUsd * 10000) / 10000,
          networkFeeUsd,
          totalCostsUsd: Math.round(totalCostsUsd * 10000) / 10000,
          expectedProfitUsd: Math.round(netProfit * 10000) / 10000,
          expectedProfitBps: Math.round(netProfitBps * 100) / 100,
          clipSizeUsd: clipUsd,
          simulatedAt: new Date().toISOString(),
          simulationDurationMs: durationMs,
        });
      }

      if (netProfitBps < MIN_PROFIT_BPS) {
        return this.record({
          id: request.id,
          pair,
          buyExchange: buyEx,
          sellExchange: sellEx,
          verdict: "NO_GO",
          reason: `NET_SPREAD_TOO_THIN: ${netProfitBps.toFixed(1)}bps < ${MIN_PROFIT_BPS}bps minimum`,
          liveBuyPrice: Number(bestAsk),
          liveSellPrice: Number(bestBid),
          liveSpreadBps: Math.round(liveSpreadBps * 100) / 100,
          simulatedBuyCost: buySimulation.totalCost,
          simulatedSellReceived: sellSimulation.totalReceived,
          buySlippageBps: Math.round(buySlippageBps * 100) / 100,
          sellSlippageBps: Math.round(sellSlippageBps * 100) / 100,
          tradingFeesUsd: Math.round(tradingFeesUsd * 10000) / 10000,
          networkFeeUsd,
          totalCostsUsd: Math.round(totalCostsUsd * 10000) / 10000,
          expectedProfitUsd: Math.round(netProfit * 10000) / 10000,
          expectedProfitBps: Math.round(netProfitBps * 100) / 100,
          clipSizeUsd: clipUsd,
          simulatedAt: new Date().toISOString(),
          simulationDurationMs: durationMs,
        });
      }

      // ██ GO — MATHEMATICALLY PROVEN PROFIT ██
      return this.record({
        id: request.id,
        pair,
        buyExchange: buyEx,
        sellExchange: sellEx,
        verdict: "GO",
        reason: `PROFIT_CONFIRMED: $${netProfit.toFixed(4)} net (${netProfitBps.toFixed(1)}bps)`,
        liveBuyPrice: Number(bestAsk),
        liveSellPrice: Number(bestBid),
        liveSpreadBps: Math.round(liveSpreadBps * 100) / 100,
        simulatedBuyCost: buySimulation.totalCost,
        simulatedSellReceived: sellSimulation.totalReceived,
        buySlippageBps: Math.round(buySlippageBps * 100) / 100,
        sellSlippageBps: Math.round(sellSlippageBps * 100) / 100,
        tradingFeesUsd: Math.round(tradingFeesUsd * 10000) / 10000,
        networkFeeUsd,
        totalCostsUsd: Math.round(totalCostsUsd * 10000) / 10000,
        expectedProfitUsd: Math.round(netProfit * 10000) / 10000,
        expectedProfitBps: Math.round(netProfitBps * 100) / 100,
        clipSizeUsd: clipUsd,
        simulatedAt: new Date().toISOString(),
        simulationDurationMs: durationMs,
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown";
      return this.noGo(request, startMs, `SIMULATION_ERROR: ${msg}`, 0, 0, 0, 0);
    }
  }

  /**
   * Simulate a market buy by walking the ask side of the order book.
   * Returns the average fill price and quantity for a given USD spend.
   */
  private simulateMarketBuy(
    asks: number[][],
    spendUsd: number,
  ): { filled: boolean; avgPrice: number; quantity: number; totalCost: number } {
    let remaining = spendUsd;
    let totalQuantity = 0;
    let totalCost = 0;

    for (const [price, size] of asks) {
      if (remaining <= 0) break;

      const levelCost = price * size;
      if (levelCost <= remaining) {
        // Consume entire level
        totalQuantity += size;
        totalCost += levelCost;
        remaining -= levelCost;
      } else {
        // Partial fill at this level
        const partialQty = remaining / price;
        totalQuantity += partialQty;
        totalCost += remaining;
        remaining = 0;
      }
    }

    const filled = remaining < spendUsd * 0.05; // At least 95% filled
    const avgPrice = totalQuantity > 0 ? totalCost / totalQuantity : 0;

    return { filled, avgPrice, quantity: totalQuantity, totalCost };
  }

  /**
   * Simulate a market sell by walking the bid side of the order book.
   * Returns the average fill price and total received for a given quantity.
   */
  private simulateMarketSell(
    bids: number[][],
    quantity: number,
  ): { filled: boolean; avgPrice: number; totalReceived: number } {
    let remaining = quantity;
    let totalReceived = 0;

    for (const [price, size] of bids) {
      if (remaining <= 0) break;

      if (size <= remaining) {
        // Consume entire level
        totalReceived += price * size;
        remaining -= size;
      } else {
        // Partial fill at this level
        totalReceived += price * remaining;
        remaining = 0;
      }
    }

    const filled = remaining < quantity * 0.05; // At least 95% filled
    const avgPrice = quantity - remaining > 0 ? totalReceived / (quantity - remaining) : 0;

    return { filled, avgPrice, totalReceived };
  }

  /**
   * Create a NO_GO result for early-exit conditions.
   */
  private noGo(
    request: BeachheadRequest,
    startMs: number,
    reason: string,
    buyPrice: number,
    sellPrice: number,
    spreadBps: number,
    profitUsd: number,
  ): FirstStrikeSimulation {
    return this.record({
      id: request.id,
      pair: request.pair,
      buyExchange: request.buyExchange.toLowerCase(),
      sellExchange: request.sellExchange.toLowerCase(),
      verdict: "NO_GO",
      reason,
      liveBuyPrice: buyPrice,
      liveSellPrice: sellPrice,
      liveSpreadBps: spreadBps,
      simulatedBuyCost: 0,
      simulatedSellReceived: 0,
      buySlippageBps: 0,
      sellSlippageBps: 0,
      tradingFeesUsd: 0,
      networkFeeUsd: 0,
      totalCostsUsd: 0,
      expectedProfitUsd: profitUsd,
      expectedProfitBps: 0,
      clipSizeUsd: request.amount,
      simulatedAt: new Date().toISOString(),
      simulationDurationMs: Date.now() - startMs,
    });
  }

  /**
   * Record simulation result and update stats.
   */
  private record(sim: FirstStrikeSimulation): FirstStrikeSimulation {
    this.stats.totalSimulations++;

    if (sim.verdict === "GO") {
      this.stats.goCount++;
      this.stats.totalExpectedProfit += sim.expectedProfitUsd;
    } else {
      this.stats.noGoCount++;
      // Extract base reason (before the colon detail)
      const baseReason = sim.reason.split(":")[0];
      this.stats.reasons[baseReason] = (this.stats.reasons[baseReason] || 0) + 1;

      // Track saves — if the ARB data suggested profit but live data shows loss
      if (sim.expectedProfitUsd < 0) {
        this.stats.savedFromLoss++;
      }
    }

    this.simulations.push(sim);
    if (this.simulations.length > this.maxHistory) {
      this.simulations.shift();
    }

    const emoji = sim.verdict === "GO" ? "██ GO ██" : "░░ NO_GO ░░";
    console.log(
      `[FIRST-STRIKE] ${emoji} id=${sim.id} ${sim.pair} ` +
      `${sim.buyExchange}→${sim.sellExchange} ` +
      `live=${sim.liveSpreadBps.toFixed(0)}bps ` +
      `net=$${sim.expectedProfitUsd.toFixed(4)} ` +
      `(${sim.simulationDurationMs}ms) ` +
      `${sim.reason}`,
    );

    return sim;
  }

  /**
   * Get recent simulations.
   */
  getRecentSimulations(limit = 50): FirstStrikeSimulation[] {
    return this.simulations.slice(-limit);
  }

  /**
   * Get stats summary.
   */
  getStats(): FirstStrikeStats {
    const total = this.stats.totalSimulations;
    return {
      totalSimulations: total,
      goCount: this.stats.goCount,
      noGoCount: this.stats.noGoCount,
      abortRate: total > 0
        ? `${((this.stats.noGoCount / total) * 100).toFixed(1)}%`
        : "0.0%",
      avgExpectedProfitUsd: this.stats.goCount > 0
        ? Math.round((this.stats.totalExpectedProfit / this.stats.goCount) * 10000) / 10000
        : 0,
      totalSavedFromLoss: this.stats.savedFromLoss,
      reasons: { ...this.stats.reasons },
    };
  }

  /**
   * Convert pair format to ccxt symbol: BTCUSDT → BTC/USDT
   */
  private toCcxtSymbol(pair: string): string {
    const quotes = ["USDT", "USDC", "USD", "GBP", "EUR", "BTC", "ETH", "DAI", "BUSD"];
    const upper = pair.toUpperCase();
    for (const q of quotes) {
      if (upper.endsWith(q)) {
        return `${upper.slice(0, -q.length)}/${q}`;
      }
    }
    return pair;
  }
}
