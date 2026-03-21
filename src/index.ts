/**
 * GENESIS-BEACHHEAD-EXECUTOR — Buy-Transfer-Sell Cross-Exchange Arbitrage
 *
 * Receives opportunities from ARB detector, executes:
 * BUY on cheap exchange → WITHDRAW → TRANSFER → SELL on expensive exchange.
 *
 * Works with USDT only — no token inventory required.
 * Kill-switch RED blocks all execution.
 *
 * Port: 8411
 */

import express from "express";
import { createHash, randomUUID } from "crypto";
import { BeachheadClientService } from "./services/beachhead-client.service";
import { NetworkSelectorService } from "./services/network-selector.service";
import { TransferManagerService } from "./services/transfer-manager.service";
import { PositionService } from "./services/position.service";
import type { BeachheadRequest } from "./types";

const PORT = parseInt(process.env.PORT || "8411", 10);
const KILL_SWITCH_URL = process.env.KILL_SWITCH_URL || "http://genesis-kill-switch-v2:7100";
const GTC_URL = process.env.GTC_URL || "http://genesis-beachhead-gtc:8650";
const LEDGER_LITE_URL = process.env.LEDGER_LITE_URL || "http://genesis-ledger-lite:8500";
const BEACHHEAD_MAX_SPREAD_BPS = parseInt(process.env.BEACHHEAD_MAX_SPREAD_BPS || "5000", 10);

/**
 * Post event to Ledger Lite for compliance recording.
 * Every fork, decision, variable change → recorded. Accountable to the last 1p.
 * payloadHash computed upstream (here) — Ledger Lite verifies, never generates.
 */
