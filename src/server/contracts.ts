import {loadClausePreferences} from './review-learning';
import {loadMaterials} from './materials';
import {auditAccess} from './access-audit';
import {recordModelCall} from './operations';
import {pauseModelAdmission} from './worker-scheduler';
import {sessionCheckpoint} from './session-checkpoint';
import {admitAIJob} from './ai-admission';
import {reviewVersionProblem} from '../lib/review-policy';
import {consultationBrief} from '../lib/consultation';
import {listQuery,summary} from '../lib/contract-list';
import {startWorkflow,controlWorkflow,type WorkflowStore} from './workflow';
import {getTemplate} from '../lib/contract-library/catalog';
import {annotateMessage} from '../lib/contract-library/engine';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { z } from 'zod';
import type {
  Contract,
  ContractContent,
  Message,
  Review,
  ReviewMessage,
  Role,
  User,
  Version,
} from '@/lib/types';
import { generateContractReply, type AiMode } from './ai';
import type { AuthContext } from './auth';
import { AppError, query, withTransaction } from './db';
import { extractDocxText, renderContract, storage, validateDocxBuffer } from './documents';
import { createEditorConfig, verifyOnlyOfficeToken, type OnlyOfficeCallbackBody, type OnlyOfficeEditorConfigResponse, type OnlyOfficeTokenPayload, type PersistOnlyOfficeRevisionInput } from './onlyoffice';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type ContractRow = {
  workflow?:Contract["workflow"];
  workflow_revision?:number;
  id: string;
  owner_id: string;
  owner_name: string;
  title: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type MessageRow = {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: Date | string;
};

type VersionRow = {
  text_content?:string;
  id: string;
  number: number;
  kind: 'draft' | 'review';
  review_id: string | null;
  file_key: string;
  content: unknown;
  created_at: Date | string;
  source: 'ai' | 'demo' | 'lawyer';
  sha256: string | null;
};

type ReviewRow = {
  id: string;
  submitted_version_id: string | null;
  lawyer_id: string | null;
  lawyer_name?: string;
  handoff_version_id?:string;
  status: Review['status'];
  stance: string;
  concerns: string;
  requirements: string;
  submitted_at: Date | string;
  completed_at: Date | string | null;
  final_version_id: string | null;
  delivery_note: string | null;
  client_response?: Review['clientResponse'] | null;
  client_responded_at?: Date | string | null;
  client_feedback?: string | null;
  editing_version_id: string | null;
  save_status: Review['saveStatus'] | null;
};

type ReviewMessageRow = {
  id: string;
  seq: number;
  author_id: string;
  author_name: string;
  content: string;
  created_at: Date | string;
};

type EditorSessionRow = {
  id: string;
  review_id: string;
  base_version_id: string;
  document_key: string;
  scratch_file_key: string;
  assigned_user_id: string;
  dirty_epoch: number;
  saved_epoch: number;
  save_nonce: string | null;
  active: boolean;
};

const createContractInput = z.object({
  title: z.string().trim().max(240).optional(),
});

const chatInput = z.object({
  message: z.string().trim().min(1).max(50_000),
  mode: z.enum(['demo', 'live']).default('live'),
  templateId: z.string().refine(id=>!!getTemplate(id)).optional(),
  generate: z.boolean().default(false),
});

const reviewInput = z.object({
  lawyerId: z.string().uuid().optional(),
  versionId: z.string().trim().min(1).optional(),
  consultation: z.boolean().default(false),
  stance: z.string().trim().min(1).max(10_000),
  concerns: z.string().trim().max(50_000).default(''),
});

const messageInput = z.object({
  requestId: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(50_000),
  requestInfo: z.boolean().default(false),
});

const completeInput = z.object({
  versionId: z.string().trim().min(1),
  deliveryNote: z.string().trim().min(1).max(20_000),
});

const editorSaveInput = z.object({
  versionId: z.string().trim().min(1).optional(),
  token: z.string().trim().min(1).optional(),
});

const editorDirtyInput = z.object({
  versionId: z.string().trim().min(1).optional(),
});

function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return new Date(value).toISOString();
}

function parseContent(value: unknown): ContractContent | null {
  if (!value || typeof value !== 'object') return null;
  return value as ContractContent;
}

function mapMessage(row: MessageRow): Message {
  return { id: row.id, role: row.role, content: row.content, createdAt: iso(row.created_at)! };
}

function mapVersion(row: VersionRow): Version {
  return {
    id: row.id,
    bodyLoaded:(row as VersionRow & {body_loaded?:boolean}).body_loaded??true,
    number: row.number,
    reviewId:row.review_id||undefined,
    text:row.text_content,
    kind: row.kind,
    fileKey: row.file_key,
    content: parseContent(row.content),
    createdAt: iso(row.created_at)!,
    source: row.source,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
  };
}

function mapReview(row: ReviewRow, messages: ReviewMessage[]): Review {
  return {
    id: row.id,
    submittedVersionId: row.submitted_version_id,
    lawyerId: row.lawyer_id,
    lawyerName: row.lawyer_name,
    handoffVersionId: row.handoff_version_id,
    status: row.status,
    stance: row.stance,
    concerns: row.concerns,
    requirements: row.requirements,
    submittedAt: iso(row.submitted_at)!,
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    ...(row.final_version_id ? { finalVersionId: row.final_version_id } : {}),
    ...(row.delivery_note ? { deliveryNote: row.delivery_note } : {}),
    ...(row.client_response ? { clientResponse: row.client_response } : {}),
    ...(row.client_responded_at ? { clientRespondedAt: iso(row.client_responded_at) } : {}),
    ...(row.client_feedback ? { clientFeedback: row.client_feedback } : {}),
    messages,
    ...(row.editing_version_id ? { editingVersionId: row.editing_version_id } : {}),
    ...(row.save_status ? { saveStatus: row.save_status } : {}),
  };
}

function mapContract(row: ContractRow, messages: Message[], versions: Version[], reviews: Review[]): Contract {
  return {
    workflow:row.workflow,
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    title: row.title,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    messages,
    versions,
    reviews,
  };
}

async function hydrateContract(row: ContractRow, actor?: AuthContext['user'], compact=false): Promise<Contract> {
  const lawyerScope = actor?.role === 'lawyer';
  // Keep the complete persisted record for the Agent. Browser reads need only
  // recent messages and the current draft / latest submitted source bodies.
  const bodyColumns=compact?`CASE WHEN v.id=(SELECT id FROM versions WHERE contract_id=v.contract_id ORDER BY number DESC LIMIT 1)
    OR v.id=(SELECT submitted_version_id FROM reviews WHERE contract_id=v.contract_id ${lawyerScope?'AND lawyer_id=$2':''} ORDER BY submitted_at DESC,id DESC LIMIT 1)
    THEN v.content ELSE NULL END AS content,
    CASE WHEN v.id=(SELECT id FROM versions WHERE contract_id=v.contract_id ORDER BY number DESC LIMIT 1) OR v.id=(SELECT submitted_version_id FROM reviews WHERE contract_id=v.contract_id ${lawyerScope?'AND lawyer_id=$2':''} ORDER BY submitted_at DESC,id DESC LIMIT 1) THEN v.text_content ELSE NULL END AS text_content,
    (v.id=(SELECT id FROM versions WHERE contract_id=v.contract_id ORDER BY number DESC LIMIT 1)
    OR v.id=(SELECT submitted_version_id FROM reviews WHERE contract_id=v.contract_id ${lawyerScope?'AND lawyer_id=$2':''} ORDER BY submitted_at DESC,id DESC LIMIT 1)) AS body_loaded`:'v.content,v.text_content,true AS body_loaded';
  const [messageRows, versionRows, reviewRows] = await Promise.all([
    lawyerScope
      ? Promise.resolve({ rows: [] as MessageRow[] })
      : query<MessageRow>(
        `SELECT id, seq, role, content, created_at FROM messages WHERE contract_id = $1 ORDER BY seq ${compact?'DESC LIMIT 51':'ASC'}`,
        [row.id],
      ),
    lawyerScope
      ? query<VersionRow>(
        `SELECT v.id, v.number, v.kind, v.review_id, v.file_key, ${bodyColumns}, v.created_at, v.source, v.sha256
         FROM versions v
         WHERE v.contract_id = $1
           AND EXISTS (
             SELECT 1
             FROM reviews r
             WHERE r.contract_id = v.contract_id
               AND r.lawyer_id = $2
               AND (
                 r.id = v.review_id
                 OR r.submitted_version_id = v.id
                 OR r.editing_version_id = v.id
                 OR r.final_version_id = v.id
               )
           )
         ORDER BY v.number ASC`,
        [row.id, actor!.id],
      )
      : query<VersionRow>(
        `SELECT v.id, v.number, v.kind, v.review_id, v.file_key, ${bodyColumns}, v.created_at, v.source, v.sha256
         FROM versions v WHERE v.contract_id = $1 ORDER BY v.number ASC`,
        [row.id],
      ),
    lawyerScope
      ? query<ReviewRow>(
        `SELECT id, submitted_version_id, lawyer_id, (SELECT name FROM users WHERE users.id=reviews.lawyer_id) AS lawyer_name, status, stance, concerns, requirements,
                submitted_at, completed_at, final_version_id, delivery_note, client_response, client_responded_at, client_feedback,
                editing_version_id, save_status, handoff_version_id
         FROM reviews
         WHERE contract_id = $1 AND lawyer_id = $2
         ORDER BY submitted_at DESC, id DESC`,
        [row.id, actor!.id],
      )
      : query<ReviewRow>(
        `SELECT id, submitted_version_id, lawyer_id, (SELECT name FROM users WHERE users.id=reviews.lawyer_id) AS lawyer_name, status, stance, concerns, requirements,
                submitted_at, completed_at, final_version_id, delivery_note, client_response, client_responded_at, client_feedback,
                editing_version_id, save_status, handoff_version_id
         FROM reviews WHERE contract_id = $1 ORDER BY submitted_at DESC, id DESC`,
        [row.id],
      ),
  ]);
  const reviewMessages = await Promise.all(reviewRows.rows.map(async (review) => {
    const result = await query<ReviewMessageRow>(
      `SELECT rm.id, rm.seq, rm.author_id, u.name AS author_name, rm.content, rm.created_at
       FROM review_messages rm JOIN users u ON u.id = rm.author_id
       WHERE rm.review_id = $1 ORDER BY rm.seq ${compact?'DESC LIMIT 51':'ASC'}`,
      [review.id],
    );
    return [review.id, {hasMore:compact&&result.rows.length>50,items:(compact?result.rows.slice(0,50).reverse():result.rows).map((message) => ({
      id: message.id,
      authorId: message.author_id,
      authorName: message.author_name,
      content: message.content,
      createdAt: iso(message.created_at)!,
    }))}] as const;
  }));
  const messageMap = new Map(reviewMessages);
  const contract = mapContract(
    actor?.role==='lawyer'?{...row,workflow:undefined}:row,
    (compact?messageRows.rows.slice(0,50).reverse():messageRows.rows).map(mapMessage),
    versionRows.rows.map(mapVersion),
    reviewRows.rows.map((review) => ({...mapReview(review, messageMap.get(review.id)?.items ?? []),messagesHasMore:messageMap.get(review.id)?.hasMore})),
  );
  if(compact){
    contract.messagesHasMore=messageRows.rows.length>50;
    if(contract.workflow){const {receipts,...workflow}=contract.workflow;contract.workflow={...workflow};
      if(workflow.job){const {content,repairFeedback,lease,continuation,...job}=workflow.job;contract.workflow.job=job;}
    }
  }
  return contract;
}

