import type { Services } from '../../app.ts';
import { created, ok } from '../http.ts';
import type { Router } from '../router.ts';
import { movementDto, stockLevelDto, warehouseDto } from '../serialize.ts';

export function inventoryRoutes(r: Router, s: Services): void {
  r.add('POST', '/warehouses', ({ actor, body }) => created(warehouseDto(s.warehouses.create(actor, body))));
  r.add('GET', '/warehouses', ({ actor }) => ok(s.warehouses.list(actor).map(warehouseDto)));

  r.add('POST', '/inventory/receive', ({ actor, body }) => {
    const level = s.stock.receive(actor, body);
    return ok(stockLevelDto({ ...level, available: level.onHand - level.reserved }));
  });
  r.add('POST', '/inventory/adjust', ({ actor, body }) => {
    const level = s.stock.adjust(actor, body);
    return ok(stockLevelDto({ ...level, available: level.onHand - level.reserved }));
  });
  /** Levels of one sku in every active warehouse, in shipping order. */
  r.add('GET', '/inventory/:sku', ({ actor, params }) => ok(s.stock.levelsFor(actor, params.sku).map(stockLevelDto)));
  r.add('GET', '/inventory/:sku/movements', ({ actor, params }) => ok(s.stock.history(actor, params.sku).map(movementDto)));
}
