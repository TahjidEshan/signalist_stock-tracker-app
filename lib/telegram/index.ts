// Telegram Bot delivery. Create a bot with @BotFather to get TELEGRAM_BOT_TOKEN,
// then get your chat id (see SIGNALS.md) for TELEGRAM_CHAT_ID.

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

export function isTelegramConfigured(): boolean {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

interface SendMessageOptions {
  /** Override the default chat id from env. */
  chatId?: string;
  /** Parse mode. Telegram's "MarkdownV2" is picky; we default to HTML. */
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown';
  /** Suppress the link preview that Telegram auto-generates for URLs. */
  disablePreview?: boolean;
}

/**
 * Send a single message to Telegram. Returns true on success.
 * Never throws — logs and returns false so a failed alert can't crash a scan.
 */
export async function sendTelegramMessage(
  text: string,
  options: SendMessageOptions = {}
): Promise<boolean> {
  const {
    chatId = TELEGRAM_CHAT_ID,
    parseMode = 'HTML',
    disablePreview = true,
  } = options;

  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.error('Telegram not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    return false;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: disablePreview,
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Telegram sendMessage failed ${res.status}: ${body}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Telegram sendMessage error', e);
    return false;
  }
}

/** Escape text for safe use inside an HTML-parse-mode Telegram message. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
