import {auditAccess} from './access-audit';
import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Role, User } from '@/lib/types';
import { AppError, query, withTransaction } from './db';
import {
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
  must_change_password?: boolean;
  email_verified_at?: Date|string;
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
  return { id: row.id, name: row.name, email: row.email, role: row.role, disabled: row.disabled, mustChangePassword: Boolean(row.must_change_password), emailVerified: Boolean(row.email_verified_at), emailVerificationRequired: process.env.CONTRACT_REQUIRE_VERIFIED_EMAIL==='true' };
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
    'SELECT id, name, email, role, disabled, must_change_password, email_verified_at FROM users WHERE id = $1 LIMIT 1',
    [id],
  );
  return result.rows[0] ?? null;
}

async function findUserForLogin(email: string): Promise<(UserRow & { password_hash: string }) | null> {
  const result = await query<UserRow & { password_hash: string }>(
    'SELECT id, name, email, role, disabled, must_change_password, email_verified_at, password_hash FROM users WHERE email_normalized = $1 LIMIT 1',
    [normalizeEmail(email)],
  );
  return result.rows[0] ?? null;
}

async function createUserRecord(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
  mustChangePassword?: boolean;
}): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  try {
    const result = await query<UserRow>(
      `INSERT INTO users (id, name, email, email_normalized, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, role, disabled, must_change_password, email_verified_at`,
      [randomUUID(), input.name.trim(), input.email.trim(), normalizeEmail(input.email), passwordHash, input.role, input.mustChangePassword ?? false],
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
  // Registration counts every attempt, including successful creation, so a
  // source cannot create unlimited accounts by choosing fresh email addresses.
  await recordAuthRateLimitAttempt(rateKeys);
  return createUserRecord({ ...parsed, role: 'client' });
}

export async function createUserAsAdmin(input: unknown): Promise<User> {
  const parsed = adminUserInput.parse(input);
  return createUserRecord({...parsed, mustChangePassword: true});
}

export async function login(input: unknown, context: AuthAttemptContext = {}): Promise<{ user: User; token: string; sessionId: string; expiresAt: Date }> {
  const parsed = loginInput.parse(input);
  const rateKeys = buildAuthRateLimitKeys('login', normalizeEmail(parsed.email), context.sourceIdentifier);
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
  await withTransaction(async client => {
    const current = await client.query('SELECT password_hash, disabled FROM users WHERE id=$1 FOR UPDATE',[user.id]);
    if (!current.rows[0] || current.rows[0].disabled || current.rows[0].password_hash !== row.password_hash) throw new AppError(401,'Invalid email or password.','INVALID_CREDENTIALS');
    await client.query('INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',[issued.sessionId,user.id,tokenHash(issued.token),issued.expiresAt]);
  });
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
  if (auth.user.mustChangePassword && !['/api/auth/password','/api/auth/logout','/api/auth/verification-email'].includes(new URL(request.url).pathname)) throw new AppError(403, '请先修改初始密码。', 'PASSWORD_CHANGE_REQUIRED');
  if(auth.user.emailVerificationRequired&&!auth.user.emailVerified&&!['/api/auth/password','/api/auth/logout','/api/auth/verification-email'].includes(new URL(request.url).pathname))throw new AppError(403,'请先验证邮箱。','EMAIL_VERIFICATION_REQUIRED');
  await auditAccess(auth.user.id);
  return auth;
}

export async function revokeSession(request: Request): Promise<void> {
  const token = parseCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) return;
  let decoded: { userId: string; claims: SessionClaims };
  try {
    decoded = await decodeToken(token);
  } catch {
    // Logout is idempotent, including for an already expired or malformed cookie.
    return;
  }
  await withTransaction(async client => {
    const revoked = await client.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING user_id', [decoded.claims.sid, decoded.userId]);
    if (revoked.rowCount) await client.query('UPDATE editor_sessions SET active=false,updated_at=now() WHERE assigned_user_id=$1 AND active=true', [decoded.userId]);
  });
}

export function clearSessionCookie(response: Response): void {
  response.headers.append('Set-Cookie', cookieValue('', 0));
}

export async function listUsers(): Promise<User[]> {
  const result = await query<UserRow>(
    'SELECT id, name, email, role, disabled, must_change_password, email_verified_at FROM users ORDER BY created_at ASC, id ASC',
  );
  return result.rows.map(rowToUser);
}

