import { ConflictError, ValidationError } from '../core/errors.ts';
import type { Clock } from '../core/clock.ts';
import type { EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import { Table } from '../core/store.ts';
import { requireEmail, requireObject, requireOneOf, requireString } from '../core/validate.ts';
import { ROLES, requirePermission } from './permissions.ts';
import type { Actor, Role } from './permissions.ts';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export class UserService {
  readonly table = new Table<User>('user');
  private ids: IdGenerator;
  private bus: EventBus;
  private clock: Clock;

  constructor(deps: { ids: IdGenerator; bus: EventBus; clock: Clock }) {
    this.ids = deps.ids;
    this.bus = deps.bus;
    this.clock = deps.clock;
  }

  /** The first admin, created when the app starts. Not an API operation. */
  bootstrapAdmin(email: string, name: string): User {
    if (this.table.size > 0) { throw new ConflictError('already bootstrapped'); }
    return this.insert({ email, name, role: 'admin' }, 'system');
  }

  /** Anyone may sign up as a customer. */
  signUp(input: unknown): User {
    const body = requireObject(input);
    return this.insert({ email: body.email, name: body.name, role: 'customer' }, 'self');
  }

  /** Admins create staff, admins or customers. */
  create(actor: Actor, input: unknown): User {
    requirePermission(actor, 'users:manage');
    const body = requireObject(input);
    const role = requireOneOf(body.role, 'role', ROLES);
    return this.insert({ email: body.email, name: body.name, role }, actor.id);
  }

  deactivate(actor: Actor, userId: string): User {
    requirePermission(actor, 'users:manage');
    if (userId === actor.id) { throw new ValidationError('you cannot deactivate yourself'); }
    const user = this.table.update(userId, u => { u.active = false; });
    this.bus.publish({ type: 'user.deactivated', actor: actor.id, entity: 'user', entityId: userId, data: {} });
    return user;
  }

  get(userId: string): User {
    return this.table.get(userId);
  }

  private insert(input: { email: unknown; name: unknown; role: Role }, actorId: string): User {
    const email = requireEmail(input.email);
    const name = requireString(input.name, 'name', { max: 100 });
    if (this.table.list(u => u.email === email).length > 0) { throw new ConflictError('email already registered'); }
    const user: User = {
      id: this.ids.next('user'), email, name, role: input.role, active: true,
      createdAt: this.clock.now().toISOString(),
    };
    const stored = this.table.insert(user);
    this.bus.publish({
      type: 'user.created', actor: actorId === 'self' ? stored.id : actorId,
      entity: 'user', entityId: stored.id, data: { role: stored.role, email: stored.email, name: stored.name },
    });
    return stored;
  }
}
