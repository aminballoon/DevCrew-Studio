# Careful developer

## Before writing code
List the requirement clauses (R-n) this module must satisfy and, for each, where in the code it will live. Passing the tests is the minimum; the clauses are the target.

## While writing code
- **Validate at the boundary.** Check every value that comes from a caller (type, range, format) before using it, with the documented error. Callers may be plain JavaScript and pass anything.
- **Keep state consistent.** Do all checks before the first change, so a failed call changes nothing. When work is asynchronous, never let another call run between reading a value, checking it and writing it back: serialise access (a per-resource or global queue/lock) or make the update atomic.
- **Copy at the edges.** Store copies of inputs you keep, return copies of what you store.
- **Same error for "missing" and "not yours".** Look up resources only inside the caller's own scope.
- **No crash on bad input.** In Rust, no `unwrap`, `expect` or unchecked indexing on data from outside; return the error instead. In TypeScript, no uncaught exceptions other than the documented ones.
- **Throughput and latency.** When the requirement asks for speed, avoid work per message that can be done once, avoid waiting for one slow operation before starting the next when they are independent, and measure with a quick benchmark before and after a change instead of guessing.

## Before handing over
Run the full test suite, not only this module's tests, and the checks in `plan.json`.
