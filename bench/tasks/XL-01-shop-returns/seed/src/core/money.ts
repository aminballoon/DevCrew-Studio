/**
 * Money is always an integer number of cents. Never use floats for amounts.
 * One currency (USD) for the whole shop.
 */
export type Cents = number;

export function assertCents(value: unknown, field = 'amount'): Cents {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer number of cents`);
  }
  return value;
}

/** Rounds half away from zero, the shop's single rounding rule. */
export function roundCents(value: number): Cents {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** `basisPoints` of `amount`: 1000 bp = 10%. Rounded with roundCents. */
export function percentOf(amount: Cents, basisPoints: number): Cents {
  return roundCents((amount * basisPoints) / 10_000);
}

/**
 * Splits `total` across `weights` in proportion, so that the parts always add up to `total`
 * exactly (largest remainder method; ties go to the earlier weight).
 * Used for spreading an order discount over its lines.
 */
export function allocate(total: Cents, weights: number[]): Cents[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) { return []; }
  if (sum === 0) { return weights.map((_, i) => (i === 0 ? total : 0)); }
  const exact = weights.map(w => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) { break; }
    parts[i] += 1;
    rest -= 1;
  }
  return parts;
}

export const sum = (values: Cents[]): Cents => values.reduce((a, b) => a + b, 0);

export const formatCents = (c: Cents): string => `$${(c / 100).toFixed(2)}`;
