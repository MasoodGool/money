import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { Executor, EntryOutcome, ExitOutcome, SignalInput } from "../src/executor.js";

/** Minimal Executor stub recording what the route layer dispatched. */
function makeExecutorStub() {
  const entries: SignalInput[] = [];
  const exits: SignalInput[] = [];
  const stub = {
    handleEntry: vi.fn(async (s: SignalInput): Promise<EntryOutcome> => {
      entries.push(s);
      return { action: "placed", tradeId: s.trade_id, amount: 1, stakeQuote: 100 };
    }),
    handleExit: vi.fn(async (s: SignalInput): Promise<ExitOutcome> => {
      exits.push(s);
      return { action: "closed", tradeId: s.trade_id, realizedQuote: 0 };
    }),
  };
  return { stub: stub as unknown as Executor, entries, exits, raw: stub };
}

const entryPayload = {
  type: "entry",
  trade_id: "1042",
  pair: "SOL/USDT",
  open_rate: "142.30",
  current_rate: "142.31",
};

describe("GET /healthz", () => {
  it("reports ok", async () => {
    const { stub } = makeExecutorStub();
    const app = buildApp({ executor: stub }, { logger: false });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /signal routing", () => {
  it("dispatches an entry event to the executor with the open_rate", async () => {
    const { stub, entries, raw } = makeExecutorStub();
    const app = buildApp({ executor: stub }, { logger: false });

    const res = await app.inject({ method: "POST", url: "/signal", payload: entryPayload });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, action: "placed" });
    expect(raw.handleEntry).toHaveBeenCalledOnce();
    expect(entries[0]).toEqual({ type: "entry", trade_id: "1042", pair: "SOL/USDT", rate: 142.3 });
  });

  it("dispatches an exit event using close_rate", async () => {
    const { stub, exits } = makeExecutorStub();
    const app = buildApp({ executor: stub }, { logger: false });

    await app.inject({
      method: "POST",
      url: "/signal",
      payload: { type: "exit", trade_id: "1042", pair: "SOL/USDT", close_rate: "150.0" },
    });

    expect(exits[0]).toEqual({ type: "exit", trade_id: "1042", pair: "SOL/USDT", rate: 150 });
  });

  it("does not execute on fills/cancels/status — only notes them", async () => {
    const { stub, raw } = makeExecutorStub();
    const app = buildApp({ executor: stub }, { logger: false });

    for (const type of ["entry_fill", "exit_fill", "entry_cancel", "status"]) {
      const res = await app.inject({
        method: "POST",
        url: "/signal",
        payload: { type, trade_id: "1", pair: "SOL/USDT", open_rate: "1" },
      });
      expect(res.json()).toMatchObject({ received: true, action: "noted" });
    }
    expect(raw.handleEntry).not.toHaveBeenCalled();
    expect(raw.handleExit).not.toHaveBeenCalled();
  });

  it("never drops a signal: acknowledges an unparseable payload", async () => {
    const { stub } = makeExecutorStub();
    const app = buildApp({ executor: stub }, { logger: false });
    const res = await app.inject({ method: "POST", url: "/signal", payload: { foo: "bar" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, action: "ignored" });
  });
});
