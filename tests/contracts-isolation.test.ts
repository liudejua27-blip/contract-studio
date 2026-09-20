import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { ContractContent, User } from '../src/lib/types';
import {
  assertOnlyOfficeRevisionCurrent,
  chatContract,
  getContractForRoute,
  getOnlyOfficeRevisionState,
  getVersionFile,
  markEditorDirty,
  persistOnlyOfficeRevision,
  submitReview,
  uploadReviewVersion,
} from '../src/server/contracts';
import { closeDatabase, query, withTransaction } from '../src/server/db';
import { renderContract, storage } from '../src/server/documents';

const databaseAvailable = Boolean(process.env.DATABASE_URL);

test.after(async () => {
  if (databaseAvailable) await closeDatabase();
});

const draftContent = (title: string): ContractContent => ({
  title,
  parties: [],
  sections: [],
  signing: '',
  missing: [],
});

function actor(id: string, name: string, role: User['role']): User {
  return { id, name, email: `${id}@isolation.test`, role };
}

test('lawyer contract views stay scoped to the assigned review after delivery and reassignment', {
  skip: !databaseAvailable,
}, async () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const firstLawyerId = randomUUID();
  const secondLawyerId = randomUUID();
  const contractId = randomUUID();
  const firstDraftId = randomUUID();
  const firstReviewId = randomUUID();
  const firstReviewVersionId = randomUUID();
  const secondDraftId = randomUUID();
  const secondReviewId = randomUUID();
  const secondReviewVersionId = randomUUID();
  const editorSessionId = randomUUID();
  const rows = {
    users: [ownerId, otherOwnerId, firstLawyerId, secondLawyerId],
    contract: contractId,
    versions: [firstDraftId, firstReviewVersionId, secondDraftId, secondReviewVersionId],
    reviews: [firstReviewId, secondReviewId],
    editorSession: editorSessionId,
  };

  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, name, email, email_normalized, password_hash, role)
         VALUES
           ($1, 'Client A', $5, $5, 'test', 'client'),
           ($2, 'Client B', $6, $6, 'test', 'client'),
           ($3, 'Lawyer A', $7, $7, 'test', 'lawyer'),
           ($4, 'Lawyer B', $8, $8, 'test', 'lawyer')`,
        [ownerId, otherOwnerId, firstLawyerId, secondLawyerId,
          `client-a-${suffix}@isolation.test`, `client-b-${suffix}@isolation.test`,
          `lawyer-a-${suffix}@isolation.test`, `lawyer-b-${suffix}@isolation.test`],
      );
      await client.query(
        'INSERT INTO contracts (id, owner_id, title) VALUES ($1, $2, $3)',
        [contractId, ownerId, '当前合同标题'],
      );
      await client.query(
        `INSERT INTO messages (id, contract_id, role, content)
         VALUES ($1, $3, 'user', '旧起草消息'), ($2, $3, 'assistant', '旧助手消息')`,
        [randomUUID(), randomUUID(), contractId],
      );
      await client.query(
        `INSERT INTO versions (id, contract_id, number, kind, file_key, content, source, sha256)
         VALUES ($1, $3, 1, 'draft', $4, $6::jsonb, 'demo', NULL),
                ($2, $3, 3, 'draft', $5, $7::jsonb, 'demo', NULL)`,
        [firstDraftId, secondDraftId, contractId,
          `contracts/${contractId}/${firstDraftId}.docx`, `contracts/${contractId}/${secondDraftId}.docx`,
          JSON.stringify(draftContent('第一次送审')), JSON.stringify(draftContent('交付后的新草稿'))],
      );
      await client.query(
        `INSERT INTO reviews
         (id, contract_id, submitted_version_id, lawyer_id, status, stance, concerns, requirements, completed_at)
         VALUES ($1, $3, $4, $5, 'completed', '通过', '', '第一次冻结需求', now()),
                ($2, $3, $6, $7, 'reviewing', '复核', '', '第二次冻结需求', NULL)`,
        [firstReviewId, secondReviewId, contractId, firstDraftId, firstLawyerId, secondDraftId, secondLawyerId],
      );
      await client.query(
        `INSERT INTO versions (id, contract_id, number, kind, review_id, file_key, content, source, sha256)
         VALUES ($1, $3, 2, 'review', $4, $5, NULL, 'lawyer', NULL),
                ($2, $3, 4, 'review', $6, $7, NULL, 'lawyer', NULL)`,
        [firstReviewVersionId, secondReviewVersionId, contractId, firstReviewId,
          `contracts/${contractId}/${firstReviewVersionId}.docx`, secondReviewId,
          `contracts/${contractId}/${secondReviewVersionId}.docx`],
      );
      await client.query(
        `INSERT INTO editor_sessions
         (id, review_id, base_version_id, document_key, scratch_file_key, assigned_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [editorSessionId, secondReviewId, secondDraftId,
          `document-${editorSessionId}`, `scratch-${editorSessionId}`, secondLawyerId],
      );
      await client.query(
        'UPDATE reviews SET final_version_id = $1, editing_version_id = $1 WHERE id = $2',
        [firstReviewVersionId, firstReviewId],
      );
    });

    const firstLawyerView = await getContractForRoute(actor(firstLawyerId, 'Lawyer A', 'lawyer'), contractId);
    assert.deepEqual(firstLawyerView.reviews.map((review) => review.id), [firstReviewId]);
    assert.deepEqual(firstLawyerView.versions.map((version) => version.id), [firstDraftId, firstReviewVersionId]);
    assert.deepEqual(firstLawyerView.messages, []);
    assert.equal(firstLawyerView.reviews[0]?.requirements, '第一次冻结需求');
    assert.equal(firstLawyerView.versions.some((version) => version.id === secondDraftId), false);
    assert.equal(firstLawyerView.versions.some((version) => version.id === secondReviewVersionId), false);

    const secondLawyerView = await getContractForRoute(actor(secondLawyerId, 'Lawyer B', 'lawyer'), contractId);
    assert.deepEqual(secondLawyerView.reviews.map((review) => review.id), [secondReviewId]);
    assert.deepEqual(secondLawyerView.versions.map((version) => version.id), [secondDraftId, secondReviewVersionId]);
    assert.equal(secondLawyerView.versions.some((version) => version.id === firstReviewVersionId), false);

    const ownerView = await getContractForRoute(actor(ownerId, 'Client A', 'client'), contractId);
    assert.equal(ownerView.reviews.length, 2);
    assert.equal(ownerView.versions.length, 4);
    assert.equal(ownerView.messages.length, 2);
    await assert.rejects(
      () => getContractForRoute(actor(otherOwnerId, 'Client B', 'client'), contractId),
      (error: unknown) => (error as { code?: string }).code === 'CONTRACT_NOT_FOUND',
    );

    await assert.rejects(
      () => getVersionFile(actor(firstLawyerId, 'Lawyer A', 'lawyer'), secondDraftId),
      (error: unknown) => (error as { code?: string }).code === 'VERSION_NOT_FOUND',
    );
    await assert.rejects(
      () => getVersionFile(actor(firstLawyerId, 'Lawyer A', 'lawyer'), secondReviewVersionId),
      (error: unknown) => (error as { code?: string }).code === 'VERSION_NOT_FOUND',
    );
    await assert.rejects(
      () => getVersionFile(actor(secondLawyerId, 'Lawyer B', 'lawyer'), firstReviewVersionId),
      (error: unknown) => (error as { code?: string }).code === 'VERSION_NOT_FOUND',
    );

    await query('UPDATE users SET disabled = true WHERE id = $1', [secondLawyerId]);
    const disabledState = await getOnlyOfficeRevisionState({
      reviewId: secondReviewId,
      versionId: secondDraftId,
      revision: editorSessionId,
      sessionId: editorSessionId,
      sha256: 'disabled-callback',
    });
    assert.equal(disabledState.state, 'stale');
    await assert.rejects(
      () => assertOnlyOfficeRevisionCurrent({
        reviewId: secondReviewId,
        versionId: secondDraftId,
        revision: editorSessionId,
        sessionId: editorSessionId,
      }),
      (error: unknown) => (error as { code?: string }).code === 'EDITOR_REVISION_STALE',
    );
    await query('UPDATE users SET disabled = false WHERE id = $1', [secondLawyerId]);
    await query('UPDATE editor_sessions SET active = false WHERE id = $1', [editorSessionId]);
    const closedState = await getOnlyOfficeRevisionState({
      reviewId: secondReviewId,
      versionId: secondDraftId,
      revision: editorSessionId,
      sessionId: editorSessionId,
      sha256: 'closed-callback',
    });
    assert.equal(closedState.state, 'stale');
  } finally {
    await withTransaction(async (client) => {
      await client.query('DELETE FROM reviews WHERE id = ANY($1::text[])', [rows.reviews]);
      await client.query('DELETE FROM versions WHERE id = ANY($1::text[])', [rows.versions]);
      await client.query('DELETE FROM messages WHERE contract_id = $1', [rows.contract]);
      await client.query('DELETE FROM contracts WHERE id = $1', [rows.contract]);
      await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [rows.users]);
    });
  }
});

