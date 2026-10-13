import type { Services } from '../../app.ts';
import { created, ok } from '../http.ts';
import type { Router } from '../router.ts';
import { couponDto, productDto } from '../serialize.ts';

export function catalogRoutes(r: Router, s: Services): void {
  r.add('GET', '/products', ({ actor }) => ok(s.products.list(actor).map(productDto)));
  r.add('GET', '/products/:id', ({ actor, params }) => ok(productDto(s.products.get(actor, params.id))));
  r.add('POST', '/products', ({ actor, body }) => created(productDto(s.products.create(actor, body))));
  r.add('PATCH', '/products/:id', ({ actor, params, body }) => ok(productDto(s.products.update(actor, params.id, body))));
  r.add('POST', '/products/:id/deactivate', ({ actor, params }) => ok(productDto(s.products.setActive(actor, params.id, false))));
  r.add('POST', '/products/:id/activate', ({ actor, params }) => ok(productDto(s.products.setActive(actor, params.id, true))));

  r.add('POST', '/coupons', ({ actor, body }) => created(couponDto(s.coupons.create(actor, body))));
  r.add('GET', '/coupons/:id', ({ actor, params }) => ok(couponDto(s.coupons.get(actor, params.id))));
}
