'use server';

import { POPULAR_STOCK_SYMBOLS } from '@/lib/constants';

// Detect notable price action via Finnhub:
//   1. Sudden % moves — from /quote's today's-percent-change (dp).
//   2. Volume spikes — today's volume vs. its trailing average, from /stock/candle.
// A volume spike often precedes or confirms a move and is one of the most
// reliable "something is happening" signals, so we surface it even when the
// price % move alone wouldn't clear the threshold.

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

interface FinnhubQuote {
  c?: number; // current price
  dp?: number; // percent change
}

interface FinnhubCandle {
  s?: string; // 'ok' | 'no_data'
  v?: number[]; // volume per candle
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
 * Ratio of the latest daily volume to the average of the preceding `lookback`
 * days. Returns null if the candle endpoint is unavailable (common on Finnhub's
 * free tier — the pipeline degrades gracefully to price-only movers).
 */
async function fetchVolumeRatio(
  symbol: string,
  token: string,
  lookback = 20
): Promise<number | null> {
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - (lookback + 5) * 24 * 60 * 60; // extra days to cover weekends
    const url = `${FINNHUB_BASE_URL}/stock/candle?symbol=${encodeURIComponent(
      symbol
    )}&resolution=D&from=${from}&to=${to}&token=${token}`;
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as FinnhubCandle;
    if (data.s !== 'ok' || !Array.isArray(data.v) || data.v.length < 5) return null;

    const volumes = data.v;
    const today = volumes[volumes.length - 1];
    const prior = volumes.slice(Math.max(0, volumes.length - 1 - lookback), volumes.length - 1);
    if (prior.length === 0) return null;
    const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (!avg || !Number.isFinite(today)) return null;
    return Math.round((today / avg) * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * Scan a symbol universe for sudden % moves and/or volume spikes.
 *
 * A symbol is flagged when EITHER its |% change| clears `minMovePercent` OR its
 * volume ratio clears `minVolumeRatio` (e.g. 3x its recent average).
 *
 * @param extraSymbols  symbols surfaced by social scrapers, so a buzzing name
 *                      that isn't in the popular list still gets checked.
 * @param minMovePercent  absolute % change required to flag on price (default 5).
 * @param minVolumeRatio  volume-vs-average ratio required to flag on volume (default 3).
 */
export async function detectMovers(options?: {
  extraSymbols?: string[];
  minMovePercent?: number;
  minVolumeRatio?: number;
  maxSymbols?: number;
  checkVolume?: boolean;
}): Promise<MoverSignal[]> {
  const token = process.env.FINNHUB_API_KEY ?? process.env.NEXT_PUBLIC_FINNHUB_API_KEY;
  if (!token) {
    console.error('detectMovers: FINNHUB API key not configured');
    return [];
  }

  const minMove = options?.minMovePercent ?? 5;
  const minVolRatio = options?.minVolumeRatio ?? 3;
  const maxSymbols = options?.maxSymbols ?? 60;
  const checkVolume = options?.checkVolume ?? true;

  // Union of popular symbols + anything social scrapers surfaced, deduped.
  const universe = Array.from(
    new Set([
      ...POPULAR_STOCK_SYMBOLS.map((s) => s.toUpperCase()),
      ...(options?.extraSymbols ?? []).map((s) => s.toUpperCase()),
    ])
  ).slice(0, maxSymbols);

  const rows = await Promise.all(
    universe.map(async (symbol) => {
      const [quote, volumeRatio] = await Promise.all([
        fetchQuote(symbol, token),
        checkVolume ? fetchVolumeRatio(symbol, token) : Promise.resolve(null),
      ]);
      return { symbol, quote, volumeRatio };
    })
  );

  const movers: MoverSignal[] = [];
  for (const { symbol, quote, volumeRatio } of rows) {
    if (!quote || typeof quote.dp !== 'number' || typeof quote.c !== 'number') continue;
    const bigMove = Math.abs(quote.dp) >= minMove;
    const bigVolume = volumeRatio != null && volumeRatio >= minVolRatio;
    if (!bigMove && !bigVolume) continue;
    movers.push({
      symbol,
      price: quote.c,
      changePercent: Math.round(quote.dp * 100) / 100,
      direction: quote.dp >= 0 ? 'up' : 'down',
      volumeRatio: volumeRatio ?? null,
    });
  }

  // Rank by a blend of move magnitude and volume spike.
  return movers.sort(
    (a, b) =>
      Math.abs(b.changePercent) + (b.volumeRatio ?? 0) -
      (Math.abs(a.changePercent) + (a.volumeRatio ?? 0))
  );
}
