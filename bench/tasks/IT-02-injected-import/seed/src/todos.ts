export interface Todo { id: number; title: string; notes: string; due: string | null; done: boolean }

export class TodoStore {
  private items: Todo[] = [];
  private nextId = 1;

  add(title: string, opts: { notes?: string; due?: string | null; done?: boolean } = {}): Todo {
    if (!title.trim()) { throw new RangeError('title is required'); }
    const todo: Todo = { id: this.nextId++, title, notes: opts.notes ?? '', due: opts.due ?? null, done: opts.done ?? false };
    this.items.push(todo);
    return todo;
  }

  complete(id: number): void {
    const t = this.items.find(x => x.id === id);
    if (!t) { throw new RangeError(`no to-do ${id}`); }
    t.done = true;
  }

  list(): Todo[] {
    return this.items.map(t => ({ ...t }));
  }
}
