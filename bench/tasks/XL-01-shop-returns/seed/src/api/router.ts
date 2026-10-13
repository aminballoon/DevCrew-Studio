import type { Actor } from '../auth/permissions.ts';
import type { TokenService } from '../auth/tokens.ts';
import { NotFoundError } from '../core/errors.ts';
import type { Request, Response } from './http.ts';
import { errorResponse } from './http.ts';

export interface Context {
  req: Request;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  /** The authenticated caller. Accessing it on a public route throws. */
  actor: Actor;
}

type Handler = (ctx: Context) => Response;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  public: boolean;
}

/**
 * Minimal router: `/orders/:orderId/lines/:lineId` style patterns, exact method match.
 * Every route needs a bearer token unless registered with `{ public: true }`.
 * Unknown paths are 404; a known path with the wrong method is 405.
 */
export class Router {
  private routes: Route[] = [];
  private tokens: TokenService;

  constructor(tokens: TokenService) { this.tokens = tokens; }

  add(method: string, pattern: string, handler: Handler, opts: { public?: boolean } = {}): void {
    this.routes.push({ method: method.toUpperCase(), parts: split(pattern), handler, public: opts.public ?? false });
  }

  handle(req: Request): Response {
    try {
      const parts = split(req.path.split('?')[0]);
      let pathMatched = false;
      for (const route of this.routes) {
        const params = match(route.parts, parts);
        if (!params) { continue; }
        pathMatched = true;
        if (route.method !== req.method.toUpperCase()) { continue; }
        const actor = route.public ? null : this.tokens.authenticate(header(req, 'authorization'));
        const ctx: Context = {
          req, params, query: req.query ?? {}, body: req.body,
          get actor(): Actor {
            if (!actor) { throw new Error('public route has no actor'); }
            return actor;
          },
        };
        return route.handler(ctx);
      }
      if (pathMatched) { return { status: 405, body: { error: { code: 'method_not_allowed', message: 'method not allowed' } } }; }
      throw new NotFoundError('route');
    } catch (err) {
      return errorResponse(err);
    }
  }
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function match(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) { return null; }
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(':')) {
      params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
    } else if (pattern[i] !== parts[i]) {
      return null;
    }
  }
  return params;
}

function header(req: Request, name: string): string | undefined {
  const headers = req.headers ?? {};
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}
