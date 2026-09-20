import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { DOCX_CONTENT_TYPE, validateDocxBuffer, type ValidatedDocx } from './documents';
import { createStorage, normalizeStorageKey, type StorageAdapter } from './storage';

export type OnlyOfficeRole = 'edit' | 'view';
export type OnlyOfficeRevision = string | number;

export interface OnlyOfficeTokenPayload extends JWTPayload {
  purpose: 'document' | 'callback';
  scope: 'contract-document-read' | 'contract-document-callback';
  reviewId: string;
  versionId: string;
  revision: string;
  /** Immutable source object loaded when this editor session started. */
  inputSourceFileKey: string;
  /** Compatibility alias; it is never used as the save target. */
  fileKey: string;
  documentKey: string;
  role: OnlyOfficeRole;
  /** The session account that requested the editor config. */
  userId?: string;
  /** Server-side editor session binding. */
  sessionId: string;
}

export interface OnlyOfficeEditorConfig {
  document: {
    fileType: 'docx';
    key: string;
    title: string;
    url: string;
    permissions: { edit: boolean; download: boolean; print: boolean };
  };
  documentType: 'word';
  editorConfig: {
    mode: 'edit' | 'view';
    callbackUrl: string;
    customization: { forcesave: boolean; autosave: boolean };
    lang: 'zh-CN';
    user?: { id: string; name?: string };
  };
  token: string;
}

export interface OnlyOfficeEditorConfigResponse {
  documentServerUrl: string;
  config: OnlyOfficeEditorConfig;
}

export interface CreateEditorConfigInput {
  reviewId: string;
  versionId: string;
  revision: OnlyOfficeRevision;
  fileKey?: string;
  sourceFileKey?: string;
  role?: OnlyOfficeRole;
  userId?: string;
  userName?: string;
  title?: string;
  baseUrl?: string;
  callbackBaseUrl?: string;
  documentPath?: string;
  callbackPath?: string;
  sessionId: string;
}

export interface OnlyOfficeOptions {
  secret?: string;
  issuer?: string;
  audience?: string;
  /** Legacy override for all token classes; prefer the class-specific fields. */
  tokenTtlSeconds?: number;
  /** Browser document URL/config token lifetime. Defaults to 15 minutes. */
  documentTokenTtlSeconds?: number;
  /** Callback URL token lifetime. Defaults to the active editor session window (8 hours). */
  callbackTokenTtlSeconds?: number;
  /** ONLYOFFICE config.token lifetime. Defaults to documentTokenTtlSeconds. */
  configTokenTtlSeconds?: number;
  publicBaseUrl?: string;
  documentServerUrl?: string;
  trustedDownloadOrigins?: string[];
  allowPrivateHosts?: string[];
  documentPath?: string;
  callbackPath?: string;
  storage?: StorageAdapter;
  fetchImpl?: typeof fetch;
  lookup?: typeof dnsLookup;
  maxDownloadBytes?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface VerifyOnlyOfficeTokenOptions {
  secret?: string;
  issuer?: string;
  audience?: string;
  purpose?: OnlyOfficeTokenPayload['purpose'];
  reviewId?: string;
  versionId?: string;
  revision?: OnlyOfficeRevision;
  fileKey?: string;
  sourceFileKey?: string;
  documentKey?: string;
  role?: OnlyOfficeRole;
  userId?: string;
  sessionId?: string;
}

export interface OnlyOfficeCallbackBody {
  /** Status may be present only inside the JWT when body-token mode is used. */
  status?: number;
  url?: string;
  key?: string;
  token?: string;
  userdata?: unknown;
  forcesavetype?: number;
  users?: string[];
  [key: string]: unknown;
}

export interface OnlyOfficeCallbackRequest {
  token?: string;
  headers?: Headers | Record<string, string | undefined>;
  body: OnlyOfficeCallbackBody;
}

export interface PersistOnlyOfficeRevisionInput {
  reviewId: string;
  versionId: string;
  revision: string;
  sourceFileKey: string;
  fileKey: string;
  bytes: Buffer;
  sha256: string;
  status: 2 | 6;
  sessionId: string;
  userId?: string;
  /** Force-save nonce/epoch or other signed callback userdata. */
  userData?: unknown;
}

export interface OnlyOfficeCallbackDependencies extends OnlyOfficeOptions {
  persistRevision: (input: PersistOnlyOfficeRevisionInput) => Promise<void>;
  /** A backend may reject a stale callback after reading its current DB row. */
  assertRevisionCurrent?: (input: Pick<PersistOnlyOfficeRevisionInput, 'reviewId' | 'versionId' | 'revision' | 'sessionId'>) => Promise<void>;
  /**
   * Optional read used to make a repeated callback idempotent. A saved row with
   * the same hash is acknowledged without rewriting the pointer; a stale or
   * completed row is rejected before storage is touched.
   */
  getRevisionState?: (input: Pick<PersistOnlyOfficeRevisionInput, 'reviewId' | 'versionId' | 'revision' | 'sessionId' | 'sha256'>) => Promise<{
    state: 'current' | 'saved' | 'stale' | 'completed';
    sha256?: string | null;
  }>;
}

export interface OnlyOfficeCallbackResult {
  error: 0 | 1;
  ignored?: boolean;
  saved?: boolean;
  status?: number;
  sha256?: string;
  message?: string;
}

export class OnlyOfficeSecurityError extends Error {
  readonly code = 'ONLYOFFICE_SECURITY_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'OnlyOfficeSecurityError';
  }
}