async function findAccessibleRow(contractId: string, actor: AuthContext['user']): Promise<ContractRow | null> {
  const result = await query<ContractRow>(
    `SELECT c.id, c.owner_id, u.name AS owner_name, c.title, c.created_at, c.updated_at, c.workflow, c.workflow_revision
     FROM contracts c JOIN users u ON u.id = c.owner_id
     WHERE c.id = $1
       AND ($2 = 'admin' OR c.owner_id = $3
            OR EXISTS (SELECT 1 FROM reviews r WHERE r.contract_id = c.id AND r.lawyer_id = $3))
     LIMIT 1`,
    [contractId, actor.role, actor.id],
  );
  return result.rows[0] ?? null;
}

async function requireAccessible(contractId: string, actor: AuthContext['user'],compact=true): Promise<Contract> {
  const row = await findAccessibleRow(contractId, actor);
  if (!row) throw new AppError(404, 'Contract not found.', 'CONTRACT_NOT_FOUND');
  return hydrateContract(row, actor,compact);
}

export async function getContractForRoute(actor: AuthContext['user'], contractId: string): Promise<Contract> {
  return requireAccessible(contractId, actor);
}

export async function listContracts(actor: AuthContext['user']): Promise<Contract[]> {
  const result = await query<ContractRow>(
    `SELECT c.id, c.owner_id, u.name AS owner_name, c.title, c.created_at, c.updated_at, c.workflow, c.workflow_revision
     FROM contracts c JOIN users u ON u.id = c.owner_id
     WHERE $1 = 'admin' OR c.owner_id = $2
        OR EXISTS (SELECT 1 FROM reviews r WHERE r.contract_id = c.id AND r.lawyer_id = $2)
     ORDER BY c.updated_at DESC, c.id DESC LIMIT 20`,
    [actor.role, actor.id],
  );
  return Promise.all(result.rows.map((contractRow) => hydrateContract(contractRow, actor,true)));
}

export async function createContract(actor: AuthContext['user'], input: unknown): Promise<Contract> {
  const parsed = createContractInput.parse(input ?? {});
  const id = randomUUID();
  const title = parsed.title?.trim() || '未命名合同';
  await query(
    'INSERT INTO contracts (id, owner_id, title) VALUES ($1, $2, $3)',
    [id, actor.id, title],
  );
  return requireAccessible(id, actor);
}

async function openReviewExists(contractId: string, client?: PoolClient): Promise<boolean> {
  const sql = `SELECT 1 FROM reviews WHERE contract_id = $1 AND status IN ('waiting', 'reviewing', 'need_info') AND (submitted_version_id IS NOT NULL OR editing_version_id IS NOT NULL) LIMIT 1`;
  const result = client ? await client.query(sql, [contractId]) : await query(sql, [contractId]);
  return Boolean(result.rows[0]);
}

async function lockContract(client: PoolClient, contractId: string): Promise<void> {
  const result = await client.query('SELECT id FROM contracts WHERE id = $1 FOR UPDATE', [contractId]);
  if (!result.rows[0]) throw new AppError(404, 'Contract not found.', 'CONTRACT_NOT_FOUND');
}

async function renderAndStore(content: ContractContent, fileKey: string): Promise<string> {
  const rendered = await renderContract(content);
  const bytes = Buffer.isBuffer(rendered) ? rendered : Buffer.from(rendered);
  await storage.put(fileKey, bytes, DOCX_CONTENT_TYPE);
  return createHash('sha256').update(bytes).digest('hex');
}

export function workflowStore(actor:User,contractId:string,workerToken?:string):WorkflowStore{let admission=false;return{
 background:true,
 loadMaterials:()=>loadMaterials(actor,contractId),
 loadPreferences:intake=>loadClausePreferences(actor,intake),
 agentSessions:true,
 onRateLimit:pauseModelAdmission,onModelCall:recordModelCall,
 sessionCheckpoint:(jobId,lease)=>sessionCheckpoint(actor.id,contractId,jobId,lease,workerToken),
 load:async()=>{const row=await findAccessibleRow(contractId,actor);if(!row)throw new AppError(404,'合同不存在。','CONTRACT_NOT_FOUND');return{contract:await hydrateContract(row,actor),revision:row.workflow_revision||0}},
 save:async(c,revision)=>{await withTransaction(async client=>{
 if(admission)await admitAIJob(client,actor.id,contractId);
 const changed=await client.query('UPDATE contracts SET workflow=$1::jsonb,workflow_revision=workflow_revision+1,title=$2,updated_at=now() WHERE id=$3 AND workflow_revision=$4 AND EXISTS(SELECT 1 FROM users WHERE id=$5 AND disabled=false AND role=$6) AND ($7::text IS NULL OR EXISTS(SELECT 1 FROM agent_worker_leases WHERE contract_id=$3 AND token=$7 AND expires_at>now()))',[JSON.stringify(c.workflow),c.title,contractId,revision,actor.id,actor.role,workerToken??null]);
 if(changed.rowCount!==1)throw new AppError(409,'合同状态已变化，请刷新。','CONFLICT');
 if(await openReviewExists(contractId,client))throw new AppError(409,'合同正在审核。','REVIEW_VERSION_FROZEN');
 await client.query(`INSERT INTO messages(id,contract_id,role,content,created_at)
 SELECT x.id,$1,x.role,x.content,x."createdAt" FROM jsonb_to_recordset($2::jsonb) AS x(id text,role text,content text,"createdAt" timestamptz)
 WHERE NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=x.id) ON CONFLICT(id) DO NOTHING`,[c.id,JSON.stringify(c.messages)]);
 await client.query(`INSERT INTO versions(id,contract_id,number,kind,file_key,content,source,sha256,created_at)
 SELECT x.id,$1,x.number,x.kind,x."fileKey",x.content,x.source,x.sha256,x."createdAt" FROM jsonb_to_recordset($2::jsonb) AS x(id text,number int,kind text,"fileKey" text,content jsonb,source text,sha256 text,"createdAt" timestamptz)
 WHERE NOT EXISTS(SELECT 1 FROM versions v WHERE v.id=x.id) ON CONFLICT(id) DO NOTHING`,[c.id,JSON.stringify(c.versions)]);
 });admission=false;return requireAccessible(contractId,actor,false)},
 isCurrent:async(id,lease)=>{const result=await query(`SELECT 1 FROM contracts c JOIN users u ON u.id=c.owner_id WHERE c.id=$1 AND c.owner_id=$2 AND NOT u.disabled AND u.role='client' AND c.workflow->'job'->>'id'=$3 AND c.workflow->'job'->>'lease'=$4 AND c.workflow->'job'->>'status'='running' AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM agent_worker_leases WHERE contract_id=c.id AND token=$5 AND expires_at>now()))`,[contractId,actor.id,id,lease,workerToken??null]);return !!result.rowCount;},
 put:async(key,content)=>renderAndStore(content,key),
 limit:async()=>{admission=true;},
};}
export async function chatContract(actor:User,contractId:string,input:unknown):Promise<Contract>{await startWorkflow(workflowStore(actor,contractId),actor,input);return requireAccessible(contractId,actor);}
export async function jobAction(actor:User,contractId:string,jobId:string,action:'run'|'retry'|'cancel',onEvent?:import('../lib/agent-stream').AgentEventSink){return controlWorkflow({...workflowStore(actor,contractId),onEvent},actor,jobId,action);}

