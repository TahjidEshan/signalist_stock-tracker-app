'use server';

import { extractTickers } from '@/lib/actions/signals.utils';

// Feed Finnhub news into the scanner as a signal source. We pull general market
// news plus per-symbol company news for the symbols already surfacing from
// social buzz, extract tickers from headlines/summaries, and emit `news`
// mentions. The headline doubles as a human-readable catalyst for the LLM.

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

interface RawNews {
  headline?: string;
  summary?: string;
  url?: string;
  datetime?: number; // seconds
  related?: string; // comma-separated tickers Finnhub already tagged
}

function ymd(d: Date): string {
  return d.toISOString().split('T')[0];
}

async function fetchNews(url: string): Promise<RawNews[]> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as RawNews[]) : [];
  } catch {
    return [];
  }
}

function toMentions(articles: RawNews[]): ScrapedMention[] {
  const mentions: ScrapedMention[] = [];
  for (const a of articles) {
    const text = `${a.headline ?? ''} ${a.summary ?? ''}`.trim();
    if (!text) continue;

    // Trust Finnhub's own `related` tags plus any tickers we extract from text.
    const tagged = (a.related ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const symbols = new Set<string>([...tagged, ...extractTickers(text)]);

    for (const symbol of symbols) {
      mentions.push({
        symbol,
        source: 'news',
        text: (a.headline ?? text).slice(0, 200),
        url: a.url,
        sentiment: null,
        createdAt: a.datetime ? a.datetime * 1000 : undefined,
      });
    }
  }
  return mentions;
}

/**
 * Scrape Finnhub news as ticker mentions. Never throws.
 *
 * @param symbols  symbols to pull dedicated company news for (e.g. the ones
 *                 already buzzing on social). General market news is always
 *                 fetched too.
 */
export async function scrapeNews(options?: {
  symbols?: string[];
  maxCompanySymbols?: number;
}): Promise<ScrapedMention[]> {
  const token = process.env.FINNHUB_API_KEY ?? process.env.NEXT_PUBLIC_FINNHUB_API_KEY;
  if (!token) {
    console.error('scrapeNews: FINNHUB API key not configured');
    return [];
  }

  const maxCompany = options?.maxCompanySymbols ?? 20;
  const companySymbols = (options?.symbols ?? []).slice(0, maxCompany);

  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 2); // last ~48h keeps it fresh

  // General market news.
  const generalPromise = fetchNews(
    `${FINNHUB_BASE_URL}/news?category=general&token=${token}`
  );

  // Per-symbol company news for the buzzing set.
  const companyPromises = companySymbols.map((sym) =>
    fetchNews(
      `${FINNHUB_BASE_URL}/company-news?symbol=${encodeURIComponent(
        sym
      )}&from=${ymd(from)}&to=${ymd(to)}&token=${token}`
    )
  );

  const [general, ...companyLists] = await Promise.all([generalPromise, ...companyPromises]);

  const all = [...general, ...companyLists.flat()];
  return toMentions(all);
}
