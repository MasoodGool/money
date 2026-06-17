/**
 * Telegram notifier: pushes notify-only alerts to a chat via the Bot API.
 *
 * Resilience invariant: notification is downstream of execution, so a
 * Telegram outage must NEVER break the order flow. notify() therefore
 * catches everything and logs — it never throws back into the executor.
 */

import type { Notifier } from "./notifier.js";

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