export class OnlyOfficeConfigurationError extends Error {
  readonly code = 'ONLYOFFICE_CONFIGURATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'OnlyOfficeConfigurationError';
  }
}

function revisionString(revision: OnlyOfficeRevision): string {
  const value = String(revision);
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new OnlyOfficeSecurityError('revision must be a short canonical identifier');
  }
  return value;
}

function requireIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000\r\n]/.test(value)) {
    throw new OnlyOfficeSecurityError(`${name} is invalid`);
  }
  return value;
}

function secretBytes(secret: string | undefined): Uint8Array {
  const value = secret ?? process.env.ONLYOFFICE_JWT_SECRET;
  if (!value || value.length < 32) {
    throw new OnlyOfficeConfigurationError('ONLYOFFICE_JWT_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(value);
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function configuredPrivateHosts(explicit?: string[]): Set<string> {
  const fromEnv = (process.env.ONLYOFFICE_ALLOW_PRIVATE_HOSTS ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return new Set([...fromEnv, ...(explicit ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean)]);
}

function validatedOrigin(value: string, label: string, allowPrivateHosts?: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OnlyOfficeConfigurationError(`${label} must be an absolute URL`);
  }
  const cleanPath = parsed.pathname === '/' || parsed.pathname === '';
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || !cleanPath) {
    throw new OnlyOfficeConfigurationError(`${label} must be a bare HTTP(S) origin`);
  }
  const privateHosts = configuredPrivateHosts(allowPrivateHosts);
  const explicitDevelopmentHost = process.env.NODE_ENV !== 'production' && privateHosts.has(parsed.hostname.toLowerCase());
  if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname) && !explicitDevelopmentHost) {
    throw new OnlyOfficeConfigurationError(`${label} must use HTTPS outside localhost development`);
  }
  return parsed;
}

function resolveBaseUrl(input: CreateEditorConfigInput, options: OnlyOfficeOptions): URL {
  const raw = input.baseUrl ?? options.publicBaseUrl ?? process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL;
  if (!raw) throw new OnlyOfficeConfigurationError('APP_BASE_URL is required for signed OnlyOffice URLs');
  return validatedOrigin(raw, 'APP_BASE_URL', options.allowPrivateHosts);
}

function resolveDocumentServerUrl(options: OnlyOfficeOptions): URL {
  const raw = options.documentServerUrl ?? process.env.ONLYOFFICE_DOCUMENT_SERVER_URL;
  if (!raw) throw new OnlyOfficeConfigurationError('ONLYOFFICE_DOCUMENT_SERVER_URL is required');
  return validatedOrigin(raw, 'ONLYOFFICE_DOCUMENT_SERVER_URL', options.allowPrivateHosts);
}

