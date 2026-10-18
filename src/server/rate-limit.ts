import { createHash } from 'node:crypto';
import { AppError, query, withTransaction } from './db';

/**
 * Authentication rate limits are persisted in PostgreSQL so separate app
 * instances share the same counters. The setup script should include this
 * statement in the schema migration; runtime only checks readiness.
 */
export const AUTH_RATE_LIMIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  scope text NOT NULL,
  key_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key_hash)
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_idx
  ON auth_rate_limits(updated_at);
`;

const RATE_WINDOW = "interval '15 minutes'";
const LIMITS = {
  login_email: 10,
  login_pair: 5,
  login_source: 50,
  register_email: 5,
  register_pair: 3,
  register_source: 20,
} as const;

export type AuthRateLimitKind = 'login' | 'register';
export type AuthRateLimitKey = { scope: keyof typeof LIMITS; keyHash: string };

let schemaPromise: Promise<void> | null = null;

function unavailable(error: unknown): AppError {
  if (error instanceof AppError && error.code === 'AUTH_RATE_LIMITED') return error;
  return new AppError(503, 'Authentication is temporarily unavailable.', 'AUTH_RATE_LIMIT_UNAVAILABLE');
}

async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = query('SELECT 1 FROM auth_rate_limits LIMIT 0').then(() => undefined).catch((error) => {
      schemaPromise = null;
      throw unavailable(error);
    });
  }
  return schemaPromise;
}

function keyHash(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}\u0000${value}`).digest('hex');
}

/** Keep an untrusted proxy/IP label bounded before hashing it for a key. */
function normalizeSource(sourceIdentifier: string | undefined): string | undefined {
  if (typeof sourceIdentifier !== 'string') return undefined;
  const value = sourceIdentifier.trim().toLowerCase();
  if (!value || value.length > 200 || /[\u0000\r\n]/.test(value)) return undefined;
  return value;
}

export function buildAuthRateLimitKeys(
  kind: AuthRateLimitKind,
  normalizedEmail: string,
  sourceIdentifier?: string,
): AuthRateLimitKey[] {
  const email = normalizedEmail.trim().toLowerCase();
  const source = normalizeSource(sourceIdentifier);
  const entries: Array<{ scope: keyof typeof LIMITS; value: string }> = [
    { scope: `${kind}_email`, value: email } as const,
  ];
  if (source) {
    entries.push(
      { scope: `${kind}_pair`, value: `${email}\u0000${source}` } as const,
      { scope: `${kind}_source`, value: source } as const,
    );
  }
  return entries.map(({ scope, value }) => ({ scope, keyHash: keyHash(scope, value) }));
}

/** Count an authentication attempt atomically for every bucket. */
export async function recordAuthRateLimitAttempt(keys: AuthRateLimitKey[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await ensureSchema();
    const exceeded = await withTransaction(async (client) => {
      let exceeded = false;
      for (const key of [...keys].sort((a,b) => (a.scope+a.keyHash).localeCompare(b.scope+b.keyHash))) {
        const result = await client.query<{attempts:number}>(
          `INSERT INTO auth_rate_limits (scope, key_hash, window_started_at, attempts, updated_at)
           VALUES ($1, $2, now(), 1, now())
           ON CONFLICT (scope, key_hash) DO UPDATE
             SET attempts = CASE
               WHEN auth_rate_limits.window_started_at <= now() - ${RATE_WINDOW} THEN 1
               ELSE LEAST(auth_rate_limits.attempts + 1, 1000000)
             END,
             window_started_at = CASE
               WHEN auth_rate_limits.window_started_at <= now() - ${RATE_WINDOW} THEN now()
               ELSE auth_rate_limits.window_started_at
             END,
             updated_at = now() RETURNING attempts`,
          [key.scope, key.keyHash],
        );
        if (result.rows[0].attempts > LIMITS[key.scope]) exceeded = true;
      }
      return exceeded;
    });
    if (exceeded) throw new AppError(429, 'Too many authentication attempts. Try again later.', 'AUTH_RATE_LIMITED');
  } catch (error) {
    throw unavailable(error);
  }
}

/** Backwards-compatible name for callers that record only failed attempts. */
export const recordAuthRateLimitFailure = recordAuthRateLimitAttempt;

/** A successful authentication clears the failed-attempt buckets for that identity. */
export async function clearAuthRateLimit(keys: AuthRateLimitKey[]): Promise<void> {
  keys = keys.filter(key => !key.scope.endsWith('_source'));
  if (keys.length === 0) return;
  try {
    await ensureSchema();
    await withTransaction(async client => {
      for (const key of [...keys].sort((a,b)=>(a.scope+a.keyHash).localeCompare(b.scope+b.keyHash))) {
        await client.query('DELETE FROM auth_rate_limits WHERE scope=$1 AND key_hash=$2',[key.scope,key.keyHash]);
      }
    });
  } catch (error) {
    throw unavailable(error);
  }
}
