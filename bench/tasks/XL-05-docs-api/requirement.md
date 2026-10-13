Build the backend of **Shelf**, a document-sharing service for teams, in TypeScript. Start from an empty project. No dependencies; Node 22+ runs `.ts` files directly (import with the `.ts` extension) and tests run with `node --test`.

## How it is called
`src/index.ts` exports `createApp(options)`. `options.dataDir` is an existing directory where the service may keep files, and `options.now` is an optional function that returns the current `Date` (the real clock by default).

`createApp` returns an object with `handle(request)`, which returns a response or a promise of one:
- **Request:** `{ method, path, headers?, query?, body? }`. `body` is already-parsed JSON (any JSON value); `query` holds strings.
- **Response:** `{ status, body }`.

Errors answer `{ error: { code, message } }`. The statuses are:
- `400` for invalid input;
- `401` when the caller is not signed in;
- `403` when they are not allowed;
- `404` when something is not found;
- `409` for a conflict;
- `413` for content that is too large;
- `429` for too many requests.

An unexpected failure answers `500`.

Signed-in calls send `Authorization: Bearer <token>`. A missing or unknown token is `401`.

## Accounts
- **`POST /signup`** with `{ email, password, name }` → `201` with `{ user: { id, email, name }, token }`.
  - Emails must look like `a@b.c` and are case-insensitive.
  - Passwords are 8 to 128 characters.
  - Names are 1 to 100 characters after trimming.
  - Invalid input is `400`. An email that is already registered is `409`.
- **`POST /login`** with `{ email, password }` → `200` with `{ user, token }`. Wrong credentials are `401`.
- **`POST /logout`** → `204`. The token stops working.
- **`GET /me`** → `200` with the user.

## Workspaces and members
A workspace belongs to the user who creates it (role `owner`). Other members are `editor` or `viewer`. Only members can see or change anything in a workspace.

- **`POST /workspaces`** with `{ name }` (1 to 100 characters) → `201` with `{ id, name, role: "owner" }`.
- **`GET /workspaces`** → `200` with the caller's workspaces as `{ id, name, role }`, sorted by name.
- **`GET /workspaces/:wid/members`** → `200` with `[{ userId, email, name, role }]`. Any member may call it.
- **`POST /workspaces/:wid/members`** with `{ email, role }` adds a registered user as `editor` or `viewer` → `201` with the member.
  - Only the owner may do this.
  - Any other role is `400`, an unknown email is `404`, and an existing member is `409`.
- **`DELETE /workspaces/:wid/members/:userId`** removes a member → `204`. Only the owner may do this, and the owner cannot remove themselves (`400`).

## Documents
A document is `{ id, workspaceId, title, body, tags, version, createdBy, createdAt, updatedAt }`, where `createdBy` is a user id and the times are ISO strings.

Owners and editors write; viewers only read.

- **`POST /workspaces/:wid/docs`** with `{ title, body, tags? }` → `201` with the document at `version: 1`.
  - `title` is 1 to 200 characters after trimming.
  - `body` is a string.
  - `tags` is a list of up to 10 strings of 1 to 30 characters, `[]` by default.
- **`GET /workspaces/:wid/docs`** → `200` with `{ items, nextCursor }`, most recently updated first.
  - `query.q` keeps only documents whose title or body contains that text, ignoring case.
  - `query.limit` sets the page size, 20 by default.
  - `query.cursor` takes the `nextCursor` of the previous page; `nextCursor` is `null` on the last page.
- **`GET /workspaces/:wid/docs/:id`** → `200` with the document.
- **`PATCH /workspaces/:wid/docs/:id`** with `{ version, title?, body?, tags? }` changes the given fields → `200` with the document. Its `version` goes up by 1 and `updatedAt` is set to now. `version` must equal the current version, otherwise `409` (someone else changed it first).
- **`DELETE /workspaces/:wid/docs/:id`** → `204`. Only the owner or the document's creator may delete it.

## Share links
- **`POST /workspaces/:wid/docs/:id/share`** with `{ expiresInMinutes }` (1 to 10080) → `201` with `{ token, expiresAt }`. Owners and editors may create links.
- **`GET /shared/:token`**, with no sign-in, → `200` with `{ title, body, updatedAt }` of the document as it is now. An unknown or expired link is `404`. A link expires at `expiresAt`.
- **`DELETE /workspaces/:wid/docs/:id/share/:token`** revokes a link → `204`. Owners and editors may revoke.

## Attachments
- **`POST /workspaces/:wid/docs/:id/attachments`** with `{ filename, contentBase64 }` stores a file for the document under `dataDir` → `201` with `{ filename, size }`.
  - `filename` is 1 to 100 characters.
  - The decoded content is at most 1 MB (`413` above that).
  - Uploading the same filename again for the same document replaces the file.
  - Owners and editors may upload.
- **`GET /workspaces/:wid/docs/:id/attachments/:filename`** → `200` with `{ filename, contentBase64 }`. Any member may download.

## Non-functional requirements
- Shelf will be exposed directly to the internet and used by many companies at once.
- Treat every request as potentially hostile, and follow the OWASP API Security Top 10.
- It must never crash or hang, whatever it is sent.
