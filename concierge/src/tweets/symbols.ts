/**
 * Asset allowlist for tweet-driven trades.
 *
 * A tweet can name any ticker on earth. We only ever trade the ones listed
 * here — an unknown or newly-minted ticker is recorded and ignored, never
 * bought. This is the single most important guard on this path: it caps the
 * blast radius of a misread tweet (or a pumped micro-cap) to a handful of
 * liquid pairs we chose in advance.
 */

/** Long names and common variants that resolve to a base asset. */
export const ASSET_ALIASES: Record<string, string[]> = {
  BTC: ["btc", "xbt", "bitcoin"],
  ETH: ["eth", "ether", "ethereum"],
  SOL: ["sol", "solana"],
  BNB: ["bnb", "binance coin"],
  XRP: ["xrp", "ripple"],
  ADA: ["ada", "cardano"],
  DOGE: ["doge", "dogecoin"],
  AVAX: ["avax", "avalanche"],
  LINK: ["link", "chainlink"],
  DOT: ["dot", "polkadot"],
  LTC: ["ltc", "litecoin"],
  ATOM: ["atom", "cosmos"],
};

/**
 * Conservative default: the majors the rest of the system already trades.
 * Widen deliberately via TWEET_ASSETS, not by accident.
 */
export const DEFAULT_ASSETS = ["BTC", "ETH", "SOL"];

/** Build the alias -> pair map the router resolves against. */
export function buildSymbolMap(bases: string[], quote = "USDT"): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of bases) {
    const base = raw.trim().toUpperCase();
    if (base === "") continue;
    const pair = `${base}/${quote}`;
    map[base.toLowerCase()] = pair;
    for (const alias of ASSET_ALIASES[base] ?? []) map[alias] = pair;
  }
  return map;
}

/** Every string that could name a tradable asset — used by the prefilter. */
export function aliasesOf(symbolMap: Record<string, string>): string[] {
  return Object.keys(symbolMap);
}

// --- US equities ----------------------------------------------------------

/**
 * Company names that resolve to a ticker, so "Micron" and "$MU" both land on
 * the same symbol.
 *
 * Careful with short tickers: an alias is matched on word boundaries, so a
 * two- or three-letter ticker that is also an English word (ON, ALL, IT, SO)
 * will match ordinary prose and hand the analyst a false candidate. Keep such
 * tickers out of `TWEET_ASSETS` unless you have watched the classifier handle
 * them in a backfill.
 */
export const EQUITY_ALIASES: Record<string, string[]> = {
  MU: ["mu", "micron"],
  PLTR: ["pltr", "palantir"],
  RKLB: ["rklb", "rocket lab", "rocketlab"],
  SNDK: ["sndk", "sandisk"],
  TSM: ["tsm", "taiwan semi", "taiwan semiconductor", "tsmc"],
  NVDA: ["nvda", "nvidia"],
  AMD: ["amd"],
  INTC: ["intc", "intel"],
  AVGO: ["avgo", "broadcom"],
  AAPL: ["aapl", "apple"],
  MSFT: ["msft", "microsoft"],
  TSLA: ["tsla", "tesla"],
  AMZN: ["amzn", "amazon"],
  GOOGL: ["googl", "goog", "alphabet"],
  META: ["meta"],
};

/**
 * Default equity allowlist: the names @TradexWhisperer's recent theses
 * actually cover — memory and semis — rather than a generic mega-cap list.
 */
export const DEFAULT_EQUITY_ASSETS = ["MU", "PLTR", "RKLB", "SNDK", "TSM", "NVDA"];

/**
 * Build the alias -> ticker map for equities. Unlike crypto there is no quote
 * pair: the symbol Alpaca wants is the bare ticker.
 */
export function buildEquitySymbolMap(tickers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of tickers) {
    const ticker = raw.trim().toUpperCase().replace(/^\$/, "");
    if (ticker === "") continue;
    map[ticker.toLowerCase()] = ticker;
    for (const alias of EQUITY_ALIASES[ticker] ?? []) map[alias] = ticker;
  }
  return map;
}
