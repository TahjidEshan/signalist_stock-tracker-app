// Shared helpers for the signal-scanning pipeline: extracting tickers from
// free text and aggregating mentions across sources.

// Common all-caps words that look like tickers but aren't. Keeps false
// positives out of the mention counts. Extend as you notice noise.
const TICKER_STOPWORDS = new Set([
  'A', 'I', 'AI', 'AN', 'AND', 'ARE', 'AT', 'BE', 'BUY', 'CEO', 'CFO', 'DD',
  'DO', 'EPS', 'ETF', 'FDA', 'FOMO', 'FOR', 'FUD', 'GO', 'HODL', 'IMO', 'IPO',
  'IRA', 'IT', 'ITM', 'LOL', 'ME', 'NO', 'NOT', 'NOW', 'OF', 'OK', 'ON', 'OR',
  'OTM', 'PM', 'PR', 'PT', 'RH', 'SEC', 'SELL', 'SO', 'THE', 'TO', 'UP', 'US',
  'USA', 'USD', 'WSB', 'YOLO', 'YOU', 'YOUR', 'CN', 'EU', 'UK', 'GDP', 'CPI',
  'ATH', 'ATL', 'RIP', 'TLDR', 'TL', 'DR', 'EOD', 'EOW', 'AH', 'PE',
]);

// $CASHTAG form (preferred — high precision) and bare 1-5 letter uppercase.
const CASHTAG_RE = /\$([A-Za-z]{1,5})\b/g;
const BARE_TICKER_RE = /\b([A-Z]{2,5})\b/g;

/**
 * Extract likely ticker symbols from a piece of text.
 * Cashtags ($AAPL) are always trusted. Bare uppercase words are only trusted
 * when they aren't common stopwords, to cut down on noise.
 */
export function extractTickers(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = CASHTAG_RE.exec(text)) !== null) {
    found.add(m[1].toUpperCase());
  }
  while ((m = BARE_TICKER_RE.exec(text)) !== null) {
    const t = m[1].toUpperCase();
    if (!TICKER_STOPWORDS.has(t)) found.add(t);
  }

  return [...found];
}

/**
 * Roll up individual mentions into per-symbol aggregates.
 * Keeps up to `maxSamples` representative snippets per symbol for LLM context.
 */
export function aggregateMentions(
  mentions: ScrapedMention[],
  maxSamples = 4
): MentionAggregate[] {
  const bySymbol = new Map<string, MentionAggregate>();

  for (const mention of mentions) {
    const symbol = mention.symbol.toUpperCase();
    let agg = bySymbol.get(symbol);
    if (!agg) {
      agg = { symbol, mentions: 0, sources: [], bullish: 0, bearish: 0, samples: [] };
      bySymbol.set(symbol, agg);
    }
    agg.mentions += 1;
    if (!agg.sources.includes(mention.source)) agg.sources.push(mention.source);
    if (mention.sentiment === 'bullish') agg.bullish += 1;
    if (mention.sentiment === 'bearish') agg.bearish += 1;
    if (agg.samples.length < maxSamples && mention.text) {
      agg.samples.push(mention.text.slice(0, 200));
    }
  }

  return [...bySymbol.values()].sort((a, b) => b.mentions - a.mentions);
}

/**
 * Merge social-mention aggregates with price-mover signals into a single
 * ranked list of candidate signals, applying a simple threshold + scoring.
 *
 * Score weights (tune freely):
 *   +mentions                       social buzz
 *   +2 per extra source             cross-source corroboration
 *   +|changePercent|                magnitude of a price move
 *   +5 if a symbol is BOTH buzzing and moving (strongest signal)
 */
export function buildCandidates(
  aggregates: MentionAggregate[],
  movers: MoverSignal[],
  opts: { minMentions?: number; minMovePercent?: number } = {}
): CandidateSignal[] {
  const { minMentions = 3, minMovePercent = 5 } = opts;

  const moverBySymbol = new Map(movers.map((m) => [m.symbol.toUpperCase(), m]));
  const candidates = new Map<string, CandidateSignal>();

  // Seed from social aggregates that clear the mention threshold.
  for (const agg of aggregates) {
    if (agg.mentions < minMentions) continue;
    const mover = moverBySymbol.get(agg.symbol);
    candidates.set(agg.symbol, {
      symbol: agg.symbol,
      mentions: agg.mentions,
      sources: [...agg.sources],
      bullish: agg.bullish,
      bearish: agg.bearish,
      changePercent: mover ? mover.changePercent : null,
      direction: deriveDirection(agg, mover),
      score: 0,
      samples: agg.samples,
    });
  }

  // Add movers that clear the move threshold (even if not socially buzzing).
  for (const mover of movers) {
    const sym = mover.symbol.toUpperCase();
    if (Math.abs(mover.changePercent) < minMovePercent) continue;
    const existing = candidates.get(sym);
    if (existing) {
      if (!existing.sources.includes('movers')) existing.sources.push('movers');
      existing.changePercent = mover.changePercent;
    } else {
      candidates.set(sym, {
        symbol: sym,
        mentions: 0,
        sources: ['movers'],
        bullish: 0,
        bearish: 0,
        changePercent: mover.changePercent,
        direction: mover.direction,
        score: 0,
        samples: [],
      });
    }
  }

  // Score and rank.
  const result = [...candidates.values()].map((c) => {
    let score = c.mentions;
    score += Math.max(0, c.sources.length - 1) * 2;
    if (c.changePercent != null) score += Math.abs(c.changePercent);
    const buzzingAndMoving =
      c.mentions >= minMentions &&
      c.changePercent != null &&
      Math.abs(c.changePercent) >= minMovePercent;
    if (buzzingAndMoving) score += 5;
    return { ...c, score: Math.round(score * 10) / 10 };
  });

  return result.sort((a, b) => b.score - a.score);
}

function deriveDirection(
  agg: MentionAggregate,
  mover?: MoverSignal
): 'up' | 'down' | 'neutral' {
  if (mover) return mover.direction;
  if (agg.bullish > agg.bearish) return 'up';
  if (agg.bearish > agg.bullish) return 'down';
  return 'neutral';
}

/**
 * Dedup key ties a signal to a coarse time bucket so we alert at most once per
 * symbol+direction within the bucket window (default 4h).
 */
export function makeDedupKey(
  symbol: string,
  direction: string,
  bucketHours = 4
): string {
  const bucket = Math.floor(Date.now() / (bucketHours * 60 * 60 * 1000));
  return `${symbol.toUpperCase()}:${direction}:${bucket}`;
}
