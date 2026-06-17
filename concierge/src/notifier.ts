/**
 * Notifier abstracts outbound alerts. Today it logs; a Telegram
 * implementation drops in later without touching the executor.
 *
 * Under fully-autonomous execution these messages are notify-only — they
 * report what the system already did; they are not a confirmation gate.
 */

export interface Notifier {
  notify(message: string): Promise<void>;
}

export class LogNotifier implements Notifier {
  constructor(private readonly log: (msg: string) => void = console.log) {}

  async notify(message: string): Promise<void> {
    this.log(message);
  }
}
