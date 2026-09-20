import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Role, User } from '@/lib/types';
import { AppError, query, withTransaction } from './db';
import {
  assertAuthRateLimit,
  buildAuthRateLimitKeys,
  clearAuthRateLimit,
  recordAuthRateLimitAttempt,
} from './rate-limit';

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}
const SESSION_COOKIE = 'contract_studio_session';
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
const PASSWORD_N = 16_384;
const PASSWORD_R = 8;
const PASSWORD_P = 1;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SALT_LENGTH = 16;
const PASSWORD_MAXMEM = 32 * 1024 * 1024;
// All administrator-disable decisions in this database share one transaction
// advisory lock. Row locks alone can leave two administrators each seeing the
// other as active and both committing a disable operation.
const ADMIN_DISABLE_ADVISORY_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('contract-studio:admin-disable'))";

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  disabled: boolean;
};

export type AuthContext = {
  user: User;
  sessionId: string;
};

export const registerInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(256),
});

export const loginInput = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(256),
});

export const adminUserInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(256),
  role: z.enum(['client', 'lawyer', 'admin']),
});

export const adminUserPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  disabled: z.boolean().optional(),
}).refine((value) => value.name !== undefined || value.disabled !== undefined, {
  message: 'At least one user field is required.',
});

type SessionClaims = {
  sid: string;
  role: Role;
};

export type AuthAttemptContext = {
  /** A trusted proxy-resolved source label, normally the client IP. */
  sourceIdentifier?: string;
};

function sessionSecret(): Uint8Array {
  const configured = process.env.CONTRACT_SESSION_SECRET ?? process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) return new TextEncoder().encode(configured);
  if (process.env.NODE_ENV === 'production') {
    throw new AppError(
      503,
      'Session authentication is not configured. Set CONTRACT_SESSION_SECRET.',
      'AUTH_NOT_CONFIGURED',
    );
  }
  // Development-only fallback keeps a local checkout usable before .env setup. It is
  // deliberately unavailable in production and must never be used as a deployed secret.
  return new TextEncoder().encode('contract-studio-local-development-secret-change-me');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function rowToUser(row: UserRow): User & { disabled: boolean } {
  return { id: row.id, name: row.name, email: row.email, role: row.role, disabled: row.disabled };
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const encoded = part.slice(separator + 1).trim();
    if (encoded.length > 8192) return null;
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A malformed cookie must be treated as an absent session, not as a 500.
      return null;
    }
  }
  return null;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieValue(token: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function issueToken(user: User): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const token = await new SignJWT({ sid: sessionId, role: user.role } satisfies SessionClaims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(sessionSecret());
  return { token, sessionId, expiresAt };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH, {
    N: PASSWORD_N,
    r: PASSWORD_R,
    p: PASSWORD_P,
    maxmem: 32 * 1024 * 1024,
  });
  return [
    'scrypt',
    PASSWORD_N,
    PASSWORD_R,
    PASSWORD_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nText, rText, pText, saltText, hashText] = parts;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  // Only accept the parameters produced by this service. Besides rejecting
  // malformed rows, this prevents a database write from selecting a costly
  // scrypt work factor during a login attempt.
  if (n !== PASSWORD_N || r !== PASSWORD_R || p !== PASSWORD_P) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (
      salt.length !== PASSWORD_SALT_LENGTH
      || salt.toString('base64url') !== saltText
      || expected.length !== PASSWORD_KEY_LENGTH
      || expected.toString('base64url') !== hashText
      || 128 * n * r + 128 * r * p > PASSWORD_MAXMEM
    ) return false;
    const actual = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH, {
      N: n,
      r,
      p,
      maxmem: PASSWORD_MAXMEM,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    'SELECT id, name, email, role, disabled FROM users WHERE id = $1 LIMIT 1',
    [id],
  );
  return result.rows[0] ?? null;
}

async function findUserForLogin(email: string): Promise<(UserRow & { password_hash: string }) | null> {
  const result = await query<UserRow & { password_hash: string }>(
    'SELECT id, name, email, role, disabled, password_hash FROM users WHERE email_normalized = $1 LIMIT 1',
    [normalizeEmail(email)],
  );
  return result.rows[0] ?? null;
}