export async function submitReview(actor: AuthContext['user'], contractId: string, input: unknown): Promise<Contract> {
  const parsed = reviewInput.parse(input);
  if (actor.role !== 'admin' && actor.role !== 'client') {
    throw new AppError(403, 'Only the contract owner can submit a review.', 'FORBIDDEN');
  }
  await withTransaction(async (client) => {
    const contract = await client.query<{ owner_id: string }>('SELECT owner_id FROM contracts WHERE id = $1 FOR UPDATE', [contractId]);
    if (!contract.rows[0]) throw new AppError(404, 'Contract not found.', 'CONTRACT_NOT_FOUND');
    if (actor.role !== 'admin' && contract.rows[0].owner_id !== actor.id) {
      throw new AppError(403, 'Only the contract owner can submit a review.', 'FORBIDDEN');
    }
    const jobState=await client.query("SELECT workflow->'job'->>'status' AS status FROM contracts WHERE id=$1",[contractId]);
    if(['pending','running'].includes(jobState.rows[0]?.status))throw new AppError(409,'请等待当前起草完成。','JOB_ACTIVE');
    if (await openReviewExists(contractId, client)) {
      throw new AppError(409, 'An open review already exists for this contract.', 'REVIEW_ALREADY_OPEN');
    }
    if ((await client.query("SELECT 1 FROM reviews WHERE contract_id=$1 AND status='completed' AND final_version_id IS NOT NULL LIMIT 1",[contractId])).rowCount)
      throw new AppError(409,'律师已交付成品，请在原合同中继续与负责律师沟通。','CONTRACT_DELIVERED');
    const assigned = (await client.query<{lawyer_id:string}>("SELECT lawyer_id FROM reviews WHERE contract_id=$1 AND lawyer_id IS NOT NULL ORDER BY submitted_at,id LIMIT 1",[contractId])).rows[0]?.lawyer_id;
    if (assigned && parsed.lawyerId && assigned !== parsed.lawyerId)
      throw new AppError(409,'这份合同由原负责律师持续处理，不支持更换律师。','LAWYER_FIXED');
    parsed.lawyerId = assigned || parsed.lawyerId;
    const snapshot=await client.query('SELECT workflow FROM contracts WHERE id=$1',[contractId]);
    if(!parsed.consultation){
      const rows=await client.query<VersionRow>('SELECT * FROM versions WHERE contract_id=$1 ORDER BY number ASC',[contractId]);
      const versions=rows.rows.map(mapVersion),version=versions.find(v=>v.id===parsed.versionId);
      const problem=reviewVersionProblem({workflow:snapshot.rows[0]?.workflow,versions},version);
      if(problem)throw new AppError(409,problem.message,problem.code);
      const bytes=await storage.get(version!.fileKey);
      if(!bytes||!version!.sha256||createHash('sha256').update(bytes).digest('hex')!==version!.sha256)
        throw new AppError(503,'合同文件尚未保存完整，请重新生成或上传后再送审。','FILE_NOT_FOUND');
    }else if(parsed.versionId){throw new AppError(400,'约定协助不提交合同文件，请单独选择合同审核。','INVALID_INPUT');}
    const messages = await client.query<{ role: string; content: string }>(
      'SELECT role, content FROM messages WHERE contract_id = $1 ORDER BY seq ASC',
      [contractId],
    );
    if(parsed.lawyerId){
      const target=await client.query("SELECT id FROM users WHERE id=$1 AND role='lawyer' AND disabled=false FOR SHARE",[parsed.lawyerId]);
      if(!target.rows[0])throw new AppError(400,'该律师目前无法接收审核，请重新选择。','LAWYER_UNAVAILABLE');
    }
    if(parsed.consultation&&!messages.rows.some(m=>m.role==='user'))throw new AppError(400,'请先描述交易需求。','REQUIREMENTS_REQUIRED');
    const requirements = (parsed.consultation?consultationBrief({workflow:snapshot.rows[0]?.workflow}):'')+messages.rows.map((message) => `${message.role === 'user' ? '客户' : '助手'}：${message.content}`).join('\n');
    const legacy=await client.query("SELECT id FROM reviews WHERE contract_id=$1 AND status IN ('waiting','reviewing','need_info') AND submitted_version_id IS NULL AND editing_version_id IS NULL LIMIT 1",[contractId]);
    if(legacy.rows[0]&&parsed.consultation)return;
    if(legacy.rows[0]){
      await client.query("UPDATE reviews SET submitted_version_id=$1,status='waiting',submitted_at=now(),stance=$2,concerns=$3,requirements=$4,lawyer_id=COALESCE($5,lawyer_id) WHERE id=$6",[parsed.versionId,parsed.stance,parsed.concerns,requirements,parsed.lawyerId||null,legacy.rows[0].id]);
    }else{
    await client.query(
      `INSERT INTO reviews
       (id, contract_id, submitted_version_id, status, stance, concerns, requirements, lawyer_id)
       VALUES ($1, $2, $3, 'waiting', $4, $5, $6, $7)`,
      [randomUUID(), contractId, parsed.consultation?null:parsed.versionId, parsed.stance, parsed.concerns, requirements, parsed.lawyerId||null],
    );
    }
    await client.query('UPDATE contracts SET updated_at = now() WHERE id = $1', [contractId]);
  });
  return requireAccessible(contractId, actor);
}

async function reviewForActor(clientOrQuery: PoolClient | undefined, contractId: string, reviewId: string): Promise<{
  review: ReviewRow;
  ownerId: string;
  lawyerId: string | null;
}> {
  const sql = `SELECT r.id, r.submitted_version_id, r.lawyer_id, r.status, r.stance, r.concerns,
                      r.requirements, r.submitted_at, r.completed_at, r.final_version_id,
                      r.delivery_note, r.client_response, r.client_responded_at, r.client_feedback,
                      r.editing_version_id, r.save_status, r.handoff_version_id, c.owner_id
               FROM reviews r JOIN contracts c ON c.id = r.contract_id
               WHERE r.id = $1 AND r.contract_id = $2 LIMIT 1`;
  const lock = clientOrQuery ? ' FOR UPDATE' : '';
  const result = clientOrQuery
    ? await clientOrQuery.query(`${sql}${lock}`, [reviewId, contractId])
    : await query(sql, [reviewId, contractId]);
  const row = result.rows[0] as (ReviewRow & { owner_id: string }) | undefined;
  if (!row) throw new AppError(404, 'Review not found.', 'REVIEW_NOT_FOUND');
  return { review: row, ownerId: row.owner_id, lawyerId: row.lawyer_id };
}

function canReviewMessage(actor: User, review: { ownerId: string; lawyerId: string | null }): boolean {
  return actor.role === 'admin' || actor.id === review.ownerId || (actor.role === 'lawyer' && actor.id === review.lawyerId);
}

export async function assignReview(actor: AuthContext['user'], contractId: string, reviewId: string, lawyerId: string): Promise<Contract> {
  if (actor.role !== 'admin') throw new AppError(403, 'Only an administrator can assign a lawyer.', 'FORBIDDEN');
  if (!lawyerId?.trim()) throw new AppError(400, 'lawyerId is required.', 'INVALID_INPUT');
  await withTransaction(async (client) => {
    await lockContract(client, contractId);
    const lawyer = await client.query<{ id: string; role: Role; disabled: boolean }>(
      'SELECT id, role, disabled FROM users WHERE id = $1 LIMIT 1',
      [lawyerId],
    );
    if (!lawyer.rows[0] || lawyer.rows[0].role !== 'lawyer' || lawyer.rows[0].disabled) {
      throw new AppError(400, 'Choose an active lawyer account.', 'INVALID_LAWYER');
    }
    const current = await reviewForActor(client, contractId, reviewId);
    const assigned = (await client.query<{lawyer_id:string}>("SELECT lawyer_id FROM reviews WHERE contract_id=$1 AND lawyer_id IS NOT NULL ORDER BY submitted_at,id LIMIT 1",[contractId])).rows[0]?.lawyer_id;
    if ((current.lawyerId && current.lawyerId !== lawyerId) || (assigned && assigned !== lawyerId))
      throw new AppError(409,'这份合同已确定负责律师，不支持更换。','LAWYER_FIXED');
    if (current.lawyerId === lawyerId) return;
    if (current.review.status !== 'waiting') {
      throw new AppError(409, 'A review can only be assigned while it is waiting.', 'REVIEW_NOT_ASSIGNABLE');
    }
    await client.query('UPDATE reviews SET lawyer_id = $1 WHERE id = $2', [lawyerId, reviewId]);
  });
  return requireAccessible(contractId, actor);
}

export async function startReview(actor: AuthContext['user'], contractId: string, reviewId: string): Promise<Contract> {
  await withTransaction(async (client) => {
    await lockContract(client, contractId);
    const current = await reviewForActor(client, contractId, reviewId);
    if (actor.role !== 'lawyer' || current.lawyerId !== actor.id) {
      throw new AppError(403, 'Only the assigned lawyer can start this review.', 'FORBIDDEN');
    }
    if (current.review.status === 'reviewing') return;
    if (current.review.status !== 'waiting') {
      throw new AppError(409, 'This review is no longer waiting to start.', 'REVIEW_NOT_STARTABLE');
    }
    await client.query("UPDATE reviews SET status = 'reviewing' WHERE id = $1", [reviewId]);
  });
  return requireAccessible(contractId, actor);
}

