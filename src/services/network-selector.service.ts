/**
 * GENESIS-BEACHHEAD-EXECUTOR — Network Selector Service
 * Picks the fastest/cheapest blockchain network for token transfers.
 *
 * Priority: TRC-20 > SOL > BEP-20 > Native chain > NEVER ERC-20
 * ERC-20 fees ($2-10+) would eat the entire spread on £25 clips.
 */

import type { Exchange } from "ccxt";

// Network IDs as used by major exchanges (varies per exchange)
const NETWORK_ALIASES: Record<string, string[]> = {
  TRC20: ["TRC20", "TRX", "TRON", "trc20", "trx"],
  SOL: ["SOL", "SOLANA", "sol", "solana"],
  BEP20: ["BEP20", "BSC", "BNB", "bep20", "bsc"],
  MATIC: ["MATIC", "POLYGON", "POL", "matic", "polygon"],
  AVAXC: ["AVAXC", "AVALANCHE", "avaxc"],
  ARB: ["ARB", "ARBITRUM", "ARBITRUMONE", "arb"],
  OP: ["OP", "OPTIMISM", "op"],
};

// Blacklisted networks — too expensive for £25 clips
const BLACKLISTED_NETWORKS = new Set([
  "ERC20", "ETH", "ETHEREUM", "erc20", "eth",
]);

// Preferred order — cheapest/fastest first
const PREFERENCE_ORDER = ["TRC20", "SOL", "BEP20", "MATIC", "AVAXC", "ARB", "OP"];

export class NetworkSelectorService {
  /**
   * Find the best shared network between two exchanges for a given token.
   * Returns the network string both exchanges understand, or null if no cheap path exists.
   */
  async getPreferredNetwork(
    token: string,
    buyExchange: Exchange,
    sellExchange: Exchange,
  ): Promise<string | null> {
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
          console.log(`[NETWORK] ${token}: selected ${preferred} (buy=${buyMatch}, sell=${sellMatch})`);
          // Return the buy exchange's network ID (used for withdrawal)
          return buyMatch;
        }
      }

      // Fallback: find any shared non-blacklisted network
      for (const bn of buyNetworks) {
        if (BLACKLISTED_NETWORKS.has(bn) || BLACKLISTED_NETWORKS.has(bn.toUpperCase())) continue;
        for (const sn of sellNetworks) {
          if (BLACKLISTED_NETWORKS.has(sn) || BLACKLISTED_NETWORKS.has(sn.toUpperCase())) continue;
          if (bn.toUpperCase() === sn.toUpperCase()) {
            console.log(`[NETWORK] ${token}: fallback match ${bn}`);
            return bn;
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
            // Only include networks where both withdraw and deposit are active
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