async function createUserRecord(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
}): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  try {
    const result = await query<UserRow>(
      `INSERT INTO users (id, name, email, email_normalized, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, role, disabled`,
      [randomUUID(), input.name.trim(), input.email.trim(), normalizeEmail(input.email), passwordHash, input.role],
    );
    return rowToUser(result.rows[0]);
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONFLICT') {
      // Keep the public code aligned with the existing client error map.
      throw new AppError(409, 'An account with this email already exists.', 'EMAIL_EXISTS');
    }
    throw error;
  }
}

export async function registerClient(input: unknown, context: AuthAttemptContext = {}): Promise<User> {
  const parsed = registerInput.parse(input);
  const rateKeys = buildAuthRateLimitKeys('register', normalizeEmail(parsed.email), context.sourceIdentifier);
  await assertAuthRateLimit(rateKeys);
  // Registration counts every attempt, including successful creation, so a
  // source cannot create unlimited accounts by choosing fresh email addresses.
  await recordAuthRateLimitAttempt(rateKeys);
  return createUserRecord({ ...parsed, role: 'client' });
}

export async function createUserAsAdmin(input: unknown): Promise<User> {
  const parsed = adminUserInput.parse(input);
  return createUserRecord(parsed);
}

export async function login(input: unknown, context: AuthAttemptContext = {}): Promise<{ user: User; token: string; sessionId: string; expiresAt: Date }> {
  const parsed = loginInput.parse(input);
  const rateKeys = buildAuthRateLimitKeys('login', normalizeEmail(parsed.email), context.sourceIdentifier);
  await assertAuthRateLimit(rateKeys);
  // Reserve a bucket slot before password verification. This closes the
  // concurrent-request gap where many expensive scrypt operations could pass
  // the preflight check before their failures were recorded.
  await recordAuthRateLimitAttempt(rateKeys);
  const row = await findUserForLogin(parsed.email);
  if (!row || row.disabled || !(await verifyPassword(parsed.password, row.password_hash))) {
    throw new AppError(401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
  }
  const user = rowToUser(row);
  const issued = await issueToken(user);
  await query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [issued.sessionId, user.id, tokenHash(issued.token), issued.expiresAt],
  );
  await clearAuthRateLimit(rateKeys);
  return { user, ...issued };
}

export async function attachSession(response: Response, user: User): Promise<void> {
  const issued = await issueToken(user);
  await query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [issued.sessionId, user.id, tokenHash(issued.token), issued.expiresAt],
  );
  response.headers.append('Set-Cookie', cookieValue(issued.token, SESSION_TTL_SECONDS));
}

export function setSessionCookie(response: Response, token: string, maxAge = SESSION_TTL_SECONDS): void {
  response.headers.append('Set-Cookie', cookieValue(token, maxAge));
}

async function decodeToken(token: string): Promise<{ userId: string; claims: SessionClaims }> {
  try {
    const verified = await jwtVerify<SessionClaims>(token, sessionSecret(), {
      algorithms: ['HS256'],
    });
    if (
      !verified.payload.sub
      || !verified.payload.sid
      || !verified.payload.role
      || !['client', 'lawyer', 'admin'].includes(verified.payload.role)
    ) {
      throw new Error('Incomplete session claims');
    }
    return {
      userId: verified.payload.sub,
      claims: {
        sid: verified.payload.sid,
        role: verified.payload.role,
      },
    };
  } catch {
    throw new AppError(401, 'Your session has expired. Please sign in again.', 'SESSION_INVALID');
  }
}

export async function getAuthContext(request: Request): Promise<AuthContext | null> {
  const token = parseCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) return null;
  let decoded: { userId: string; claims: SessionClaims };
  try {
    decoded = await decodeToken(token);
  } catch (error) {
    if (error instanceof AppError && error.code === 'SESSION_INVALID') return null;
    throw error;
  }
  const { userId, claims } = decoded;
  const session = await query<{ id: string }>(
    `SELECT id FROM sessions
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()
     LIMIT 1`,
    [claims.sid, userId],
  );
  if (!session.rows[0]) return null;
  const row = await findUserById(userId);
  if (!row || row.disabled) return null;
  // Read role from the database on every request so a role change takes effect
  // immediately even though the JWT contains a role claim for diagnostics only.
  return { user: rowToUser(row), sessionId: claims.sid };
}