function postToLedgerLite(eventType: string, data: Record<string, unknown>): void {
  const payload = {
    id: randomUUID(),
    rail: "BEACHHEAD" as const,
    eventType,
    source: "genesis-beachhead-executor",
    timestamp: new Date().toISOString(),
    data,
  };

  // Compute payloadHash = sha256(stable JSON of payload WITHOUT payloadHash)
  const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

  fetch(`${LEDGER_LITE_URL}/payload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, payloadHash }),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => {
    console.log(`[BEACHHEAD] Ledger Lite POST failed: ${err instanceof Error ? err.message : "Unknown"}`);
  });
}

const app = express();
app.use(express.json());

const client = new BeachheadClientService();
const networkSelector = new NetworkSelectorService();
const positions = new PositionService();
const transferManager = new TransferManagerService(client, networkSelector, positions);

// Start polling for deposit arrivals
transferManager.startPolling();

// ── GET /health ──
app.get("/health", (_req, res) => {
  const inflight = transferManager.getInflightTransfers();
  res.json({
    service: "genesis-beachhead-executor",
    status: "GREEN",
    mode: client.getConfiguredExchanges().length > 0 ? "LIVE" : "DRY_RUN",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    configuredExchanges: client.getConfiguredExchanges(),
    inflightCount: inflight.length,
    stats: positions.getStats(),
    config: {
      spreadFilter: "DYNAMIC",
      maxSpreadBps: BEACHHEAD_MAX_SPREAD_BPS,
      exampleMinBps: {
        "£5_SOL": networkSelector.calculateMinSpreadBps(6.30, "SOL"),
        "£5_TRC20": networkSelector.calculateMinSpreadBps(6.30, "TRC20"),
        "£10_SOL": networkSelector.calculateMinSpreadBps(12.60, "SOL"),
        "£10_TRC20": networkSelector.calculateMinSpreadBps(12.60, "TRC20"),
        "£25_SOL": networkSelector.calculateMinSpreadBps(31.50, "SOL"),
        "£25_TRC20": networkSelector.calculateMinSpreadBps(31.50, "TRC20"),
      },
      networkFees: networkSelector.getFeesTable(),
    },
  });
});

// ── GET /state ──
app.get("/state", (_req, res) => {
  const allTransfers = transferManager.getAllTransfers();
  const inflight = transferManager.getInflightTransfers();
  res.json({
    stats: positions.getStats(),
    inflightCount: inflight.length,
    inflight: inflight.map((t) => ({
      id: t.id,
      token: t.token,
      status: t.status,
      buyExchange: t.buyExchange,
      sellExchange: t.sellExchange,
      network: t.network,
      costUsdt: t.costUsdt,
      elapsedSec: Math.round((Date.now() - t.startedAt) / 1000),
    })),
    recentPositions: positions.getRecentPositions(50),
    totalTransfers: allTransfers.length,
    configuredExchanges: client.getConfiguredExchanges(),
  });
});

// ── GET /verify ──
app.get("/verify", async (_req, res) => {
  const results = await client.verifyAll();
  const allGreen = results.every((r) => r.status === "GREEN");
  res.json({
    overall: allGreen ? "ALL_GREEN" : "SOME_RED",
    total: results.length,
    green: results.filter((r) => r.status === "GREEN").length,
    red: results.filter((r) => r.status === "RED").length,
    exchanges: results,
  });
});

// ── POST /execute ──
app.post("/execute", async (req, res) => {
  const request = req.body as BeachheadRequest;

  // Validate required fields
  if (!request.id || !request.pair || !request.buyExchange || !request.sellExchange) {
    res.status(400).json({
      accepted: false,
      error: "MISSING_REQUIRED_FIELDS",
    });
    return;
  }

  if (typeof request.amount !== "number" || request.amount <= 0) {
    res.status(400).json({
      accepted: false,
      error: "INVALID_AMOUNT",
    });
    return;
  }

  // Dynamic spread pre-filter — uses cheapest possible network fee (SOL = $0.01)
  // This is permissive: lets through anything that COULD be profitable on any network.
  // The transfer manager does a precise profitability check after network selection.
  const preFilterMinBps = networkSelector.calculateMinSpreadBps(request.amount);
  if (request.grossSpreadBps < preFilterMinBps) {
    const reason = `SPREAD_TOO_LOW: ${request.grossSpreadBps}bps < dynamic min ${preFilterMinBps}bps (clip=$${request.amount}, cheapest network)`;
    postToLedgerLite("SPREAD_REJECT", { id: request.id, pair: request.pair, buyExchange: request.buyExchange, sellExchange: request.sellExchange, grossSpreadBps: request.grossSpreadBps, minBps: preFilterMinBps, amount: request.amount, reason });
    res.status(200).json({ accepted: false, reason, id: request.id });
    return;
  }

  if (request.grossSpreadBps > BEACHHEAD_MAX_SPREAD_BPS) {
    const reason = `SPREAD_TOO_HIGH: ${request.grossSpreadBps}bps > max ${BEACHHEAD_MAX_SPREAD_BPS}bps`;
    postToLedgerLite("SPREAD_REJECT", { id: request.id, pair: request.pair, grossSpreadBps: request.grossSpreadBps, maxBps: BEACHHEAD_MAX_SPREAD_BPS, reason });
    res.status(200).json({ accepted: false, reason, id: request.id });
    return;
  }

  // Kill-switch check
  try {
    const ksRes = await fetch(`${KILL_SWITCH_URL}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (ksRes.ok) {
      const ksData = (await ksRes.json()) as { state?: string };
      if (ksData.state?.toUpperCase() === "RED") {
        res.status(503).json({
          accepted: false,
          error: "KILL_SWITCH_RED",
          id: request.id,
        });
        return;
      }
    }
  } catch {
    // Proceed if kill switch unreachable
  }

  // Guard checks
  const guard = transferManager.canAccept(request);
  if (!guard.ok) {
    const reason = `GUARD: ${guard.reason}`;
    postToLedgerLite("GUARD_REJECT", { id: request.id, pair: request.pair, buyExchange: request.buyExchange, sellExchange: request.sellExchange, grossSpreadBps: request.grossSpreadBps, amount: request.amount, reason });
    res.status(200).json({ accepted: false, reason, id: request.id });
    return;
  }

  // Check USDT balance on buy exchange
  const usdtBalance = await client.getUsdtBalance(request.buyExchange);
  if (usdtBalance < request.amount) {
    const reason = `INSUFFICIENT_BALANCE: ${request.buyExchange} has $${usdtBalance.toFixed(2)} USDT, need $${request.amount.toFixed(2)}`;
    postToLedgerLite("BALANCE_REJECT", { id: request.id, pair: request.pair, buyExchange: request.buyExchange, usdtBalance, amountNeeded: request.amount, reason });
    res.status(200).json({ accepted: false, reason, id: request.id });
    return;
  }

  // Accept and execute
  postToLedgerLite("BEACHHEAD_ACCEPTED", { id: request.id, pair: request.pair, buyExchange: request.buyExchange, sellExchange: request.sellExchange, grossSpreadBps: request.grossSpreadBps, amount: request.amount, usdtBalance });
  res.status(202).json({
    accepted: true,
    id: request.id,
    pair: request.pair,
    buyExchange: request.buyExchange,
    sellExchange: request.sellExchange,
    grossSpreadBps: request.grossSpreadBps,
    mode: "BEACHHEAD",
  });

  // Execute pipeline (non-blocking)
  try {
    const result = await transferManager.execute(request);

    const executionData = {
      id: request.id,
      pair: request.pair,
      token: result.token,
      buyExchange: request.buyExchange,
      sellExchange: request.sellExchange,
      status: result.status,
      network: result.network,
      amount: request.amount,
      buyPrice: result.buyPrice,
      sellPrice: result.sellPrice,
      quantity: result.quantity,
      grossSpreadBps: request.grossSpreadBps,
      realizedPnl: result.realizedPnl,
      withdrawalFee: result.withdrawalFee,
      error: result.error,
      durationMs: result.completedAt ? result.completedAt - result.startedAt : undefined,
    };

    // GTC telemetry (fire-and-forget)
    fetch(`${GTC_URL}/telemetry/append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: `beachhead-${request.id}-${Date.now()}`,
        eventType: "BEACHHEAD_EXECUTION",
        source: "genesis-beachhead-executor",
        timestamp: new Date().toISOString(),
        payload: executionData,
      }),
    }).catch(() => {});

    // Ledger Lite compliance (fire-and-forget) — every execution recorded
    postToLedgerLite("BEACHHEAD_EXECUTION", executionData);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown";
    console.error(`[BEACHHEAD] Execution error — id=${request.id} error=${msg}`);
    postToLedgerLite("BEACHHEAD_ERROR", { id: request.id, error: msg });
  }
});

// ── Start ──
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[BEACHHEAD] Genesis Beachhead Executor listening on port ${PORT}`);
  console.log(`[BEACHHEAD] Mode: ${client.getConfiguredExchanges().length > 0 ? "LIVE" : "DRY_RUN"}`);
  console.log(`[BEACHHEAD] Configured exchanges: ${client.getConfiguredExchanges().join(", ") || "NONE"}`);
  console.log(`[BEACHHEAD] Spread filter: DYNAMIC (clip-size × network adaptive) max=${BEACHHEAD_MAX_SPREAD_BPS}bps`);
  console.log(`[BEACHHEAD] Example min spreads: £5/SOL=${networkSelector.calculateMinSpreadBps(6.30, "SOL")}bps, £5/TRC20=${networkSelector.calculateMinSpreadBps(6.30, "TRC20")}bps, £25/SOL=${networkSelector.calculateMinSpreadBps(31.50, "SOL")}bps, £25/TRC20=${networkSelector.calculateMinSpreadBps(31.50, "TRC20")}bps`);
  console.log(`[BEACHHEAD] Kill Switch: ${KILL_SWITCH_URL}`);
});
