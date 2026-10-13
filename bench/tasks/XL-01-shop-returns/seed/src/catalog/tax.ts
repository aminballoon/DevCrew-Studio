import type { Cents } from '../core/money.ts';
import { percentOf } from '../core/money.ts';

/** Tax categories and their rates in basis points (1000 = 10%). */
export const TAX_RATES = {
  standard: 1000,
  reduced: 500,
  exempt: 0,
} as const;

export type TaxCategory = keyof typeof TAX_RATES;
export const TAX_CATEGORIES = Object.keys(TAX_RATES) as TaxCategory[];

/**
 * Tax on a line is computed on the line's amount after its share of the discount,
 * rounded once per line (never per unit).
 */
export function taxFor(netAmount: Cents, category: TaxCategory): Cents {
  return percentOf(netAmount, TAX_RATES[category]);
}
