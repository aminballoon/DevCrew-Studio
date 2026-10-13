import { adminRoutes } from './api/routes/admin.ts';
import { catalogRoutes } from './api/routes/catalog.ts';
import { inventoryRoutes } from './api/routes/inventory.ts';
import { orderRoutes } from './api/routes/orders.ts';
import { userRoutes } from './api/routes/users.ts';
import type { Request, Response } from './api/http.ts';
import { Router } from './api/router.ts';
import { AuditLog } from './audit/audit.ts';
import { TokenService } from './auth/tokens.ts';
import { UserService } from './auth/users.ts';
import { ProductService } from './catalog/products.ts';
import type { Clock } from './core/clock.ts';
import { ManualClock, systemClock } from './core/clock.ts';
import { EventBus } from './core/events.ts';
import { IdGenerator } from './core/ids.ts';
import { CustomerService } from './customers/customers.ts';
import { StockService } from './inventory/stock.ts';
import { WarehouseService } from './inventory/warehouses.ts';
import { Outbox } from './notifications/outbox.ts';
import { OrderService } from './orders/orders.ts';
import { FakeGateway } from './payments/gateway.ts';
import { PaymentService } from './payments/payments.ts';
import { CouponService } from './pricing/coupons.ts';
import { SalesReports } from './reports/sales.ts';
import { StockReports } from './reports/stock.ts';
import { ShipmentService } from './shipping/shipments.ts';

export interface Services {
  clock: Clock;
  ids: IdGenerator;
  bus: EventBus;
  gateway: FakeGateway;
  users: UserService;
  tokens: TokenService;
  products: ProductService;
  customers: CustomerService;
  warehouses: WarehouseService;
  stock: StockService;
  coupons: CouponService;
  orders: OrderService;
  payments: PaymentService;
  shipments: ShipmentService;
  audit: AuditLog;
  outbox: Outbox;
  salesReports: SalesReports;
  stockReports: StockReports;
}

export interface App {
  handle(req: Request): Response;
  services: Services;
  /** Creates the first admin and returns a token for them. */
  bootstrap(email: string, name: string): { userId: string; token: string };
  /** A fresh token for an existing user (what a login would return). */
  tokenFor(userId: string): string;
}

/**
 * Builds the whole shop. Order matters: subscribers (customers, audit, outbox) are
 * created before anything publishes.
 */
export function createApp(options: { clock?: Clock; now?: string } = {}): App {
  const clock = options.clock ?? (options.now ? new ManualClock(options.now) : systemClock);
  const ids = new IdGenerator();
  const bus = new EventBus(clock);
  const gateway = new FakeGateway();

  const audit = new AuditLog({ ids, bus });
  const users = new UserService({ ids, bus, clock });
  const tokens = new TokenService({ users });
  const customers = new CustomerService({ ids, bus });
  const products = new ProductService({ ids, bus, clock });
  const warehouses = new WarehouseService({ ids, bus });
  const stock = new StockService({ ids, bus, clock, warehouses });
  const coupons = new CouponService({ ids, bus, clock });
  const orders = new OrderService({ ids, bus, clock, products, customers, stock, coupons });
  const payments = new PaymentService({ ids, bus, clock, orders, gateway });
  orders.attachRefunder(payments);
  const shipments = new ShipmentService({ ids, bus, clock, orders, stock });
  const outbox = new Outbox({ ids, bus, orders, customers });
  const salesReports = new SalesReports({ orders, payments });
  const stockReports = new StockReports({ products, stock });

  const services: Services = {
    clock, ids, bus, gateway, users, tokens, products, customers, warehouses, stock, coupons,
    orders, payments, shipments, audit, outbox, salesReports, stockReports,
  };

  const router = new Router(tokens);
  userRoutes(router, services);
  catalogRoutes(router, services);
  inventoryRoutes(router, services);
  orderRoutes(router, services);
  adminRoutes(router, services);

  return {
    handle: req => router.handle(req),
    services,
    bootstrap(email, name) {
      const admin = users.bootstrapAdmin(email, name);
      return { userId: admin.id, token: tokens.issue(admin.id) };
    },
    tokenFor: userId => tokens.issue(userId),
  };
}