test('one editor session accepts repeated immutable saves and rejects an old callback after upload', {
  skip: !databaseAvailable,
}, async () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const lawyerId = randomUUID();
  const contractId = randomUUID();
  const draftId = randomUUID();
  const reviewId = randomUUID();
  const sessionId = randomUUID();
  const sourceFileKey = `contracts/${contractId}/source.docx`;
  const documentKey = `document-${sessionId}`;
  const scratchFileKey = `scratch-${sessionId}`;
  const lawyer = actor(lawyerId, 'Lawyer', 'lawyer');
  const content = (title: string): ContractContent => draftContent(title);
  const memory = new Map<string, Buffer>();
  const originalPut = storage.put;
  const originalGet = storage.get;

  storage.put = async (fileKey, bytes) => {
    memory.set(fileKey, Buffer.from(bytes));
  };
  storage.get = async (fileKey) => memory.get(fileKey) ? Buffer.from(memory.get(fileKey)!) : null;

  try {
    const sourceBytes = await renderContract(content('送审合同'));
    memory.set(sourceFileKey, sourceBytes);
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, name, email, email_normalized, password_hash, role)
         VALUES ($1, 'Concurrency Client', $3, $3, 'test', 'client'),
                ($2, 'Concurrency Lawyer', $4, $4, 'test', 'lawyer')`,
        [ownerId, lawyerId, `client-${suffix}@isolation.test`, `lawyer-${suffix}@isolation.test`],
      );
      await client.query(
        'INSERT INTO contracts (id, owner_id, title) VALUES ($1, $2, $3)',
        [contractId, ownerId, '并发保存合同'],
      );
      await client.query(
        `INSERT INTO versions (id, contract_id, number, kind, file_key, content, source, sha256)
         VALUES ($1, $2, 1, 'draft', $3, $4::jsonb, 'demo', $5)`,
        [draftId, contractId, sourceFileKey, JSON.stringify(content('送审合同')), createHash('sha256').update(sourceBytes).digest('hex')],
      );
      await client.query(
        `INSERT INTO reviews
         (id, contract_id, submitted_version_id, lawyer_id, status, stance, concerns, requirements)
         VALUES ($1, $2, $3, $4, 'reviewing', '复核', '', '冻结需求')`,
        [reviewId, contractId, draftId, lawyerId],
      );
      await client.query(
        `INSERT INTO editor_sessions
         (id, review_id, base_version_id, document_key, scratch_file_key, assigned_user_id,
          dirty_epoch, saved_epoch, save_nonce, active)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 'nonce-1', true)`,
        [sessionId, reviewId, draftId, documentKey, scratchFileKey, lawyerId],
      );
    });

    const firstBytes = await renderContract(content('第一次律师编辑'));
    const firstFileKey = `contracts/${contractId}/onlyoffice/${sessionId}/first.docx`;
    const firstInput = {
      reviewId,
      versionId: draftId,
      revision: sessionId,
      sourceFileKey,
      fileKey: firstFileKey,
      bytes: firstBytes,
      sha256: createHash('sha256').update(firstBytes).digest('hex'),
      status: 6 as const,
      sessionId,
      userId: lawyerId,
      userData: { epoch: 1, nonce: 'nonce-1' },
    };
    memory.set(firstFileKey, firstBytes);
    await assert.rejects(
      () => persistOnlyOfficeRevision({ ...firstInput, userData: { epoch: 1, nonce: 'wrong-nonce' } }),
      (error: unknown) => (error as { code?: string }).code === 'EDITOR_REVISION_STALE',
      'a callback must match the pending save nonce even when its epoch matches',
    );
    await persistOnlyOfficeRevision(firstInput);
    const firstSession = (await query<{ base_version_id: string; document_key: string; saved_epoch: number; dirty_epoch: number }>(
      'SELECT base_version_id, document_key, saved_epoch, dirty_epoch FROM editor_sessions WHERE id = $1',
      [sessionId],
    )).rows[0];
    assert.equal(firstSession.base_version_id, draftId);
    assert.equal(firstSession.document_key, documentKey);
    assert.equal(Number(firstSession.saved_epoch), 1);
    assert.equal(Number(firstSession.dirty_epoch), 1);

    await markEditorDirty(lawyer, contractId, reviewId, {});
    await query('UPDATE editor_sessions SET save_nonce = $1 WHERE id = $2', ['nonce-2', sessionId]);
    await assert.rejects(
      () => persistOnlyOfficeRevision(firstInput),
      (error: unknown) => (error as { code?: string }).code === 'EDITOR_REVISION_STALE',
      'a callback from the prior force-save epoch must not mark the later edit saved',
    );
    const secondBytes = await renderContract(content('第二次律师编辑'));
    const secondFileKey = `contracts/${contractId}/onlyoffice/${sessionId}/second.docx`;
    const secondInput = {
      ...firstInput,
      fileKey: secondFileKey,
      bytes: secondBytes,
      sha256: createHash('sha256').update(secondBytes).digest('hex'),
      userData: { epoch: 2, nonce: 'nonce-2' },
    };
    memory.set(secondFileKey, secondBytes);
    await persistOnlyOfficeRevision(secondInput);
    const secondSession = (await query<{ base_version_id: string; document_key: string; saved_epoch: number; dirty_epoch: number }>(
      'SELECT base_version_id, document_key, saved_epoch, dirty_epoch FROM editor_sessions WHERE id = $1',
      [sessionId],
    )).rows[0];
    assert.equal(secondSession.base_version_id, draftId, 'the browser session must keep its original version binding');
    assert.equal(secondSession.document_key, documentKey, 'the browser session must keep its original document key');
    assert.equal(Number(secondSession.saved_epoch), 2);
    assert.equal(Number(secondSession.dirty_epoch), 2);
    await assert.doesNotReject(() => assertOnlyOfficeRevisionCurrent({
      reviewId,
      versionId: draftId,
      revision: sessionId,
      sessionId,
    }));
    const beforeDuplicate = Number((await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM versions WHERE review_id = $1',
      [reviewId],
    )).rows[0]?.count ?? 0);
    await persistOnlyOfficeRevision(secondInput);
    const afterDuplicate = Number((await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM versions WHERE review_id = $1',
      [reviewId],
    )).rows[0]?.count ?? 0);
    assert.equal(afterDuplicate, beforeDuplicate, 'replayed callback must be idempotent');

    const uploadBytes = await renderContract(content('手工上传版本'));
    await uploadReviewVersion(lawyer, contractId, reviewId, {
      name: 'lawyer-upload.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: uploadBytes,
    });
    const uploadSession = (await query<{ active: boolean }>(
      'SELECT active FROM editor_sessions WHERE id = $1',
      [sessionId],
    )).rows[0];
    assert.equal(uploadSession.active, false, 'manual upload must close the old browser session');
    await assert.rejects(
      () => persistOnlyOfficeRevision(secondInput),
      (error: unknown) => (error as { code?: string }).code === 'EDITOR_REVISION_STALE',
    );
    const afterOldCallback = Number((await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM versions WHERE review_id = $1',
      [reviewId],
    )).rows[0]?.count ?? 0);
    assert.equal(afterOldCallback, beforeDuplicate + 1, 'old callback must not create a version after upload');
  } finally {
    storage.put = originalPut;
    storage.get = originalGet;
    await withTransaction(async (client) => {
      await client.query(
        'DELETE FROM editor_sessions WHERE review_id IN (SELECT id FROM reviews WHERE contract_id = $1)',
        [contractId],
      );
      await client.query('DELETE FROM reviews WHERE contract_id = $1', [contractId]);
      await client.query('DELETE FROM versions WHERE contract_id = $1', [contractId]);
      await client.query('DELETE FROM messages WHERE contract_id = $1', [contractId]);
      await client.query('DELETE FROM contracts WHERE id = $1', [contractId]);
      await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, lawyerId]]);
    });
  }
});

test('an AI chat that started before review submission is rejected when its transaction commits after the freeze', {
  skip: !databaseAvailable,
}, async () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const contractId = randomUUID();
  const draftId = randomUUID();
  const owner = actor(ownerId, 'Race Client', 'client');
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.CONTRACT_AI_API_KEY;
  const previousBaseUrl = process.env.CONTRACT_AI_BASE_URL;
  let resolveStarted!: () => void;
  let resolveRelease!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const release = new Promise<void>((resolve) => { resolveRelease = resolve; });
  process.env.CONTRACT_AI_API_KEY = 'concurrency-test-key';
  process.env.CONTRACT_AI_BASE_URL = 'http://concurrency-test.invalid/v1';
  globalThis.fetch = async (_url,init) => {
    if(String(init?.body).includes('CONTRACT_ROUTER_V1'))return Response.json({choices:[{message:{content:JSON.stringify({templateId:null,action:'answer',reason:'测试对话',facts:[]})}}]});
    resolveStarted();
    await release;
    return Response.json({ choices: [{ message: { content: '并发审核已开始，不能再写入起草消息。' } }] });
  };

  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, name, email, email_normalized, password_hash, role)
         VALUES ($1, 'Race Client', $2, $2, 'test', 'client')`,
        [ownerId, `race-client-${suffix}@isolation.test`],
      );
      await client.query(
        'INSERT INTO contracts (id, owner_id, title) VALUES ($1, $2, $3)',
        [contractId, ownerId, '审核冻结竞态合同'],
      );
    });

    const chatPromise = chatContract(owner, contractId, {
      message: '这条消息在审核开始前发出',
      mode: 'live',
      generate: false,
    });
    await started;
    await query(
      `INSERT INTO versions (id, contract_id, number, kind, file_key, content, source, sha256)
       VALUES ($1, $2, 1, 'draft', $3, $4::jsonb, 'demo', NULL)`,
      [draftId, contractId, `contracts/${contractId}/${draftId}.docx`, JSON.stringify(draftContent('竞态草稿'))],
    );
    await submitReview(owner, contractId, {
      versionId: draftId,
      stance: '请审核',
      concerns: '',
    });
    resolveRelease();
    await assert.rejects(
      () => chatPromise,
      (error: unknown) => (error as { code?: string }).code === 'REVIEW_VERSION_FROZEN',
    );
    const messageCount = Number((await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM messages WHERE contract_id = $1',
      [contractId],
    )).rows[0]?.count ?? 0);
    assert.equal(messageCount, 0, 'the losing chat transaction must not append post-freeze messages');
  } finally {
    resolveRelease();
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.CONTRACT_AI_API_KEY;
    else process.env.CONTRACT_AI_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.CONTRACT_AI_BASE_URL;
    else process.env.CONTRACT_AI_BASE_URL = previousBaseUrl;
    await withTransaction(async (client) => {
      await client.query('DELETE FROM messages WHERE contract_id = $1', [contractId]);
      await client.query('DELETE FROM reviews WHERE contract_id = $1', [contractId]);
      await client.query('DELETE FROM versions WHERE contract_id = $1', [contractId]);
      await client.query('DELETE FROM contracts WHERE id = $1', [contractId]);
      await client.query('DELETE FROM users WHERE id = $1', [ownerId]);
    });
  }
});