function pathJoin(base: URL, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('\\') || /[\u0000\r\n?#]/.test(path)) {
    throw new OnlyOfficeConfigurationError('OnlyOffice route path is invalid');
  }
  return new URL(path, base).toString();
}

export function onlyOfficeDocumentKey(versionId: string, revision: OnlyOfficeRevision): string {
  return createHash('sha256').update(`${requireIdentifier(versionId, 'versionId')}:${revisionString(revision)}`).digest('hex');
}

const MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60;

function checkedTokenTtl(ttl: number, label: string): number {
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > MAX_TOKEN_TTL_SECONDS) {
    throw new OnlyOfficeConfigurationError(`${label} must be between 30 seconds and 24 hours`);
  }
  return ttl;
}

function documentTokenTtl(options: OnlyOfficeOptions): number {
  return checkedTokenTtl(options.documentTokenTtlSeconds ?? options.tokenTtlSeconds ?? 15 * 60, 'OnlyOffice document token TTL');
}

function callbackTokenTtl(options: OnlyOfficeOptions): number {
  return checkedTokenTtl(options.callbackTokenTtlSeconds ?? options.tokenTtlSeconds ?? 8 * 60 * 60, 'OnlyOffice callback token TTL');
}

async function signJwtPayload(payload: Record<string, unknown>, options: OnlyOfficeOptions, ttl: number): Promise<string> {
  const checkedTtl = checkedTokenTtl(ttl, 'OnlyOffice token TTL');
  const now = Math.floor((options.now ?? (() => Date.now()))() / 1000);
  let jwt = new SignJWT({ ...payload, jti: randomUUID() })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + checkedTtl);
  const issuer = options.issuer ?? process.env.ONLYOFFICE_JWT_ISSUER;
  const audience = options.audience ?? process.env.ONLYOFFICE_JWT_AUDIENCE;
  if (issuer) jwt = jwt.setIssuer(issuer);
  if (audience) jwt = jwt.setAudience(audience);
  return jwt.sign(secretBytes(options.secret));
}

async function signToken(payload: Omit<OnlyOfficeTokenPayload, 'iat' | 'exp'>, options: OnlyOfficeOptions): Promise<string> {
  const ttl = payload.purpose === 'callback' ? callbackTokenTtl(options) : documentTokenTtl(options);
  return signJwtPayload(payload as unknown as Record<string, unknown>, options, ttl);
}

export async function verifyOnlyOfficeToken(
  token: string,
  expected: VerifyOnlyOfficeTokenOptions = {},
): Promise<OnlyOfficeTokenPayload> {
  if (!token || token.length > 8192) throw new OnlyOfficeSecurityError('OnlyOffice token is missing or too large');
  const issuer = expected.issuer ?? process.env.ONLYOFFICE_JWT_ISSUER;
  const audience = expected.audience ?? process.env.ONLYOFFICE_JWT_AUDIENCE;
  const result = await jwtVerify<OnlyOfficeTokenPayload>(token, secretBytes(expected.secret), {
    algorithms: ['HS256'],
    issuer: issuer || undefined,
    audience: audience || undefined,
    requiredClaims: ['purpose', 'scope', 'reviewId', 'versionId', 'revision', 'fileKey', 'inputSourceFileKey', 'documentKey', 'role', 'sessionId'],
  });
  const payload = result.payload;
  if (payload.purpose !== 'document' && payload.purpose !== 'callback') throw new OnlyOfficeSecurityError('OnlyOffice token purpose is invalid');
  if (payload.scope !== (payload.purpose === 'document' ? 'contract-document-read' : 'contract-document-callback')) {
    throw new OnlyOfficeSecurityError('OnlyOffice token scope is invalid');
  }
  if (payload.role !== 'edit' && payload.role !== 'view') throw new OnlyOfficeSecurityError('OnlyOffice token role is invalid');
  if (expected.purpose && payload.purpose !== expected.purpose) throw new OnlyOfficeSecurityError('OnlyOffice token purpose does not match');
  if (expected.reviewId && payload.reviewId !== expected.reviewId) throw new OnlyOfficeSecurityError('OnlyOffice review does not match token');
  if (expected.versionId && payload.versionId !== expected.versionId) throw new OnlyOfficeSecurityError('OnlyOffice version does not match token');
  if (expected.revision !== undefined && payload.revision !== revisionString(expected.revision)) throw new OnlyOfficeSecurityError('OnlyOffice revision does not match token');
  const tokenSourceFileKey = payload.inputSourceFileKey || payload.fileKey;
  if (expected.fileKey && tokenSourceFileKey !== expected.fileKey) throw new OnlyOfficeSecurityError('OnlyOffice file key does not match token');
  if (expected.sourceFileKey && tokenSourceFileKey !== expected.sourceFileKey) throw new OnlyOfficeSecurityError('OnlyOffice source file key does not match token');
  if (expected.documentKey && payload.documentKey !== expected.documentKey) throw new OnlyOfficeSecurityError('OnlyOffice document key does not match token');
  if (expected.role && payload.role !== expected.role) throw new OnlyOfficeSecurityError('OnlyOffice role does not match token');
  if (expected.userId && payload.userId !== expected.userId) throw new OnlyOfficeSecurityError('OnlyOffice user does not match token');
  if (expected.sessionId && payload.sessionId !== expected.sessionId) throw new OnlyOfficeSecurityError('OnlyOffice session does not match token');
  return payload;
}