export async function requireAuth(request: Request): Promise<AuthContext> {
  const auth = await getAuthContext(request);
  if (!auth) throw new AppError(401, 'Sign in is required.', 'UNAUTHENTICATED');
  return auth;
}

export async function revokeSession(request: Request): Promise<void> {
  const token = parseCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) return;
  try {
    const { claims } = await decodeToken(token);
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [claims.sid]);
  } catch {
    // Logout is idempotent, including for an already expired or malformed cookie.
  }
}

export function clearSessionCookie(response: Response): void {
  response.headers.append('Set-Cookie', cookieValue('', 0));
}

export async function listUsers(): Promise<User[]> {
  const result = await query<UserRow>(
    'SELECT id, name, email, role, disabled FROM users ORDER BY created_at ASC, id ASC',
  );
  return result.rows.map(rowToUser);
}

export async function updateUser(id: string, input: unknown, actorId?: string): Promise<User> {
  const parsed = adminUserPatch.parse(input);
  return withTransaction(async (client) => {
    const currentResult = await client.query<UserRow>(
      'SELECT id, name, email, role, disabled FROM users WHERE id = $1 LIMIT 1 FOR UPDATE',
      [id],
    );
    const current = currentResult.rows[0];
    if (!current) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
    if (parsed.disabled === true && actorId && actorId === id) {
      throw new AppError(409, 'An administrator cannot disable their own account.', 'SELF_DISABLE_FORBIDDEN');
    }
    if (parsed.disabled === true && !current.disabled && current.role === 'admin') {
      await client.query(ADMIN_DISABLE_ADVISORY_LOCK_SQL);
      const activeAdmins = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE role = 'admin' AND disabled = false AND id <> $1",
        [id],
      );
      if (Number(activeAdmins.rows[0]?.count ?? 0) === 0) {
        throw new AppError(409, 'At least one active administrator is required.', 'LAST_ADMIN_DISABLE_FORBIDDEN');
      }
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    if (parsed.name !== undefined) {
      values.push(parsed.name.trim());
      fields.push(`name = $${values.length}`);
    }
    if (parsed.disabled !== undefined) {
      values.push(parsed.disabled);
      fields.push(`disabled = $${values.length}`);
    }
    values.push(id);
    const result = await client.query<UserRow>(
      `UPDATE users SET ${fields.join(', ')}, updated_at = now()
       WHERE id = $${values.length}
       RETURNING id, name, email, role, disabled`,
      values as unknown[],
    );
    if (!result.rows[0]) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
    if (parsed.disabled === true && !current.disabled) {
      await client.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [id],
      );
    }
    return rowToUser(result.rows[0]);
  });
}

export async function makeScopedToken(payload: {
  userId: string;
  scope: 'onlyoffice';
  reviewId: string;
  versionId: string;
  ttlSeconds?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    scope: payload.scope,
    reviewId: payload.reviewId,
    versionId: payload.versionId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(payload.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + (payload.ttlSeconds ?? 15 * 60))
    .sign(sessionSecret());
}

export async function verifyScopedToken(token: string, expected: {
  userId?: string;
  reviewId?: string;
  versionId?: string;
}): Promise<boolean> {
  try {
    const { payload } = await jwtVerify<{
      scope?: string;
      reviewId?: string;
      versionId?: string;
    }>(token, sessionSecret(), { algorithms: ['HS256'] });
    return payload.scope === 'onlyoffice'
      && (!expected.userId || payload.sub === expected.userId)
      && (!expected.reviewId || payload.reviewId === expected.reviewId)
      && (!expected.versionId || payload.versionId === expected.versionId);
  } catch {
    return false;
  }
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export async function listAvailableLawyers(){
  return (await query<{id:string;name:string}>("SELECT id,name FROM users WHERE role='lawyer' AND disabled=false ORDER BY name,id")).rows;
}
