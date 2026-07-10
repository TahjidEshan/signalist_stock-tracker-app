# Signal Scanner — Mac mini Runbook

This app now runs a **market-signal scanner** entirely locally. It pulls from
several sources, asks your local **Ollama** model which candidates are genuinely
notable, dedups them, and pushes alerts to **Telegram**. All AI runs on Ollama
— Gemini is no longer used.

### Data sources

| Source | What it contributes | File |
|--------|--------------------|------|
| **Reddit** (posts + comments) | Ticker mentions + comment velocity (early buzz) | `reddit.actions.ts` |
| **StockTwits** | Mentions with explicit bullish/bearish sentiment | `stocktwits.actions.ts` |
| **Finnhub news** | Headlines as catalysts, feeding the buzzing symbols | `news.actions.ts` |
| **Finnhub movers** | Sudden % price moves **and** volume spikes (vs. avg) | `movers.actions.ts` |
| **SEC EDGAR** | Insider Form 4 + 8-K material-event filings (smart-money) | `edgar.actions.ts` |
| Twitter/X | Optional, off by default (fragile) | `twitter.actions.ts` |

## Architecture

```
Inngest cron (every 15 min, on the Mac mini)
  → scrape social: Reddit posts+comments, StockTwits, Twitter(opt)
  → aggregate → find buzzing symbols                (signals.utils.ts)
  → enrich (parallel): Finnhub news + price/volume movers + SEC EDGAR filings
  → re-aggregate (incl. news), rank candidates by score
       (mentions, velocity, %move, volume spike, insider/8-K catalysts, corroboration)
  → ask Ollama what's genuinely notable             (lib/ollama, prompts.ts)
  → dedup against MongoDB (Signal model)            (database/models/signal.model.ts)
  → send Telegram alerts (with catalysts + volume)  (lib/telegram)
```

Everything lives in `lib/inngest/functions.ts` → `scanMarketSignals`, registered
in `app/api/inngest/route.ts`.

## One-time setup on the Mac mini

### 1. Ollama
```bash
ollama pull llama3.1:8b          # or whatever model you prefer
ollama serve                     # usually already running as a service
```
Set `OLLAMA_MODEL` in `.env` to the tag you pulled. To use a bigger model
later, just change that env var — no code change.

### 2. Telegram bot
1. In Telegram, message **@BotFather** → `/newbot` → copy the **bot token** →
   `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message (e.g. "hi") so it can see you.
3. Get your chat id:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
   ```
   Find `"chat":{"id":<number>...}` → that number is `TELEGRAM_CHAT_ID`.
   (For a channel, add the bot as admin and use the channel's `@username` or
   `-100...` id.)

### 3. Environment
Copy `.env.example` → `.env` and fill in `FINNHUB_API_KEY`, Telegram vars,
`MONGODB_URI`, and the Ollama vars.

## Running it (Docker — recommended for the Mac mini)

Everything except Ollama runs in containers: the Next.js app, MongoDB, and the
Inngest dev server (which discovers `scanMarketSignals` and fires its cron).
**Ollama stays on the host** and is reached via `host.docker.internal`.

```bash
# 0. On the host: make sure Ollama is running and the model is pulled
ollama pull llama3.1:8b
ollama serve                         # if not already running as a service

# 1. Configure
cp .env.example .env                 # fill in FINNHUB_API_KEY, TELEGRAM_*, secrets

# 2. Launch the whole stack
docker compose up -d --build
```

Services:
| Service | Port | Purpose |
|---------|------|---------|
| app     | 3000 | Next.js UI + `/api/inngest` endpoint |
| mongo   | 27017 | Database (auth, watchlists, signals) |
| inngest | 8288 | Inngest dashboard + cron runner |

Open the Inngest dashboard at **http://localhost:8288**. The scan cron fires
automatically; the app is at **http://localhost:3000**.

**Trigger a scan on demand** (don't wait for the cron): in the Inngest dashboard
send the `app/scan.signals` event — it runs the identical pipeline immediately.

**Logs / restart:**
```bash
docker compose logs -f app inngest
docker compose restart app
docker compose down                  # stop (add -v to also wipe the mongo volume)
```

### Alternative: run without Docker (bare npm)

```bash
npm run build && npm start                              # app + /api/inngest
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```
Keep both processes alive (e.g. `pm2`, `launchd`, or `tmux`). Requires a local
MongoDB and Ollama.

## Tuning

| What | Where |
|------|-------|
| Scan frequency | `SIGNAL_SCAN_CRON` (e.g. `*/15 9-16 * * 1-5` for market hours) |
| Subreddits | `REDDIT_SUBREDDITS` |
| Ollama model | `OLLAMA_MODEL` |
| Min mentions / % move / volume ratio to qualify | `buildCandidates()` defaults in `signals.utils.ts` |
| Velocity window (recent-mention spike, default 90 min) | `aggregateMentions()` in `signals.utils.ts` |
| Alert dedup window (default 4h) | `makeDedupKey()` bucketHours in `signals.utils.ts` |
| Ticker false-positives | `TICKER_STOPWORDS` in `signals.utils.ts` |
| Scoring weights (mentions, velocity, volume, insider, …) | `buildCandidates()` in `signals.utils.ts` |
| SEC contact (required) | `SEC_USER_AGENT` |

## Notes & limits

- **Twitter/X is off by default** (`TWITTER_ENABLED=false`). X's API is
  paid/limited and scraping breaks often. To enable, point
  `TWITTER_NITTER_INSTANCE` at a working Nitter instance. Reddit + StockTwits +
  news + movers + EDGAR already cover most signal.
- **StockTwits / Reddit are unauthenticated public endpoints** and may
  rate-limit (HTTP 429). Every source degrades gracefully — a failing source is
  skipped, the scan continues.
- **Volume spikes** come from Finnhub's `/stock/candle` (today's volume vs. its
  20-day average). That endpoint is **restricted on Finnhub's free tier**; if it
  403s the scan silently falls back to price-only movers. A paid Finnhub plan
  (or another volume source) unlocks it.
- **SEC EDGAR** requires a real contact in `SEC_USER_AGENT` and rate-limits to
  ~10 req/s — we only query the buzzing symbols, well within limits. Form 4s are
  tagged as insider transactions; the LLM infers buy vs. sell from context.
- **Not financial advice.** These are noisy, unverified signals meant to surface
  things to look at — nothing more.
