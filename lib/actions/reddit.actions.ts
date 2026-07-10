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
    // post fields
    title?: string;
    selftext?: string;
    // comment fields
    body?: string;
    // shared
    permalink?: string;
    created_utc?: number;
    stickied?: boolean;
  };
}

interface RedditListing {
  data?: { children?: RedditChild[] };
}

async function fetchListing(sub: string, path: string, limit: number): Promise<RedditChild[]> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(
    sub
  )}/${path}.json?limit=${limit}&raw_json=1`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    console.error(`Reddit fetch failed for r/${sub}/${path}: ${res.status}`);
    return [];
  }

  const json = (await res.json()) as RedditListing;
  return json.data?.children ?? [];
}

/** Posts (titles + selftext) from a subreddit's chosen sort. */
async function fetchSubredditPosts(
  sub: string,
  sort: string,
  limit: number
): Promise<ScrapedMention[]> {
  const children = await fetchListing(sub, sort, limit);
  const mentions: ScrapedMention[] = [];

  for (const child of children) {
    const post = child.data;
    if (!post || post.stickied) continue;
    const text = `${post.title ?? ''} ${post.selftext ?? ''}`.trim();
    if (!text) continue;

    for (const symbol of extractTickers(text)) {
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
 * Recent comments across a subreddit. Comment velocity often accelerates before
 * a ticker breaks into post titles, so this adds an earlier-warning signal.
 */
async function fetchSubredditComments(sub: string, limit: number): Promise<ScrapedMention[]> {
  const children = await fetchListing(sub, 'comments', limit);
  const mentions: ScrapedMention[] = [];

  for (const child of children) {
    const c = child.data;
    const body = c?.body?.trim();
    if (!body) continue;

    for (const symbol of extractTickers(body)) {
      mentions.push({
        symbol,
        source: 'reddit-comment',
        text: body.slice(0, 200),
        url: c?.permalink ? `https://www.reddit.com${c.permalink}` : undefined,
        sentiment: null,
        createdAt: c?.created_utc ? c.created_utc * 1000 : undefined,
      });
    }
  }
  return mentions;
}

/**
 * Scrape configured subreddits (posts + comments) and return raw ticker
 * mentions. Never throws — a failing subreddit is skipped so the scan continues.
 */
export async function scrapeReddit(options?: {
  subreddits?: string[];
  sort?: 'hot' | 'new' | 'rising';
  limitPerSub?: number;
  includeComments?: boolean;
}): Promise<ScrapedMention[]> {
  const subs = options?.subreddits ?? DEFAULT_SUBREDDITS;
  const sort = options?.sort ?? 'hot';
  const limit = options?.limitPerSub ?? 50;
  const includeComments = options?.includeComments ?? true;

  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        const [posts, comments] = await Promise.all([
          fetchSubredditPosts(sub, sort, limit),
          includeComments
            ? fetchSubredditComments(sub, limit)
            : Promise.resolve([] as ScrapedMention[]),
        ]);
        return [...posts, ...comments];
      } catch (e) {
        console.error(`Reddit scrape error for r/${sub}`, e);
        return [] as ScrapedMention[];
      }
    })
  );

  return results.flat();
}
