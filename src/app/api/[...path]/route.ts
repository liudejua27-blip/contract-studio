import {audited,auditAccess} from '@/server/access-audit';
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
  onlyOfficeAccess,
  getVersionFile,
  getOnlyOfficeRevisionState,
  listContracts,
  markEditorDirty,
  persistOnlyOfficeRevision,
  reportOnlyOfficeSaveFailure,
  respondToDelivery,
  assertOnlyOfficeRevisionCurrent,
  readUploadFile,
  saveEditor,
  startReview,
  submitReview,
  uploadReviewVersion,
} from '@/server/contracts';
import { capabilities } from '@/server/ai';
import {
  changePassword, issuePasswordReset, resetPassword,
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
import { readJsonBody, readUploadForm, assertMutationRequest, assertRequestSize, trustedSourceIdentifier } from '@/server/http-security';
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

const body = readJsonBody;

function requireAdmin(auth: Awaited<ReturnType<typeof requireAuth>>) {
  if (auth.user.role !== 'admin') throw new AppError(403, 'Administrator access is required.', 'FORBIDDEN');
}

async function handleGET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const path = await routePath(context);
    if(path.length===1&&path[0]==='learning'){const auth=await requireAuth(request);const {listLearning}=await import('@/server/review-learning');const url=new URL(request.url);return data(await listLearning(auth.user,url.searchParams.get('contract')||undefined,url.searchParams.get('review')||undefined,Number(url.searchParams.get('offset'))||0));}
    if(path.join('/')==='operations/generation'){const auth=await requireAuth(request);requireAdmin(auth);const {operationsReport}=await import('@/server/operations');return data(await operationsReport());}
    if(path.length===1&&path[0]==='notifications'){const auth=await requireAuth(request);const {query}=await import('@/server/db');return data((await query('SELECT id::text,contract_id,message,created_at FROM notifications WHERE user_id=$1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 50',[auth.user.id])).rows);}
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
    if(path.length===5&&path[0]==='contracts'&&path[2]==='jobs'&&path[4]==='events'){const auth=await requireAuth(request);const {jobSubscription}=await import('@/server/job-subscription');return await jobSubscription(auth.user,path[1],path[3]);}
    if(path.length===3&&path[0]==='contracts'&&path[2]==='deletion'){const auth=await requireAuth(request);const {deletionState}=await import('@/server/lifecycle');return data(await deletionState(auth.user,path[1]));}
    if(path.length===5&&path[0]==='contracts'&&path[2]==='reviews'&&path[4]==='materials'){const auth=await requireAuth(request);const {listReviewMaterials}=await import('@/server/materials');return data(await listReviewMaterials(auth.user,path[1],path[3]));}
    if(path[0]==='contracts'&&path[2]==='materials'){const auth=await requireAuth(request);const m=await import('@/server/materials');if(path.length===3)return data(await m.listMaterials(auth.user,path[1]));if(path.length===4){const file=await m.materialFile(auth.user,path[1],path[3]);return new Response(new Uint8Array(file.bytes),{headers:{'content-type':'application/octet-stream','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});}}
    if(path[0]==='contracts'&&((path.length===3&&path[2]==='messages')||(path.length===5&&path[2]==='reviews'&&path[4]==='messages'))){
      const auth=await requireAuth(request),{messagePage}=await import('@/server/contracts');
      return data(await messagePage(auth.user,path[1],new URL(request.url).searchParams.get('before')||undefined,path.length===5?path[3]:undefined));
    }
    if(path.length===4&&path[0]==='contracts'&&path[2]==='versions'){
      const auth=await requireAuth(request),{versionDetails}=await import('@/server/contracts');return data(await versionDetails(auth.user,path[1],path[3]));
    }
    if (path.length === 2 && path[0] === 'contracts') {
      const auth = await requireAuth(request),module = await import('@/server/contracts');
      const tag='"'+await module.contractChangeToken(auth.user,path[1])+'"';
      if(request.headers.get('if-none-match')===tag)return new Response(null,{status:304,headers:{etag:tag,'cache-control':'private, no-cache',vary:'Cookie'}});
      const response=data(await module.getContractForRoute(auth.user,path[1]));response.headers.set('etag',tag);response.headers.set('vary','Cookie');return response;
    }
    if (path.length === 2 && path[0] === 'files' && path[1] === 'onlyoffice') {
      const token = new URL(request.url).searchParams.get('token') ?? '';
      const claims = await verifyOnlyOfficeToken(token, { purpose: 'document' });
      await onlyOfficeAccess.check(claims);
      await auditAccess(claims.userId??'onlyoffice',claims.versionId);
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
      return data(await editorConfig(auth.user, path[1], path[3], viewOnly, auth.sessionId));
    }
    throw new AppError(404, 'API route not found.', 'NOT_FOUND');
  } catch (error) {
    return failure(error);
  }
}

async function handlePOST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const path = await routePath(context);
    if (!(path.length === 2 && path[0] === 'onlyoffice' && path[1] === 'callback')) {
      assertMutationRequest(request);
      assertRequestSize(request, ((path.length >= 5 && ['upload','materials'].includes(path[4])) || (path.length===3 && path[2]==='materials')) ? 30 * 1024 * 1024 : 2 * 1024 * 1024);
    }
    if (path.length === 2 && path[0] === 'onlyoffice' && path[1] === 'callback') {
      assertRequestSize(request, 2 * 1024 * 1024);
      const callbackBody = await readJsonBody(request);
      const token = new URL(request.url).searchParams.get('token') ?? request.headers.get('x-onlyoffice-token') ?? undefined;
      const result = await handleOnlyOfficeCallback({ token, headers: request.headers, body: callbackBody as never }, {
        storage,
        persistRevision: persistOnlyOfficeRevision,
        assertRevisionCurrent: assertOnlyOfficeRevisionCurrent,
        getRevisionState: getOnlyOfficeRevisionState,
        assertAccess: onlyOfficeAccess.check,
        reportSaveFailure: reportOnlyOfficeSaveFailure,
      });
      return NextResponse.json(result, { status: 200, headers: { 'cache-control': 'no-store' } });
    }
    if(path.length===5&&path[0]==='contracts'&&path[2]==='reviews'&&path[4]==='learning'){const auth=await requireAuth(request);const {createLearning}=await import('@/server/review-learning');return data(await createLearning(auth.user,path[1],path[3],await body(request)),201);}
    if(path.length===3&&path[0]==='learning'&&path[2]==='decision'){const auth=await requireAuth(request);const {decideLearning}=await import('@/server/review-learning');return data(await decideLearning(auth.user,path[1],await body(request)));}
    if(path.length===5&&path[0]==='contracts'&&path[2]==='reviews'&&path[4]==='materials'){const auth=await requireAuth(request);const {uploadReviewMaterial}=await import('@/server/materials');const form=await readUploadForm(request),file=form.get('file');if(!(file instanceof File))throw new AppError(400,'请选择补充材料。','MATERIAL_TYPE');return data(await uploadReviewMaterial(auth.user,path[1],path[3],{name:file.name,bytes:Buffer.from(await file.arrayBuffer())}),201);}
    if(path[0]==='contracts'&&path[2]==='materials'){const auth=await requireAuth(request);const m=await import('@/server/materials');if(path.length===3){const form=await readUploadForm(request),file=form.get('file');if(!(file instanceof File))throw new AppError(400,'请选择材料文件。','MATERIAL_TYPE');return data(await m.uploadMaterial(auth.user,path[1],{name:file.name,bytes:Buffer.from(await file.arrayBuffer())},form.get('purpose')),201);}if(path.length===5&&path[4]==='withdraw')return data(await m.withdrawMaterial(auth.user,path[1],path[3]));}
    if(path.join('/')==='auth/forgot-password'){const {requestAccountEmail}=await import('@/server/account-email');return data(await requestAccountEmail(await body(request),'reset',trustedSourceIdentifier(request)));}
    if(path.join('/')==='auth/verification-email'){const auth=await requireAuth(request);const {requestAccountEmail}=await import('@/server/account-email');return data(await requestAccountEmail({},'verify',trustedSourceIdentifier(request),auth.user.id));}
    if(path.join('/')==='auth/verify-email'){const {verifyAccountEmail}=await import('@/server/account-email');return data(await verifyAccountEmail(await body(request)));}
    if(path.length===1&&path[0]==='notifications'){const auth=await requireAuth(request);const input=await body(request);const {query}=await import('@/server/db');await query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id=$2',[auth.user.id,String(input.id||'0').replace(/[^0-9]/g,'')||'0']);return data(null);}
    if (path.join('/') === 'auth/password') {
      const auth = await requireAuth(request);
      await changePassword(auth.user.id, await body(request));
      const response=data(null); clearSessionCookie(response); return response;
    }
    if (path.join('/') === 'auth/reset-password') {
      await resetPassword(await body(request));
      const response=data(null); clearSessionCookie(response); return response;
    }
    if (path.length===3 && path[0]==='users' && path[2]==='reset-password') {
      const auth=await requireAuth(request);requireAdmin(auth);
      return data(await issuePasswordReset(auth.user,path[1],await body(request)));
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
    if(path.length===3&&path[0]==='contracts'&&path[2]==='deletion'){const auth=await requireAuth(request);const input=await body(request);const {deletionRequest}=await import('@/server/lifecycle');return data(await deletionRequest(auth.user,path[1],input.cancel===true));}
    if (path.length === 1 && path[0] === 'contracts') {
      const auth = await requireAuth(request);
      return data(await createContract(auth.user, await body(request)), 201);
    }
    if(path.length===5&&path[0]==='contracts'&&path[2]==='jobs'&&['run','retry','cancel'].includes(path[4])){const auth=await requireAuth(request);if(path[4]==='run'){const {jobSubscription}=await import('@/server/job-subscription');return await jobSubscription(auth.user,path[1],path[3]);}const {jobAction}=await import('@/server/contracts');return data(await jobAction(auth.user,path[1],path[3],path[4] as 'retry'|'cancel'));}
    if (path.length === 3 && path[0] === 'contracts' && path[2] === 'chat') {
      const auth = await requireAuth(request);
      return data(await chatContract(auth.user, path[1], await body(request)));
    }
    if (path.length === 3 && path[0] === 'contracts' && path[2] === 'reviews') {
      const auth = await requireAuth(request);
      return data(await submitReview(auth.user, path[1], await body(request)), 201);
    }
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
      const form = await readUploadForm(request);
      const file = await readUploadFile(form.get('file'));
      return data(await uploadReviewVersion(auth.user, path[1], path[3], file));
    }
    if (path.length === 5 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'complete') {
      const auth = await requireAuth(request);
      return data(await completeReview(auth.user, path[1], path[3], await body(request)));
    }
    if (path.length === 5 && path[0] === 'contracts' && path[2] === 'reviews' && path[4] === 'respond') {
      const auth = await requireAuth(request);
      return data(await respondToDelivery(auth.user, path[1], path[3], await body(request)));
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

async function handlePATCH(request: Request, context: RouteContext): Promise<Response> {
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

export const GET=audited(handleGET);
export const POST=audited(handlePOST);
export const PATCH=audited(handlePATCH);
