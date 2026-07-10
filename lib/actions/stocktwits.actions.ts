'use server';

// StockTwits has a public (unauthenticated, lightly rate-limited) API.
// The trending endpoint gives symbols with active discussion; each symbol's
// stream gives individual messages with an explicit Bullish/Bearish sentiment.

const BASE_URL = 'https://api.stocktwits.com/api/2';

interface StockTwitsSymbol {
  symbol?: string;
}

interface StockTwitsMessage {
  body?: string;
  created_at?: string;
  entities?: { sentiment?: { basic?: 'Bullish' | 'Bearish' } | null };
  symbols?: StockTwitsSymbol[];
}

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // 429 is common; caller degrades gracefully.
      console.error(`StockTwits fetch failed ${res.status}: ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.error('StockTwits fetch error', e);
    return null;
  }
}

function mapSentiment(msg: StockTwitsMessage): 'bullish' | 'bearish' | null {
  const basic = msg.entities?.sentiment?.basic;
  if (basic === 'Bullish') return 'bullish';
  if (basic === 'Bearish') return 'bearish';
  return null;
}

/** Get the list of currently trending StockTwits symbols. */
export async function getTrendingSymbols(): Promise<string[]> {
  const data = await fetchJSON<{ symbols?: StockTwitsSymbol[] }>(
    `${BASE_URL}/trending/symbols.json`
  );
  return (data?.symbols ?? [])
    .map((s) => s.symbol?.toUpperCase())
    .filter((s): s is string => Boolean(s));
}

/** Pull recent messages for one symbol as mentions with sentiment. */
async function fetchSymbolStream(symbol: string): Promise<ScrapedMention[]> {
  const data = await fetchJSON<{ messages?: StockTwitsMessage[] }>(
    `${BASE_URL}/streams/symbol/${encodeURIComponent(symbol)}.json`
  );
  const messages = data?.messages ?? [];
  return messages.map((msg) => ({
    symbol: symbol.toUpperCase(),
    source: 'stocktwits' as const,
    text: (msg.body ?? '').slice(0, 200),
    sentiment: mapSentiment(msg),
    createdAt: msg.created_at ? Date.parse(msg.created_at) : undefined,
  }));
}

/**
 * Scrape StockTwits: take the trending symbols, then pull each one's stream
 * for sentiment-tagged mentions. Never throws.
 */
export async function scrapeStockTwits(options?: {
  maxSymbols?: number;
}): Promise<ScrapedMention[]> {
  const maxSymbols = options?.maxSymbols ?? 15;

  const trending = await getTrendingSymbols();
  const symbols = trending.slice(0, maxSymbols);
  if (symbols.length === 0) return [];

  const results = await Promise.all(
    symbols.map(async (sym) => {
      try {
        return await fetchSymbolStream(sym);
      } catch (e) {
        console.error(`StockTwits stream error for ${sym}`, e);
        return [] as ScrapedMention[];
      }
    })
  );

  return results.flat();
}
