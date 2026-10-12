This project is an existing meeting room booking library (`src/index.ts`) with passing tests in `tests/`. Everything it does today must keep working, except where this change request says otherwise. Keep everything exported from `src/index.ts`.

## Change request

### 1. Weekly recurring bookings
Add `bookRecurring(actor, orgId, { roomId, start, end, title, attendees, weeks })`.
- It books the same slot every week for `weeks` weeks, starting with the given `start` / `end` (occurrence *k* is shifted by exactly *k* × 7 days in UTC).
- `weeks` is an integer from 2 to 12; otherwise `ValidationError`. Members may book at most 4 weeks (more throws `ValidationError`); admins up to 12.
- Every occurrence follows the same rules as a single booking (time-zone, 15-minute boundaries, duration, past, title, attendees, capacity, roles).
- All or nothing: if any occurrence would overlap an active booking, nothing is booked and `ConflictError` is thrown.
- It returns the bookings in time order. Each has the usual fields plus `seriesId` (a string shared by the whole series). Single bookings keep their current shape with no `seriesId` property.

### 2. The member limit counts a series once
A member may still hold at most 3 upcoming active bookings in one organisation, but a series counts as one, as long as at least one of its occurrences is active and not yet ended. Booking a new series when the member already holds 3 throws `ConflictError`.

### 3. Cancelling a series
Add `cancelSeries(actor, orgId, seriesId, options?)`. It cancels every active occurrence of the series, or with `options.from` (ISO time with a time-zone) only the occurrences that start at or after `from`. It returns the bookings it cancelled, in time order (an empty array if none were left to cancel). The same people who may cancel a booking may cancel a series. An unknown series, or a series of another organisation, throws `NotFoundError`.

### 4. Shorter bookings for members
Members may now book at most 4 hours at a time (`ValidationError` above that), for single and recurring bookings. Admins keep the 8-hour limit.

No dependencies. Tests run with `node --test` (Node runs `.ts` files directly; import with the `.ts` extension).
