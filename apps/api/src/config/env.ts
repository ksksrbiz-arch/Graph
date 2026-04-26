// Single env-validation entrypoint. Imported from `main.ts` and any module that
// needs typed env access. Validates against the zod schema in `@pkg/shared`
// per Rule 5 (zero secrets in source, fail-fast on misconfiguration).

import { EnvSchema, type Env } from '@pkg/shared';

let cached: Env | undefined;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${formatted}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the cache. Test-only. */
export function resetEnvCache(): void {
  cached = undefined;
}
