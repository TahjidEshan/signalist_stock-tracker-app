import {inngest} from "@/lib/inngest/client";
import {NEWS_SUMMARY_EMAIL_PROMPT, PERSONALIZED_WELCOME_EMAIL_PROMPT, SIGNAL_ANALYSIS_PROMPT} from "@/lib/inngest/prompts";
import {sendNewsSummaryEmail, sendWelcomeEmail} from "@/lib/nodemailer";
import {getAllUsersForNewsEmail} from "@/lib/actions/user.actions";
import { getWatchlistSymbolsByEmail } from "@/lib/actions/watchlist.actions";
import { getNews } from "@/lib/actions/finnhub.actions";
import { getFormattedTodayDate } from "@/lib/utils";
import { ollamaGenerate, ollamaGenerateJSON } from "@/lib/ollama";
import { scrapeReddit } from "@/lib/actions/reddit.actions";
import { scrapeStockTwits } from "@/lib/actions/stocktwits.actions";
import { scrapeTwitter } from "@/lib/actions/twitter.actions";
import { detectMovers } from "@/lib/actions/movers.actions";
import { aggregateMentions, buildCandidates, makeDedupKey } from "@/lib/actions/signals.utils";
import { sendTelegramMessage, escapeHtml, isTelegramConfigured } from "@/lib/telegram";
import { connectToDatabase } from "@/database/mongoose";
import { Signal } from "@/database/models/signal.model";

export const sendSignUpEmail = inngest.createFunction(
    { id: 'sign-up-email' },
    { event: 'app/user.created'},
    async ({ event, step }) => {
        const userProfile = `
            - Country: ${event.data.country}
            - Investment goals: ${event.data.investmentGoals}
            - Risk tolerance: ${event.data.riskTolerance}
            - Preferred industry: ${event.data.preferredIndustry}
        `

        const prompt = PERSONALIZED_WELCOME_EMAIL_PROMPT.replace('{{userProfile}}', userProfile)

        const introText = await step.run('generate-welcome-intro', async () => {
            try {
                const text = await ollamaGenerate(prompt, { temperature: 0.7 });
                return text || null;
            } catch (e) {
                console.error('welcome-intro: ollama generation failed', e);
                return null;
            }
        })

        await step.run('send-welcome-email', async () => {
            const intro = introText || 'Thanks for joining Signalist. You now have the tools to track markets and make smarter moves.'

            const { data: { email, name } } = event;

            return await sendWelcomeEmail({ email, name, intro });
        })

        return {
            success: true,
            message: 'Welcome email sent successfully'
        }
    }
)

export const sendDailyNewsSummary = inngest.createFunction(
    { id: 'daily-news-summary' },
    [ { event: 'app/send.daily.news' }, { cron: '0 12 * * *' } ],
    async ({ step }) => {
        // Step #1: Get all users for news delivery
        const users = await step.run('get-all-users', getAllUsersForNewsEmail)

        if(!users || users.length === 0) return { success: false, message: 'No users found for news email' };

        // Step #2: For each user, get watchlist symbols -> fetch news (fallback to general)
        const results = await step.run('fetch-user-news', async () => {
            const perUser: Array<{ user: UserForNewsEmail; articles: MarketNewsArticle[] }> = [];
            for (const user of users as UserForNewsEmail[]) {
                try {
                    const symbols = await getWatchlistSymbolsByEmail(user.email);
                    let articles = await getNews(symbols);
                    // Enforce max 6 articles per user
                    articles = (articles || []).slice(0, 6);
                    // If still empty, fallback to general
                    if (!articles || articles.length === 0) {
                        articles = await getNews();
                        articles = (articles || []).slice(0, 6);
                    }
                    perUser.push({ user, articles });
                } catch (e) {
                    console.error('daily-news: error preparing user news', user.email, e);
                    perUser.push({ user, articles: [] });
                }
            }
            return perUser;
        });

        // Step #3: (placeholder) Summarize news via AI
        const userNewsSummaries: { user: UserForNewsEmail; newsContent: string | null }[] = [];

        for (const { user, articles } of results) {
                try {
                    const prompt = NEWS_SUMMARY_EMAIL_PROMPT.replace('{{newsData}}', JSON.stringify(articles, null, 2));

                    const newsContent = await step.run(`summarize-news-${user.email}`, async () => {
                        const text = await ollamaGenerate(prompt, { temperature: 0.5 });
                        return text || 'No market news.';
                    });

                    userNewsSummaries.push({ user, newsContent });
                } catch (e) {
                    console.error('Failed to summarize news for : ', user.email);
                    userNewsSummaries.push({ user, newsContent: null });
                }
            }

        // Step #4: (placeholder) Send the emails
        await step.run('send-news-emails', async () => {
                await Promise.all(
                    userNewsSummaries.map(async ({ user, newsContent}) => {
                        if(!newsContent) return false;

                        return await sendNewsSummaryEmail({ email: user.email, date: getFormattedTodayDate(), newsContent })
                    })
                )
            })

        return { success: true, message: 'Daily news summary emails sent successfully' }
    }
)

