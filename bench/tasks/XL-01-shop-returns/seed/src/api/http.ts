import {
  AuthError, ConflictError, DomainError, ForbiddenError, NotFoundError, PaymentError, StateError, ValidationError,
} from '../core/errors.ts';

/** Transport-neutral request / response. A real HTTP server adapts to these (see README). */
export interface Request {
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface Response {
  status: number;
  body: unknown;
}

export interface ErrorBody {
  error: { code: string; message: string; field?: string };
}

/** The one place domain errors become HTTP statuses. */
const STATUS: [new (...args: never[]) => DomainError, number][] = [
  [ValidationError, 400],
  [AuthError, 401],
  [PaymentError, 402],
  [ForbiddenError, 403],
  [NotFoundError, 404],
  [ConflictError, 409],
  [StateError, 409],
];

export function errorResponse(err: unknown): Response {
  if (err instanceof DomainError) {
    const status = STATUS.find(([cls]) => err instanceof cls)?.[1] ?? 400;
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    if (err instanceof ValidationError && err.field) { body.error.field = err.field; }
    return { status, body };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
}

export const ok = (body: unknown): Response => ({ status: 200, body });
export const created = (body: unknown): Response => ({ status: 201, body });
