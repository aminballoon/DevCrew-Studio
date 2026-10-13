import { PaymentError } from '../core/errors.ts';
import type { Cents } from '../core/money.ts';

/**
 * Stand-in for the card processor. Card tokens:
 * - `tok_visa`, `tok_mastercard` → approved
 * - `tok_declined` → declined
 * Set `down = true` to make every call fail (outage).
 */
export class FakeGateway {
  down = false;
  readonly charges: { ref: string; amountCents: Cents; cardToken: string }[] = [];
  readonly refunds: { ref: string; chargeRef: string; amountCents: Cents }[] = [];

  charge(amountCents: Cents, cardToken: string): { ref: string } {
    if (this.down) { throw new PaymentError('gateway unavailable'); }
    if (cardToken === 'tok_declined') { throw new PaymentError('card declined'); }
    if (!/^tok_[a-z]+$/.test(cardToken)) { throw new PaymentError('invalid card token'); }
    const ref = `ch_${this.charges.length + 1}`;
    this.charges.push({ ref, amountCents, cardToken });
    return { ref };
  }

  refund(chargeRef: string, amountCents: Cents): { ref: string } {
    if (this.down) { throw new PaymentError('gateway unavailable'); }
    const charge = this.charges.find(c => c.ref === chargeRef);
    if (!charge) { throw new PaymentError('unknown charge'); }
    const already = this.refunds.filter(r => r.chargeRef === chargeRef).reduce((n, r) => n + r.amountCents, 0);
    if (already + amountCents > charge.amountCents) { throw new PaymentError('refund exceeds charge'); }
    const ref = `re_${this.refunds.length + 1}`;
    this.refunds.push({ ref, chargeRef, amountCents });
    return { ref };
  }
}
