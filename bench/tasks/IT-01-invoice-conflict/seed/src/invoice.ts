export interface Line { sku: string; qty: number; unitPrice: number }
export interface Totals { net: number; vat: number; gross: number }

export function invoiceTotal(lines: Line[]): Totals {
  throw new Error('not implemented');
}

export function formatTHB(satang: number): string {
  throw new Error('not implemented');
}
