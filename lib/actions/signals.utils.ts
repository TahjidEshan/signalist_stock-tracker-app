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
 * Keeps up to `maxSamples` representative snippets per symbol for LLM context,
 * and counts how many mentions fall inside the recency window (`velocityMins`)
 * so we can reward sudden acceleration, not just raw volume.
 */
export function aggregateMentions(
  mentions: ScrapedMention[],
  maxSamples = 4,
  velocityMins = 90
): MentionAggregate[] {
  const bySymbol = new Map<string, MentionAggregate>();
  const recentCutoff = Date.now() - velocityMins * 60 * 1000;

  for (const mention of mentions) {
    const symbol = mention.symbol.toUpperCase();
    let agg = bySymbol.get(symbol);
    if (!agg) {
      agg = {
        symbol,
        mentions: 0,
        sources: [],
        bullish: 0,
        bearish: 0,
        samples: [],
        recentMentions: 0,
      };
      bySymbol.set(symbol, agg);
    }
    agg.mentions += 1;
    if (mention.createdAt != null && mention.createdAt >= recentCutoff) {
      agg.recentMentions += 1;
    }
    if (!agg.sources.includes(mention.source)) agg.sources.push(mention.source);
    if (mention.sentiment === 'bullish') agg.bullish += 1;
    if (mention.sentiment === 'bearish') agg.bearish += 1;
    if (agg.samples.length < maxSamples && mention.text) {
      agg.samples.push(mention.text.slice(0, 200));
    }
  }

  return [...bySymbol.values()].sort((a, b) => b.mentions - a.mentions);
}

function blankCandidate(symbol: string): CandidateSignal {
  return {
    symbol,
    mentions: 0,
    recentMentions: 0,
    sources: [],
    bullish: 0,
    bearish: 0,
    changePercent: null,
    volumeRatio: null,
    catalysts: [],
    direction: 'neutral',
    score: 0,
    samples: [],
  };
}

function addSource(c: CandidateSignal, tag: SignalSourceTag) {
  if (!c.sources.includes(tag)) c.sources.push(tag);
}

/**
 * Merge every signal source — social mentions (buzz + velocity), price/volume
 * movers, and SEC insider/8-K filings — into one ranked candidate list.
 *
 * A symbol becomes a candidate if it clears ANY gate: enough social mentions,
 * a big enough price move, a volume spike, or a fresh insider/material filing.
 *
 * Score weights (tune freely):
 *   +mentions                        social buzz (raw volume)
 *   +2 * recentMentions              acceleration (velocity matters more)
 *   +2 per extra distinct source     cross-source corroboration
 *   +|changePercent|                 magnitude of the price move
 *   +volumeRatio                     size of the volume spike
 *   +4 per insider filing / +3 per 8-K  hard catalyst
 *   +5 if BOTH buzzing AND moving    strongest combined signal
 */
export function buildCandidates(
  aggregates: MentionAggregate[],
  movers: MoverSignal[],
  insiders: InsiderSignal[] = [],
  opts: { minMentions?: number; minMovePercent?: number; minVolumeRatio?: number } = {}
): CandidateSignal[] {
  const { minMentions = 3, minMovePercent = 5, minVolumeRatio = 3 } = opts;

  const candidates = new Map<string, CandidateSignal>();
  const get = (sym: string) => {
    const key = sym.toUpperCase();
    let c = candidates.get(key);
    if (!c) {
      c = blankCandidate(key);
      candidates.set(key, c);
    }
    return c;
  };

  const moverBySymbol = new Map(movers.map((m) => [m.symbol.toUpperCase(), m]));

  // Social aggregates that clear the mention threshold.
  for (const agg of aggregates) {
    if (agg.mentions < minMentions) continue;
    const c = get(agg.symbol);
    c.mentions = agg.mentions;
    c.recentMentions = agg.recentMentions;
    c.bullish = agg.bullish;
    c.bearish = agg.bearish;
    c.samples = agg.samples;
    for (const s of agg.sources) addSource(c, s);
    const mover = moverBySymbol.get(agg.symbol);
    if (mover) {
      c.changePercent = mover.changePercent;
      c.volumeRatio = mover.volumeRatio ?? null;
    }
  }

  // Movers: price move OR volume spike qualifies (even without social buzz).
  for (const mover of movers) {
    const sym = mover.symbol.toUpperCase();
    const bigMove = Math.abs(mover.changePercent) >= minMovePercent;
    const bigVol = mover.volumeRatio != null && mover.volumeRatio >= minVolumeRatio;
    const alreadyCandidate = candidates.has(sym);
    if (!bigMove && !bigVol && !alreadyCandidate) continue;

    const c = get(sym);
    c.changePercent = mover.changePercent;
    c.volumeRatio = mover.volumeRatio ?? c.volumeRatio;
    if (bigMove) addSource(c, 'movers');
    if (bigVol) addSource(c, 'volume');
  }

  // Insider transactions / 8-K material events — always promoted to a candidate.
  for (const ins of insiders) {
    const c = get(ins.symbol);
    if (ins.kind === '8-K') {
      addSource(c, 'filing');
      c.catalysts.push(`8-K: ${ins.title}`);
    } else {
      addSource(c, 'insider');
      c.catalysts.push(`Insider Form 4: ${ins.title}`);
    }
  }

  // Score, set direction, and rank.
  const result = [...candidates.values()].map((c) => {
    let score = c.mentions;
    score += 2 * c.recentMentions;
    score += Math.max(0, c.sources.length - 1) * 2;
    if (c.changePercent != null) score += Math.abs(c.changePercent);
    if (c.volumeRatio != null) score += c.volumeRatio;
    score += c.sources.filter((s) => s === 'insider').length * 4;
    score += c.sources.filter((s) => s === 'filing').length * 3;

    const buzzing = c.mentions >= minMentions;
    const moving =
      (c.changePercent != null && Math.abs(c.changePercent) >= minMovePercent) ||
      (c.volumeRatio != null && c.volumeRatio >= minVolumeRatio);
    if (buzzing && moving) score += 5;

    c.direction = deriveDirection(c);
    c.score = Math.round(score * 10) / 10;
    return c;
  });

  return result.sort((a, b) => b.score - a.score);
}

function deriveDirection(c: CandidateSignal): 'up' | 'down' | 'neutral' {
  if (c.changePercent != null && Math.abs(c.changePercent) >= 0.01) {
    return c.changePercent >= 0 ? 'up' : 'down';
  }
  if (c.sources.includes('insider')) return 'up'; // insider buys skew bullish
  if (c.bullish > c.bearish) return 'up';
  if (c.bearish > c.bullish) return 'down';
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