export async function addReviewMessage(actor: AuthContext['user'], contractId: string, reviewId: string, input: unknown): Promise<Contract> {
  const parsed = messageInput.parse(input);
  await withTransaction(async (client) => {
    await lockContract(client, contractId);
    const current = await reviewForActor(client, contractId, reviewId);
    if (!canReviewMessage(actor, current)) throw new AppError(403, 'You cannot message this review.', 'FORBIDDEN');
    if (current.review.status === 'waiting'&&actor.role==='lawyer')throw new AppError(409,'请先接收审核任务。','REVIEW_NOT_STARTED');
    if (parsed.requestInfo && (actor.role !== 'lawyer' || current.lawyerId !== actor.id)) {
      throw new AppError(403, 'Only the assigned lawyer can request information.', 'FORBIDDEN');
    }
    if(parsed.requestId){
      const previous=(await client.query('SELECT content,request_info FROM review_messages WHERE review_id=$1 AND author_id=$2 AND request_id=$3',[reviewId,actor.id,parsed.requestId])).rows[0];
      if(previous){
        if(previous.content!==parsed.content||previous.request_info!==parsed.requestInfo)throw new AppError(409,'这次发送的内容已变化，请重新发送。','MESSAGE_REQUEST_CONFLICT');
        return;
      }
    }
    await client.query(
      'INSERT INTO review_messages (id, review_id, author_id, content,request_id,request_info) VALUES ($1, $2, $3, $4,$5,$6)',
      [randomUUID(), reviewId, actor.id, parsed.content,parsed.requestId??null,parsed.requestInfo],
    );
    const recipient = actor.id === current.ownerId ? current.lawyerId : current.ownerId;
    if (recipient) await client.query('INSERT INTO notifications(user_id,contract_id,message) VALUES($1,$2,$3)',[recipient,contractId,'合同有新的沟通消息，请联系本合同的用户或负责律师。']);
    await client.query('UPDATE contracts SET updated_at=now() WHERE id=$1',[contractId]);
    if (parsed.requestInfo && current.review.status !== 'completed') {
      await client.query("UPDATE reviews SET status = 'need_info' WHERE id = $1", [reviewId]);
    } else if (actor.id === current.ownerId && current.review.status === 'need_info') {
      await client.query("UPDATE reviews SET status = 'reviewing' WHERE id = $1", [reviewId]);
    }
  });
  return requireAccessible(contractId, actor);
}

export async function uploadReviewVersion(actor: AuthContext['user'], contractId: string, reviewId: string, file: {
  name: string;
  type: string;
  bytes: Buffer;
}): Promise<Contract> {
  if (actor.role !== 'lawyer') throw new AppError(403, 'Only the assigned lawyer can upload a review version.', 'FORBIDDEN');
  if (!file.name.toLowerCase().endsWith('.docx') && file.type !== DOCX_CONTENT_TYPE) {
    throw new AppError(400, 'Only DOCX files are accepted.', 'INVALID_FILE_TYPE');
  }
  const maxBytes = Number(process.env.CONTRACT_MAX_DOCX_BYTES ?? 25 * 1024 * 1024);
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > maxBytes) {
    throw new AppError(413, 'The DOCX file is empty or too large.', 'FILE_TOO_LARGE');
  }
  try {
    validateDocxBuffer(file.bytes, { maxCompressedBytes: maxBytes });
  } catch {
    throw new AppError(400, 'The uploaded file is not a valid DOCX document.', 'INVALID_DOCX');
  }
  const review = await reviewForActor(undefined, contractId, reviewId);
  if (review.lawyerId !== actor.id) throw new AppError(403, 'Only the assigned lawyer can upload a review version.', 'FORBIDDEN');
  if (review.review.status === 'completed') throw new AppError(409, 'The delivered review is read-only.', 'REVIEW_COMPLETED');
  if(!review.review.submitted_version_id)throw new AppError(409,'请先由客户提交 Word。','VERSION_REQUIRED');
  const versionId = randomUUID();
  const fileKey = `contracts/${contractId}/versions/${versionId}.docx`;
  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  await storage.put(fileKey, file.bytes, DOCX_CONTENT_TYPE);
  await withTransaction(async (client) => {
    await lockContract(client, contractId);
    const locked = await reviewForActor(client, contractId, reviewId);
    if (locked.lawyerId !== actor.id) throw new AppError(403, 'Only the assigned lawyer can upload a review version.', 'FORBIDDEN');
    if(!locked.review.submitted_version_id)throw new AppError(409,'请先由客户提交 Word，约定协助不能直接交付合同。','VERSION_REQUIRED');
    if (locked.review.status === 'waiting')throw new AppError(409,'请先接收审核任务。','REVIEW_NOT_STARTED');
    if (locked.review.status === 'completed') throw new AppError(409, 'The delivered review is read-only.', 'REVIEW_COMPLETED');
    const max = await client.query<{ max: number | null }>('SELECT MAX(number) AS max FROM versions WHERE contract_id = $1', [contractId]);
    const number = Number(max.rows[0]?.max ?? 0) + 1;
    await client.query(
      `INSERT INTO versions (id, contract_id, number, kind, review_id, file_key, content, source, sha256)
       VALUES ($1, $2, $3, 'review', $4, $5, NULL, 'lawyer', $6)`,
      [versionId, contractId, number, reviewId, fileKey, sha256],
    );
    await client.query('UPDATE versions SET text_content=$1 WHERE id=$2',[extractDocxText(file.bytes).slice(0,100000),versionId]);
    await client.query(
      "UPDATE reviews SET editing_version_id = $1, save_status = 'saved' WHERE id = $2",
      [versionId, reviewId],
    );
    const sessions = await client.query<EditorSessionRow>(
      `SELECT id, review_id, base_version_id, document_key, scratch_file_key, assigned_user_id,
              dirty_epoch, saved_epoch, save_nonce, active
       FROM editor_sessions WHERE review_id = $1 AND active = true LIMIT 1 FOR UPDATE`,
      [reviewId],
    );
    if (sessions.rows[0]) {
      // Uploading a new DOCX is an explicit revision boundary. Close the
      // browser's old session so the next editor config gets a fresh key.
      await client.query('UPDATE editor_sessions SET active = false, updated_at = now() WHERE id = $1', [sessions.rows[0].id]);
    }
    await client.query('UPDATE contracts SET updated_at = now() WHERE id = $1', [contractId]);
  });
  return requireAccessible(contractId, actor);
}

export async function completeReview(actor: AuthContext['user'], contractId: string, reviewId: string, input: unknown): Promise<Contract> {
  const parsed = completeInput.parse(input);
  if (actor.role !== 'lawyer') throw new AppError(403, 'Only the assigned lawyer can deliver a review.', 'FORBIDDEN');
  await withTransaction(async (client) => {
    await lockContract(client, contractId);
    const current = await reviewForActor(client, contractId, reviewId);
    if (current.lawyerId !== actor.id) throw new AppError(403, 'Only the assigned lawyer can deliver a review.', 'FORBIDDEN');
    if (current.review.status === 'completed') {
      if (current.review.final_version_id === parsed.versionId) return;
      throw new AppError(409, 'This review has already been delivered.', 'REVIEW_COMPLETED');
    }
    if (!current.review.editing_version_id || current.review.editing_version_id !== parsed.versionId) {
      throw new AppError(409, 'Delivery must reference the exact latest lawyer version.', 'VERSION_NOT_CURRENT');
    }
    if (current.review.save_status !== 'saved') {
      throw new AppError(409, 'Wait for the editor to finish saving before delivery.', 'EDITOR_SAVE_PENDING');
    }
    const editorState = await client.query<{ dirty_epoch: number; saved_epoch: number }>(
      'SELECT dirty_epoch, saved_epoch FROM editor_sessions WHERE review_id = $1 AND active = true LIMIT 1',
      [reviewId],
    );
    if (editorState.rows[0] && Number(editorState.rows[0].dirty_epoch) !== Number(editorState.rows[0].saved_epoch)) {
      throw new AppError(409, 'The editor has unsaved changes. Force-save before delivery.', 'EDITOR_SAVE_PENDING');
    }
    const version = await client.query<{ id: string; kind: string }>(
      'SELECT id, kind FROM versions WHERE id = $1 AND contract_id = $2 LIMIT 1',
      [parsed.versionId, contractId],
    );
    if (!version.rows[0] || version.rows[0].kind !== 'review') {
      throw new AppError(409, 'Delivery must reference a lawyer review version.', 'VERSION_NOT_CURRENT');
    }
    const storedMeta = await client.query<{ file_key: string; sha256: string | null }>(
      'SELECT file_key, sha256 FROM versions WHERE id = $1 LIMIT 1',
      [parsed.versionId],
    );
    const metadata = storedMeta.rows[0];
    const stored = metadata?.file_key ? await storage.get(metadata.file_key) : null;
    if (!metadata?.file_key || !metadata.sha256 || !stored) {
      throw new AppError(409, 'The review document has not been saved to storage.', 'VERSION_FILE_NOT_READY');
    }
    const storedHash = createHash('sha256').update(Buffer.isBuffer(stored) ? stored : Buffer.from(stored)).digest('hex');
    if (storedHash !== metadata.sha256) {
      throw new AppError(409, 'The saved review document changed or is incomplete.', 'VERSION_FILE_MISMATCH');
    }
    await client.query(
      `UPDATE reviews SET status = 'completed', completed_at = now(), final_version_id = $1,
                          delivery_note = $2, save_status = 'saved'
       WHERE id = $3`,
      [parsed.versionId, parsed.deliveryNote, reviewId],
    );
    await client.query('UPDATE contracts SET updated_at = now() WHERE id = $1', [contractId]);
  });
  return requireAccessible(contractId, actor);
}

export async function respondToDelivery(actor: User, contractId: string, reviewId: string, input: unknown): Promise<Contract> {
  const parsed = z.object({action:z.enum(['received','request_changes']),feedback:z.string().trim().max(6000).optional()}).parse(input);
  if (actor.role !== 'client') throw new AppError(403, '仅合同所有者可以回应交付。', 'FORBIDDEN');
  if (parsed.action === 'request_changes' && !parsed.feedback) throw new AppError(400, '请写明需要修改的内容。', 'FEEDBACK_REQUIRED');
  await withTransaction(async client => {
    await lockContract(client, contractId);
    const current = await reviewForActor(client, contractId, reviewId);
    if (current.ownerId !== actor.id) throw new AppError(403, '仅合同所有者可以回应交付。', 'FORBIDDEN');
    const review = current.review;
    if (review.status !== 'completed' || !review.final_version_id) throw new AppError(409, '请等待律师交付 Word 后再回应。', 'REVIEW_NOT_COMPLETED');
    if (parsed.action === 'request_changes')
      throw new AppError(409,'交付后请在原合同中联系负责律师，不再发起新审核。','CONTRACT_DELIVERED');
    if (!review.client_response) await client.query(
      "UPDATE reviews SET client_response='received',client_responded_at=now() WHERE id=$1", [reviewId]);
  });
  return requireAccessible(contractId, actor);
}

