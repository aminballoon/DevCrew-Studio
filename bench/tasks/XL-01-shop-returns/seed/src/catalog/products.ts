import type { Actor } from '../auth/permissions.ts';
import { requirePermission } from '../auth/permissions.ts';
import type { Clock } from '../core/clock.ts';
import { ConflictError, NotFoundError } from '../core/errors.ts';
import type { EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import type { Cents } from '../core/money.ts';
import { Table } from '../core/store.ts';
import { optionalString, requireCentsInput, requireObject, requireOneOf, requireSku, requireString } from '../core/validate.ts';
import { TAX_CATEGORIES } from './tax.ts';
import type { TaxCategory } from './tax.ts';

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: Cents;
  taxCategory: TaxCategory;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export class ProductService {
  readonly table = new Table<Product>('product');
  private ids: IdGenerator;
  private bus: EventBus;
  private clock: Clock;

  constructor(deps: { ids: IdGenerator; bus: EventBus; clock: Clock }) {
    this.ids = deps.ids;
    this.bus = deps.bus;
    this.clock = deps.clock;
  }

  create(actor: Actor, input: unknown): Product {
    requirePermission(actor, 'catalog:write');
    const body = requireObject(input);
    const sku = requireSku(body.sku);
    if (this.findBySku(sku)) { throw new ConflictError(`sku ${sku} already exists`); }
    const now = this.clock.now().toISOString();
    const product = this.table.insert({
      id: this.ids.next('product'),
      sku,
      name: requireString(body.name, 'name', { max: 120 }),
      description: optionalString(body.description, 'description', { max: 2000 }) ?? '',
      priceCents: requireCentsInput(body.priceCents, 'priceCents'),
      taxCategory: body.taxCategory === undefined ? 'standard' : requireOneOf(body.taxCategory, 'taxCategory', TAX_CATEGORIES),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    this.bus.publish({ type: 'product.created', actor: actor.id, entity: 'product', entityId: product.id, data: { sku, priceCents: product.priceCents } });
    return product;
  }

  /** Changes name, description, price or tax category. Existing orders keep the prices they were placed with. */
  update(actor: Actor, productId: string, input: unknown): Product {
    requirePermission(actor, 'catalog:write');
    const body = requireObject(input);
    const changes: Partial<Product> = {};
    if (body.name !== undefined) { changes.name = requireString(body.name, 'name', { max: 120 }); }
    if (body.description !== undefined) { changes.description = optionalString(body.description, 'description', { max: 2000 }) ?? ''; }
    if (body.priceCents !== undefined) { changes.priceCents = requireCentsInput(body.priceCents, 'priceCents'); }
    if (body.taxCategory !== undefined) { changes.taxCategory = requireOneOf(body.taxCategory, 'taxCategory', TAX_CATEGORIES); }
    const product = this.table.update(productId, p => {
      Object.assign(p, changes);
      p.updatedAt = this.clock.now().toISOString();
    });
    this.bus.publish({ type: 'product.updated', actor: actor.id, entity: 'product', entityId: productId, data: { ...changes } });
    return product;
  }

  setActive(actor: Actor, productId: string, active: boolean): Product {
    requirePermission(actor, 'catalog:write');
    const product = this.table.update(productId, p => {
      p.active = active;
      p.updatedAt = this.clock.now().toISOString();
    });
    this.bus.publish({ type: active ? 'product.activated' : 'product.deactivated', actor: actor.id, entity: 'product', entityId: productId, data: {} });
    return product;
  }

  /** Customers only see active products. */
  get(actor: Actor, productId: string): Product {
    requirePermission(actor, 'catalog:read');
    const product = this.table.get(productId);
    if (!product.active && actor.role === 'customer') { throw new NotFoundError('product'); }
    return product;
  }

  list(actor: Actor): Product[] {
    requirePermission(actor, 'catalog:read');
    return this.table
      .list(p => p.active || actor.role !== 'customer')
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }

  findBySku(sku: string): Product | undefined {
    return this.table.list(p => p.sku === sku)[0];
  }
}
