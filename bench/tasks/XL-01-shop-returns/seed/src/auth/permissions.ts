import { ForbiddenError, NotFoundError } from '../core/errors.ts';

export type Role = 'admin' | 'staff' | 'customer';
export const ROLES: readonly Role[] = ['admin', 'staff', 'customer'];

/**
 * Every permission the shop knows. `:own` permissions allow acting on things the user
 * owns (their customer profile, their orders); `:any` allows it on everything.
 */
export type Permission =
  | 'catalog:read' | 'catalog:write'
  | 'inventory:read' | 'inventory:adjust' | 'warehouses:manage'
  | 'customers:read:own' | 'customers:read:any'
  | 'orders:create:own' | 'orders:create:any'
  | 'orders:read:own' | 'orders:read:any'
  | 'orders:cancel:own' | 'orders:cancel:any'
  | 'payments:pay:own' | 'payments:pay:any'
  | 'payments:refund'
  | 'shipments:manage'
  | 'coupons:manage'
  | 'reports:read'
  | 'audit:read'
  | 'users:manage';

const CUSTOMER: Permission[] = [
  'catalog:read',
  'customers:read:own',
  'orders:create:own', 'orders:read:own', 'orders:cancel:own',
  'payments:pay:own',
];

const STAFF: Permission[] = [
  'catalog:read', 'catalog:write',
  'inventory:read', 'inventory:adjust',
  'customers:read:any',
  'orders:create:any', 'orders:read:any', 'orders:cancel:any',
  'payments:pay:any', 'payments:refund',
  'shipments:manage',
  'coupons:manage',
  'reports:read',
];

const ADMIN: Permission[] = [...STAFF, 'warehouses:manage', 'audit:read', 'users:manage'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  customer: new Set(CUSTOMER),
  staff: new Set(STAFF),
  admin: new Set(ADMIN),
};

export interface Actor {
  id: string;
  role: Role;
}

export function can(actor: Actor, permission: Permission): boolean {
  return ROLE_PERMISSIONS[actor.role].has(permission);
}

/** Throws ForbiddenError unless the actor has the permission. */
export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) { throw new ForbiddenError(`missing permission ${permission}`); }
}

/**
 * Access to something owned by `ownerUserId` under a `<base>:own` / `<base>:any` pair.
 * - `:any` → allowed.
 * - `:own` and the actor owns it → allowed.
 * - `:own` but someone else's → NotFoundError (do not reveal that it exists).
 * - neither → ForbiddenError.
 */
export function requireOwnedAccess(actor: Actor, base: string, ownerUserId: string, what: string): void {
  if (can(actor, `${base}:any` as Permission)) { return; }
  if (can(actor, `${base}:own` as Permission)) {
    if (actor.id === ownerUserId) { return; }
    throw new NotFoundError(what);
  }
  throw new ForbiddenError(`missing permission ${base}`);
}
