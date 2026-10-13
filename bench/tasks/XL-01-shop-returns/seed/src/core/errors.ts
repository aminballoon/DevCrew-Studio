/**
 * Domain errors. The API layer maps each class to an HTTP status (see api/http.ts),
 * so services throw these and never build responses themselves.
 */
export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

/** Input is malformed or breaks a business rule about its shape. → 400 */
export class ValidationError extends DomainError {
  field?: string;
  constructor(message: string, field?: string) {
    super('validation_failed', message);
    this.field = field;
  }
}

/** No valid credentials. → 401 */
export class AuthError extends DomainError {
  constructor(message = 'authentication required') { super('unauthenticated', message); }
}

/** Authenticated but not allowed. → 403 */
export class ForbiddenError extends DomainError {
  constructor(message = 'not allowed') { super('forbidden', message); }
}

/**
 * The thing does not exist, or the caller may not know it exists. → 404
 * Resources owned by someone else are reported as not found, never as forbidden,
 * so ids cannot be probed.
 */
export class NotFoundError extends DomainError {
  constructor(what: string) { super('not_found', `${what} not found`); }
}

/** The request clashes with current state (duplicate, out of stock, limit reached). → 409 */
export class ConflictError extends DomainError {
  constructor(message: string) { super('conflict', message); }
}

/** The entity is in a state that does not allow this operation. → 409 */
export class StateError extends DomainError {
  constructor(message: string) { super('invalid_state', message); }
}

/** A downstream system (payment gateway) refused. → 402 */
export class PaymentError extends DomainError {
  constructor(message: string) { super('payment_failed', message); }
}
