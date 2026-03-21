/**
 * GENESIS-BEACHHEAD-EXECUTOR — Beachhead Client Service
 * Wraps exchange API calls for buy→transfer→sell cross-exchange arbitrage.
 *
 * Flow: BUY on cheap exchange → WITHDRAW → TRANSFER → SELL on expensive exchange.
 * Works with USDT only — no token inventory required.
 */

import ccxt, { type Exchange } from "ccxt";

const SUPPORTED_EXCHANGES = [
  // ── Premier League (Original 20) ──
  "BINANCE", "KRAKEN", "BYBIT", "OKX", "GATEIO", "BITSTAMP",
  "COINBASE", "MEXC", "KUCOIN", "BITFINEX", "HTX", "BITGET",
  "PHEMEX", "WHITEBIT", "BITMART", "POLONIEX", "XT", "BITRUE",
  "LBANK", "BINGX",
  // ── Reinforcements (40 additional) ──
  "CRYPTO_COM", "COINEX", "GEMINI", "ASCENDEX", "DIGIFINEX",
  "TOOBIT", "BTSE", "P2B", "BIGONE", "BITHUMB",
  "COINW", "DEEPCOIN", "WOO_X", "BACKPACK", "LUNO",
  "BICONOMY", "BITVENUS", "COINDCX", "POINTPAY", "PIONEX",
  "EMIREX", "EXMO", "BLOCKCHAIN_COM", "AZBIT", "BITAZZA",
  "NOVADAX", "BITSO", "BITPANDA", "LATOKEN", "GIOTTUS",
  "BLOFIN", "DERIBIT", "BTCTURK", "BITFOREX", "BITBANK",
  "KORBIT", "COINCHECK",
  // ── MERIDIAN FIVE + Global Expansion (20 more) ──
  "UPBIT", "BITFLYER", "WAZIRX", "PARIBU", "MERCADOBITCOIN",
  "PROBIT", "INDODAX", "CEXIO", "NDAX", "OKCOIN",
  "FOXBIT", "INDEPENDENTRESERVE", "BUDA", "ZAIF", "BITOPRO",
  "VALR", "YOBIT", "COINSPH", "ACE", "TIDEX",
] as const;

// Map our names to ccxt exchange IDs where they differ
const CCXT_ID_MAP: Record<string, string> = {
  COINBASE: "coinbase",
  GATEIO: "gateio",
  BIGONE: "bigone",
  COINEX: "coinex",
  CRYPTO_COM: "cryptocom",
  ASCENDEX: "ascendex",
  WOO_X: "woo",
  BLOCKCHAIN_COM: "blockchaincom",
  BTCTURK: "btcturk",
  BITVENUS: "bitvenus",
  COINDCX: "coindcx",
  MERCADOBITCOIN: "mercado",
  CEXIO: "cex",
  INDEPENDENTRESERVE: "independentreserve",
  COINSPH: "coins",
  BITOPRO: "bitopro",
};

// Exchanges that require a passphrase (3rd credential)
const NEEDS_PASSPHRASE = new Set(["OKX", "KUCOIN", "BITGET", "CRYPTO_COM"]);
const NEEDS_UID = new Set(["BITMART"]);

export interface VerifyResult {
  exchange: string;
  status: "GREEN" | "RED";
  error?: string;
  balances?: Record<string, number>;
  canWithdraw?: boolean;
}

export class BeachheadClientService {
  private configuredExchanges: string[] = [];
  private exchangeInstances: Map<string, Exchange> = new Map();
  private balanceCache: Map<string, { balances: Record<string, number>; updatedAt: number }> = new Map();

  constructor() {
    this.initializeExchanges();
  }

  private getCcxtId(name: string): string {
    return (CCXT_ID_MAP[name] || name).toLowerCase();
  }

