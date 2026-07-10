'use server';

import { POPULAR_STOCK_SYMBOLS } from '@/lib/constants';

// Detect sudden price moves using Finnhub's /quote endpoint. Finnhub returns
// the current price (c) and today's percent change (dp) per symbol; we flag any
// symbol whose |dp| clears a threshold. Volume-spike detection would need the
// candle endpoint — left as a future extension.

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

interface FinnhubQuote {
  c?: number; // current price
  dp?: number; // percent change
}

async function fetchQuote(symbol: string, token: string): Promise<FinnhubQuote | null> {
  try {
    const url = `${FINNHUB_BASE_URL}/quote?symbol=${encodeURIComponent(
      symbol
    )}&token=${token}`;
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as FinnhubQuote;
  } catch {
    return null;
  }
}

/**
 * Scan a symbol universe for sudden % moves.
 *
 * @param extraSymbols  symbols surfaced by social scrapers, so a buzzing name
 *                      that isn't in the popular list still gets a quote check.
 * @param minMovePercent  absolute % change required to flag (default 5).
 */
export async function detectMovers(options?: {
  extraSymbols?: string[];
  minMovePercent?: number;
  maxSymbols?: number;
}): Promise<MoverSignal[]> {
  const token = process.env.FINNHUB_API_KEY ?? process.env.NEXT_PUBLIC_FINNHUB_API_KEY;
  if (!token) {
    console.error('detectMovers: FINNHUB API key not configured');
    return [];
  }

  const minMove = options?.minMovePercent ?? 5;
  const maxSymbols = options?.maxSymbols ?? 60;

  // Union of popular symbols + anything social scrapers surfaced, deduped.
  const universe = Array.from(
    new Set([
      ...POPULAR_STOCK_SYMBOLS.map((s) => s.toUpperCase()),
      ...(options?.extraSymbols ?? []).map((s) => s.toUpperCase()),
    ])
  ).slice(0, maxSymbols);

  const quotes = await Promise.all(
    universe.map(async (symbol) => ({ symbol, quote: await fetchQuote(symbol, token) }))
  );

  const movers: MoverSignal[] = [];
  for (const { symbol, quote } of quotes) {
    if (!quote || typeof quote.dp !== 'number' || typeof quote.c !== 'number') continue;
    if (Math.abs(quote.dp) < minMove) continue;
    movers.push({
      symbol,
      price: quote.c,
      changePercent: Math.round(quote.dp * 100) / 100,
      direction: quote.dp >= 0 ? 'up' : 'down',
    });
  }

  return movers.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
}
