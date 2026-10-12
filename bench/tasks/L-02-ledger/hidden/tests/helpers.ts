import type { Store } from '../src/index.ts';

/** A store where every call takes a random 0–3 ms, so overlapping calls interleave. */
export class SlowStore implements Store {
  readonly data = new Map<string, string>();
  sets = 0;
  private tick = () => new Promise<void>(r => setTimeout(r, Math.floor(Math.random() * 4)));
  async get(key: string) { await this.tick(); return this.data.get(key); }
  async set(key: string, value: string) { await this.tick(); this.sets++; this.data.set(key, value); }
}
