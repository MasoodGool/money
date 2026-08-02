/**
 * Inbound Telegram control — the remote safety panel for the autonomous bot.
 * The human can't confirm each trade (fully autonomous), so they need a way
 * to slam the brakes and inspect state from their phone:
 *
 *   /kill           engage the kill switch (suppress all entries)
 *   /arm            disengage the kill switch (resume auto-execution)
 *   /equity <usdt>  update the equity used for position sizing
 *   /risk           show equity, limits, remaining daily budget, positions
 *   /status         show kill switch, venue, open-position count
 *   /help           list commands
 *
 * Commands are accepted ONLY from the configured chat id; anything else is
 * ignored. executeCommand is pure (side effects via the executor) so it is
 * unit-tested without network; the listener is a thin long-poll loop.
 */

import type { Executor } from "./executor.js";

export interface CommandContext {
  executor: Executor;
  /** Whether orders go to testnet (for the status readout). */
  testnet: boolean;
  /** Currency label for money in the readout. */
  quoteCurrency?: string;
}

/**
 * Interpret one inbound message. Returns the reply text, or undefined if the
 * message is not a command we handle (so the listener stays quiet).
 */
export async function executeCommand(
  text: string,
  ctx: CommandContext
): Promise<string | undefined> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const [rawCmd, ...args] = trimmed.split(/\s+/);
  // Strip a @botname suffix Telegram adds in group chats.
  const cmd = rawCmd!.slice(1).split("@")[0]!.toLowerCase();
  const ex = ctx.executor;

  switch (cmd) {
    case "kill":
      ex.setKillSwitch(true);
      return "🔴 Kill switch ENGAGED — all entries suppressed. Open positions keep their brackets.";

    case "arm":
      ex.setKillSwitch(false);
      return "🟢 ARMED — auto-execution active.";

    case "equity": {
      const value = Number(args[0]);
      if (args.length === 0 || !Number.isFinite(value) || value <= 0) {
        return "Usage: /equity <positive number>  e.g. /equity 25000";
      }
      ex.setEquity(value);
      return `💰 Equity set to ${value} ${ctx.quoteCurrency ?? "USDT"}. New sizing uses this immediately.`;
    }

    case "risk": {
      const r = ex.getRiskConfig();
      const positions = ex.getOpenPositions();
      const lines = [
        `Equity: ${ex.getEquity()} ${ctx.quoteCurrency ?? "USDT"}`,
        `Risk/trade: ${(r.riskPerTrade * 100).toFixed(2)}%  |  Max position: ${(r.maxPositionPct * 100).toFixed(0)}%`,
        `Daily loss limit: ${(r.dailyLossLimit * 100).toFixed(0)}%  |  Remaining today: ${ex.remainingDailyBudget().toFixed(2)} ${ctx.quoteCurrency ?? "USDT"}`,
        `Open positions: ${positions.length}`,
        ...positions.map((p) => `  • #${p.tradeId} ${p.symbol} ${p.amount} @ ${p.entryPrice}`),
      ];
      return lines.join("\n");
    }

    case "status":
      return [
        `Kill switch: ${ex.isKillSwitchOn() ? "🔴 ON (suppressing)" : "🟢 OFF (armed)"}`,
        `Venue: ${ctx.testnet ? "TESTNET (paper)" : "MAINNET (real funds)"}`,
        `Open positions: ${ex.getOpenPositions().length}`,
      ].join("\n");

    case "help":
    case "start":
      return [
        "Commands:",
        "/status — kill switch, venue, open positions",
        "/risk — equity, limits, daily budget, positions",
        "/kill — engage kill switch (stop new entries)",
        "/arm — resume auto-execution",
        "/equity <usdt> — update sizing equity",
      ].join("\n");

    default:
      return `Unknown command: /${cmd}. Try /help`;
  }
}

/** Minimal Telegram transport so the listener is testable without network. */
export interface TelegramUpdate {
  updateId: number;
  chatId: string;
  text: string;
}
export interface TelegramTransport {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
}

export interface ListenerOptions {
  transport: TelegramTransport;
  /** Only this chat id may issue commands. */
  chatId: string;
  context: CommandContext;
  log?: (msg: string) => void;
}

export class TelegramCommandListener {
  private readonly transport: TelegramTransport;
  private readonly chatId: string;
  private readonly context: CommandContext;
  private readonly log: (msg: string) => void;
  private offset = 0;
  private running = false;

  constructor(opts: ListenerOptions) {
    this.transport = opts.transport;
    this.chatId = opts.chatId;
    this.context = opts.context;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  /** Process one batch of updates; returns how many were dispatched. */
  async pollOnce(): Promise<number> {
    const updates = await this.transport.getUpdates(this.offset);
    let dispatched = 0;
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.updateId + 1);
      // Ignore anything not from the authorised chat.
      if (String(u.chatId) !== String(this.chatId)) continue;
      const reply = await executeCommand(u.text, this.context);
      if (reply !== undefined) {
        await this.transport.sendMessage(this.chatId, reply);
        dispatched++;
      }
    }
    return dispatched;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        // A polling hiccup must not kill the control channel.
        this.log(`telegram command poll error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}
