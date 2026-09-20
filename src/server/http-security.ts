import { isIP } from 'node:net';
import { AppError } from './db';

export function assertMutationRequest(request: Request): void {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') throw new AppError(403, 'Cross-site requests are not allowed.', 'CSRF_BLOCKED');
  const origin = request.headers.get('origin');
  if (!origin) return;
  const expected = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  try {
    if (new URL(origin).origin !== new URL(expected).origin) {
      throw new AppError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
  }
}

export function assertRequestSize(request: Request, maxBytes: number): void {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError(413, 'Request body is too large.', 'REQUEST_TOO_LARGE');
  }
}

/**
 * Return a source label only when the deployment explicitly trusts its proxy
 * headers. A client-controlled X-Forwarded-For must never become the only
 * login bucket; the email bucket in auth.ts remains effective without this.
 */
export function trustedSourceIdentifier(request: Request): string | undefined {
  if (process.env.CONTRACT_TRUST_PROXY !== 'true') return undefined;
  const candidates = [
    request.headers.get('x-real-ip'),
    request.headers.get('x-forwarded-for')?.split(',')[0],
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && isIP(value)) return value;
  }
  return undefined;
}

