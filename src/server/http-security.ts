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


/** Bound actual streamed bytes even when Content-Length is absent or dishonest. */
export async function readRequestBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  assertRequestSize(request, maxBytes);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let buffer = new Uint8Array(Math.min(65536,maxBytes));
  let size = 0;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 30_000);
  let ended = false;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) { ended = true; break; }
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new AppError(413, 'Request body is too large.', 'REQUEST_TOO_LARGE');
      }
      if(size>buffer.length){const grown=new Uint8Array(Math.min(maxBytes,Math.max(size,buffer.length*2)));grown.set(buffer);buffer=grown;}
      buffer.set(value,size-value.byteLength);
    }
  } finally { clearTimeout(deadline); reader.releaseLock(); }
  if (timedOut || !ended) throw new AppError(408, 'Request timed out.', 'REQUEST_TIMEOUT');
  return buffer.slice(0,size);
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readRequestBytes(request, 2 * 1024 * 1024);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
  catch { throw new AppError(400, 'Valid JSON is required.', 'INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'JSON object is required.', 'INVALID_INPUT');
  return value as Record<string, unknown>;
}

export async function readUploadForm(request: Request): Promise<FormData> {
  const bytes = await readRequestBytes(request, 30 * 1024 * 1024);
  try { return await new Response(new Uint8Array(bytes), {headers: {'content-type': request.headers.get('content-type') ?? ''}}).formData(); }
  catch { throw new AppError(400, 'Valid upload form is required.', 'INVALID_INPUT'); }
}