export async function createEditorConfig(
  input: CreateEditorConfigInput,
  options: OnlyOfficeOptions = {},
): Promise<OnlyOfficeEditorConfigResponse> {
  const reviewId = requireIdentifier(input.reviewId, 'reviewId');
  const versionId = requireIdentifier(input.versionId, 'versionId');
  const revision = revisionString(input.revision);
  const role = input.role ?? 'edit';
  const fileKey = normalizeStorageKey(requireIdentifier(input.fileKey ?? `contracts/${reviewId}/versions/${versionId}/${revision}.docx`, 'fileKey'));
  const sourceFileKey = normalizeStorageKey(requireIdentifier(input.sourceFileKey ?? fileKey, 'sourceFileKey'));
  const documentKey = onlyOfficeDocumentKey(versionId, revision);
  const baseUrl = resolveBaseUrl(input, options);
  const documentServerUrl = resolveDocumentServerUrl(options);
  const documentPath = input.documentPath ?? options.documentPath ?? '/api/files/onlyoffice';
  const callbackPath = input.callbackPath ?? options.callbackPath ?? '/api/onlyoffice/callback';
  const callbackBaseUrl = input.callbackBaseUrl ? validatedOrigin(input.callbackBaseUrl, 'OnlyOffice callback base URL', options.allowPrivateHosts) : baseUrl;
  const sessionId = requireIdentifier(input.sessionId, 'sessionId');
  const documentToken = await signToken({ purpose: 'document', scope: 'contract-document-read', reviewId, versionId, revision, inputSourceFileKey: sourceFileKey, fileKey, documentKey, role, sessionId, ...(input.userId ? { userId: input.userId } : {}) }, options);
  const callbackToken = await signToken({ purpose: 'callback', scope: 'contract-document-callback', reviewId, versionId, revision, inputSourceFileKey: sourceFileKey, fileKey, documentKey, role, sessionId, ...(input.userId ? { userId: input.userId } : {}) }, options);
  const title = (input.title?.trim() || `合同-${versionId}`).slice(0, 180);
  const documentUrl = `${pathJoin(baseUrl, documentPath)}?token=${encodeURIComponent(documentToken)}`;
  const callbackUrl = `${pathJoin(callbackBaseUrl, callbackPath)}?token=${encodeURIComponent(callbackToken)}`;
  const editorConfig = {
    mode: role,
    callbackUrl,
    customization: { forcesave: true, autosave: true },
    lang: 'zh-CN' as const,
    ...(input.userId ? { user: { id: input.userId, name: input.userName } } : {}),
  };
  const configBody = {
    document: {
      fileType: 'docx' as const,
      key: documentKey,
      title: title.endsWith('.docx') ? title : `${title}.docx`,
      url: documentUrl,
      permissions: { edit: role === 'edit', download: true, print: true },
    },
    documentType: 'word' as const,
    editorConfig,
  };
  // ONLYOFFICE validates config.token against the complete config payload.
  // The business document/callback credentials stay in their narrow URL query
  // tokens and are deliberately not mixed into this browser-facing JWT.
  const configToken = await signJwtPayload(configBody, options, checkedTokenTtl(options.configTokenTtlSeconds ?? options.documentTokenTtlSeconds ?? options.tokenTtlSeconds ?? 15 * 60, 'OnlyOffice config token TTL'));
  return {
    documentServerUrl: documentServerUrl.origin,
    config: {
      ...configBody,
      token: configToken,
    },
  };
}

