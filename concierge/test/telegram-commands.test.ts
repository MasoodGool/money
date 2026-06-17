import { describe, expect, it, vi } from "vitest";

import type { Executor } from "../src/executor.js";
import {
  executeCommand,
  TelegramCommandListener,
  type CommandContext,
  type TelegramTransport,
  type TelegramUpdate,
} from "../src/telegram-commands.js";

/** Fake executor exposing only what the command handler touches. */
function fakeExecutor(overrides: Partial<Record<string, unknown>> = {}) {
  const state = { kill: false, equity: 10000 };
  const ex = {
    setKillSwitch: vi.fn((v: boolean) => (state.kill = v)),
    isKillSwitchOn: vi.fn(() => state.kill),
    setEquity: vi.fn((v: number) => (state.equity = v)),
    getEquity: vi.fn(() => state.equity),
    getOpenPositions: vi.fn(() => [] as unknown[]),
    remainingDailyBudget: vi.fn(() => 300),
    getRiskConfig: vi.fn(() => ({
      equity: 10000,
      riskPerTrade: 0.01,
      maxPositionPct: 0.2,
      dailyLossLimit: 0.03,
      stopLossPct: 0.05,
      stopLimitOffsetPct: 0.005,
      takeProfitPct: 0.08,
    })),
    ...overrides,
  };
  return { ex: ex as unknown as Executor, state, raw: ex };
}

function ctx(ex: Executor, testnet = true): CommandContext {
  return { executor: ex, testnet };
}

describe("executeCommand", () => {
  it("ignores non-command text", async () => {
    const { ex } = fakeExecutor();
    expect(await executeCommand("hello there", ctx(ex))).toBeUndefined();
  });

  it("/kill engages the kill switch", async () => {
    const { ex, raw, state } = fakeExecutor();
    const reply = await executeCommand("/kill", ctx(ex));
    expect(raw.setKillSwitch).toHaveBeenCalledWith(true);
    expect(state.kill).toBe(true);
    expect(reply).toMatch(/ENGAGED/);
  });

  it("/arm disengages the kill switch", async () => {
    const { ex, raw } = fakeExecutor();
    await executeCommand("/arm", ctx(ex));
    expect(raw.setKillSwitch).toHaveBeenCalledWith(false);
  });

  it("/equity sets a valid number and rejects junk", async () => {
    const { ex, raw, state } = fakeExecutor();
    const ok = await executeCommand("/equity 25000", ctx(ex));
    expect(raw.setEquity).toHaveBeenCalledWith(25000);
    expect(state.equity).toBe(25000);
    expect(ok).toMatch(/25000/);

    raw.setEquity.mockClear();
    const bad = await executeCommand("/equity abc", ctx(ex));
    expect(raw.setEquity).not.toHaveBeenCalled();
    expect(bad).toMatch(/Usage/);
  });

  it("/risk and /status render readouts", async () => {
    const { ex } = fakeExecutor();
    expect(await executeCommand("/risk", ctx(ex))).toMatch(/Equity: 10000/);
    const status = await executeCommand("/status", ctx(ex, false));
    expect(status).toMatch(/MAINNET/);
  });

  it("strips a @botname suffix (group chats)", async () => {
    const { ex, raw } = fakeExecutor();
    await executeCommand("/kill@my_trading_bot", ctx(ex));
    expect(raw.setKillSwitch).toHaveBeenCalledWith(true);
  });

  it("reports unknown commands", async () => {
    const { ex } = fakeExecutor();
    expect(await executeCommand("/frobnicate", ctx(ex))).toMatch(/Unknown command/);
  });
});

describe("TelegramCommandListener.pollOnce", () => {
  function transport(updates: TelegramUpdate[]) {
    const sent: Array<{ chatId: string; text: string }> = [];
    let served = false;
    const t: TelegramTransport = {
      getUpdates: async () => {
        if (served) return [];
        served = true;
        return updates;
      },
      sendMessage: async (chatId, text) => void sent.push({ chatId, text }),
    };
    return { t, sent };
  }

  it("dispatches commands only from the authorised chat", async () => {
    const { ex, raw } = fakeExecutor();
    const { t, sent } = transport([
      { updateId: 1, chatId: "999", text: "/kill" }, // wrong chat — ignored
      { updateId: 2, chatId: "42", text: "/kill" }, // authorised
    ]);
    const listener = new TelegramCommandListener({ transport: t, chatId: "42", context: ctx(ex) });

    const dispatched = await listener.pollOnce();
    expect(dispatched).toBe(1);
    expect(raw.setKillSwitch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe("42");
  });

  it("advances offset past non-command messages without replying", async () => {
    const { ex } = fakeExecutor();
    const { t, sent } = transport([{ updateId: 5, chatId: "42", text: "just chatting" }]);
    const listener = new TelegramCommandListener({ transport: t, chatId: "42", context: ctx(ex) });
    expect(await listener.pollOnce()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
