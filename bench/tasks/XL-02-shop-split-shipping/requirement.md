This project is an existing online shop backend (`src/`, start with `README.md` and `src/app.ts`) with its tests in `tests/`. Everything it does today must keep working, except where this change request says otherwise. Keep `createApp` and everything else exported from `src/index.ts`. Follow the conventions the code already uses. Update the existing tests where this change makes them wrong, and keep them all passing.

## Change request: shipping from several warehouses

An order whose units are reserved in more than one warehouse now ships as several parcels, one from each warehouse.

### 1. Shipping one warehouse's part
`POST /orders/:id/shipments` now takes `{ warehouseId, carrier, trackingNumber }`.
- `warehouseId` is required (`400` if it is missing). An unknown warehouse is `404`.
- The shipment contains everything the order has reserved at that warehouse, for all lines. Only that warehouse's stock goes down, with the usual `ship` stock movements.
- Two cases are `409`: the order has nothing reserved at that warehouse, or that warehouse has already shipped its part of this order.
- The order must be `paid` or `partially_shipped` (`409` otherwise).
- A shipment now includes `warehouseId`, and its `allocations` only list that warehouse's units.

### 2. Order status
- New status `partially_shipped`: after a shipment, if other warehouses still have to ship their part. The order becomes `shipped` once every warehouse has shipped. An order reserved in one warehouse goes straight to `shipped`, as today.
- Each status change is added to the order's `history`.
- Moving to `partially_shipped` publishes `order.partially_shipped`. `order.shipped` is published when the order becomes `shipped`.
- A `partially_shipped` order cannot be cancelled (`409`).

### 3. Listing shipments
`GET /orders/:id/shipments` lists the order's shipments, oldest first, with the same visibility as the order. `GET /orders/:id/shipment` is removed.

### 4. Delivery
Each parcel is delivered on its own with `POST /shipments/:id/deliver`. The order becomes `delivered` when it is `shipped` and all of its shipments are delivered. Its `deliveredAt` is the time of the last delivery, so the 30-day return window starts then. Delivering a parcel while other warehouses have not yet shipped does not change the order's status.

### 5. Emails
The customer gets an `order_shipped` email for every shipment. Its subject is:
- `Part of order SO-1001 is on its way` while other warehouses still have to ship;
- `Order SO-1001 is on its way` for the shipment that completes the order, and for an order that ships in one go.

### 6. Returns go back where they came from
Returned units now go back to the warehouses that shipped them, instead of all going to the line's first warehouse:
- The units of a line are counted back to the line's `fulfilment` warehouses in order. Each warehouse takes at most the units it shipped for that line, minus the units of that line already counted back to it by earlier approved returns.
- `resellable` units are restocked where they are counted, with one `return` movement per warehouse.
- `damaged` units are counted the same way but are not restocked.
