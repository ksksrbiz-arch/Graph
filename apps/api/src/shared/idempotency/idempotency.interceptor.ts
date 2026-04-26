// HTTP-level wrapper around IdempotencyService. Looks at the `Idempotency-Key`
// request header (RFC draft `draft-ietf-httpapi-idempotency-key`) and dedupes
// the wrapped handler by `(userId, METHOD path, key)`.
//
// Endpoints opt in by applying the `@Idempotent()` decorator. Routes without
// an Idempotency-Key header pass through unchanged — clients that don't care
// about replay-safety pay no cost.

import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, defer, from } from 'rxjs';
import {
  IdempotencyConflictError,
  IdempotencyService,
} from './idempotency.service';

const IDEMPOTENT_META = 'idempotent';
const HEADER = 'idempotency-key';

interface AuthedRequest extends Request {
  user?: { sub?: string };
}

/** Mark a controller method as idempotent. Without the decorator the
 *  interceptor is a no-op even if installed globally. */
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_META, true);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly idem: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.get<boolean>(IDEMPOTENT_META, ctx.getHandler());
    if (!enabled) return next.handle();

    const http = ctx.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const headerValue = req.headers[HEADER];
    const key = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!key || typeof key !== 'string' || key.length === 0) {
      return next.handle();
    }

    const userId = req.user?.sub ?? 'anon';
    const route = `${req.method.toUpperCase()} ${req.route?.path ?? req.url}`;
    const scope = `${userId}:${route}`;

    return defer(() =>
      from(
        this.idem
          .withKey(
            scope,
            key,
            () =>
              new Promise<unknown>((resolve, reject) => {
                next.handle().subscribe({
                  next: (value) => resolve(value),
                  error: (err) => reject(err),
                });
              }),
            { payload: { body: req.body, query: req.query } },
          )
          .catch((err) => {
            if (err instanceof IdempotencyConflictError) {
              throw new ConflictException(err.message);
            }
            throw err;
          }),
      ),
    );
  }
}
