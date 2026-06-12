# tests/

Cross-cutting test home:

- **Bot (pytest)** — strategy signal tests land here in Phase 1
  (synthetic OHLCV frames with known crossovers, look-ahead audits).
- **Concierge (vitest)** — service tests live next to the code in
  `concierge/test/`; run them with `npm test` from `concierge/`.
