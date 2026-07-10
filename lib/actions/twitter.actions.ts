import { extractTickers } from '@/lib/actions/signals.utils';

// Twitter/X scraping is intentionally OFF by default: X's official API is
// paid/limited and unofficial scraping breaks often. When you want it, set
// TWITTER_ENABLED=true and point TWITTER_NITTER_INSTANCE at a working Nitter
// instance (or adapt fetchSearch() to your paid API of choice).
//
// This module degrades to an empty result whenever it's disabled or fails, so
// the rest of the pipeline is unaffected.

const TWITTER_ENABLED = process.env.TWITTER_ENABLED === 'true';
const NITTER_INSTANCE = process.env.TWITTER_NITTER_INSTANCE ?? '';

// Cashtag queries to search when enabled (comma-separated in env).
const SEARCH_QUERIES = (process.env.TWITTER_QUERIES ?? '$SPY,$QQQ,stocks')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function isTwitterEnabled(): boolean {
  return TWITTER_ENABLED && Boolean(NITTER_INSTANCE);
}

/**
 * Fetch a Nitter search RSS feed and pull tweet text out of it.
 * Nitter exposes /search/rss?f=tweets&q=... which needs no auth.
 */
async function fetchSearch(query: string): Promise<ScrapedMention[]> {
  const url = `${NITTER_INSTANCE.replace(/\/$/, '')}/search/rss?f=tweets&q=${encodeURIComponent(
    query
  )}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'signalist-scanner/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error(`Nitter fetch failed ${res.status} for "${query}"`);
    return [];
  }

  const xml = await res.text();
  const mentions: ScrapedMention[] = [];

  // Minimal RSS parse: grab each <item>'s <title> (tweet text lives there).
  const items = xml.split('<item>').slice(1);
  for (const item of items) {
    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
    const text = decodeXml(titleMatch?.[1] ?? '').trim();
    if (!text) continue;

    for (const symbol of extractTickers(text)) {
      mentions.push({
        symbol,
        source: 'twitter',
        text: text.slice(0, 200),
        url: linkMatch?.[1]?.trim(),
        sentiment: null,
      });
    }
  }

  return mentions;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Scrape Twitter/X if enabled; otherwise return []. Never throws.
 */
export async function scrapeTwitter(): Promise<ScrapedMention[]> {
  if (!isTwitterEnabled()) return [];

  const results = await Promise.all(
    SEARCH_QUERIES.map(async (q) => {
      try {
        return await fetchSearch(q);
      } catch (e) {
        console.error(`Twitter scrape error for "${q}"`, e);
        return [] as ScrapedMention[];
      }
    })
  );

  return results.flat();
}
