/**
 * GENESIS-BEACHHEAD-EXECUTOR — Network Selector Service
 * Picks the fastest/cheapest blockchain network for token transfers.
 *
 * Priority: SOL > TRC-20 > BEP-20 > MATIC > ARB > OP > AVAXC > NEVER ERC-20
 *
 * Also provides estimated transfer fees and dynamic minimum spread calculation.
 * At £5 clips on Solana: min profitable spread = ~40bps
 * At £25 clips on TRC-20: min profitable spread = ~344bps
 * Self-tuning — the system catches more fish as balances grow.
 */

import type { Exchange } from "ccxt";

// Network IDs as used by major exchanges (varies per exchange)
const NETWORK_ALIASES: Record<string, string[]> = {
  SOL: ["SOL", "SOLANA", "sol", "solana"],
  TRC20: ["TRC20", "TRX", "TRON", "trc20", "trx"],
  BEP20: ["BEP20", "BSC", "BNB", "bep20", "bsc"],
  MATIC: ["MATIC", "POLYGON", "POL", "matic", "polygon"],
  ARB: ["ARB", "ARBITRUM", "ARBITRUMONE", "arb"],
  OP: ["OP", "OPTIMISM", "op"],
  AVAXC: ["AVAXC", "AVALANCHE", "avaxc"],
  BASE: ["BASE", "base"],
};

// Estimated withdrawal fees in USD per network (conservative — actual may be lower)
const NETWORK_FEES_USD: Record<string, number> = {
  SOL: 0.01,
  TRC20: 1.00,
  BEP20: 0.50,
  MATIC: 0.10,
  ARB: 0.10,
  OP: 0.10,
  AVAXC: 0.30,
  BASE: 0.10,
};

// Estimated round-trip trading fee (buy + sell) as fraction
// Most exchanges: 0.1% maker + 0.1% taker = 0.2% round trip
const TRADING_FEE_FRACTION = 0.002;

// Safety margin — add 20% buffer to account for fee variance and slippage
const SAFETY_MARGIN = 1.2;

// Blacklisted networks — too expensive
const BLACKLISTED_NETWORKS = new Set([
  "ERC20", "ETH", "ETHEREUM", "erc20", "eth",
]);

// Preferred order — cheapest/fastest first (SOL first now — near-zero fees)
const PREFERENCE_ORDER = ["SOL", "TRC20", "BEP20", "MATIC", "BASE", "ARB", "OP", "AVAXC"];

// Minimum floor — never go below this regardless of calculation (prevents dust trades)
const ABSOLUTE_MIN_SPREAD_BPS = 20;

export class NetworkSelectorService {
  /**
   * Calculate the minimum profitable spread in bps for a given clip size and network.
   *
   * Formula: minBps = ((transferFee + tradingFees) * safetyMargin) / clipSize * 10000
   *
   * Examples:
   *   £5  + SOL:   (0.01 + 0.01) * 1.2 / 6.30 * 10000 = ~38 bps
   *   £5  + TRC20: (1.00 + 0.01) * 1.2 / 6.30 * 10000 = ~1924 bps
   *   £10 + TRC20: (1.00 + 0.02) * 1.2 / 12.60 * 10000 = ~972 bps
   *   £25 + TRC20: (1.00 + 0.05) * 1.2 / 31.50 * 10000 = ~400 bps
   *   £25 + SOL:   (0.01 + 0.05) * 1.2 / 31.50 * 10000 = ~23 bps
   */
  calculateMinSpreadBps(clipSizeUsd: number, network?: string): number {
    const transferFee = network ? this.getNetworkFee(network) : this.getCheapestFee();
    const tradingFees = clipSizeUsd * TRADING_FEE_FRACTION;
    const totalCost = (transferFee + tradingFees) * SAFETY_MARGIN;
    const minBps = (totalCost / clipSizeUsd) * 10000;
    return Math.max(ABSOLUTE_MIN_SPREAD_BPS, Math.ceil(minBps));
  }