export async function getVersionFile(actor: AuthContext['user'], versionId: string): Promise<{
  bytes: Buffer;
  fileName: string;
  contentType: string;
  sha256: string | null;
}> {
  const result = await query<VersionRow & { contract_id: string; title: string; owner_id: string }>(
    `SELECT v.id, v.number, v.kind, v.review_id, v.file_key, v.content,v.text_content, v.created_at, v.source, v.sha256,
            c.id AS contract_id, c.title, c.owner_id
     FROM versions v JOIN contracts c ON c.id = v.contract_id
     WHERE v.id = $1 LIMIT 1`,
    [versionId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'Version not found.', 'VERSION_NOT_FOUND');
  const accessible = actor.role === 'admin' || actor.id === row.owner_id || Boolean((await query(
    `SELECT 1
     FROM reviews r
     WHERE r.contract_id = $1
       AND r.lawyer_id = $2
       AND (
         r.id = $3
         OR r.submitted_version_id = $4
         OR r.editing_version_id = $4
         OR r.final_version_id = $4
       )
     LIMIT 1`,
    [row.contract_id, actor.id, row.review_id, versionId],
  )).rows[0]);
  if (!accessible) throw new AppError(404, 'Version not found.', 'VERSION_NOT_FOUND');
  const bytes = await storage.get(row.file_key);
  if (!bytes) throw new AppError(404, 'The document bytes are unavailable.', 'FILE_NOT_FOUND');
  return {
    bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    fileName: `${row.title.replace(/[^\w\-\u4e00-\u9fff]+/g, '-').slice(0, 80) || 'contract'}-v${row.number}.docx`,
    contentType: DOCX_CONTENT_TYPE,
    sha256: row.sha256,
  };
}

async function ensureEditorSession(actor: AuthContext['user'], contractId: string, reviewId: string): Promise<EditorSessionRow> {
  if (actor.role !== 'lawyer') throw new AppError(403, 'Only the assigned lawyer can edit this review.', 'FORBIDDEN');
  return withTransaction(async (client) => {
    await lockContract(client, contractId);
    const current = await reviewForActor(client, contractId, reviewId);
    if (current.lawyerId !== actor.id) throw new AppError(403, 'Only the assigned lawyer can edit this review.', 'FORBIDDEN');
    if (current.review.status === 'completed') throw new AppError(409,'合同已交付，不能再改变编辑状态。','REVIEW_COMPLETED');
    if (current.review.status === 'waiting') throw new AppError(409,'请先接收合同。','REVIEW_NOT_STARTED');
    const existing = await client.query<EditorSessionRow>(
      'SELECT id, review_id, base_version_id, document_key, scratch_file_key, assigned_user_id, dirty_epoch, saved_epoch, save_nonce, active FROM editor_sessions WHERE review_id = $1 AND active = true LIMIT 1 FOR UPDATE',
      [reviewId],
    );
    // Keep the session identity stable while the browser has an open editor. A
    // callback may advance the review's immutable version, but the current
    // OnlyOffice document/key remains bound to this session until it closes.
    if (existing.rows[0]) {
      const active=existing.rows[0];
      if(active.assigned_user_id!==actor.id)throw new AppError(409,'编辑器所属律师已变化，请重新打开审核任务。','EDITOR_SESSION_INVALID');
      const latestId=current.review.editing_version_id??active.base_version_id;
      const latest=await client.query<{file_key:string;sha256:string|null}>(
        'SELECT file_key,sha256 FROM versions WHERE id=$1 AND contract_id=$2',[latestId,contractId]);
      if(!latest.rows[0]?.sha256)throw new AppError(409,'最新审阅版尚未保存完整。','VERSION_FILE_NOT_READY');
      const scratch=await storage.get(active.scratch_file_key);
      if(!scratch||createHash('sha256').update(scratch).digest('hex')!==latest.rows[0].sha256){
        const saved=await storage.get(latest.rows[0].file_key);
        if(!saved||createHash('sha256').update(saved).digest('hex')!==latest.rows[0].sha256)
          throw new AppError(409,'最新审阅版文件不完整，请联系管理员。','VERSION_FILE_MISMATCH');
        await storage.put(active.scratch_file_key,Buffer.isBuffer(saved)?saved:Buffer.from(saved),DOCX_CONTENT_TYPE);
      }
      return active;
    }
    const candidateVersionId = current.review.editing_version_id ?? current.review.handoff_version_id ?? current.review.submitted_version_id;
    const candidate = await client.query<{ id: string; file_key: string; number: number }>(
      'SELECT id, file_key, number FROM versions WHERE id = $1 AND contract_id = $2 LIMIT 1',
      [candidateVersionId, contractId],
    );
    if (!candidate.rows[0]) throw new AppError(404, 'Review version not found.', 'VERSION_NOT_FOUND');
    const sessionId = randomUUID();
    const scratchFileKey = `contracts/${contractId}/sessions/${sessionId}/current.docx`;
    const documentKey = createHash('sha256').update(`${candidate.rows[0].id}:${sessionId}`).digest('hex');
    const sourceBytes = await storage.get(candidate.rows[0].file_key);
    if (!sourceBytes) throw new AppError(409, 'The review source document is unavailable.', 'VERSION_FILE_NOT_READY');
    // A session scratch object lets OnlyOffice read the immutable source and keeps its
    // callbacks from ever overwriting a version row. Each callback gets a new version.
    await storage.put(scratchFileKey, Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes), DOCX_CONTENT_TYPE);
    const inserted = await client.query<EditorSessionRow>(
      `INSERT INTO editor_sessions
       (id, review_id, base_version_id, document_key, scratch_file_key, assigned_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, review_id, base_version_id, document_key, scratch_file_key, assigned_user_id,
                 dirty_epoch, saved_epoch, save_nonce, active`,
      [sessionId, reviewId, candidate.rows[0].id, documentKey, scratchFileKey, actor.id],
    );
    return inserted.rows[0];
  });
}

export async function editorConfig(actor: AuthContext['user'], contractId: string, reviewId: string, viewOnly = false, authSessionId?: string): Promise<OnlyOfficeEditorConfigResponse> {
  const current = await reviewForActor(undefined, contractId, reviewId);
  const isAssigned = actor.role === 'lawyer' && current.lawyerId === actor.id;
  const isOwner = actor.role === 'client' && current.ownerId === actor.id;
  if (!isAssigned && !isOwner && actor.role !== 'admin') throw new AppError(403, 'You cannot open this editor.', 'FORBIDDEN');
  if (!isAssigned && !viewOnly && actor.role !== 'admin') throw new AppError(403, 'Only the assigned lawyer can edit.', 'FORBIDDEN');
  const session = isAssigned && !viewOnly ? await ensureEditorSession(actor, contractId, reviewId) : null;
  const versionId = session?.base_version_id ?? current.review.editing_version_id ?? current.review.handoff_version_id ?? current.review.submitted_version_id;
  if(!versionId)throw new AppError(409,'请先上传律师起草的 Word，再打开编辑器。','VERSION_REQUIRED');
  const version = await query<{ id: string; number: number; file_key: string; title: string }>(
    `SELECT v.id, v.number, v.file_key, c.title
     FROM versions v JOIN contracts c ON c.id = v.contract_id
     WHERE v.id = $1 AND c.id = $2 LIMIT 1`,
    [versionId, contractId],
  );
  const versionRow = version.rows[0];
  if (!versionRow) throw new AppError(404, 'Review version not found.', 'VERSION_NOT_FOUND');
  try {
    return await createEditorConfig({
      reviewId,
      versionId,
      revision: session?.id ?? String(versionRow.number),
      fileKey: session?.scratch_file_key ?? versionRow.file_key,
      sourceFileKey: session ? versionRow.file_key : undefined,
      sessionId: session?.id ?? randomUUID(),
      role: isAssigned && !viewOnly ? 'edit' : 'view',
      userId: actor.id,
      authSessionId,
      userName: actor.name,
      title: `${versionRow.title}-v${versionRow.number}.docx`,
      baseUrl: process.env.ONLYOFFICE_DOCUMENT_BASE_URL ?? process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_BASE_URL,
      callbackBaseUrl: process.env.ONLYOFFICE_CALLBACK_BASE_URL ?? process.env.OO_CALLBACK_BASE_URL ?? process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_BASE_URL,
    }, {
      documentServerUrl: process.env.ONLYOFFICE_DOCUMENT_SERVER_URL ?? process.env.ONLYOFFICE_URL,
      publicBaseUrl: process.env.ONLYOFFICE_DOCUMENT_BASE_URL ?? process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_BASE_URL,
    });
  } catch {
    throw new AppError(503, 'OnlyOffice is not configured for this environment.', 'ONLYOFFICE_NOT_CONFIGURED');
  }
}

