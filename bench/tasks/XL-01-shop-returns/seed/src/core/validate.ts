import { ValidationError } from './errors.ts';

/** Small input checkers shared by every service. They throw ValidationError naming the field. */

export function requireObject(value: unknown, field = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, field: string, opts: { max?: number; min?: number } = {}): string {
  if (typeof value !== 'string') { throw new ValidationError(`${field} must be a string`, field); }
  const s = value.trim();
  if (s.length < (opts.min ?? 1)) { throw new ValidationError(`${field} is required`, field); }
  if (opts.max !== undefined && s.length > opts.max) { throw new ValidationError(`${field} is too long`, field); }
  return s;
}

export function optionalString(value: unknown, field: string, opts: { max?: number } = {}): string | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value !== 'string') { throw new ValidationError(`${field} must be a string`, field); }
  const s = value.trim();
  if (opts.max !== undefined && s.length > opts.max) { throw new ValidationError(`${field} is too long`, field); }
  return s;
}

export function requireInt(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer`, field);
  }
  if (opts.min !== undefined && value < opts.min) { throw new ValidationError(`${field} must be at least ${opts.min}`, field); }
  if (opts.max !== undefined && value > opts.max) { throw new ValidationError(`${field} must be at most ${opts.max}`, field); }
  return value;
}

export function requireCentsInput(value: unknown, field: string): number {
  return requireInt(value, field, { min: 0 });
}

export function requireOneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`, field);
  }
  return value as T;
}

export function requireArray(value: unknown, field: string, opts: { min?: number; max?: number } = {}): unknown[] {
  if (!Array.isArray(value)) { throw new ValidationError(`${field} must be an array`, field); }
  if (opts.min !== undefined && value.length < opts.min) { throw new ValidationError(`${field} needs at least ${opts.min} item(s)`, field); }
  if (opts.max !== undefined && value.length > opts.max) { throw new ValidationError(`${field} has too many items`, field); }
  return value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function requireEmail(value: unknown, field = 'email'): string {
  const s = requireString(value, field, { max: 254 }).toLowerCase();
  if (!EMAIL.test(s)) { throw new ValidationError(`${field} is not a valid email`, field); }
  return s;
}

export function requireIsoTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO time with a time-zone`, field);
  }
  return new Date(value).toISOString();
}

const SKU = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
export function requireSku(value: unknown, field = 'sku'): string {
  const s = requireString(value, field).toUpperCase();
  if (!SKU.test(s)) { throw new ValidationError(`${field} must be 2-32 letters, digits or dashes`, field); }
  return s;
}