function ipv4Blocked(ip: string): boolean {
  const octets = ip.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
}

export function isBlockedIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4Blocked(ip);
  if (version !== 6) return true;
  const value = ip.toLowerCase().split('%')[0];
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  // Loopback, unspecified, unique-local, link-local and multicast ranges are
  // not valid targets for a callback download. The first hextet tests avoid a
  // permissive string-prefix check for compressed IPv6 spellings.
  const firstHextet = Number.parseInt(value.split(':').find(Boolean) ?? '', 16);
  if (value === '::1' || value === '::' || (Number.isInteger(firstHextet) && ((firstHextet >= 0xfc00 && firstHextet <= 0xfdff) || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) || firstHextet >= 0xff00))) return true;
  return value.startsWith('2001:db8:');
}

function normaliseTrustedOrigins(origins: string[] | undefined, allowPrivateHosts?: string[]): Set<string> {
  const values = origins ?? (process.env.ONLYOFFICE_TRUSTED_DOWNLOAD_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new OnlyOfficeConfigurationError('OnlyOffice callback requires a trusted download origin allowlist');
  const result = new Set<string>();
  for (const value of values) result.add(validatedOrigin(value, 'OnlyOffice trusted download origin', allowPrivateHosts).origin);
  return result;
}

export async function assertTrustedDownloadUrl(
  rawUrl: string,
  options: Pick<OnlyOfficeOptions, 'trustedDownloadOrigins' | 'allowPrivateHosts' | 'lookup'> = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OnlyOfficeSecurityError('OnlyOffice callback download URL is invalid');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new OnlyOfficeSecurityError('OnlyOffice callback download URL has an unsafe scheme or credentials');
  const allowPrivate = configuredPrivateHosts(options.allowPrivateHosts);
  if (url.protocol === 'http:' && !isLocalHost(url.hostname) && !(process.env.NODE_ENV !== 'production' && allowPrivate.has(url.hostname.toLowerCase()))) throw new OnlyOfficeSecurityError('OnlyOffice callback download URL must use HTTPS');
  if (!normaliseTrustedOrigins(options.trustedDownloadOrigins, [...allowPrivate]).has(url.origin)) throw new OnlyOfficeSecurityError('OnlyOffice callback download URL is outside the trusted origin allowlist');
  const hostname = url.hostname.toLowerCase();
  if (allowPrivate.has(hostname)) return url;
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await (options.lookup ?? dnsLookup)(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isBlockedIpAddress(entry.address))) throw new OnlyOfficeSecurityError('OnlyOffice callback download URL resolves to a private or reserved address');
  return url;
}

