Build a TypeScript library for booking meeting rooms, shared by several organisations. Everything is exported from one entry point: `src/index.ts`.

## Errors
Export four error classes, each extending `Error`: `ValidationError` (bad input), `AuthError` (the caller may not do this), `NotFoundError` (no such thing, or it belongs to another organisation) and `ConflictError` (the action clashes with existing data).

## Service
`new BookingService(options?)` where `options.now` is an optional function returning the current `Date` (default: the real clock). Every method that acts for someone takes the acting user's id, `actor`, as its first argument.

### Organisations and people
- `createOrg(name, adminUserId)` creates an organisation and returns its id (a string). `adminUserId` becomes its first member, with role `admin`. A name that is empty after trimming throws `ValidationError`.
- `addUser(actor, orgId, userId, role)` adds a member. Roles are `admin`, `member` and `viewer`; any other role throws `ValidationError`. Only admins of that organisation may add people. A user who is already a member throws `ConflictError`.
- One user id may belong to several organisations, with a different role in each. Membership and roles in one organisation give no rights in another.

### Rooms
- `addRoom(actor, orgId, { roomId, name, capacity })`: admins only. `capacity` is an integer from 1 to 500, otherwise `ValidationError`. A `roomId` already used in that organisation throws `ConflictError`. Two organisations may use the same `roomId`; they are different rooms.

### Bookings
`book(actor, orgId, { roomId, start, end, title, attendees })` returns the booking: `{ id, orgId, roomId, userId, start, end, title, attendees, status }` with `status: 'active'`.
- Admins and members may book; viewers may not (`AuthError`). An unknown room throws `NotFoundError`.
- `start` and `end` are ISO 8601 strings that must carry a time-zone (`Z` or `±hh:mm`). Missing time-zone or an unparsable time throws `ValidationError`. Returned times are UTC, in `Date.prototype.toISOString()` form.
- Times must fall on 15-minute boundaries (whole seconds of zero). The booking lasts at least 15 minutes and at most 8 hours, and `start` must be before `end`. It may not start in the past (before `now()`). All of these throw `ValidationError`.
- `title` is trimmed and must be 1 to 100 characters; `attendees` is an integer from 1 to the room's capacity. Otherwise `ValidationError`.
- A booking may not overlap another active booking of the same room: intervals are half-open, so one that ends at 10:00 and one that starts at 10:00 do not overlap. Overlap throws `ConflictError`.
- A `member` may hold at most 3 active bookings that have not ended yet in one organisation; the 4th throws `ConflictError`. Admins have no limit.
- Booking ids are unique strings.

`cancel(actor, orgId, bookingId)` sets the booking's status to `cancelled` and returns it. Only the person who booked it or an admin may cancel (`AuthError`). Cancelling a cancelled booking throws `ConflictError`. A cancelled booking frees its time slot and no longer counts towards the limit of 3.

`getBooking(actor, orgId, bookingId)` returns one booking, including cancelled ones.

`listBookings(actor, orgId, filter?)` returns the active bookings of the organisation sorted by `start`, then `id`. `filter` may have `roomId`, and `from` / `to` (ISO times with a time-zone): only bookings that overlap `[from, to)` are returned.

`freeSlots(actor, orgId, roomId, from, to)` returns the free gaps of a room inside `[from, to)` as `{ start, end }` in UTC ISO form, sorted, with neighbouring gaps merged and empty gaps left out.

### Access rules for every method
- An `actor` who is not a member of `orgId` gets `AuthError`. Any member, viewers included, may read (`getBooking`, `listBookings`, `freeSlots`).
- An unknown organisation throws `NotFoundError`.
- A booking or room that exists in another organisation must look exactly like one that does not exist: `NotFoundError`.
- Objects returned to callers are copies: changing them does not change the service's data.

No dependencies. Tests run with `node --test` (Node runs `.ts` files directly; import with the `.ts` extension).
