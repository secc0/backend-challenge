import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'isPublic';

/** Marks a route as reachable without authentication (health checks, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Authentication extension point.
 *
 * Authentication is intentionally not implemented (optional in the challenge,
 * see ARCHITECTURE.md). Every non-public route already goes through this
 * guard, so plugging an identity provider (Keycloak/Zitadel, JWT validated
 * against the provider's JWKS) means implementing `authenticate` only:
 * no controller changes are needed. Queue messages are a trusted internal
 * channel and do not go through it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    return this.authenticate(context);
  }

  /** AUTH_MODE=none (default): no identity provider configured. */
  protected authenticate(_context: ExecutionContext): boolean {
    return true;
  }
}