/** A signed URL still needs the account, website session and current review grant. */
export async function assertOnlyOfficeAccess(claims: OnlyOfficeTokenPayload): Promise<void> {
  if (!claims.userId || !claims.authSessionId) throw new AppError(403, '请重新登录并打开编辑器。', 'EDITOR_SESSION_INVALID');
  const result = await query<{
    role: Role; disabled: boolean; must_change_password: boolean; email_verified_at: Date | null;
    login_session_id: string | null; owner_id: string; lawyer_id: string | null; review_status: Review['status'];
    submitted_version_id: string | null; editing_version_id: string | null; handoff_version_id: string | null; final_version_id: string | null;
    version_file_key: string; editor_session_id: string | null; editor_active: boolean | null;
    assigned_user_id: string | null; base_version_id: string | null; document_key: string | null; scratch_file_key: string | null;
  }>(`SELECT u.role,u.disabled,u.must_change_password,u.email_verified_at,
       s.id AS login_session_id,c.owner_id,r.lawyer_id,r.status AS review_status,
       r.submitted_version_id,r.editing_version_id,r.handoff_version_id,r.final_version_id,
       v.file_key AS version_file_key,es.id AS editor_session_id,es.active AS editor_active,
       es.assigned_user_id,es.base_version_id,es.document_key,es.scratch_file_key
     FROM reviews r JOIN contracts c ON c.id=r.contract_id
     JOIN versions v ON v.id=$2 AND v.contract_id=c.id
     JOIN users u ON u.id=$3
     LEFT JOIN sessions s ON s.id=$4 AND s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>now()
     LEFT JOIN editor_sessions es ON es.id=$5 AND es.review_id=r.id
     WHERE r.id=$1 LIMIT 1`, [claims.reviewId, claims.versionId, claims.userId, claims.authSessionId, claims.sessionId]);
  const row = result.rows[0];
  if (!row || !row.login_session_id || row.disabled || row.must_change_password ||
      (process.env.CONTRACT_REQUIRE_VERIFIED_EMAIL === 'true' && !row.email_verified_at)) {
    throw new AppError(403, '编辑器访问已失效，请重新登录。', 'EDITOR_SESSION_INVALID');
  }
  if (claims.role === 'edit') {
    if (row.role !== 'lawyer' || row.lawyer_id !== claims.userId || row.review_status === 'completed' ||
        !row.editor_active || row.editor_session_id !== claims.sessionId || row.assigned_user_id !== claims.userId ||
        row.base_version_id !== claims.versionId || row.document_key !== claims.documentKey ||
        row.scratch_file_key !== claims.fileKey || row.version_file_key !== claims.inputSourceFileKey) {
      throw new AppError(403, '当前编辑权限已失效，请重新打开审核任务。', 'EDITOR_SESSION_INVALID');
    }
    return;
  }
  const allowedViewer = row.role === 'admin' ||
    (row.role === 'client' && row.owner_id === claims.userId) ||
    (row.role === 'lawyer' && row.lawyer_id === claims.userId);
  if (!allowedViewer || row.version_file_key !== claims.fileKey ||
      ![row.submitted_version_id, row.editing_version_id, row.handoff_version_id, row.final_version_id].includes(claims.versionId)) {
    throw new AppError(403, '当前查看权限已失效，请重新打开合同。', 'EDITOR_SESSION_INVALID');
  }
}
export const onlyOfficeAccess = { check: assertOnlyOfficeAccess };

export async function saveEditor(actor: AuthContext['user'], contractId: string, reviewId: string, input: unknown): Promise<Contract> {
  const parsed = editorSaveInput.parse(input);
  const current = await reviewForActor(undefined, contractId, reviewId);
  if (actor.role !== 'lawyer' || current.lawyerId !== actor.id) {
    throw new AppError(403, 'Only the assigned lawyer can save this editor.', 'FORBIDDEN');
  }
  if (current.review.status === 'completed') throw new AppError(409, 'The delivered review is read-only.', 'REVIEW_COMPLETED');
  const session = await ensureEditorSession(actor, contractId, reviewId);
  if (parsed.versionId && parsed.versionId !== session.base_version_id && parsed.versionId !== current.review.editing_version_id) {
    throw new AppError(409, 'The editor revision is stale.', 'EDITOR_REVISION_STALE');
  }
  const nonce = randomUUID();
  let forceSavePayload: { documentKey: string; dirtyEpoch: number; nonce: string } | null = null;
  await withTransaction(async (client) => {
    await lockContract(client, contractId);
    const locked = await reviewForActor(client, contractId, reviewId);
    if (locked.review.status === 'completed') throw new AppError(409, 'The delivered review is read-only.', 'REVIEW_COMPLETED');
    const row = await client.query<EditorSessionRow>(
      `SELECT id, review_id, base_version_id, document_key, scratch_file_key, assigned_user_id,
              dirty_epoch, saved_epoch, save_nonce, active
       FROM editor_sessions
       WHERE id = $1 AND review_id = $2 AND assigned_user_id = $3 AND active = true
       FOR UPDATE`,
      [session.id, reviewId, actor.id],
    );
    if (!row.rows[0]) throw new AppError(409, 'The editor session is no longer active.', 'EDITOR_SESSION_INVALID');
    forceSavePayload = { documentKey: row.rows[0].document_key, dirtyEpoch: Number(row.rows[0].dirty_epoch), nonce };
    await client.query('UPDATE editor_sessions SET save_nonce = $1, updated_at = now() WHERE id = $2', [nonce, session.id]);
    // A request to force-save never marks the document as saved. Only the validated
    // OnlyOffice status 2/6 callback may move saved_epoch and saveStatus forward.
    await client.query("UPDATE reviews SET save_status = 'pending' WHERE id = $1", [reviewId]);
  });
  if (!forceSavePayload) throw new AppError(500, 'The editor session could not be prepared.', 'EDITOR_SESSION_INVALID');
  try {
    const outcome = await requestOnlyOfficeForceSave(forceSavePayload);
    if (outcome === 'unchanged') await saveUnchangedEditor(actor, contractId, reviewId, session.id, nonce);
  } catch (error) {
    await query("UPDATE reviews SET save_status='error' WHERE id=$1 AND save_status='pending' AND EXISTS (SELECT 1 FROM editor_sessions WHERE id=$2 AND review_id=$1 AND save_nonce=$3 AND active=true)", [reviewId,session.id,nonce]);
    throw error;
  }
  return requireAccessible(contractId, actor);
}

export async function markEditorDirty(actor: AuthContext['user'], contractId: string, reviewId: string, input: unknown): Promise<Contract> {
  const parsed = editorDirtyInput.parse(input);
  if (actor.role !== 'lawyer') throw new AppError(403, 'Only the assigned lawyer can mark an editor revision.', 'FORBIDDEN');
  const session = await ensureEditorSession(actor, contractId, reviewId);
  await withTransaction(async (client) => {
    await lockContract(client, contractId);
    const current = await reviewForActor(client, contractId, reviewId);
    if (current.lawyerId !== actor.id) throw new AppError(403, 'Only the assigned lawyer can mark an editor revision.', 'FORBIDDEN');
    if (current.review.status === 'completed') throw new AppError(409,'合同已交付，不能再改变编辑状态。','REVIEW_COMPLETED');
    await client.query(
      `UPDATE editor_sessions
       SET dirty_epoch = dirty_epoch + 1, save_nonce = NULL, updated_at = now()
       WHERE id = $1 AND review_id = $2 AND assigned_user_id = $3 AND active = true`,
      [session.id, reviewId, actor.id],
    );
    await client.query("UPDATE reviews SET save_status = 'pending' WHERE id = $1", [reviewId]);
  });
  return requireAccessible(contractId, actor);
}