// ---------------------------------------------------------------------------
// Market signal scanner
//
// Scrapes Reddit + StockTwits (+ optional Twitter), detects sudden price moves
// via Finnhub, aggregates ticker mentions, ranks candidates, asks the local
// Ollama model which are genuinely notable, dedups against MongoDB, and pushes
// the survivors to Telegram.
//
// Runs on a cron (default every 15 min) and is also triggerable on demand via
// the 'app/scan.signals' event so you can test it without waiting.
// ---------------------------------------------------------------------------

interface OllamaSignalResult {
    symbol: string;
    notable?: boolean;
    direction?: 'up' | 'down' | 'neutral';
    confidence?: 'high' | 'medium' | 'low';
    summary?: string;
}

const SCAN_CRON = process.env.SIGNAL_SCAN_CRON || '*/15 * * * *';

export const scanMarketSignals = inngest.createFunction(
    { id: 'scan-market-signals', concurrency: 1 },
    [ { event: 'app/scan.signals' }, { cron: SCAN_CRON } ],
    async ({ step }) => {
        // Step #1: Scrape all social sources + detect price movers in parallel.
        const scraped = await step.run('scrape-sources', async () => {
            const [reddit, stocktwits, twitter] = await Promise.all([
                scrapeReddit(),
                scrapeStockTwits(),
                scrapeTwitter(),
            ]);
            return [...reddit, ...stocktwits, ...twitter];
        });

        // Step #2: Aggregate mentions, then quote-check the buzzing symbols too.
        const aggregates = aggregateMentions(scraped as ScrapedMention[]);
        const buzzingSymbols = aggregates.slice(0, 40).map((a) => a.symbol);

        const movers = await step.run('detect-movers', async () => {
            return await detectMovers({ extraSymbols: buzzingSymbols });
        });

        // Step #3: Build ranked candidate signals.
        const candidates = buildCandidates(aggregates, movers as MoverSignal[]);
        if (candidates.length === 0) {
            return { success: true, message: 'No candidate signals this scan' };
        }

        // Step #4: Ask Ollama which candidates are genuinely notable.
        const analysis = await step.run('analyze-signals', async () => {
            const top = candidates.slice(0, 15); // keep the prompt small/fast
            const prompt = SIGNAL_ANALYSIS_PROMPT.replace(
                '{{candidates}}',
                JSON.stringify(top, null, 2)
            );
            const parsed = await ollamaGenerateJSON<{ signals?: OllamaSignalResult[] }>(
                prompt,
                { temperature: 0.2 }
            );
            return parsed?.signals ?? [];
        });

        const notable = (analysis as OllamaSignalResult[]).filter((s) => s?.notable && s.symbol);
        if (notable.length === 0) {
            return { success: true, message: `Scanned ${candidates.length} candidates, none notable` };
        }

        // Step #5: Dedup against MongoDB and persist the fresh ones.
        const fresh = await step.run('dedup-and-store', async () => {
            await connectToDatabase();
            const bySymbol = new Map(candidates.map((c) => [c.symbol, c]));
            const kept: Array<{ signal: OllamaSignalResult; candidate: CandidateSignal }> = [];

            for (const signal of notable) {
                const candidate = bySymbol.get(signal.symbol.toUpperCase());
                if (!candidate) continue;
                const direction = signal.direction || candidate.direction;
                const dedupKey = makeDedupKey(candidate.symbol, direction);
                try {
                    await Signal.create({
                        symbol: candidate.symbol,
                        sources: candidate.sources,
                        direction,
                        score: candidate.score,
                        mentions: candidate.mentions,
                        changePercent: candidate.changePercent,
                        summary: signal.summary || '',
                        dedupKey,
                    });
                    kept.push({ signal, candidate });
                } catch (e: unknown) {
                    // Duplicate key => already alerted this bucket; skip silently.
                    if ((e as { code?: number })?.code !== 11000) {
                        console.error('signal store error for', candidate.symbol, e);
                    }
                }
            }
            return kept;
        });

        if (fresh.length === 0) {
            return { success: true, message: 'All notable signals were already alerted' };
        }

        // Step #6: Send Telegram alerts.
        await step.run('send-telegram', async () => {
            if (!isTelegramConfigured()) {
                console.error('scan: Telegram not configured; skipping alerts');
                return;
            }
            for (const { signal, candidate } of fresh) {
                await sendTelegramMessage(formatSignalMessage(signal, candidate));
            }
        });

        return { success: true, message: `Sent ${fresh.length} signal alert(s)` };
    }
)

function formatSignalMessage(signal: OllamaSignalResult, candidate: CandidateSignal): string {
    const arrow = signal.direction === 'up' ? '🟢▲' : signal.direction === 'down' ? '🔴▼' : '⚪';
    const move = candidate.changePercent != null
        ? ` (${candidate.changePercent > 0 ? '+' : ''}${candidate.changePercent}%)`
        : '';
    const conf = signal.confidence ? ` · ${signal.confidence} confidence` : '';
    const sources = candidate.sources.join(', ');

    return [
        `${arrow} <b>$${escapeHtml(candidate.symbol)}</b>${escapeHtml(move)}`,
        escapeHtml(signal.summary || ''),
        `<i>${candidate.mentions} mentions · ${escapeHtml(sources)}${escapeHtml(conf)}</i>`,
    ].filter(Boolean).join('\n');
}
