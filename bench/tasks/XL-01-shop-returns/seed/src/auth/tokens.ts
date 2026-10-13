import { randomBytes } from 'node:crypto';

import { AuthError } from '../core/errors.ts';
import type { Actor } from './permissions.ts';
import type { UserService } from './users.ts';

/**
 * Bearer tokens. Opaque random strings mapped to a user id. A deactivated user's
 * tokens stop working immediately.
 */
export class TokenService {
  private tokens = new Map<string, string>();
  private users: UserService;

  constructor(deps: { users: UserService }) { this.users = deps.users; }

  issue(userId: string): string {
    this.users.get(userId);
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, userId);
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  /** `Authorization: Bearer <token>` → Actor, or AuthError. */
  authenticate(header: string | undefined): Actor {
    const match = /^Bearer (\S+)$/.exec(header ?? '');
    if (!match) { throw new AuthError(); }
    const userId = this.tokens.get(match[1]);
    if (!userId) { throw new AuthError('invalid token'); }
    const user = this.users.table.find(userId);
    if (!user || !user.active) { throw new AuthError('invalid token'); }
    return { id: user.id, role: user.role };
  }
}
