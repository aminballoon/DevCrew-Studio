/** All "now" reads go through a Clock so tests can move time. Never call `new Date()` in services. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests can set and advance. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: string | Date) { this.t = new Date(start).getTime(); }
  now(): Date { return new Date(this.t); }
  set(at: string | Date): void { this.t = new Date(at).getTime(); }
  advance(ms: number): void { this.t += ms; }
  advanceDays(days: number): void { this.t += days * DAY_MS; }
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export const iso = (d: Date | number): string => new Date(d).toISOString();

/** The UTC calendar day of a timestamp, `YYYY-MM-DD`. Reports group by this. */
export const utcDay = (d: Date | string | number): string => new Date(d).toISOString().slice(0, 10);
