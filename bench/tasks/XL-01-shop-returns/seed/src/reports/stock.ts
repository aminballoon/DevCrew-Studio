import type { Actor } from '../auth/permissions.ts';
import { requirePermission } from '../auth/permissions.ts';
import type { ProductService } from '../catalog/products.ts';
import type { StockService } from '../inventory/stock.ts';

export interface LowStockRow {
  sku: string;
  name: string;
  available: number;
}

export class StockReports {
  private products: ProductService;
  private stock: StockService;

  constructor(deps: { products: ProductService; stock: StockService }) {
    this.products = deps.products;
    this.stock = deps.stock;
  }

  /** Active products with fewer than `threshold` units available across warehouses; fewest first. */
  lowStock(actor: Actor, threshold: number): LowStockRow[] {
    requirePermission(actor, 'reports:read');
    return this.products.table
      .list(p => p.active)
      .map(p => ({ sku: p.sku, name: p.name, available: this.stock.available(p.sku) }))
      .filter(r => r.available < threshold)
      .sort((a, b) => a.available - b.available || a.sku.localeCompare(b.sku));
  }
}
