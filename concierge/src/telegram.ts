/**
 * Telegram notifier: pushes notify-only alerts to a chat via the Bot API.
 *
 * Resilience invariant: notification is downstream of execution, so a
 * Telegram outage must NEVER break the order flow. notify() therefore
 * catches everything and logs — it never throws back into the executor.
 */

import type { Notifier } from "./notifier.js";
import type { TelegramTransport, TelegramUpdate } from "./telegram-commands.js";

/** Minimal POST result so tests don't need to fake the whole fetch Response. */
export interface PostResult {
  ok: boolean;
  status: number;
  body: string;
}

export type Poster = (url: string, json: unknown) => Promise<PostResult>;

/**
 * Default transport over Node 22's global fetch, with a hard timeout so a
 * hanging or unreachable Telegram endpoint can never stall the executor.
 */
const fetchPoster: Poster = async (url, json) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
    signal: AbortSignal.timeout(5000),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
};

export interface TelegramOptions {
  botToken: string;
  chatId: string;
  /** Injectable transport for tests. */
  post?: Poster;
  /** Where to report send failures. */
  log?: (msg: string) => void;
}

export class TelegramNotifier implements Notifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly post: Poster;
  private readonly log: (msg: string) => void;

  constructor(opts: TelegramOptions) {
    this.botToken = opts.botToken;
    this.chatId = opts.chatId;
    this.post = opts.post ?? fetchPoster;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  async notify(message: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      // Plain text (no parse_mode) so emojis and ad-hoc reasons can't trip
      // Markdown/HTML parsing and get the message rejected.
      const res = await this.post(url, {
        chat_id: this.chatId,
        text: message,
        disable_web_page_preview: true,
      });
      if (!res.ok) {
        this.log(`telegram send failed: HTTP ${res.status} ${res.body}`);
      }
    } catch (err) {
      this.log(`telegram send error: ${(err as Error).message}`);
    }
  }
}

/**
 * Live Telegram transport for the command listener: a 30s long-poll on
 * getUpdates plus a sendMessage. Built on global fetch with timeouts.
 */
export function createTelegramTransport(botToken: string): TelegramTransport {
  const base = `https://api.telegram.org/bot${botToken}`;
  return {
    async getUpdates(offset: number): Promise<TelegramUpdate[]> {
      // Long-poll up to 30s; client timeout slightly higher so we don't abort
      // a healthy poll early.
      const res = await fetch(`${base}/getUpdates?timeout=30&offset=${offset}`, {
        signal: AbortSignal.timeout(35000),
      });
      const data = (await res.json()) as {
        ok: boolean;
        result?: Array<{ update_id: number; message?: { text?: string; chat?: { id: number } } }>;
      };
      if (!data.ok || !data.result) return [];
      const updates: TelegramUpdate[] = [];
      for (const u of data.result) {
        const text = u.message?.text;
        const chatId = u.message?.chat?.id;
        if (typeof text === "string" && chatId !== undefined) {
          updates.push({ updateId: u.update_id, chatId: String(chatId), text });
        } else {
          // Still advance past non-text updates so we don't re-fetch them.
          updates.push({ updateId: u.update_id, chatId: "", text: "" });
        }
      }
      return updates;
    },
    async sendMessage(chatId: string, text: string): Promise<void> {
      await fetch(`${base}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      });
    },
  };
}
