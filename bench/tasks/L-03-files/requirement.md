Build a TypeScript library that stores users' files on disk and lets them share files with time-limited links. Everything is exported from one entry point: `src/index.ts`.

## Errors
Export three error classes, each extending `Error`: `ValidationError`, `NotFoundError` and `ConflictError`.

## FileStore
`new FileStore({ root, maxFileBytes, quotaBytes, now? })`. `root` is an existing directory; the store may only create, change or delete files inside it. `maxFileBytes` limits one file, `quotaBytes` limits the total size of one owner's files. `now` is an optional function returning the current `Date` (default: the real clock). All methods are `async`. An owner is any non-empty string.

- `put(owner, name, data, contentType)` stores a file (`data` is a `Uint8Array`) and returns its metadata `{ id, owner, name, size, contentType, sha256, createdAt }` (`sha256` is lowercase hex, `createdAt` is an ISO string from `now()`).
  - `name` is 1 to 255 characters and may not contain `/`, `\`, a NUL character or any control character, may not be `.` or `..`, and may not start with `.`. Otherwise `ValidationError`.
  - An owner may not have two files with the same name (`ConflictError`). Different owners may.
  - Empty files and files over `maxFileBytes` throw `ValidationError`. A file that would take the owner over `quotaBytes` throws `ConflictError`.
  - Allowed types: `image/png`, `image/jpeg`, `application/pdf`, `text/plain`. Any other type throws `ValidationError`. The content must match the type, otherwise `ValidationError`: PNG starts with the bytes `89 50 4E 47 0D 0A 1A 0A`, JPEG with `FF D8 FF`, PDF with `%PDF-`, and `text/plain` must be valid UTF-8 with no NUL bytes.
- `get(owner, id)` returns `{ meta, data }`. A file of another owner must look exactly like one that does not exist: `NotFoundError`.
- `list(owner)` returns the owner's metadata sorted by name.
- `delete(owner, id)` removes the file from disk and frees its quota; its share links stop working.
- `share(owner, id, ttlSeconds)` returns a share token for one of the owner's files. `ttlSeconds` is an integer from 1 to 86400 (`ValidationError`). Tokens must be unguessable: at least 128 random bits, written with only `A-Z a-z 0-9 - _`.
- `openShared(token)` returns `{ meta, data }` while the link is valid. Unknown, expired (`now()` is at or after creation + ttl), revoked or deleted links throw `NotFoundError`.
- `revoke(owner, token)` ends a link early. Only the file's owner may revoke it; for anyone else, and for unknown tokens, `NotFoundError`.
- Returned metadata and data are copies.

No dependencies. Tests run with `node --test` (Node runs `.ts` files directly; import with the `.ts` extension).