async function readResponseBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new OnlyOfficeSecurityError('OnlyOffice callback download is too large');
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new OnlyOfficeSecurityError('OnlyOffice callback download is too large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new OnlyOfficeSecurityError('OnlyOffice callback download is too large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function downloadOnlyOfficeFile(
  rawUrl: string,
  options: Pick<OnlyOfficeOptions, 'trustedDownloadOrigins' | 'allowPrivateHosts' | 'lookup' | 'fetchImpl' | 'maxDownloadBytes' | 'timeoutMs'> = {},
): Promise<ValidatedDocx> {
  const url = await assertTrustedDownloadUrl(rawUrl, options);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxDownloadBytes ?? 25 * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) throw new OnlyOfficeSecurityError('OnlyOffice callback redirects are not accepted');
    if (!response.ok) throw new OnlyOfficeSecurityError(`OnlyOffice callback download failed with HTTP ${response.status}`);
    const bytes = await readResponseBounded(response, maxBytes);
    return validateDocxBuffer(bytes);
  } catch (error) {
    if (error instanceof OnlyOfficeSecurityError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new OnlyOfficeSecurityError('OnlyOffice callback download timed out');
    throw new OnlyOfficeSecurityError(`OnlyOffice callback download failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    clearTimeout(timeout);
  }
}

function callbackError(message: string, status?: number): OnlyOfficeCallbackResult {
  return { error: 1, status, message };
}

export interface VerifyDocumentServerCallbackOptions {
  secret?: string;
  issuer?: string;
  audience?: string;
  expectedKey?: string;
  expectedStatus?: number;
}

export interface VerifiedDocumentServerCallback {
  claims: JWTPayload;
  /** The signed callback body, unwrapped from the optional JWT payload field. */
  payload: Record<string, unknown>;
}

function headerValue(headers: Headers | Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  const wanted = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return found?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Verify the JWT emitted by Document Server for the callback body. This is a
 * second signature check in addition to the narrow callback URL token: the URL
 * token fixes our session target, while this token proves the body came from a
 * JWT-enabled Document Server using the shared secret.
 */
export async function verifyDocumentServerCallback(
  request: Pick<OnlyOfficeCallbackRequest, 'headers' | 'body'>,
  options: VerifyDocumentServerCallbackOptions = {},
): Promise<VerifiedDocumentServerCallback> {
  const authorization = headerValue(request.headers, 'authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const bodyToken = typeof request.body?.token === 'string' ? request.body.token : undefined;
  const token = bearer ?? bodyToken;
  if (!token || token.length > 8192) throw new OnlyOfficeSecurityError('Document Server callback JWT is missing or too large');
  const result = await jwtVerify<JWTPayload>(token, secretBytes(options.secret), {
    algorithms: ['HS256'],
    issuer: options.issuer ?? process.env.ONLYOFFICE_JWT_ISSUER ?? undefined,
    audience: options.audience ?? process.env.ONLYOFFICE_JWT_AUDIENCE ?? undefined,
    // Document Server versions can emit a short callback JWT without exp; the
    // URL token remains the expiry-bound business credential. If exp is
    // present jose validates it automatically.
    requiredClaims: [],
  });
  const claims = result.payload;
  // Header-signed callbacks use {payload:{key,status,url,...}}, while body
  // signed callbacks use the callback fields directly. Accept both forms and
  // compare every field that arrived outside the token byte-for-byte after a
  // stable JSON normalization.
  const signedPayload = isRecord(claims.payload) ? claims.payload : claims;
  for (const [key, value] of Object.entries(request.body ?? {})) {
    if (key === 'token') continue;
    if (!(key in signedPayload) || canonicalJson(signedPayload[key]) !== canonicalJson(value)) {
      throw new OnlyOfficeSecurityError(`Document Server callback field is not covered by its JWT: ${key}`);
    }
  }
  const claimKey = typeof signedPayload.key === 'string' ? signedPayload.key : typeof signedPayload.documentKey === 'string' ? signedPayload.documentKey : undefined;
  if (options.expectedKey && claimKey !== options.expectedKey) throw new OnlyOfficeSecurityError('Document Server callback key does not match the document');
  if (options.expectedStatus !== undefined && Number(signedPayload.status) !== options.expectedStatus) {
    throw new OnlyOfficeSecurityError('Document Server callback status does not match the request');
  }
  return { claims, payload: signedPayload };
}

function boundedUserData(value: unknown): unknown {
  if (value === undefined) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new OnlyOfficeSecurityError('OnlyOffice callback userdata is not JSON serializable');
  }
  if (encoded.length > 16_384) throw new OnlyOfficeSecurityError('OnlyOffice callback userdata is too large');
  return JSON.parse(encoded);
}

function immutableCallbackFileKey(sourceFileKey: string, revision: string, sha256: string): string {
  const source = normalizeStorageKey(sourceFileKey);
  const slash = source.lastIndexOf('/');
  const directory = slash >= 0 ? source.slice(0, slash) : 'contracts';
  // Content-addressing makes a repeated callback idempotent while preserving
  // every distinct DOCX as a new immutable object. The source object is never
  // overwritten, even when a callback is retried.
  return normalizeStorageKey(`${directory}/onlyoffice/${revision}/${sha256}.docx`);
}

/** Process ONLYOFFICE callback statuses 2 (save) and 6 (force-save). */
export async function handleOnlyOfficeCallback(
  request: OnlyOfficeCallbackRequest,
  dependencies: OnlyOfficeCallbackDependencies,
): Promise<OnlyOfficeCallbackResult> {
  try {
    // Verify the URL credential first so a body-only callback JWT cannot choose
    // a different document key. Then use only the signed callback payload for
    // persistence; request fields are checked by verifyDocumentServerCallback
    // but are never trusted as the source of the downloaded URL/userdata.
    const claims = await verifyOnlyOfficeToken(request.token ?? '', { secret: dependencies.secret, issuer: dependencies.issuer, audience: dependencies.audience, purpose: 'callback' });
    const verifiedBody = await verifyDocumentServerCallback(
      { headers: request.headers, body: request.body },
      { secret: dependencies.secret, issuer: dependencies.issuer, audience: dependencies.audience, expectedKey: claims.documentKey },
    );
    const effectiveBody = { ...verifiedBody.payload } as OnlyOfficeCallbackBody;
    delete effectiveBody.token;
    const status = Number(effectiveBody.status);
    if (!Number.isInteger(status)) return callbackError('OnlyOffice callback status is missing');
    if (status === 1 || status === 4) return { error: 0, ignored: true, status };
    if (status === 3 || status === 7) return callbackError('OnlyOffice reported a save error; existing version was preserved', status);
    if (status !== 2 && status !== 6) return callbackError('OnlyOffice callback status is unsupported', status);
    if (claims.role !== 'edit') return callbackError('OnlyOffice view tokens cannot save a document', status);
    if (effectiveBody.key && effectiveBody.key !== claims.documentKey) return callbackError('OnlyOffice document key does not match callback token', status);
    if (!effectiveBody.url || typeof effectiveBody.url !== 'string') return callbackError('OnlyOffice callback did not provide a download URL', status);
    const downloaded = await downloadOnlyOfficeFile(effectiveBody.url, dependencies);
    const sourceFileKey = claims.inputSourceFileKey || claims.fileKey;
    const persistence: PersistOnlyOfficeRevisionInput = {
      reviewId: claims.reviewId,
      versionId: claims.versionId,
      revision: claims.revision,
      sessionId: claims.sessionId,
      userId: claims.userId,
      sourceFileKey,
      fileKey: immutableCallbackFileKey(sourceFileKey, claims.revision, downloaded.sha256),
      bytes: downloaded.bytes,
      sha256: downloaded.sha256,
      status: status as 2 | 6,
      userData: boundedUserData(effectiveBody.userdata),
    };
    const currentState = dependencies.getRevisionState ? await dependencies.getRevisionState(persistence) : undefined;
    if (currentState?.state === 'completed' || currentState?.state === 'stale') {
      return callbackError('OnlyOffice callback revision is no longer current', status);
    }
    if (currentState?.state === 'saved') {
      if (currentState.sha256 && currentState.sha256 === persistence.sha256) {
        return { error: 0, saved: true, ignored: true, status, sha256: persistence.sha256 };
      }
      // The same editor session may save a new immutable DOCX after a dirty
      // event. Only an identical hash is a duplicate; a different hash must
      // continue through the current-session guard and get its own object key.
    }
    if (dependencies.assertRevisionCurrent) await dependencies.assertRevisionCurrent(persistence);
    const objectStorage = dependencies.storage ?? createStorage();
    await objectStorage.put(persistence.fileKey, persistence.bytes, DOCX_CONTENT_TYPE);
    // The DB pointer changes only after validated bytes are stored. A failed
    // hook leaves the prior saved version untouched and a retry is idempotent.
    await dependencies.persistRevision(persistence);
    return { error: 0, saved: true, status, sha256: persistence.sha256 };
  } catch (error) {
    const callbackStatus = Number(request.body?.status);
    return callbackError(error instanceof Error ? error.message : 'OnlyOffice callback persistence failed', Number.isFinite(callbackStatus) ? callbackStatus : undefined);
  }
}
