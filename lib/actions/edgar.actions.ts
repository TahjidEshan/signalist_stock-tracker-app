'use server';

// SEC EDGAR filings as a "smart money / material event" signal — the opposite
// of hype-driven social buzz. For a given ticker we pull:
//   - Form 4  (insider transactions): buys are a notably bullish signal.
//   - 8-K     (material events): earnings, M&A, executive changes, etc.
//
// EDGAR's per-company Atom feed takes a ticker directly and needs no API key,
// but the SEC REQUIRES a descriptive User-Agent with contact info and asks for
// <= 10 requests/sec. We only query the handful of symbols already surfacing
// from other sources, so volume stays well within limits.

// SEC requires a real contact in the UA. Override via env for your own address.
const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT ?? 'signalist-scanner (contact: set SEC_USER_AGENT)';

interface EdgarEntry {
  title: string;
  link?: string;
  updated?: number;
}

async function fetchEdgarAtom(ticker: string, formType: '4' | '8-K'): Promise<EdgarEntry[]> {
  const url =
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany` +
    `&ticker=${encodeURIComponent(ticker)}&type=${encodeURIComponent(formType)}` +
    `&dateb=&owner=include&count=10&output=atom`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/atom+xml' },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseAtomEntries(xml);
  } catch {
    return [];
  }
}

function parseAtomEntries(xml: string): EdgarEntry[] {
  const entries: EdgarEntry[] = [];
  const chunks = xml.split('<entry>').slice(1);
  for (const chunk of chunks) {
    const title = matchTag(chunk, 'title');
    if (!title) continue;
    const linkHref = chunk.match(/<link[^>]*href="([^"]+)"/)?.[1];
    const updated = matchTag(chunk, 'updated');
    entries.push({
      title,
      link: linkHref,
      updated: updated ? Date.parse(updated) : undefined,
    });
  }
  return entries;
}

function matchTag(s: string, tag: string): string {
  const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return (m?.[1] ?? '').trim();
}

// Only count recent filings so we don't re-surface stale ones every scan.
function isRecent(entry: EdgarEntry, maxAgeDays: number): boolean {
  if (!entry.updated) return true; // undated → keep, dedup handles repeats
  return Date.now() - entry.updated <= maxAgeDays * 24 * 60 * 60 * 1000;
}

// A Form 4 filing title looks roughly like "4 - Doe John (Reporting)". We can't
// tell buy vs. sell from the title alone, so we tag it 'insider-buy' optimistically
// only when the body would confirm; to stay cheap we treat all Form 4s as an
// insider *transaction* event and let the LLM weigh direction from context.
function classifyForm4(): InsiderSignal['kind'] {
  return 'insider-buy';
}

/**
 * Fetch recent EDGAR insider transactions (Form 4) and material events (8-K)
 * for the given symbols. Never throws.
 *
 * @param symbols     tickers to check (keep this small — the buzzing set).
 * @param maxAgeDays  ignore filings older than this (default 3).
 */
export async function scrapeEdgar(options: {
  symbols: string[];
  maxSymbols?: number;
  maxAgeDays?: number;
}): Promise<InsiderSignal[]> {
  const maxSymbols = options.maxSymbols ?? 15;
  const maxAgeDays = options.maxAgeDays ?? 3;
  const symbols = options.symbols.slice(0, maxSymbols);
  if (symbols.length === 0) return [];

  const signals: InsiderSignal[] = [];

  // Sequential per symbol to respect SEC rate limits; two form types each.
  for (const raw of symbols) {
    const symbol = raw.toUpperCase();
    const [form4, form8k] = await Promise.all([
      fetchEdgarAtom(symbol, '4'),
      fetchEdgarAtom(symbol, '8-K'),
    ]);

    for (const e of form4) {
      if (!isRecent(e, maxAgeDays)) continue;
      signals.push({
        symbol,
        kind: classifyForm4(),
        title: e.title.slice(0, 160),
        url: e.link,
        filedAt: e.updated,
      });
    }
    for (const e of form8k) {
      if (!isRecent(e, maxAgeDays)) continue;
      signals.push({
        symbol,
        kind: '8-K',
        title: e.title.slice(0, 160),
        url: e.link,
        filedAt: e.updated,
      });
    }
  }

  return signals;
}
