'use server';

import { extractTickers } from '@/lib/actions/signals.utils';

// Reddit exposes public listings as JSON at /r/<sub>/<sort>.json with no auth.
// We read titles + selftext, pull tickers, and emit one mention per (post, ticker).

const DEFAULT_SUBREDDITS = (
  process.env.REDDIT_SUBREDDITS ??
  'wallstreetbets,stocks,options,StockMarket,investing'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Reddit rate-limits by User-Agent; a descriptive one is required.
const USER_AGENT =
  process.env.REDDIT_USER_AGENT ?? 'signalist-scanner/1.0 (personal use)';

interface RedditChild {
  data?: {
    title?: string;
    selftext?: string;
    permalink?: string;
    created_utc?: number;
    stickied?: boolean;
  };
}

interface RedditListing {
  data?: { children?: RedditChild[] };
}

async function fetchSubreddit(
  sub: string,
  sort: string,
  limit: number
): Promise<ScrapedMention[]> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(
    sub
  )}/${sort}.json?limit=${limit}&raw_json=1`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    console.error(`Reddit fetch failed for r/${sub}: ${res.status}`);
    return [];
  }

  const json = (await res.json()) as RedditListing;
  const children = json.data?.children ?? [];
  const mentions: ScrapedMention[] = [];

  for (const child of children) {
    const post = child.data;
    if (!post || post.stickied) continue;
    const text = `${post.title ?? ''} ${post.selftext ?? ''}`.trim();
    if (!text) continue;

    const tickers = extractTickers(text);
    for (const symbol of tickers) {
      mentions.push({
        symbol,
        source: 'reddit',
        text: post.title?.slice(0, 200) ?? text.slice(0, 200),
        url: post.permalink ? `https://www.reddit.com${post.permalink}` : undefined,
        sentiment: null,
        createdAt: post.created_utc ? post.created_utc * 1000 : undefined,
      });
    }
  }

  return mentions;
}

/**
 * Scrape configured subreddits and return raw ticker mentions.
 * Never throws — a failing subreddit is skipped so the scan continues.
 */
export async function scrapeReddit(options?: {
  subreddits?: string[];
  sort?: 'hot' | 'new' | 'rising';
  limitPerSub?: number;
}): Promise<ScrapedMention[]> {
  const subs = options?.subreddits ?? DEFAULT_SUBREDDITS;
  const sort = options?.sort ?? 'hot';
  const limit = options?.limitPerSub ?? 50;

  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        return await fetchSubreddit(sub, sort, limit);
      } catch (e) {
        console.error(`Reddit scrape error for r/${sub}`, e);
        return [] as ScrapedMention[];
      }
    })
  );

  return results.flat();
}