  /**
   * Get estimated transfer fee in USD for a network.
   */
  getNetworkFee(network: string): number {
    // Match against known network types
    const upper = network.toUpperCase();
    for (const [key, aliases] of Object.entries(NETWORK_ALIASES)) {
      if (aliases.some((a) => a.toUpperCase() === upper)) {
        return NETWORK_FEES_USD[key] ?? 1.00;
      }
    }
    // Unknown network — assume $1 (conservative)
    return 1.00;
  }

  /**
   * Get the cheapest possible transfer fee across all supported networks.
   * Used for pre-filtering (before we know which network will be selected).
   */
  getCheapestFee(): number {
    return Math.min(...Object.values(NETWORK_FEES_USD));
  }

  /**
   * Get the network fee table for display/health endpoints.
   */
  getFeesTable(): Record<string, number> {
    return { ...NETWORK_FEES_USD };
  }

  /**
   * Find the best shared network between two exchanges for a given token.
   * Returns the network string and its estimated fee, or null if no cheap path exists.
   */
  async getPreferredNetwork(
    token: string,
    buyExchange: Exchange,
    sellExchange: Exchange,
  ): Promise<{ network: string; estimatedFeeUsd: number } | null> {
    try {
      // Fetch available networks from both exchanges
      const [buyNetworks, sellNetworks] = await Promise.all([
        this.getTokenNetworks(token, buyExchange),
        this.getTokenNetworks(token, sellExchange),
      ]);

      if (!buyNetworks.length || !sellNetworks.length) {
        console.log(`[NETWORK] No networks found for ${token} on one or both exchanges`);
        return null;
      }

      // Find cheapest shared network
      for (const preferred of PREFERENCE_ORDER) {
        const aliases = NETWORK_ALIASES[preferred] || [preferred];

        const buyMatch = buyNetworks.find((n) =>
          aliases.some((a) => n.toUpperCase() === a.toUpperCase()),
        );
        const sellMatch = sellNetworks.find((n) =>
          aliases.some((a) => n.toUpperCase() === a.toUpperCase()),
        );

        if (buyMatch && sellMatch) {
          const fee = NETWORK_FEES_USD[preferred] ?? 1.00;
          console.log(`[NETWORK] ${token}: selected ${preferred} (buy=${buyMatch}, sell=${sellMatch}, fee=$${fee})`);
          return { network: buyMatch, estimatedFeeUsd: fee };
        }
      }

      // Fallback: find any shared non-blacklisted network
      for (const bn of buyNetworks) {
        if (BLACKLISTED_NETWORKS.has(bn) || BLACKLISTED_NETWORKS.has(bn.toUpperCase())) continue;
        for (const sn of sellNetworks) {
          if (BLACKLISTED_NETWORKS.has(sn) || BLACKLISTED_NETWORKS.has(sn.toUpperCase())) continue;
          if (bn.toUpperCase() === sn.toUpperCase()) {
            console.log(`[NETWORK] ${token}: fallback match ${bn} (fee=$1.00 estimated)`);
            return { network: bn, estimatedFeeUsd: 1.00 };
          }
        }
      }

      console.log(`[NETWORK] ${token}: no cheap shared network found (buy=[${buyNetworks}], sell=[${sellNetworks}])`);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown";
      console.log(`[NETWORK] Error finding network for ${token}: ${msg}`);
      return null;
    }
  }

  /**
   * Get available withdrawal/deposit networks for a token on an exchange.
   */
  private async getTokenNetworks(token: string, exchange: Exchange): Promise<string[]> {
    try {
      if (exchange.has["fetchCurrencies"]) {
        const currencies = await exchange.fetchCurrencies();
        const currency = currencies[token] || currencies[token.toUpperCase()];
        if (currency && currency.networks) {
          const networks = Object.keys(currency.networks).filter((n) => {
            const net = currency.networks![n];
            return net.active !== false && net.withdraw !== false && net.deposit !== false;
          });
          return networks;
        }
      }
      return [];
    } catch {
      return [];
    }
  }
}
