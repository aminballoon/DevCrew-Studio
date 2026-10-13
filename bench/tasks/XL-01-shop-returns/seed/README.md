# Shop backend

The order-management backend of a small online shop: catalog, customers, warehouses and
stock, coupons, orders, card payments and refunds, shipping, an audit trail, customer
emails and sales reports. Node 22+ with built-in TypeScript type stripping; no dependencies.

Run the tests with `node --test "tests/**/*.test.ts"`.

## Layout

| Folder | What lives there |
|---|---|
| `src/core` | errors, ids, clock, money (integer cents), validation, events, in-memory tables, pagination |
| `src/auth` | users, roles and permissions, bearer tokens |
| `src/catalog` | products and tax categories |
| `src/customers` | customer profiles and addresses |
| `src/inventory` | warehouses, stock levels, reservations and the stock movement ledger |
| `src/pricing` | coupons and order pricing |
| `src/orders` | the order model, status transitions and the order service |
| `src/payments` | the card gateway stand-in and payments / refunds |
| `src/shipping` | shipments and delivery |
| `src/audit` | the audit trail |
| `src/notifications` | the customer email outbox |
| `src/reports` | sales and stock reports |
| `src/api` | the transport-neutral HTTP layer: router, error mapping, DTOs, routes |
| `src/app.ts` | wires everything together (`createApp`) |

## Conventions

- **Errors.** Services throw the classes in `core/errors.ts`; `api/http.ts` turns them into
  statuses (400, 401, 402, 403, 404, 409). Error bodies are `{ error: { code, message, field? } }`.
- **Ownership.** `:own` / `:any` permission pairs and `requireOwnedAccess` decide who may touch
  what. Another customer's resource is always `404`, never `403`.
- **Money.** Integer cents everywhere; rounding goes through `core/money.ts`.
- **Events.** Every change publishes a domain event (`<entity>.<verb>`). The audit log records
  every event, and the outbox turns some of them into customer emails. Nothing writes to
  either directly.
- **Stock.** Stock levels only change through movements in `inventory/stock.ts`, so the
  movement history always explains the numbers.
- **Time.** Read the time from the injected `Clock`, never from `new Date()`.
- **API output.** Responses go through the DTO mappers in `api/serialize.ts`; internal fields
  (owner ids, gateway references) never leave the service.

## API at a glance

`POST /signup` (public), `POST /users`, `GET /me`, `GET /customers/me`, `GET /customers/:id`,
`POST /customers/:id/addresses`, `GET|POST /products`, `GET|PATCH /products/:id`,
`POST /products/:id/(de)activate`, `GET|POST /warehouses`, `POST /inventory/receive`,
`POST /inventory/adjust`, `GET /inventory/:sku`, `GET /inventory/:sku/movements`, `POST /coupons`,
`GET /coupons/:id`, `GET|POST /orders`, `GET /orders/:id`, `POST /orders/:id/lines`,
`PATCH /orders/:id/lines/:lineId`, `PUT /orders/:id/shipping-address`, `PUT /orders/:id/coupon`,
`POST /orders/:id/place`, `POST /orders/:id/cancel`, `GET|POST /orders/:id/payments`,
`POST /payments/:id/refunds`, `POST /orders/:id/shipments`, `GET /orders/:id/shipment`,
`POST /shipments/:id/deliver`, `GET /reports/sales`, `GET /reports/low-stock`, `GET /audit`,
`GET /notifications`.

`createApp()` returns `{ handle(request), services, bootstrap(email, name), tokenFor(userId) }`;
`tests/helpers.ts` shows how a test drives it.