export async function updateUser(id: string, input: unknown, actorId?: string): Promise<User> {
  const parsed = adminUserPatch.parse(input);
  return withTransaction(async (client) => {
    const currentResult = await client.query<UserRow>(
      'SELECT id, name, email, role, disabled, must_change_password, email_verified_at FROM users WHERE id = $1 LIMIT 1 FOR UPDATE',
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
       RETURNING id, name, email, role, disabled, must_change_password, email_verified_at`,
      values as unknown[],
    );
    if (!result.rows[0]) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
    if (parsed.disabled === true && !current.disabled) {
      await client.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [id],
      );
      await client.query('UPDATE editor_sessions SET active=false,updated_at=now() WHERE assigned_user_id=$1 AND active=true', [id]);
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

export async function changePassword(userId: string, input: unknown): Promise<void> {
  const parsed = z.object({currentPassword:z.string().min(1).max(256),password:z.string().min(12).max(256)}).parse(input);
  if (parsed.password === parsed.currentPassword) throw new AppError(400,'新密码不能与原密码相同。','INVALID_INPUT');
  await recordAuthRateLimitAttempt(buildAuthRateLimitKeys('login', 'password-change:'+userId));
  const row = (await query<{password_hash:string}>('SELECT password_hash FROM users WHERE id=$1 AND NOT disabled',[userId])).rows[0];
  if (!row || !await verifyPassword(parsed.currentPassword,row.password_hash)) throw new AppError(401,'原密码不正确。','INVALID_CREDENTIALS');
  const hash = await hashPassword(parsed.password);
  await withTransaction(async client => {
    const changed = await client.query('UPDATE users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2 AND password_hash=$3 AND NOT disabled RETURNING id',[hash,userId,row.password_hash]);
    if (!changed.rowCount) throw new AppError(409,'凭据已发生变化，请重新登录。','CREDENTIAL_CHANGED');
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[userId]);
    await client.query('UPDATE editor_sessions SET active=false,updated_at=now() WHERE assigned_user_id=$1 AND active=true',[userId]);
    await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[userId]);
    await client.query("INSERT INTO access_audit(actor_id,action,resource_id,outcome) VALUES ($1,'password.change',$1,200)",[userId]);
  });
}

/** Operator must verify identity through an established channel before issuing. Raw token is returned once. */
export async function issuePasswordReset(actor: User, userId: string, input: unknown): Promise<{token:string;expiresAt:string}> {
  if (actor.role !== 'admin') throw new AppError(403,'Administrator required.','FORBIDDEN');
  const parsed = z.object({currentPassword:z.string().min(1).max(256)}).parse(input);
  await recordAuthRateLimitAttempt(buildAuthRateLimitKeys('login', 'password-reset:'+actor.id));
  const admin = (await query<{password_hash:string}>('SELECT password_hash FROM users WHERE id=$1 AND NOT disabled AND role=\'admin\'',[actor.id])).rows[0];
  if (!admin || !await verifyPassword(parsed.currentPassword,admin.password_hash)) throw new AppError(401,'管理员密码不正确。','INVALID_CREDENTIALS');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now()+30*60*1000).toISOString();
  await withTransaction(async client => {
    const locked=await client.query('SELECT id,password_hash,role,disabled FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[[actor.id,userId]]);
    const operator=locked.rows.find(row=>row.id===actor.id);
    if(!operator||operator.disabled||operator.role!=='admin'||operator.password_hash!==admin.password_hash)throw new AppError(401,'管理员凭据已变化，请重新登录。','INVALID_CREDENTIALS');
    const user = await client.query('SELECT id FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',[userId]);
    if (!user.rowCount) throw new AppError(404,'User not found.','USER_NOT_FOUND');
    await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[userId]);
    await client.query('INSERT INTO password_reset_tokens(token_hash,user_id,issued_by,expires_at) VALUES ($1,$2,$3,$4)',[tokenHash(token),userId,actor.id,expiresAt]);
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[userId]);
    await client.query('UPDATE editor_sessions SET active=false,updated_at=now() WHERE assigned_user_id=$1 AND active=true',[userId]);
    await client.query("INSERT INTO access_audit(actor_id,action,resource_id,outcome) VALUES ($1,'password.reset.issue',$2,200)",[actor.id,userId]);
  });
  return {token,expiresAt};
}

export async function resetPassword(input: unknown): Promise<void> {
  const parsed = z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),password:z.string().min(12).max(256)}).parse(input);
  const digest = tokenHash(parsed.token);
  // Reject invalid tokens before scrypt. Recheck under the user lock to prevent reuse/races.
  const token = (await query<{user_id:string}>('SELECT user_id FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()',[digest])).rows[0];
  if (!token) throw new AppError(400,'重置链接无效或已过期。','RESET_INVALID');
  const hash = await hashPassword(parsed.password);
  await withTransaction(async client => {
    const user = await client.query('SELECT id FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',[token.user_id]);
    const used = await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id',[digest]);
    if (!user.rowCount || !used.rowCount) throw new AppError(400,'重置链接无效或已过期。','RESET_INVALID');
    await client.query('UPDATE users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2',[hash,token.user_id]);
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[token.user_id]);
    await client.query('UPDATE editor_sessions SET active=false,updated_at=now() WHERE assigned_user_id=$1 AND active=true',[token.user_id]);
    await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[token.user_id]);
    await client.query("INSERT INTO access_audit(actor_id,action,resource_id,outcome) VALUES ($1,'password.reset.complete',$1,200)",[token.user_id]);
  });
}
