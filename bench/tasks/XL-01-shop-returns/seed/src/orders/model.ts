import type { TaxCategory } from '../catalog/tax.ts';
import type { Address } from '../customers/customers.ts';
import type { Cents } from '../core/money.ts';
import type { LineAmounts, OrderAmounts } from '../pricing/pricing.ts';
import type { OrderStatus } from './state.ts';

export interface OrderLine {
  id: string;
  productId: string;
  sku: string;
  name: string;
  /** Catalog price when the line was last changed; frozen when the order is placed. */
  unitPriceCents: Cents;
  qty: number;
  taxCategory: TaxCategory;
  /** Set when the order is placed. */
  amounts: LineAmounts | null;
  /** Where the units are reserved / were shipped from, in shipping order. Set when placed. */
  fulfilment: { warehouseId: string; qty: number }[];
}

export interface StatusChange {
  status: OrderStatus;
  at: string;
  actor: string;
}

export interface Order {
  id: string;
  /** Human-facing number, e.g. SO-1001. */
  number: string;
  customerId: string;
  /** The user id of the customer, for ownership checks. */
  ownerUserId: string;
  status: OrderStatus;
  lines: OrderLine[];
  couponCode: string | null;
  shippingAddress: Address | null;
  /** Set when placed; the amount the customer is charged. */
  amounts: OrderAmounts | null;
  history: StatusChange[];
  createdBy: string;
  createdAt: string;
  placedAt: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export const MAX_LINES = 50;
export const MAX_QTY_PER_LINE = 99;
