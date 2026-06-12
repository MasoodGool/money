import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

/** Collects pino log lines so tests can assert on what was logged. */
function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line));
      }
      callback();
    },
  });
  return { lines, stream };
}

const sampleEntrySignal = {
  type: "entry",
  trade_id: "1",
  exchange: "binance",
  pair: "SOL/USDT",
  direction: "long",
  open_rate: "142.30",
  amount: "0.611",
  stake_amount: "87",
  stake_currency: "USDT",
  current_rate: "142.31",
  enter_tag: "",
  open_date: "2026-06-12 10:00:00",
};

describe("GET /healthz", () => {
  it("reports ok", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /signal", () => {
  it("acknowledges a freqtrade entry webhook", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/signal",
      payload: sampleEntrySignal,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });

  it("logs the full payload — a signal is never silently dropped", async () => {
    const { lines, stream } = captureLogs();
    const app = buildApp({ logger: { level: "info", stream } });

    await app.inject({ method: "POST", url: "/signal", payload: sampleEntrySignal });

    const signalLog = lines.find((l) => l["msg"] === "freqtrade signal received");
    expect(signalLog).toBeDefined();
    expect(signalLog?.["signal"]).toMatchObject(sampleEntrySignal);
    expect(signalLog?.["event"]).toBe("entry");
    expect(signalLog?.["pair"]).toBe("SOL/USDT");
  });

  it("handles exit events the same way", async () => {
    const { lines, stream } = captureLogs();
    const app = buildApp({ logger: { level: "info", stream } });

    const res = await app.inject({
      method: "POST",
      url: "/signal",
      payload: { type: "exit", trade_id: "1", pair: "BTC/USDT", exit_reason: "exit_signal" },
    });

    expect(res.statusCode).toBe(200);
    const signalLog = lines.find((l) => l["msg"] === "freqtrade signal received");
    expect(signalLog?.["event"]).toBe("exit");
  });
});
