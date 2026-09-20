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
import { createEditorConfig, verifyOnlyOfficeToken, type OnlyOfficeEditorConfigResponse, type PersistOnlyOfficeRevisionInput } from './onlyoffice';

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
  submitted_version_id: string;
  lawyer_id: string | null;
  lawyer_name?: string;
  status: Review['status'];
  stance: string;
  concerns: string;
  requirements: string;
  submitted_at: Date | string;
  completed_at: Date | string | null;
  final_version_id: string | null;
  delivery_note: string | null;
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
  versionId: z.string().trim().min(1),
  stance: z.string().trim().min(1).max(10_000),
  concerns: z.string().trim().max(50_000).default(''),
});

const messageInput = z.object({
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
    number: row.number,
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
    status: row.status,
    stance: row.stance,
    concerns: row.concerns,
    requirements: row.requirements,
    submittedAt: iso(row.submitted_at)!,
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    ...(row.final_version_id ? { finalVersionId: row.final_version_id } : {}),
    ...(row.delivery_note ? { deliveryNote: row.delivery_note } : {}),
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

async function hydrateContract(row: ContractRow, actor?: AuthContext['user']): Promise<Contract> {
  const lawyerScope = actor?.role === 'lawyer';
  const [messageRows, versionRows, reviewRows] = await Promise.all([
    lawyerScope
      ? Promise.resolve({ rows: [] as MessageRow[] })
      : query<MessageRow>(
        'SELECT id, seq, role, content, created_at FROM messages WHERE contract_id = $1 ORDER BY seq ASC',
        [row.id],
      ),
    lawyerScope
      ? query<VersionRow>(
        `SELECT v.id, v.number, v.kind, v.review_id, v.file_key, v.content, v.created_at, v.source, v.sha256, v.text_content
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
        `SELECT v.id, v.number, v.kind, v.review_id, v.file_key, v.content, v.created_at, v.source, v.sha256, v.text_content
         FROM versions v WHERE v.contract_id = $1 ORDER BY v.number ASC`,
        [row.id],
      ),
    lawyerScope
      ? query<ReviewRow>(
        `SELECT id, submitted_version_id, lawyer_id, (SELECT name FROM users WHERE users.id=reviews.lawyer_id) AS lawyer_name, status, stance, concerns, requirements,
                submitted_at, completed_at, final_version_id, delivery_note,
                editing_version_id, save_status
         FROM reviews
         WHERE contract_id = $1 AND lawyer_id = $2
         ORDER BY submitted_at DESC, id DESC`,
        [row.id, actor!.id],
      )
      : query<ReviewRow>(
        `SELECT id, submitted_version_id, lawyer_id, (SELECT name FROM users WHERE users.id=reviews.lawyer_id) AS lawyer_name, status, stance, concerns, requirements,
                submitted_at, completed_at, final_version_id, delivery_note,
                editing_version_id, save_status
         FROM reviews WHERE contract_id = $1 ORDER BY submitted_at DESC, id DESC`,
        [row.id],
      ),
  ]);
  const reviewMessages = await Promise.all(reviewRows.rows.map(async (review) => {
    const result = await query<ReviewMessageRow>(
      `SELECT rm.id, rm.seq, rm.author_id, u.name AS author_name, rm.content, rm.created_at
       FROM review_messages rm JOIN users u ON u.id = rm.author_id
       WHERE rm.review_id = $1 ORDER BY rm.seq ASC`,
      [review.id],
    );
    return [review.id, result.rows.map((message) => ({
      id: message.id,
      authorId: message.author_id,
      authorName: message.author_name,
      content: message.content,
      createdAt: iso(message.created_at)!,
    }))] as const;
  }));
  const messageMap = new Map(reviewMessages);
  return mapContract(
    actor?.role==='lawyer'?{...row,workflow:undefined}:row,
    messageRows.rows.map(mapMessage),
    versionRows.rows.map(mapVersion),
    reviewRows.rows.map((review) => mapReview(review, messageMap.get(review.id) ?? [])),
  );
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

async function requireAccessible(contractId: string, actor: AuthContext['user']): Promise<Contract> {
  const row = await findAccessibleRow(contractId, actor);
  if (!row) throw new AppError(404, 'Contract not found.', 'CONTRACT_NOT_FOUND');
  return hydrateContract(row, actor);
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
     ORDER BY c.updated_at DESC, c.id DESC`,
    [actor.role, actor.id],
  );
  return Promise.all(result.rows.map((contractRow) => hydrateContract(contractRow, actor)));
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
  const sql = `SELECT 1 FROM reviews WHERE contract_id = $1 AND status IN ('waiting', 'reviewing', 'need_info') LIMIT 1`;
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

function workflowStore(actor:User,contractId:string):WorkflowStore{return{
 load:async()=>{const row=await findAccessibleRow(contractId,actor);if(!row)throw new AppError(404,'合同不存在。','CONTRACT_NOT_FOUND');return{contract:await hydrateContract(row,actor),revision:row.workflow_revision||0}},
 save:async(c,revision)=>{await withTransaction(async client=>{
 const changed=await client.query('UPDATE contracts SET workflow=$1::jsonb,workflow_revision=workflow_revision+1,title=$2,updated_at=now() WHERE id=$3 AND workflow_revision=$4 AND EXISTS(SELECT 1 FROM users WHERE id=$5 AND disabled=false AND role=$6)',[JSON.stringify(c.workflow),c.title,contractId,revision,actor.id,actor.role]);
 if(changed.rowCount!==1)throw new AppError(409,'合同状态已变化，请刷新。','CONFLICT');
 if(await openReviewExists(contractId,client))throw new AppError(409,'合同正在审核。','REVIEW_VERSION_FROZEN');
 for(const m of c.messages)await client.query('INSERT INTO messages(id,contract_id,role,content,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[m.id,c.id,m.role,m.content,m.createdAt]);
 for(const v of c.versions)await client.query('INSERT INTO versions(id,contract_id,number,kind,file_key,content,source,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT(id) DO NOTHING',[v.id,c.id,v.number,v.kind,v.fileKey,JSON.stringify(v.content),v.source,v.sha256,v.createdAt]);
 });return requireAccessible(contractId,actor)},
 put:async(key,content)=>renderAndStore(content,key),
 limit:async()=>{},
};}
export async function chatContract(actor:User,contractId:string,input:unknown):Promise<Contract>{return startWorkflow(workflowStore(actor,contractId),actor,input);}
export async function jobAction(actor:User,contractId:string,jobId:string,action:'run'|'retry'|'cancel'){return controlWorkflow(workflowStore(actor,contractId),actor,jobId,action);}

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
    const version = await client.query<{ id: string; kind: string; content: unknown }>(
      'SELECT id, kind, content FROM versions WHERE id = $1 AND contract_id = $2 LIMIT 1',
      [parsed.versionId, contractId],
    );
    if (!version.rows[0]) throw new AppError(404, 'Version not found.', 'VERSION_NOT_FOUND');
    if (version.rows[0].kind !== 'draft' || !version.rows[0].content) {
      throw new AppError(409, 'Only an immutable draft version can be submitted for review.', 'VERSION_NOT_SUBMITTABLE');
    }
    const messages = await client.query<{ role: string; content: string }>(
      'SELECT role, content FROM messages WHERE contract_id = $1 ORDER BY seq ASC',
      [contractId],
    );
    if(parsed.lawyerId){
      const target=await client.query("SELECT id FROM users WHERE id=$1 AND role='lawyer' AND disabled=false FOR SHARE",[parsed.lawyerId]);
      if(!target.rows[0])throw new AppError(400,'该律师目前无法接收审核，请重新选择。','LAWYER_UNAVAILABLE');
    }
    const requirements = messages.rows.map((message) => `${message.role === 'user' ? '客户' : '助手'}：${message.content}`).join('\n');
    await client.query(
      `INSERT INTO reviews
       (id, contract_id, submitted_version_id, status, stance, concerns, requirements, lawyer_id)
       VALUES ($1, $2, $3, 'waiting', $4, $5, $6, $7)`,
      [randomUUID(), contractId, parsed.versionId, parsed.stance, parsed.concerns, requirements, parsed.lawyerId||null],
    );
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
                      r.delivery_note, r.editing_version_id, r.save_status, c.owner_id
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
    if (current.review.status !== 'waiting') {
      if (current.lawyerId === lawyerId) return;
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
    if (current.review.status === 'completed') throw new AppError(409, 'The delivered review is read-only.', 'REVIEW_COMPLETED');
    if (parsed.requestInfo && (actor.role !== 'lawyer' || current.lawyerId !== actor.id)) {
      throw new AppError(403, 'Only the assigned lawyer can request information.', 'FORBIDDEN');
    }
    await client.query(
      'INSERT INTO review_messages (id, review_id, author_id, content) VALUES ($1, $2, $3, $4)',
      [randomUUID(), reviewId, actor.id, parsed.content],
    );
    if (parsed.requestInfo) {
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
  const versionId = randomUUID();
  const fileKey = `contracts/${contractId}/versions/${versionId}.docx`;
  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  await storage.put(fileKey, file.bytes, DOCX_CONTENT_TYPE);
  await withTransaction(async (client) => {
    await lockContract(client, contractId);
    const locked = await reviewForActor(client, contractId, reviewId);
    if (locked.lawyerId !== actor.id) throw new AppError(403, 'Only the assigned lawyer can upload a review version.', 'FORBIDDEN');
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

export async function getVersionFile(actor: AuthContext['user'], versionId: string): Promise<{
  bytes: Buffer;
  fileName: string;
  contentType: string;
  sha256: string | null;
}> {
  const result = await query<VersionRow & { contract_id: string; title: string; owner_id: string }>(
    `SELECT v.id, v.number, v.kind, v.review_id, v.file_key, v.content, v.created_at, v.source, v.sha256, v.text_content,
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
    if (current.review.status === 'completed') throw new AppError(409, 'The delivered review is read-only.', 'REVIEW_COMPLETED');
    const existing = await client.query<EditorSessionRow>(
      'SELECT id, review_id, base_version_id, document_key, scratch_file_key, assigned_user_id, dirty_epoch, saved_epoch, save_nonce, active FROM editor_sessions WHERE review_id = $1 AND active = true LIMIT 1 FOR UPDATE',
      [reviewId],
    );
    // Keep the session identity stable while the browser has an open editor. A
    // callback may advance the review's immutable version, but the current
    // OnlyOffice document/key remains bound to this session until it closes.
    if (existing.rows[0]) return existing.rows[0];
    const candidateVersionId = current.review.editing_version_id ?? current.review.submitted_version_id;
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

export async function editorConfig(actor: AuthContext['user'], contractId: string, reviewId: string, viewOnly = false): Promise<OnlyOfficeEditorConfigResponse> {
  const current = await reviewForActor(undefined, contractId, reviewId);
  const isAssigned = actor.role === 'lawyer' && current.lawyerId === actor.id;
  const isOwner = actor.role === 'client' && current.ownerId === actor.id;
  if (!isAssigned && !isOwner && actor.role !== 'admin') throw new AppError(403, 'You cannot open this editor.', 'FORBIDDEN');
  if (!isAssigned && !viewOnly && actor.role !== 'admin') throw new AppError(403, 'Only the assigned lawyer can edit.', 'FORBIDDEN');
  const session = isAssigned ? await ensureEditorSession(actor, contractId, reviewId) : null;
  const versionId = session?.base_version_id ?? current.review.editing_version_id ?? current.review.submitted_version_id;
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
  await requestOnlyOfficeForceSave(forceSavePayload);
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
    if (current.review.status === 'completed') throw new AppError(409, 'The delivered review is read-only.', 'REVIEW_COMPLETED');
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

async function requestOnlyOfficeForceSave(input: { documentKey: string; dirtyEpoch: number; nonce: string }): Promise<void> {
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
    if (payload.error !== undefined && payload.error !== 0) throw new Error('OnlyOffice rejected the force-save command');
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

export async function getOnlyOfficeRevisionState(input: Pick<PersistOnlyOfficeRevisionInput, 'reviewId' | 'versionId' | 'revision' | 'sessionId' | 'sha256'>): Promise<{
  state: 'current' | 'saved' | 'stale' | 'completed';
  sha256?: string | null;
}> {
  const result = await query<{
    review_status: Review['status'];
    editing_version_id: string | null;
    session_id: string;
    session_active: boolean;
    user_disabled: boolean;
    base_version_id: string;
    saved_epoch: number;
    dirty_epoch: number;
    last_sha256: string | null;
  }>(
    `SELECT r.status AS review_status, r.editing_version_id, es.id AS session_id,
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
  if (row.saved_epoch === row.dirty_epoch && row.last_sha256 && row.last_sha256 === input.sha256) {
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
  const stored = await storage.get(input.fileKey);
  if (!stored || createHash('sha256').update(Buffer.isBuffer(stored) ? stored : Buffer.from(stored)).digest('hex') !== input.sha256) {
    throw new AppError(409, 'The saved review document is unavailable or has changed.', 'VERSION_FILE_MISMATCH');
  }
  const callbackUserData = parseEditorCallbackUserData(input.userData);
  if (!callbackUserData.valid) {
    throw new AppError(409, 'The OnlyOffice callback metadata is invalid.', 'EDITOR_REVISION_STALE');
  }
  await withTransaction(async (client) => {
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
    if (row.existing_sha256 && row.existing_sha256 === input.sha256 && row.saved_epoch === row.dirty_epoch) return;
    await storage.put(row.scratch_file_key, input.bytes, DOCX_CONTENT_TYPE);
    const next = await client.query<{ max: number | null }>('SELECT MAX(number) AS max FROM versions WHERE contract_id = $1', [row.contract_id]);
    const versionId = randomUUID();
    const number = Number(next.rows[0]?.max ?? 0) + 1;
    await client.query(
      `INSERT INTO versions (id, contract_id, number, kind, review_id, file_key, content, source, sha256)
       VALUES ($1, $2, $3, 'review', $4, $5, NULL, 'lawyer', $6)`,
      [versionId, row.contract_id, number, input.reviewId, input.fileKey, input.sha256],
    );
    await client.query(
      "UPDATE reviews SET editing_version_id = $1, save_status = 'saved' WHERE id = $2",
      [versionId, input.reviewId],
    );
    await client.query(
      `UPDATE editor_sessions
       SET saved_epoch = dirty_epoch, updated_at = now()
       WHERE id = $1`,
      [input.sessionId],
    );
  });
}

export async function readUploadFile(value: FormDataEntryValue | null): Promise<{ name: string; type: string; bytes: Buffer }> {
  if (!value || typeof value === 'string') throw new AppError(400, 'A DOCX file is required.', 'FILE_REQUIRED');
  return { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
}
