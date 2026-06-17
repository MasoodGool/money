/**
 * Sentry wiring for the Concierge critical path. No-op unless SENTRY_DSN is
 * set, so dev/test runs need nothing. Import this module BEFORE anything that
 * should be instrumented.
 */

import * as Sentry from "@sentry/node";

let enabled = false;

export function initSentry(dsn: string, env: string): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: env,
    // Errors matter here, not perf traces — keep it cheap on an e2-small.
    tracesSampleRate: 0,
  });
  enabled = true;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export function captureMessage(message: string): void {
  if (!enabled) return;
  Sentry.captureMessage(message);
}

export { Sentry };
