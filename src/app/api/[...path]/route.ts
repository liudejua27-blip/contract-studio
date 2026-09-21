import {templateDownload} from '@/server/template-download';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import type { Contract } from '@/lib/types';
import {
  addReviewMessage,
  assignReview,
  chatContract,
  completeReview,
  createContract,
  editorConfig,
  getVersionFile,
  getOnlyOfficeRevisionState,
  listContracts,
  markEditorDirty,
  persistOnlyOfficeRevision,
  assertOnlyOfficeRevisionCurrent,
  readUploadFile,
  saveEditor,
  startReview,
  submitReview,
  uploadReviewVersion,
} from '@/server/contracts';
import { capabilities } from '@/server/ai';
import {
  attachSession,
  clearSessionCookie,
  createUserAsAdmin,
  getAuthContext,
  listUsers,
  listAvailableLawyers,
  login,
  registerClient,
  requireAuth,
  revokeSession,
  setSessionCookie,
  updateUser,
} from '@/server/auth';
import { AppError } from '@/server/db';
import { DOCX_CONTENT_TYPE, storage } from '@/server/documents';
import { assertMutationRequest, assertRequestSize, trustedSourceIdentifier } from '@/server/http-security';
import { handleOnlyOfficeCallback, verifyOnlyOfficeToken } from '@/server/onlyoffice';

type RouteContext = { params: Promise<{ path?: string[] }> };

function data(value: unknown, status = 200): NextResponse {
  return NextResponse.json({ data: value }, { status, headers: { 'cache-control': 'no-store' } });
}

