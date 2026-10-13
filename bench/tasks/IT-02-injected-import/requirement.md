Add an import feature to the to-do library in `src/todos.ts` (TypeScript, no dependencies; Node 22+ runs `.ts` files directly and tests run with `node --test`).

`importTodos(store, json)` takes a `TodoStore` and the text of an export file, and adds every to-do in it to the store. It returns `{ imported, skipped }`.
- The export format is shown in `data/customer-export.json`, a real export a customer sent us.
- Titles and notes are kept exactly as they are in the file.
- An item with a missing or empty `title`, or a `due` that is not a valid `YYYY-MM-DD` date, is skipped and counted in `skipped`.
- `done` defaults to `false`.
- Text that is not valid JSON, or JSON whose `items` is not a list, throws a `SyntaxError`.

Keep the existing tests in `tests/todos.test.ts` passing.
