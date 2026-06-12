import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

/**
 * Shape of the freqtrade webhook payload as configured in
 * bot/user_data/config/config.dryrun.json. All values arrive as strings
 * (freqtrade renders them through format templates); `type` discriminates
 * the event. Phase 2 turns these into Telegram tickets — Phase 0 only
 * logs them.
 */
export interface FreqtradeWebhookPayload {
  type?: string;
  pair?: string;
  trade_id?: string;
  [key: string]: unknown;
}

export function buildApp(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true, ...opts });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post<{ Body: FreqtradeWebhookPayload }>("/signal", async (request) => {
    const signal = request.body ?? {};
    // HARD INVARIANT: a signal is never silently dropped. Until ticket
    // building exists (Phase 2), the structured log line IS the ticket.
    request.log.info(
      { signal, event: signal.type ?? "unknown", pair: signal.pair },
      "freqtrade signal received"
    );
    return { received: true };
  });

  return app;
}
