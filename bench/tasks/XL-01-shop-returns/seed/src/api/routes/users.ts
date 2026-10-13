import type { Services } from '../../app.ts';
import { created, ok } from '../http.ts';
import type { Router } from '../router.ts';
import { customerDto, userDto } from '../serialize.ts';

export function userRoutes(r: Router, s: Services): void {
  /** Public sign-up: creates a customer and returns a token for them. */
  r.add('POST', '/signup', ({ body }) => {
    const user = s.users.signUp(body);
    return created({ user: userDto(user), token: s.tokens.issue(user.id) });
  }, { public: true });
  r.add('POST', '/users', ({ actor, body }) => created(userDto(s.users.create(actor, body))));
  r.add('POST', '/users/:id/deactivate', ({ actor, params }) => ok(userDto(s.users.deactivate(actor, params.id))));
  r.add('GET', '/me', ({ actor }) => ok(userDto(s.users.get(actor.id))));

  r.add('GET', '/customers/me', ({ actor }) => ok(customerDto(s.customers.get(actor, s.customers.forUser(actor.id).id))));
  r.add('GET', '/customers/:id', ({ actor, params }) => ok(customerDto(s.customers.get(actor, params.id))));
  r.add('POST', '/customers/:id/addresses', ({ actor, params, body }) => created(customerDto(s.customers.addAddress(actor, params.id, body))));
}
