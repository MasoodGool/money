import { describe, expect, it, vi } from "vitest";

import { TelegramNotifier, type PostResult } from "../src/telegram.js";

function okPost(): { post: (u: string, j: unknown) => Promise<PostResult>; calls: Array<{ url: string; json: unknown }> } {
  const calls: Array<{ url: string; json: unknown }> = [];
  return {
    calls,
    post: async (url, json) => {
      calls.push({ url, json });
      return { ok: true, status: 200, body: '{"ok":true}' };
    },
  };
}

describe("TelegramNotifier", () => {
  it("posts to the bot sendMessage endpoint with chat_id and text", async () => {
    const { post, calls } = okPost();
    const n = new TelegramNotifier({ botToken: "TKN", chatId: "999", post });

    await n.notify("🟢 AUTO-ENTRY #1042 SOL/USDT");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/botTKN/sendMessage");
    expect(calls[0]!.json).toMatchObject({
      chat_id: "999",
      text: "🟢 AUTO-ENTRY #1042 SOL/USDT",
    });
  });

  it("does not throw when Telegram returns a non-ok status (logs instead)", async () => {
    const log = vi.fn();
    const n = new TelegramNotifier({
      botToken: "TKN",
      chatId: "999",
      log,
      post: async () => ({ ok: false, status: 400, body: "Bad Request: chat not found" }),
    });

    await expect(n.notify("hi")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(/HTTP 400/);
  });

  it("does not throw when the transport errors — execution must not break", async () => {
    const log = vi.fn();
    const n = new TelegramNotifier({
      botToken: "TKN",
      chatId: "999",
      log,
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    await expect(n.notify("hi")).resolves.toBeUndefined();
    expect(log.mock.calls[0]![0]).toMatch(/ECONNREFUSED/);
  });
});
