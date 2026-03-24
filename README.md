# GENESIS-BEACHHEAD-EXECUTOR
### Channel B -- Buy-Transfer-Sell Cross-Exchange Arbitrage

**Port: 8411**

> "Prove the kill before pulling the trigger. The failure never existed." -- First Strike Protocol, Section 47 Phase 0

## What It Does

1. **Buy-Transfer-Sell execution** -- receives arb opportunities, buys tokens on the cheap exchange with USDT, withdraws across the cheapest blockchain network, deposits on the expensive exchange, sells for profit
2. **First Strike Protocol (Section 47 Phase 0)** -- before committing a single penny, fetches LIVE order books from both exchanges, simulates the full trade with slippage, calculates ALL costs (trading fees + network fees + slippage), returns GO only if net profit > $0.10 AND > 5bps
3. **Dynamic spread filter** -- self-tuning minimum spread based on clip size and network fee (SOL=$0.01, TRC20=$1.00): at $6.30 on SOL the minimum is ~38bps, at $31.50 on TRC20 it is ~400bps
4. **80+ exchange support** via CCXT -- 20 Premier League + 37 Reinforcements + 20 Meridian Five, with per-exchange API key configuration, passphrase support, and UID handling
5. **Transfer state machine** -- BUYING, BOUGHT, WITHDRAWING, TRANSFERRING, ARRIVED, SELLING, COMPLETE/FAILED/STALLED with 30-minute timeout and background deposit polling
6. **Kill Switch compliance** -- checks Kill Switch V2 before every execution; RED state blocks all trades
7. **Full Ledger Lite compliance** -- every fork, decision, variable change recorded with SHA-256 payload hashing; accountable to the last penny

## Architecture

| File | Purpose | Lines |
|------|---------|-------|
| `src/index.ts` | Express server, 5 endpoints, kill switch gate, First Strike integration, Ledger Lite compliance | 349 |
| `src/types.ts` | Request/response types, TransferState, FirstStrikeSimulation, PositionEntry | 115 |
| `src/services/first-strike.service.ts` | Section 47 Phase 0: live order book simulation, slippage calculation, GO/NO_GO verdict | 405 |
| `src/services/beachhead-client.service.ts` | CCXT wrapper for 80+ exchanges: buy, sell, withdraw, deposit check, balance cache | 395 |
| `src/services/network-selector.service.ts` | Cheapest/fastest network selection (SOL > TRC20 > BEP20 > MATIC > ARB > OP > AVAXC), dynamic min spread calc | 190 |
| `src/services/transfer-manager.service.ts` | Full buy-transfer-sell state machine with guards, profitability gate, deposit polling | 287 |
| `src/services/position.service.ts` | P&L tracking: complete/failed/stalled counts, aggregate PnL | 63 |
| `package.json` | Dependencies: express, ccxt | 28 |
| `Dockerfile` | node:20-alpine, production build | 16 |

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Service health, configured exchanges, First Strike stats, dynamic spread examples |
| GET | `/state` | Full state: inflight transfers, recent positions, stats |
| GET | `/first-strike` | First Strike Protocol stats, abort rate, NO_GO reason breakdown, recent simulations |
| GET | `/verify` | Verify all configured exchange API connections and withdrawal capability |
| POST | `/execute` | Accept and execute a buy-transfer-sell opportunity |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8411` | Service port |
| `KILL_SWITCH_URL` | `http://genesis-kill-switch-v2:7100` | Kill Switch V2 for trade gating |
| `GTC_URL` | `http://genesis-beachhead-gtc:8650` | Telemetry forwarding |
| `LEDGER_LITE_URL` | `http://genesis-ledger-lite:8500` | Compliance recording |
| `BEACHHEAD_MAX_SPREAD_BPS` | `5000` | Maximum spread filter (bps) |
| `FIRST_STRIKE_MIN_PROFIT_USD` | `0.10` | Minimum net profit for GO verdict |
| `FIRST_STRIKE_MIN_PROFIT_BPS` | `5` | Minimum net profit in bps for GO verdict |
| `TRANSFER_TIMEOUT_MS` | `1800000` | Transfer timeout (30 min) |
| `DEPOSIT_POLL_INTERVAL_MS` | `15000` | Deposit arrival polling interval |
| `MAX_INFLIGHT_PER_EXCHANGE` | `1` | Max concurrent transfers per exchange |
| `{EXCHANGE}_API_KEY` | -- | Per-exchange API key (e.g., BINANCE_API_KEY) |
| `{EXCHANGE}_API_SECRET` | -- | Per-exchange API secret |
| `{EXCHANGE}_API_PASSPHRASE` | -- | Per-exchange passphrase (OKX, KuCoin, Bitget, Crypto.com) |

## Integration

- **Receives from**: Arbitrage Detector via POST `/execute`
- **Writes to**: Beachhead GTC (telemetry), Ledger Lite (compliance), Kill Switch V2 (gate check)
- **Trades on**: 80+ exchanges via CCXT (Binance, Kraken, Bybit, OKX, Gate.io, Bitstamp, Coinbase, MEXC, KuCoin, and 70+ more)
- **Networks**: SOL, TRC20, BEP20, MATIC, ARB, OP, AVAXC, BASE (ERC20 blacklisted)

## Current State

- Channel B executor BUILT and wired into docker-compose
- First Strike Protocol ARMED -- every opportunity simulated before capital committed
- Dynamic spread filter LIVE -- self-tuning by clip size and network
- 0 FILLED trades (withdrawal blocker -- API keys need withdrawal permissions enabled + EC2 IP whitelisted)

## Future Editions

1. Multi-leg arbitrage: triangular paths across 3+ exchanges
2. Partial fill handling: execute what is available rather than all-or-nothing
3. Smart network selection: real-time fee queries instead of static estimates
4. Parallel execution: multiple inflight transfers per exchange as capital grows
5. GPU-accelerated order book analysis via NVIDIA Warp for sub-millisecond simulation

## Rail Deployment

| Rail | Status | Notes |
|------|--------|-------|
| Rail 1 (Cash Rail) | BUILT | Channel B, 80+ exchanges, First Strike Protocol, dynamic spread filter |
| Rail 2 (DeFi) | Planned | DEX execution variant with MEV protection |
| Rail 3+ | Future | GOD/Ray Trace dashboard for real-time execution monitoring |
