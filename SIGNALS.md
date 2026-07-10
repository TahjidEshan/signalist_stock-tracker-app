# Signal Scanner — Mac mini Runbook

This app now runs a **market-signal scanner** entirely locally: it scrapes
Reddit + StockTwits (+ optional Twitter/X), detects sudden price moves via
Finnhub, asks your local **Ollama** model which candidates are genuinely
notable, dedups them, and pushes alerts to **Telegram**. All AI runs on Ollama
— Gemini is no longer used.

## Architecture

```
Inngest cron (every 15 min, on the Mac mini)
  → scrape Reddit + StockTwits + Twitter(opt)   (lib/actions/*.actions.ts)
  → extract $TICKER mentions, aggregate          (lib/actions/signals.utils.ts)
  → Finnhub quote-check buzzing + popular symbols → % movers
  → rank candidates, ask Ollama what's notable    (lib/ollama, prompts.ts)
  → dedup against MongoDB (Signal model)          (database/models/signal.model.ts)
  → send Telegram alerts                          (lib/telegram)
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
| Min mentions / min % move to qualify | `buildCandidates()` defaults in `lib/actions/signals.utils.ts` |
| Alert dedup window (default 4h) | `makeDedupKey()` bucketHours in `signals.utils.ts` |
| Ticker false-positives | `TICKER_STOPWORDS` in `signals.utils.ts` |
| Scoring weights | `buildCandidates()` in `signals.utils.ts` |

## Notes & limits

- **Twitter/X is off by default** (`TWITTER_ENABLED=false`). X's API is
  paid/limited and scraping breaks often. To enable, point
  `TWITTER_NITTER_INSTANCE` at a working Nitter instance. Reddit + StockTwits +
  price movers already cover most retail signal.
- **StockTwits / Reddit are unauthenticated public endpoints** and may
  rate-limit (HTTP 429). The scrapers degrade gracefully — a failing source is
  skipped, the scan continues.
- **Volume-spike detection** isn't implemented yet; movers use Finnhub's daily
  % change (`dp`). Adding candle-based volume spikes is a natural next step in
  `lib/actions/movers.actions.ts`.
- **Not financial advice.** These are noisy, unverified social signals meant to
  surface things to look at — nothing more.