  private initializeExchanges(): void {
    for (const name of SUPPORTED_EXCHANGES) {
      const apiKey = process.env[`${name}_API_KEY`];
      const apiSecret = process.env[`${name}_API_SECRET`];
      if (apiKey && apiSecret) {
        try {
          const ccxtId = this.getCcxtId(name);
          const ExchangeClass = (ccxt as Record<string, any>)[ccxtId];
          if (!ExchangeClass) {
            console.log(`[BEACHHEAD] WARNING: ccxt does not support '${ccxtId}' for ${name}`);
            continue;
          }

          const config: Record<string, any> = {
            apiKey,
            secret: apiSecret,
            enableRateLimit: true,
            timeout: 15000,
            options: {
              createMarketBuyOrderRequiresPrice: false,
            },
          };

          if (NEEDS_PASSPHRASE.has(name)) {
            const passphrase = process.env[`${name}_API_PASSPHRASE`];
            if (passphrase) config.password = passphrase;
            else console.log(`[BEACHHEAD] WARNING: ${name} requires passphrase — set ${name}_API_PASSPHRASE`);
          }

          if (NEEDS_UID.has(name)) {
            const uid = process.env[`${name}_API_UID`];
            if (uid) config.uid = uid;
            else console.log(`[BEACHHEAD] WARNING: ${name} requires UID — set ${name}_API_UID`);
          }

          const instance = new ExchangeClass(config) as Exchange;
          this.exchangeInstances.set(name.toLowerCase(), instance);
          this.configuredExchanges.push(name.toLowerCase());
          console.log(`[BEACHHEAD] Exchange ${name} — API keys loaded`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown";
          console.log(`[BEACHHEAD] WARNING: Failed to create instance for ${name}: ${msg}`);
        }
      }
    }

    if (this.configuredExchanges.length === 0) {
      console.log(`[BEACHHEAD] No exchange API keys configured — DRY_RUN mode`);
    } else {
      console.log(`[BEACHHEAD] ${this.configuredExchanges.length} exchange(s) configured`);
    }
  }

  getConfiguredExchanges(): string[] {
    return [...this.configuredExchanges];
  }

  isExchangeConfigured(exchange: string): boolean {
    return this.configuredExchanges.includes(exchange.toLowerCase());
  }

  getInstance(exchange: string): Exchange | undefined {
    return this.exchangeInstances.get(exchange.toLowerCase());
  }

  /**
   * Check USDT balance on an exchange (cached for 30s to avoid rate limits).
   */
  async getUsdtBalance(exchange: string): Promise<number> {
    const key = exchange.toLowerCase();
    const cached = this.balanceCache.get(key);
    if (cached && Date.now() - cached.updatedAt < 30000) {
      return cached.balances["USDT"] || 0;
    }

    const instance = this.exchangeInstances.get(key);
    if (!instance) return 0;

    try {
      const balance = await instance.fetchBalance();
      const balances: Record<string, number> = {};
      if (balance.free) {
        for (const [asset, amount] of Object.entries(balance.free)) {
          const num = Number(amount);
          if (num > 0) balances[asset] = num;
        }
      }
      this.balanceCache.set(key, { balances, updatedAt: Date.now() });
      return balances["USDT"] || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Buy tokens on the cheap exchange using USDT.
   * Returns the quantity of tokens received.
   */
  async marketBuy(
    exchange: string,
    pair: string,
    costUsdt: number,
  ): Promise<{ orderId: string; quantity: number; avgPrice: number }> {
    const instance = this.exchangeInstances.get(exchange.toLowerCase());
    if (!instance) throw new Error(`Exchange ${exchange} not configured`);

    const ccxtPair = this.toCcxtSymbol(pair);
    console.log(`[BEACHHEAD] BUY ${ccxtPair} on ${exchange} — spending $${costUsdt.toFixed(2)} USDT`);

    const order = await instance.createMarketBuyOrder(ccxtPair, costUsdt);

    const quantity = Number(order.filled ?? order.amount ?? 0);
    const avgPrice = Number(order.average ?? order.price ?? 0);

    console.log(`[BEACHHEAD] BUY_FILLED ${ccxtPair} on ${exchange} — got ${quantity} tokens @ ${avgPrice}`);

    // Invalidate balance cache after trade
    this.balanceCache.delete(exchange.toLowerCase());

    return { orderId: order.id, quantity, avgPrice };
  }

  /**
   * Get deposit address on the sell exchange for receiving tokens.
   */
  async getDepositAddress(
    exchange: string,
    token: string,
    network?: string,
  ): Promise<{ address: string; tag?: string }> {
    const instance = this.exchangeInstances.get(exchange.toLowerCase());
    if (!instance) throw new Error(`Exchange ${exchange} not configured`);

    const params: Record<string, any> = {};
    if (network) params.network = network;

    const result = await instance.fetchDepositAddress(token, params);
    return { address: result.address, tag: result.tag ?? undefined };
  }

  /**
   * Withdraw tokens from the buy exchange to the sell exchange's deposit address.
   */
  async withdraw(
    exchange: string,
    token: string,
    amount: number,
    address: string,
    network?: string,
    tag?: string,
  ): Promise<{ withdrawalId: string; fee?: number }> {
    const instance = this.exchangeInstances.get(exchange.toLowerCase());
    if (!instance) throw new Error(`Exchange ${exchange} not configured`);

    const params: Record<string, any> = {};
    if (network) params.network = network;
    if (tag) params.tag = tag;

    console.log(`[BEACHHEAD] WITHDRAW ${amount} ${token} from ${exchange} → ${address} (${network || "default"})`);

    const result = await instance.withdraw(token, amount, address, tag, params);

    const fee = result.fee ? Number(result.fee.cost) : undefined;
    console.log(`[BEACHHEAD] WITHDRAW_SUBMITTED — id=${result.id} fee=${fee ?? "unknown"}`);

    return { withdrawalId: result.id ?? "", fee };
  }

  /**
   * Check if tokens have arrived on the sell exchange by polling deposits.
   */
  async checkDeposit(
    exchange: string,
    token: string,
    sinceMs: number,
    expectedAmount: number,
  ): Promise<{ arrived: boolean; actualAmount?: number }> {
    const instance = this.exchangeInstances.get(exchange.toLowerCase());
    if (!instance) return { arrived: false };

    try {
      // fetchDeposits may not be supported by all exchanges
      if (!instance.has["fetchDeposits"]) {
        // Fallback: check balance increase
        const balance = await instance.fetchBalance();
        const available = Number((balance.free as Record<string, any>)?.[token] || 0);
        // If we have at least 90% of expected tokens, consider it arrived
        if (available >= expectedAmount * 0.9) {
          return { arrived: true, actualAmount: available };
        }
        return { arrived: false };
      }

      const deposits = await instance.fetchDeposits(token, sinceMs);
      for (const dep of deposits) {
        if (
          dep.currency?.toUpperCase() === token.toUpperCase() &&
          dep.status === "ok" &&
          Number(dep.amount) >= expectedAmount * 0.9
        ) {
          return { arrived: true, actualAmount: Number(dep.amount) };
        }
      }
      return { arrived: false };
    } catch {
      return { arrived: false };
    }
  }

  /**
   * Sell tokens on the expensive exchange.
   */
  async marketSell(
    exchange: string,
    pair: string,
    quantity: number,
  ): Promise<{ orderId: string; avgPrice: number; totalReceived: number }> {
    const instance = this.exchangeInstances.get(exchange.toLowerCase());
    if (!instance) throw new Error(`Exchange ${exchange} not configured`);

    const ccxtPair = this.toCcxtSymbol(pair);
    console.log(`[BEACHHEAD] SELL ${quantity} ${ccxtPair} on ${exchange}`);

    const order = await instance.createMarketSellOrder(ccxtPair, quantity);

    const avgPrice = Number(order.average ?? order.price ?? 0);
    const totalReceived = Number(order.cost ?? quantity * avgPrice);

    console.log(`[BEACHHEAD] SELL_FILLED ${ccxtPair} on ${exchange} — ${quantity} @ ${avgPrice} = $${totalReceived.toFixed(2)}`);

    // Invalidate balance cache after trade
    this.balanceCache.delete(exchange.toLowerCase());

    return { orderId: order.id, avgPrice, totalReceived };
  }

  /**
   * Verify a single exchange connection by fetching balance.
   */
  async verifyExchange(exchangeName: string): Promise<VerifyResult> {
    const key = exchangeName.toLowerCase();
    const instance = this.exchangeInstances.get(key);

    if (!instance) {
      return { exchange: exchangeName, status: "RED", error: "NOT_CONFIGURED" };
    }

    try {
      const balance = await instance.fetchBalance();
      const nonZero: Record<string, number> = {};
      if (balance.total) {
        for (const [asset, amount] of Object.entries(balance.total)) {
          const num = Number(amount);
          if (num > 0) nonZero[asset] = Math.round(num * 100000000) / 100000000;
        }
      }

      // Check if exchange supports withdrawal
      const canWithdraw = instance.has["withdraw"] === true;

      console.log(`[BEACHHEAD] VERIFY ${exchangeName}: GREEN — ${Object.keys(nonZero).length} assets, withdraw=${canWithdraw}`);
      return { exchange: exchangeName, status: "GREEN", balances: nonZero, canWithdraw };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.log(`[BEACHHEAD] VERIFY ${exchangeName}: RED — ${msg}`);
      return { exchange: exchangeName, status: "RED", error: msg };
    }
  }

  async verifyAll(): Promise<VerifyResult[]> {
    const results: VerifyResult[] = [];
    for (const name of this.configuredExchanges) {
      results.push(await this.verifyExchange(name));
    }
    return results;
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

  /**
   * Extract base token from pair: BTCUSDT → BTC, FOXYUSDT → FOXY
   */
  extractBaseToken(pair: string): string {
    const quotes = ["USDT", "USDC", "USD", "GBP", "EUR", "BTC", "ETH", "DAI", "BUSD"];
    const upper = pair.toUpperCase();
    for (const q of quotes) {
      if (upper.endsWith(q)) {
        return upper.slice(0, -q.length);
      }
    }
    return upper;
  }

  /**
   * Extract quote token from pair: BTCUSDT → USDT
   */
  extractQuoteToken(pair: string): string {
    const quotes = ["USDT", "USDC", "USD", "GBP", "EUR", "BTC", "ETH", "DAI", "BUSD"];
    const upper = pair.toUpperCase();
    for (const q of quotes) {
      if (upper.endsWith(q)) return q;
    }
    return "USDT";
  }
}