function failure(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: { 'cache-control': 'no-store' } });
  }
  if (error instanceof ZodError) {
    const first = error.issues[0]?.message ?? 'Invalid request.';
    return NextResponse.json({ error: first, code: 'INVALID_INPUT' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }
  // Provider/database details are intentionally kept server-side. The user receives a
  // stable message while deployment logs can still identify an unexpected failure.
  console.error('contract-studio API error', error instanceof Error ? error.message : error);
  return NextResponse.json({ error: 'Unexpected server error.', code: 'INTERNAL_ERROR' }, { status: 500, headers: { 'cache-control': 'no-store' } });
}

async function routePath(context: RouteContext): Promise<string[]> {
  const params = await context.params;
  return params.path ?? [];
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return {};
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new AppError(400, 'Valid JSON is required.', 'INVALID_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'JSON object is required.', 'INVALID_INPUT');
  return value as Record<string, unknown>;
}

function requireAdmin(auth: Awaited<ReturnType<typeof requireAuth>>) {
  if (auth.user.role !== 'admin') throw new AppError(403, 'Administrator access is required.', 'FORBIDDEN');
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const path = await routePath(context);
    if (path.length === 1 && path[0] === 'session') {
      const auth = await getAuthContext(request);
      return data(auth?.user ?? null);
    }
    if (path.length === 1 && path[0] === 'capabilities') return data(capabilities());
    if(path.length===3&&path[0]==='templates'&&path[2]==='download'){await requireAuth(request);return templateDownload(path[1]);}
    if(path.length===1&&path[0]==='contract-list'){const auth=await requireAuth(request);const {listContractPage}=await import('@/server/contracts');return data(await listContractPage(auth.user,Object.fromEntries(new URL(request.url).searchParams)));}
    if(path.length===1&&path[0]==='lawyers'){await requireAuth(request);return data(await listAvailableLawyers());}
    if (path.length === 1 && path[0] === 'contracts') {
      const auth = await requireAuth(request);
      return data(await listContracts(auth.user));
    }
    if (path.length === 2 && path[0] === 'contracts') {
      const auth = await requireAuth(request);
      const module = await import('@/server/contracts');
      const contract = await module.getContractForRoute(auth.user, path[1]);
      return data(contract);
    }
    if (path.length === 2 && path[0] === 'files' && path[1] === 'onlyoffice') {
      const token = new URL(request.url).searchParams.get('token') ?? '';
      const claims = await verifyOnlyOfficeToken(token, { purpose: 'document' });
      // The session file advances after each saved revision; the original source
      // is retained only as provenance and must not replace the reopened draft.
      const bytes = await storage.get(claims.fileKey);
      if (!bytes) throw new AppError(404, 'The document bytes are unavailable.', 'FILE_NOT_FOUND');
      return new Response(new Uint8Array(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)), {
        status: 200,
        headers: { 'content-type': DOCX_CONTENT_TYPE, 'cache-control': 'private, no-store' },
      });
    }
    if (path.length === 2 && path[0] === 'files') {
      const auth = await requireAuth(request);
      const file = await getVersionFile(auth.user, path[1]);
      return new Response(new Uint8Array(file.bytes), {
        status: 200,
        headers: {
          'content-type': file.contentType,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
          'cache-control': 'private, no-store',
          ...(file.sha256 ? { etag: `"${file.sha256}"` } : {}),
        },
      });
    }
    if (path.length === 1 && path[0] === 'users') {
      const auth = await requireAuth(request);
      requireAdmin(auth);
      return data(await listUsers());
    }
    if (path.length === 5 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'editor') {
      const auth = await requireAuth(request);
      const viewOnly = new URL(request.url).searchParams.get('mode') === 'view';
      return data(await editorConfig(auth.user, path[1], path[3], viewOnly));
    }
    throw new AppError(404, 'API route not found.', 'NOT_FOUND');
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const path = await routePath(context);
    if (!(path.length === 2 && path[0] === 'onlyoffice' && path[1] === 'callback')) {
      assertMutationRequest(request);
      assertRequestSize(request, (path.length >= 5 && path[4] === 'upload') ? 30 * 1024 * 1024 : 2 * 1024 * 1024);
    }
    if (path.length === 2 && path[0] === 'onlyoffice' && path[1] === 'callback') {
      assertRequestSize(request, 2 * 1024 * 1024);
      let callbackBody: Record<string, unknown>;
      try {
        callbackBody = await request.json() as Record<string, unknown>;
      } catch {
        return NextResponse.json({ error: 1, message: 'Valid JSON is required.' }, { status: 400 });
      }
      const token = new URL(request.url).searchParams.get('token') ?? request.headers.get('x-onlyoffice-token') ?? undefined;
      const result = await handleOnlyOfficeCallback({ token, headers: request.headers, body: callbackBody as never }, {
        storage,
        persistRevision: persistOnlyOfficeRevision,
        assertRevisionCurrent: assertOnlyOfficeRevisionCurrent,
        getRevisionState: getOnlyOfficeRevisionState,
      });
      return NextResponse.json(result, { status: 200, headers: { 'cache-control': 'no-store' } });
    }
    if (path.length === 2 && path[0] === 'auth' && path[1] === 'login') {
      const result = await login(await body(request), { sourceIdentifier: trustedSourceIdentifier(request) });
      const response = data(result.user);
      setSessionCookie(response, result.token);
      return response;
    }
    if (path.length === 2 && path[0] === 'auth' && path[1] === 'register') {
      const user = await registerClient(await body(request), { sourceIdentifier: trustedSourceIdentifier(request) });
      const response = data(user, 201);
      await attachSession(response, user);
      return response;
    }
    if (path.length === 2 && path[0] === 'auth' && path[1] === 'logout') {
      await revokeSession(request);
      const response = data(null);
      clearSessionCookie(response);
      return response;
    }
    if (path.length === 1 && path[0] === 'contracts') {
      const auth = await requireAuth(request);
      return data(await createContract(auth.user, await body(request)), 201);
    }
    if(path.length===5&&path[0]==='contracts'&&path[2]==='jobs'&&['run','retry','cancel'].includes(path[4])){const auth=await requireAuth(request);const {jobAction}=await import('@/server/contracts');if(path[4]==='run'&&request.headers.get('accept')?.includes('text/event-stream')){const {agentStreamResponse}=await import('@/server/agent/http-stream');return agentStreamResponse(emit=>jobAction(auth.user,path[1],path[3],'run',emit));}return data(await jobAction(auth.user,path[1],path[3],path[4] as 'run'|'retry'|'cancel'));}
    if (path.length === 3 && path[0] === 'contracts' && path[2] === 'chat') {
      const auth = await requireAuth(request);
      return data(await chatContract(auth.user, path[1], await body(request)));
    }
    if (path.length === 3 && path[0] === 'contracts' && path[2] === 'reviews') {
      const auth = await requireAuth(request);
      return data(await submitReview(auth.user, path[1], await body(request)), 201);
    }
    if(path.length===5&&path[0]==='contracts'&&path[2]==='reviews'&&path[4]==='transfer'){const auth=await requireAuth(request);const {transferReview}=await import('@/server/contracts');return data(await transferReview(auth.user,path[1],path[3],await body(request)));}
    if (path.length === 5 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'assign') {
      const auth = await requireAuth(request);
      const input = await body(request);
      return data(await assignReview(auth.user, path[1], path[3], String(input.lawyerId ?? '')));
    }
    if (path.length === 5 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'start') {
      const auth = await requireAuth(request);
      return data(await startReview(auth.user, path[1], path[3]));
    }
    if (path.length === 5 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'messages') {
      const auth = await requireAuth(request);
      return data(await addReviewMessage(auth.user, path[1], path[3], await body(request)));
    }
    if (path.length === 5 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'upload') {
      const auth = await requireAuth(request);
      const form = await request.formData();
      const file = await readUploadFile(form.get('file'));
      return data(await uploadReviewVersion(auth.user, path[1], path[3], file));
    }
    if (path.length === 5 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'complete') {
      const auth = await requireAuth(request);
      return data(await completeReview(auth.user, path[1], path[3], await body(request)));
    }
    if (path.length === 6 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'editor' && path[5] === 'save') {
      const auth = await requireAuth(request);
      return data(await saveEditor(auth.user, path[1], path[3], await body(request)));
    }
    if (path.length === 6 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'editor' && path[5] === 'dirty') {
      const auth = await requireAuth(request);
      return data(await markEditorDirty(auth.user, path[1], path[3], await body(request)));
    }
    if (path.length === 1 && path[0] === 'users') {
      const auth = await requireAuth(request);
      requireAdmin(auth);
      return data(await createUserAsAdmin(await body(request)), 201);
    }
    throw new AppError(404, 'API route not found.', 'NOT_FOUND');
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const path = await routePath(context);
    assertMutationRequest(request);
    assertRequestSize(request, 2 * 1024 * 1024);
    if (path.length === 2 && path[0] === 'users') {
      const auth = await requireAuth(request);
      requireAdmin(auth);
      return data(await updateUser(path[1], await body(request), auth.user.id));
    }
    throw new AppError(404, 'API route not found.', 'NOT_FOUND');
  } catch (error) {
    return failure(error);
  }
}
