import type { Actor } from '../auth/permissions.ts';
import { requireOwnedAccess } from '../auth/permissions.ts';
import { NotFoundError } from '../core/errors.ts';
import type { DomainEvent, EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import { Table } from '../core/store.ts';
import { requireObject, requireString } from '../core/validate.ts';

export interface Address {
  id: string;
  line1: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface Customer {
  id: string;
  userId: string;
  name: string;
  email: string;
  addresses: Address[];
  defaultAddressId: string | null;
}

/**
 * Customer profiles. Every user with the customer role gets exactly one profile,
 * created automatically when the user is created (see `user.created`).
 */
export class CustomerService {
  readonly table = new Table<Customer>('customer');
  private ids: IdGenerator;
  private bus: EventBus;

  constructor(deps: { ids: IdGenerator; bus: EventBus }) {
    this.ids = deps.ids;
    this.bus = deps.bus;
    this.bus.subscribe('user.created', e => this.onUserCreated(e));
  }

  private onUserCreated(event: DomainEvent): void {
    if (event.data.role !== 'customer') { return; }
    const customer = this.table.insert({
      id: this.ids.next('customer'),
      userId: event.entityId,
      name: String(event.data.name),
      email: String(event.data.email),
      addresses: [],
      defaultAddressId: null,
    });
    this.bus.publish({ type: 'customer.created', actor: event.actor, entity: 'customer', entityId: customer.id, data: { userId: customer.userId } });
  }

  get(actor: Actor, customerId: string): Customer {
    const customer = this.table.get(customerId);
    requireOwnedAccess(actor, 'customers:read', customer.userId, 'customer');
    return customer;
  }

  /** The profile of a customer user. NotFoundError for staff and admins. */
  forUser(userId: string): Customer {
    const customer = this.table.list(c => c.userId === userId)[0];
    if (!customer) { throw new NotFoundError('customer'); }
    return customer;
  }

  addAddress(actor: Actor, customerId: string, input: unknown): Customer {
    const customer = this.get(actor, customerId);
    if (actor.id !== customer.userId) { throw new NotFoundError('customer'); }
    const body = requireObject(input);
    const address: Address = {
      id: this.ids.next('address'),
      line1: requireString(body.line1, 'line1', { max: 200 }),
      city: requireString(body.city, 'city', { max: 100 }),
      postalCode: requireString(body.postalCode, 'postalCode', { max: 20 }),
      country: requireString(body.country, 'country', { min: 2, max: 2 }).toUpperCase(),
    };
    const updated = this.table.update(customerId, c => {
      c.addresses.push(address);
      if (!c.defaultAddressId) { c.defaultAddressId = address.id; }
    });
    this.bus.publish({ type: 'customer.address_added', actor: actor.id, entity: 'customer', entityId: customerId, data: { addressId: address.id } });
    return updated;
  }

  address(customerId: string, addressId: string): Address {
    const customer = this.table.get(customerId);
    const address = customer.addresses.find(a => a.id === addressId);
    if (!address) { throw new NotFoundError('address'); }
    return address;
  }
}
