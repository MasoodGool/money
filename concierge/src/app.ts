import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { Executor, SignalInput } from "./executor.js";

/**
 * freqtrade webhook payload (see config.dryrun.json). All values arrive as
 * strings via freqtrade's format templates; `type` discriminates the event.
 */
export interface FreqtradeWebhookPayload {
  type?: string;
  pair?: string;
  trade_id?: string | number;
  open_rate?: string | number;
  current_rate?: string | number;
  close_rate?: string | number;
  [key: string]: unknown;
}

export interface AppDeps {
  executor: Executor;
}

/**
 * Pull the price relevant to the event: entry uses open_rate, exit close_rate.
 * A rate is only required for the events we execute on (entry/exit); for
 * informational events it may be absent and the rate is left NaN.
 */
function normalizeSignal(p: FreqtradeWebhookPayload): SignalInput | undefined {
  const type = p.type;
  const tradeId = p.trade_id;
  const pair = p.pair;
  if (typeof type !== "string" || tradeId === undefined || typeof pair !== "string") {
    return undefined;
  }
  const isExit = type.startsWith("exit");
  const rawRate = isExit ? (p.close_rate ?? p.current_rate) : (p.open_rate ?? p.current_rate);
  return { type, trade_id: String(tradeId), pair, rate: Number(rawRate) };
}

export function buildApp(deps: AppDeps, opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true, ...opts });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post<{ Body: FreqtradeWebhookPayload }>("/signal", async (request, reply) => {
    const payload = request.body ?? {};
    const signal = normalizeSignal(payload);

    request.log.info(
      { signal: payload, event: payload.type ?? "unknown", pair: payload.pair },
      "freqtrade signal received"
    );

    if (!signal) {
      // Never silently drop: acknowledge, but flag the malformed payload.
      request.log.warn({ payload }, "unparseable signal — no action taken");
      return reply.code(200).send({ received: true, action: "ignored", reason: "unparseable" });
    }

    // Act on the decision events only. *_fill / *_cancel / status are
    // informational (freqtrade is in dry-run; its fills are paper). The
    // executor is idempotent per trade_id as a second line of defence.
    if (signal.type === "entry" || signal.type === "exit") {
      if (!Number.isFinite(signal.rate)) {
        request.log.warn({ payload }, "decision event missing a usable price");
        return reply.code(200).send({ received: true, action: "ignored", reason: "no price" });
      }
      const outcome =
        signal.type === "entry"
          ? await deps.executor.handleEntry(signal)
          : await deps.executor.handleExit(signal);
      return reply.code(200).send({ received: true, ...outcome });
    }

    // Cancels, fills, status, etc. — logged above, no execution side effect.
    return reply.code(200).send({ received: true, action: "noted" });
  });

  return app;
}
