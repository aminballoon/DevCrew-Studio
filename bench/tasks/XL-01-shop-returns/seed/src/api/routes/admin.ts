import type { Services } from '../../app.ts';
import { ValidationError } from '../../core/errors.ts';
import { paginate } from '../../core/pagination.ts';
import { ok } from '../http.ts';
import type { Router } from '../router.ts';
import { auditDto, notificationDto } from '../serialize.ts';

export function adminRoutes(r: Router, s: Services): void {
  r.add('GET', '/reports/sales', ({ actor, query }) => ok(s.salesReports.sales(actor, { from: query.from, to: query.to })));
  r.add('GET', '/reports/low-stock', ({ actor, query }) => {
    const threshold = query.threshold === undefined ? 5 : Number(query.threshold);
    if (!Number.isInteger(threshold) || threshold < 1) { throw new ValidationError('threshold must be a positive integer', 'threshold'); }
    return ok(s.stockReports.lowStock(actor, threshold));
  });

  /** Oldest first, paginated; filter by entity, entityId, action, actor. */
  r.add('GET', '/audit', ({ actor, query }) => {
    const page = paginate(s.audit.query(actor, { entity: query.entity, entityId: query.entityId, action: query.action, actor: query.actor }), query);
    return ok({ items: page.items.map(auditDto), nextCursor: page.nextCursor });
  });
  r.add('GET', '/notifications', ({ actor, query }) =>
    ok(s.outbox.list(actor, { to: query.to, template: query.template, orderId: query.orderId }).map(notificationDto)));
}