/** Error 4 means no new document changes; only reuse bytes already verified by storage. */
async function saveUnchangedEditor(actor:User,contractId:string,reviewId:string,sessionId:string,nonce:string){
  await withTransaction(async client=>{
    await lockContract(client,contractId);
    const current=await reviewForActor(client,contractId,reviewId);
    if(current.lawyerId!==actor.id)throw new AppError(403,'仅负责律师可以保存。','FORBIDDEN');
    if(current.review.status==='completed')throw new AppError(409,'合同已交付。','REVIEW_COMPLETED');
    const es=(await client.query<EditorSessionRow>('SELECT * FROM editor_sessions WHERE id=$1 AND review_id=$2 AND assigned_user_id=$3 AND active=true FOR UPDATE',[sessionId,reviewId,actor.id])).rows[0];
    if(!es||es.save_nonce!==nonce)throw new AppError(409,'保存请求已变化，请重试。','EDITOR_REVISION_STALE');
    if(Number(es.dirty_epoch)!==Number(es.saved_epoch))throw new AppError(409,'编辑器仍有修改尚未保存，请稍后再次保存。','EDITOR_SAVE_PENDING');
    const source=(await client.query<VersionRow>('SELECT * FROM versions WHERE id=$1 AND contract_id=$2',[current.review.editing_version_id||es.base_version_id,contractId])).rows[0];
    const bytes=source?await storage.get(source.file_key):null;
    if(!bytes||!source.sha256||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new AppError(409,'当前合同文件不完整，请重新核对。','VERSION_FILE_MISMATCH');
    let versionId=source.id;
    if(!current.review.editing_version_id){
      versionId=randomUUID();
      const number=Number((await client.query('SELECT MAX(number) AS n FROM versions WHERE contract_id=$1',[contractId])).rows[0].n||0)+1;
      const key=`contracts/${contractId}/reviews/${versionId}.docx`;
      await storage.put(key,Buffer.from(bytes),DOCX_CONTENT_TYPE);
      await client.query(`INSERT INTO versions(id,contract_id,number,kind,review_id,file_key,content,source,sha256,text_content)
        VALUES($1,$2,$3,'review',$4,$5,NULL,'lawyer',$6,$7)`,[versionId,contractId,number,reviewId,key,source.sha256,extractDocxText(Buffer.from(bytes)).slice(0,100000)]);
    }
    await client.query("UPDATE reviews SET editing_version_id=$2,save_status='saved' WHERE id=$1",[reviewId,versionId]);
    await client.query('UPDATE contracts SET updated_at=now() WHERE id=$1',[contractId]);
  });
}

async function requestOnlyOfficeForceSave(input: { documentKey: string; dirtyEpoch: number; nonce: string }): Promise<'pending'|'unchanged'> {
  const endpoint = process.env.ONLYOFFICE_COMMAND_URL
    ?? (process.env.ONLYOFFICE_DOCUMENT_SERVER_URL ?? process.env.ONLYOFFICE_URL
      ? `${(process.env.ONLYOFFICE_DOCUMENT_SERVER_URL ?? process.env.ONLYOFFICE_URL)!.replace(/\/+$/, '')}/coauthoring/CommandService.ashx`
      : undefined);
  if (!endpoint) throw new AppError(503, 'OnlyOffice is not configured for force-save.', 'ONLYOFFICE_NOT_CONFIGURED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.ONLYOFFICE_COMMAND_TIMEOUT_MS ?? 10_000));
  try {
    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    if (!secret || secret.length < 32) throw new AppError(503, 'OnlyOffice JWT is not configured for force-save.', 'ONLYOFFICE_NOT_CONFIGURED');
    const commandToken = await new SignJWT({
      c: 'forcesave',
      key: input.documentKey,
      userdata: { epoch: input.dirtyEpoch, nonce: input.nonce },
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(new TextEncoder().encode(secret));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        c: 'forcesave',
        key: input.documentKey,
        userdata: JSON.stringify({ epoch: input.dirtyEpoch, nonce: input.nonce }),
        token: commandToken,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('OnlyOffice command returned an HTTP error');
    const payload = await response.json() as { error?: number };
    if (payload.error === 4) return 'unchanged';
    if (payload.error !== 0) throw new Error('OnlyOffice rejected the force-save command');
    return 'pending';
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'OnlyOffice did not accept the force-save request.', 'ONLYOFFICE_FORCE_SAVE_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

type EditorCallbackUserData = {
  valid: boolean;
  epoch?: number;
  nonce?: string;
};

function parseEditorCallbackUserData(value: unknown): EditorCallbackUserData {
  if (value === undefined) return { valid: true };
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { valid: false };
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { valid: false };
  const record = candidate as Record<string, unknown>;
  let epoch: number | undefined;
  if (record.epoch !== undefined) {
    const parsed = typeof record.epoch === 'number' ? record.epoch : Number(record.epoch);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return { valid: false };
    epoch = parsed;
  }
  let nonce: string | undefined;
  if (record.nonce !== undefined) {
    if (typeof record.nonce !== 'string' || record.nonce.length === 0 || record.nonce.length > 128) {
      return { valid: false };
    }
    nonce = record.nonce;
  }
  return { valid: true, epoch, nonce };
}

export async function reportOnlyOfficeSaveFailure(claims: OnlyOfficeTokenPayload, body: OnlyOfficeCallbackBody): Promise<void> {
  if (claims.role !== 'edit') return;
  const userData = parseEditorCallbackUserData(body.userdata);
  if (!userData.valid) return;
  await withTransaction(async client => {
    const owner = await client.query<{contract_id:string}>('SELECT contract_id FROM reviews WHERE id=$1',[claims.reviewId]);
    if (!owner.rows[0]) return;
    await lockContract(client, owner.rows[0].contract_id);
    const review = await client.query<{status:Review['status'];save_status:Review['saveStatus']}>(
      'SELECT status,save_status FROM reviews WHERE id=$1 FOR UPDATE',[claims.reviewId]);
    if (review.rows[0]?.status === 'completed' || review.rows[0]?.save_status !== 'pending') return;
    const row = await client.query<{dirty_epoch:number;save_nonce:string|null}>(
      `SELECT es.dirty_epoch,es.save_nonce FROM editor_sessions es
       WHERE es.id=$1 AND es.review_id=$2 AND es.active=true AND es.assigned_user_id=$3
         AND es.base_version_id=$4`, [claims.sessionId,claims.reviewId,claims.userId,claims.versionId]);
    const current = row.rows[0];
    if (!current) return;
    if (current.save_nonce && (userData.nonce !== current.save_nonce || userData.epoch !== Number(current.dirty_epoch))) return;
    if (userData.epoch !== undefined && userData.epoch !== Number(current.dirty_epoch)) return;
    await client.query("UPDATE reviews SET save_status='error' WHERE id=$1 AND save_status='pending'", [claims.reviewId]);
  });
}

export async function getOnlyOfficeRevisionState(input: Pick<PersistOnlyOfficeRevisionInput, 'reviewId' | 'versionId' | 'revision' | 'sessionId' | 'sha256'>): Promise<{
  state: 'current' | 'saved' | 'stale' | 'completed';
  sha256?: string | null;
}> {
  const result = await query<{
    review_status: Review['status'];
    save_status: Review['saveStatus'] | null;
    editing_version_id: string | null;
    session_id: string;
    session_active: boolean;
    user_disabled: boolean;
    base_version_id: string;
    saved_epoch: number;
    dirty_epoch: number;
    last_sha256: string | null;
  }>(
    `SELECT r.status AS review_status, r.save_status, r.editing_version_id, es.id AS session_id,
            es.active AS session_active, u.disabled AS user_disabled,
            es.base_version_id, es.saved_epoch, es.dirty_epoch,
            v.sha256 AS last_sha256
     FROM editor_sessions es
     JOIN reviews r ON r.id = es.review_id
     JOIN users u ON u.id = es.assigned_user_id
     LEFT JOIN versions v ON v.id = r.editing_version_id
     WHERE es.id = $1 AND r.id = $2 LIMIT 1`,
    [input.sessionId, input.reviewId],
  );
  const row = result.rows[0];
  if (!row) return { state: 'stale' };
  if (row.review_status === 'completed') return { state: 'completed', sha256: row.last_sha256 };
  if (!row.session_active || row.user_disabled) return { state: 'stale', sha256: row.last_sha256 };
  if (row.session_id !== input.sessionId || row.base_version_id !== input.versionId || String(input.revision) !== String(row.session_id)) {
    // A callback retry for the exact bytes already persisted is still safe to
    // acknowledge; a different hash is an old or conflicting revision.
    if (row.last_sha256 && row.last_sha256 === input.sha256) return { state: 'saved', sha256: row.last_sha256 };
    return { state: 'stale', sha256: row.last_sha256 };
  }
  if (row.save_status === 'saved' && row.saved_epoch === row.dirty_epoch && row.last_sha256 && row.last_sha256 === input.sha256) {
    return { state: 'saved', sha256: row.last_sha256 };
  }
  return { state: 'current', sha256: row.last_sha256 };
}

export async function assertOnlyOfficeRevisionCurrent(input: Pick<PersistOnlyOfficeRevisionInput, 'reviewId' | 'versionId' | 'revision' | 'sessionId'>): Promise<void> {
  const result = await query<{
    contract_id: string;
    review_status: Review['status'];
    session_active: boolean;
    user_disabled: boolean;
    base_version_id: string;
    session_id: string;
  }>(
    `SELECT r.contract_id, r.status AS review_status, es.active AS session_active,
            u.disabled AS user_disabled, es.base_version_id, es.id AS session_id
     FROM editor_sessions es
     JOIN reviews r ON r.id = es.review_id
     JOIN users u ON u.id = es.assigned_user_id
     WHERE es.id = $1 AND r.id = $2 LIMIT 1`,
    [input.sessionId, input.reviewId],
  );
  const row = result.rows[0];
  if (!row || !row.session_active || row.user_disabled || row.session_id !== input.sessionId || row.base_version_id !== input.versionId || String(input.revision) !== String(input.sessionId) || row.review_status === 'completed') {
    throw new AppError(409, 'The OnlyOffice revision is stale.', 'EDITOR_REVISION_STALE');
  }
}

export async function persistOnlyOfficeRevision(input: PersistOnlyOfficeRevisionInput): Promise<void> {
  await auditAccess(input.userId??'onlyoffice',input.reviewId);
  const stored = await storage.get(input.fileKey);
  if (!stored || createHash('sha256').update(Buffer.isBuffer(stored) ? stored : Buffer.from(stored)).digest('hex') !== input.sha256) {
    throw new AppError(409, 'The saved review document is unavailable or has changed.', 'VERSION_FILE_MISMATCH');
  }
  const callbackUserData = parseEditorCallbackUserData(input.userData);
  if (!callbackUserData.valid) {
    throw new AppError(409, 'The OnlyOffice callback metadata is invalid.', 'EDITOR_REVISION_STALE');
  }
  const textContent = extractDocxText(input.bytes).slice(0, 100_000);
  await withTransaction(async (client) => {
    if (input.authSessionId) {
      const liveSession = await client.query(
        'SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',
        [input.authSessionId,input.userId],
      );
      if (!liveSession.rowCount) throw new AppError(403,'编辑器登录已失效，请重新登录。','EDITOR_SESSION_INVALID');
    }
    const owner=await client.query<{contract_id:string}>('SELECT contract_id FROM reviews WHERE id=$1',[input.reviewId]);
    if(!owner.rows[0])throw new AppError(409,'审核任务不存在。','EDITOR_REVISION_STALE');
    await lockContract(client,owner.rows[0].contract_id);
    const current = await client.query<{
      contract_id: string;
      status: Review['status'];
      session_active: boolean;
      user_disabled: boolean;
      assigned_user_id: string;
      base_version_id: string;
      document_key: string;
      scratch_file_key: string;
      dirty_epoch: number;
      saved_epoch: number;
      save_nonce: string | null;
      editing_version_id: string | null;
      existing_sha256: string | null;
    }>(
      `SELECT r.contract_id, r.status, es.active AS session_active, u.disabled AS user_disabled,
              es.assigned_user_id, es.base_version_id,
              es.document_key, es.scratch_file_key, es.dirty_epoch, es.saved_epoch, es.save_nonce, r.editing_version_id,
              (SELECT sha256 FROM versions WHERE id = r.editing_version_id) AS existing_sha256
       FROM editor_sessions es
       JOIN reviews r ON r.id = es.review_id
       JOIN users u ON u.id = es.assigned_user_id
       WHERE es.id = $1 AND r.id = $2
       FOR UPDATE`,
      [input.sessionId, input.reviewId],
    );
    const row = current.rows[0];
    if (!row || !row.session_active || row.user_disabled || row.status === 'completed' || row.base_version_id !== input.versionId || row.document_key.length === 0 || (input.userId && row.assigned_user_id !== input.userId)) {
      throw new AppError(409, 'The OnlyOffice revision is stale.', 'EDITOR_REVISION_STALE');
    }
    const dirtyEpoch = Number(row.dirty_epoch);
    if (callbackUserData.epoch !== undefined && callbackUserData.epoch !== dirtyEpoch) {
      throw new AppError(409, 'The OnlyOffice revision is stale.', 'EDITOR_REVISION_STALE');
    }
    if (row.save_nonce && (callbackUserData.nonce !== row.save_nonce || callbackUserData.epoch !== dirtyEpoch)) {
      throw new AppError(409, 'The OnlyOffice revision is stale.', 'EDITOR_REVISION_STALE');
    }
    if (row.existing_sha256 && row.existing_sha256 === input.sha256 && row.saved_epoch === row.dirty_epoch) {
      await client.query("UPDATE reviews SET save_status='saved' WHERE id=$1", [input.reviewId]);
      await client.query('UPDATE editor_sessions SET save_nonce=NULL,updated_at=now() WHERE id=$1', [input.sessionId]);
      return;
    }
    await storage.put(row.scratch_file_key, input.bytes, DOCX_CONTENT_TYPE);
    const next = await client.query<{ max: number | null }>('SELECT MAX(number) AS max FROM versions WHERE contract_id = $1', [row.contract_id]);
    const versionId = randomUUID();
    const number = Number(next.rows[0]?.max ?? 0) + 1;
    await client.query(
      `INSERT INTO versions (id, contract_id, number, kind, review_id, file_key, content, source, sha256, text_content)
       VALUES ($1, $2, $3, 'review', $4, $5, NULL, 'lawyer', $6, $7)`,
      [versionId, row.contract_id, number, input.reviewId, input.fileKey, input.sha256, textContent],
    );
    await client.query(
      "UPDATE reviews SET editing_version_id = $1, save_status = 'saved' WHERE id = $2",
      [versionId, input.reviewId],
    );
    await client.query(
      `UPDATE editor_sessions
       SET saved_epoch = dirty_epoch, save_nonce=NULL, updated_at = now()
       WHERE id = $1`,
      [input.sessionId],
    );
  });
}

export async function readUploadFile(value: FormDataEntryValue | null): Promise<{ name: string; type: string; bytes: Buffer }> {
  if (!value || typeof value === 'string') throw new AppError(400, 'A DOCX file is required.', 'FILE_REQUIRED');
  return { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
}

export async function listContractPage(actor:User,input:unknown){
 const v=listQuery.parse(input),args:unknown[]=[actor.role,actor.id,v.q];
 let where=" WHERE ($1='admin' OR ($1='client' AND c.owner_id=$2) OR ($1='lawyer' AND EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id=c.id AND r.lawyer_id=$2))) AND strpos(lower(c.title),lower($3))>0";
 if(v.filter!=='all')where+=" AND EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id=c.id AND ($1<>'lawyer' OR r.lawyer_id=$2) AND r.status"+(v.filter==='completed'?"='completed'":"<>'completed'")+")";
 if(v.filter==='completed')where+=" AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id=c.id AND ($1<>'lawyer' OR r.lawyer_id=$2) AND r.status<>'completed')";
 const total=await query<{n:string}>('SELECT count(*) AS n FROM contracts c'+where,args);
 const rows=await query<ContractRow&{versions:Version[]}>(`SELECT c.id,c.owner_id,u.name AS owner_name,c.title,c.created_at,c.updated_at,
 jsonb_build_object('job',jsonb_build_object('status',c.workflow->'job'->>'status'),'intake',CASE WHEN c.workflow->'intake' IS NOT NULL THEN jsonb_build_object('confirmedAt',c.workflow->'intake'->'confirmedAt','missing',COALESCE(c.workflow->'intake'->'missing','[]'::jsonb)) ELSE NULL END) AS workflow,
 COALESCE((SELECT jsonb_agg(v) FROM (SELECT v.id,v.kind,v.source FROM versions v WHERE v.contract_id=c.id AND ($1<>'lawyer' OR EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id=c.id AND r.lawyer_id=$2 AND (r.id=v.review_id OR v.id IN (r.submitted_version_id,r.editing_version_id,r.final_version_id)))) ORDER BY v.number DESC LIMIT 1) v),'[]'::jsonb) AS versions
 FROM contracts c JOIN users u ON u.id=c.owner_id`+where+' ORDER BY c.updated_at DESC,c.id DESC LIMIT 20 OFFSET $4',[...args,(v.page-1)*20]);
 const reviews=rows.rows.length?(await query<ReviewRow&{contract_id:string}>(`SELECT id,contract_id,submitted_version_id,editing_version_id,lawyer_id,status,submitted_at,(SELECT name FROM users WHERE id=r.lawyer_id) AS lawyer_name FROM reviews r WHERE contract_id=ANY($1::text[]) AND ($2<>'lawyer' OR lawyer_id=$3)`,[rows.rows.map(r=>r.id),actor.role,actor.id])).rows:[];
 const items=rows.rows.map(r=>summary(mapContract(r,[],r.versions,reviews.filter(review=>review.contract_id===r.id).map(review=>mapReview(review,[])))));
 return{items,page:v.page,total:Number(total.rows[0].n),hasMore:v.page*20<Number(total.rows[0].n)};
}

/** Cheap browser change token. Includes editor callbacks, which need not change
 * contracts.updated_at. Authorization is rechecked even for a 304 response. */
export async function contractChangeToken(actor:User,contractId:string){
 const result=await query<{token:string}>(`SELECT md5(jsonb_build_array($2::text,$3::text,c.updated_at::text,c.workflow_revision,
  (SELECT jsonb_agg(jsonb_build_array(r.id,r.status,r.lawyer_id,r.editing_version_id,r.final_version_id,r.save_status,r.client_response) ORDER BY r.id) FROM reviews r WHERE r.contract_id=c.id),
  (SELECT max(number) FROM versions WHERE contract_id=c.id),
  (SELECT max(seq) FROM messages WHERE contract_id=c.id),
  (SELECT max(rm.seq) FROM review_messages rm JOIN reviews r ON r.id=rm.review_id WHERE r.contract_id=c.id))::text) AS token
 FROM contracts c WHERE c.id=$1 AND ($2='admin' OR c.owner_id=$3 OR EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id=c.id AND r.lawyer_id=$3))`,[contractId,actor.role,actor.id]);
 if(!result.rows[0])throw new AppError(404,'合同不存在。','CONTRACT_NOT_FOUND');
 return result.rows[0].token;
}
export async function versionDetails(actor:User,contractId:string,versionId:string){
 const row=await findAccessibleRow(contractId,actor);if(!row)throw new AppError(404,'合同不存在。','CONTRACT_NOT_FOUND');
 const result=await query<VersionRow>(`SELECT v.* FROM versions v WHERE v.contract_id=$1 AND v.id=$2 AND ($3<>'lawyer' OR EXISTS(
 SELECT 1 FROM reviews r WHERE r.contract_id=v.contract_id AND r.lawyer_id=$4 AND (r.id=v.review_id OR v.id IN(r.submitted_version_id,r.editing_version_id,r.final_version_id))))`,[contractId,versionId,actor.role,actor.id]);
 if(!result.rows[0])throw new AppError(404,'版本不存在。','VERSION_NOT_FOUND');
 return mapVersion(result.rows[0]);
}
export async function messagePage(actor:User,contractId:string,before?:string,reviewId?:string){
 const row=await findAccessibleRow(contractId,actor);if(!row)throw new AppError(404,'合同不存在。','CONTRACT_NOT_FOUND');
 if(reviewId){
  const r=await query('SELECT id FROM reviews WHERE id=$1 AND contract_id=$2 AND ($3<>\'lawyer\' OR lawyer_id=$4)',[reviewId,contractId,actor.role,actor.id]);
  if(!r.rowCount)throw new AppError(404,'沟通记录不存在。','NOT_FOUND');
 }else if(actor.role==='lawyer')throw new AppError(403,'律师只能查看已共享的审核沟通。','FORBIDDEN');
 const table=reviewId?'review_messages':'messages',scope=reviewId?'review_id':'contract_id',id=reviewId||contractId;
 let cursor:string|undefined;
 if(before){cursor=(await query<{seq:string}>(`SELECT seq::text FROM ${table} WHERE id=$1 AND ${scope}=$2`,[before,id])).rows[0]?.seq;if(!cursor)throw new AppError(400,'消息位置已变化，请刷新。','INVALID_INPUT');}
 const result=await query<any>(`SELECT m.* ${reviewId?',u.name AS author_name':''} FROM ${table} m ${reviewId?'JOIN users u ON u.id=m.author_id':''} WHERE m.${scope}=$1 AND ($2::bigint IS NULL OR m.seq<$2) ORDER BY m.seq DESC LIMIT 51`,[id,cursor??null]);
 return {hasMore:result.rows.length>50,items:result.rows.slice(0,50).reverse().map(m=>reviewId?{id:m.id,authorId:m.author_id,authorName:m.author_name,content:m.content,createdAt:iso(m.created_at)!}:mapMessage(m))};
}
