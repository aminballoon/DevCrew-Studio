import { NotFoundError, ConflictError } from './errors.ts';

/**
 * In-memory table. Reads return deep copies, so callers can never change stored
 * rows by accident; writes go through insert / update.
 */
export class Table<T extends { id: string }> {
  private rows = new Map<string, T>();
  private label: string;

  constructor(label: string) { this.label = label; }

  insert(row: T): T {
    if (this.rows.has(row.id)) { throw new ConflictError(`${this.label} ${row.id} already exists`); }
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  /** Throws NotFoundError when missing. */
  get(id: string): T {
    const row = this.rows.get(id);
    if (!row) { throw new NotFoundError(this.label); }
    return structuredClone(row);
  }

  find(id: string): T | undefined {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  /** Applies `change` to a copy and stores it. Returns the stored copy. */
  update(id: string, change: (row: T) => void): T {
    const row = this.get(id);
    change(row);
    this.rows.set(id, structuredClone(row));
    return structuredClone(row);
  }

  list(filter?: (row: T) => boolean): T[] {
    const all = [...this.rows.values()];
    return (filter ? all.filter(filter) : all).map(r => structuredClone(r));
  }

  get size(): number { return this.rows.size; }
}
