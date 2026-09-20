import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync } from 'fflate';
import { SignJWT, jwtVerify } from 'jose';
import type { StorageAdapter } from '../src/server/storage';
import { createStorage, normalizeStorageKey } from '../src/server/storage';
import {
  extractDocxText,
  renderContract,
  validateDocxBuffer,
  DocxValidationError,
} from '../src/server/documents';
import {
  assertTrustedDownloadUrl,
  createEditorConfig,
  handleOnlyOfficeCallback,
  isBlockedIpAddress,
  verifyOnlyOfficeToken,
} from '../src/server/onlyoffice';

class MemoryStorage implements StorageAdapter {
  readonly values = new Map<string, Buffer>();

  async put(fileKey: string, bytes: Buffer): Promise<void> {
    this.values.set(fileKey, Buffer.from(bytes));
  }

  async get(fileKey: string): Promise<Buffer | null> {
    const bytes = this.values.get(fileKey);
    return bytes ? Buffer.from(bytes) : null;
  }
}

async function fixtureDocx(): Promise<Buffer> {
  return renderContract({
    title: '软件开发服务合同',
    parties: [
      { role: '甲方', name: '', details: '统一社会信用代码：[待补充]' },
      { role: '乙方', name: '星河科技有限公司', details: '' },
    ],
    sections: [
      { title: '项目内容', content: '乙方按照甲方确认的需求开发软件。' },
      { title: '服务费用', content: '' },
    ],
    signing: '本合同自双方签字盖章之日起生效。',
    missing: ['甲方名称', '交付日期'],
  });
}

test('renderContract creates a real Chinese DOCX with structure and explicit missing markers', async () => {
  const bytes = await fixtureDocx();
  assert.ok(bytes.length > 1000);
  const packageInfo = validateDocxBuffer(bytes);
  assert.equal(packageInfo.bytes, bytes);
  assert.equal(packageInfo.sha256.length, 64);
  const packageFiles = unzipSync(bytes);
  const documentXml = Buffer.from(packageFiles['word/document.xml']).toString('utf8');
  const headerXml = Buffer.from(packageFiles['word/header1.xml']).toString('utf8');
  const footerXml = Buffer.from(packageFiles['word/footer1.xml']).toString('utf8');
  const numberingXml = Buffer.from(packageFiles['word/numbering.xml']).toString('utf8');
  assert.match(documentXml, /软件开发服务合同/);
  assert.match(documentXml, /待补充/);
  assert.match(documentXml, /w:headerReference/);
  assert.match(documentXml, /w:footerReference/);
  assert.match(headerXml, /合同工作室/);
  assert.match(footerXml, /PAGE/);
  assert.match(numberingXml, /第%1条/);
  assert.match(documentXml, /签署页/);
});

test('DOCX validation bounds entries, paths, and decompression before fflate inflation', async () => {
  const bomb = zipSync({
    '[Content_Types].xml': new TextEncoder().encode('<Types/>'),
    '_rels/.rels': new TextEncoder().encode('<Relationships/>'),
    'word/document.xml': new TextEncoder().encode('<w:document><w:body/></w:document>'),
    'word/repetitive.xml': new Uint8Array(400_000).fill(65),
  });
  assert.throws(() => validateDocxBuffer(Buffer.from(bomb)), DocxValidationError);

  const traversal = zipSync({ '../outside.txt': new Uint8Array([1]), 'word/document.xml': new TextEncoder().encode('<w:document><w:body/></w:document>') });
  assert.throws(() => validateDocxBuffer(Buffer.from(traversal)), DocxValidationError);

  const unsupported = zipSync({ '[Content_Types].xml': new Uint8Array([1]) });
  assert.throws(() => validateDocxBuffer(Buffer.from(unsupported)), DocxValidationError);
});

test('DOCX text extraction preserves paragraphs and tables without external entities', async () => {
  const bytes = await fixtureDocx();
  const text = extractDocxText(bytes);
  assert.match(text, /软件开发服务合同/);
  assert.match(text, /项目内容/);
  assert.match(text, /乙方/);
  assert.match(text, /签署页/);
  assert.ok(text.includes('\n'));

  const packageFiles = unzipSync(bytes);
  const xml = Buffer.from(packageFiles['word/document.xml']).toString('utf8').replace('<w:document', '<!DOCTYPE w:document [<!ENTITY x "unsafe">]><w:document');
  const malicious = zipSync(Object.fromEntries(Object.entries(packageFiles).map(([name, value]) => [name, name === 'word/document.xml' ? new TextEncoder().encode(xml) : value])));
  assert.throws(() => extractDocxText(Buffer.from(malicious)), DocxValidationError);
});

test('filesystem storage keeps private keys inside the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contract-studio-storage-'));
  const symlinkRoot = `${root}-link`;
  try {
    const adapter = createStorage({ backend: 'filesystem', rootDir: root });
    const bytes = Buffer.from('private contract');
    await adapter.put('contracts/demo/v1.docx', bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.deepEqual(await adapter.get('contracts/demo/v1.docx'), bytes);
    assert.equal(await adapter.get('contracts/demo/missing.docx'), null);
    assert.equal(normalizeStorageKey('contracts/demo/v1.docx'), 'contracts/demo/v1.docx');
    assert.throws(() => normalizeStorageKey('../outside.docx'));
    assert.throws(() => normalizeStorageKey('/absolute.docx'));
    assert.throws(() => normalizeStorageKey('contracts\\outside.docx'));
    assert.equal(await readFile(join(root, 'contracts/demo/v1.docx'), 'utf8'), 'private contract');
    await symlink(root, symlinkRoot, 'dir');
    const symlinkAdapter = createStorage({ backend: 'filesystem', rootDir: symlinkRoot });
    await assert.rejects(() => symlinkAdapter.put('contracts/demo/symlink.docx', bytes), /symbolic links/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(symlinkRoot, { recursive: false, force: true });
  }
});

test('OnlyOffice config uses narrow document/callback JWTs and force-save persists exact revision', async () => {
  const secret = 'onlyoffice-test-secret-01234567890123456789';
  const bytes = await fixtureDocx();
  const memory = new MemoryStorage();
  const persisted: Array<{ reviewId: string; versionId: string; revision: string; fileKey: string; sha256: string; status: 2 | 6 }> = [];
  const configResponse = await createEditorConfig({
    reviewId: 'review-1',
    versionId: 'version-2',
    revision: 'revision-7',
    fileKey: 'contracts/contract-1/versions/version-2/revision-7.docx',
    role: 'edit',
    title: '软件开发服务合同',
    baseUrl: 'http://localhost:3210',
    documentPath: '/api/files/onlyoffice',
    callbackPath: '/api/onlyoffice/callback',
    sessionId: 'session-1',
    sourceFileKey: 'contracts/contract-1/versions/version-1.docx',
  }, {
    secret,
    documentServerUrl: 'http://localhost:8080',
    documentTokenTtlSeconds: 300,
    configTokenTtlSeconds: 300,
  });
  assert.equal(configResponse.documentServerUrl, 'http://localhost:8080');
  assert.equal(configResponse.config.document.permissions.edit, true);
  assert.equal(configResponse.config.editorConfig.customization.forcesave, true);
  assert.equal(configResponse.config.editorConfig.lang, 'zh-CN');
  await assert.rejects(() => createEditorConfig({
    reviewId: 'review-1', versionId: 'version-2', revision: 'revision-7', sessionId: 'session-1',
    fileKey: 'contracts/../outside.docx', sourceFileKey: 'contracts/contract-1/versions/version-1.docx',
    baseUrl: 'http://localhost:3210',
  }, { secret, documentServerUrl: 'http://localhost:8080' }));
  const signedConfig = (await jwtVerify(configResponse.config.token, new TextEncoder().encode(secret))).payload;
  assert.deepEqual(signedConfig.document, configResponse.config.document);
  assert.equal(signedConfig.documentType, configResponse.config.documentType);
  assert.deepEqual(signedConfig.editorConfig, configResponse.config.editorConfig);
  const documentToken = new URL(configResponse.config.document.url).searchParams.get('token');
  const callbackToken = new URL(configResponse.config.editorConfig.callbackUrl).searchParams.get('token');
  assert.ok(documentToken);
  assert.ok(callbackToken);
  const documentClaims = await verifyOnlyOfficeToken(documentToken!, { secret, purpose: 'document', reviewId: 'review-1', versionId: 'version-2', revision: 'revision-7', sessionId: 'session-1', sourceFileKey: 'contracts/contract-1/versions/version-1.docx' });
  assert.equal(documentClaims.scope, 'contract-document-read');
  const callbackClaims = await verifyOnlyOfficeToken(callbackToken!, { secret, purpose: 'callback', reviewId: 'review-1', versionId: 'version-2', revision: 'revision-7', sessionId: 'session-1', sourceFileKey: 'contracts/contract-1/versions/version-1.docx' });
  assert.equal(callbackClaims.exp! - callbackClaims.iat!, 8 * 60 * 60);
  await assert.rejects(() => verifyOnlyOfficeToken(documentToken!, { secret, purpose: 'callback' }));

  const callbackBody = { key: configResponse.config.document.key, status: 6, url: 'http://localhost:9000/private/revision-7.docx', userdata: { epoch: 1 } };
  // Official header-token mode wraps the signed callback fields in `payload`;
  // the HTTP body still carries the same fields in plain JSON.
  const bodyToken = await new SignJWT({ payload: callbackBody })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));

  const result = await handleOnlyOfficeCallback({
    token: callbackToken!,
    headers: { authorization: `Bearer ${bodyToken}` },
    body: callbackBody,
  }, {
    secret,
    trustedDownloadOrigins: ['http://localhost:9000'],
    allowPrivateHosts: ['localhost'],
    storage: memory,
    fetchImpl: async () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }),
    persistRevision: async (input) => {
      persisted.push({ reviewId: input.reviewId, versionId: input.versionId, revision: input.revision, fileKey: input.fileKey, sha256: input.sha256, status: input.status });
    },
  });
  assert.equal(result.error, 0);
  assert.equal(result.saved, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].reviewId, 'review-1');
  assert.equal(persisted[0].revision, 'revision-7');
  assert.equal(persisted[0].fileKey.includes('/onlyoffice/revision-7/'), true);
  assert.equal((await memory.get(persisted[0].fileKey))?.equals(bytes), true);

  const tampered = await handleOnlyOfficeCallback({
    token: callbackToken!,
    headers: { authorization: `Bearer ${bodyToken}` },
    body: { ...callbackBody, url: 'http://localhost:9000/private/attacker.docx' },
  }, {
    secret,
    trustedDownloadOrigins: ['http://localhost:9000'],
    allowPrivateHosts: ['localhost'],
    storage: memory,
    persistRevision: async () => { throw new Error('tampered callback must not persist'); },
  });
  assert.equal(tampered.error, 1);

  const duplicate = await handleOnlyOfficeCallback({ token: callbackToken!, headers: { authorization: `Bearer ${bodyToken}` }, body: callbackBody }, {
    secret,
    trustedDownloadOrigins: ['http://localhost:9000'],
    allowPrivateHosts: ['localhost'],
    storage: memory,
    fetchImpl: async () => new Response(new Uint8Array(bytes), { status: 200 }),
    getRevisionState: async () => ({ state: 'saved', sha256: result.sha256 }),
    persistRevision: async () => { throw new Error('duplicate callback must be idempotent'); },
  });
  assert.equal(duplicate.error, 0);
  assert.equal(duplicate.ignored, true);

  const failedBody = { key: configResponse.config.document.key, status: 7 };
  const failedToken = await new SignJWT({ payload: failedBody })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
  const failed = await handleOnlyOfficeCallback({ token: callbackToken!, headers: { authorization: `Bearer ${failedToken}` }, body: failedBody }, {
    secret,
    trustedDownloadOrigins: ['http://localhost:9000'],
    allowPrivateHosts: ['localhost'],
    storage: memory,
    persistRevision: async () => { throw new Error('must not persist error callback'); },
  });
  assert.equal(failed.error, 1);
  assert.equal(persisted.length, 1);

  const stale = await handleOnlyOfficeCallback({ token: callbackToken!, headers: { authorization: `Bearer ${bodyToken}` }, body: callbackBody }, {
    secret,
    trustedDownloadOrigins: ['http://localhost:9000'],
    allowPrivateHosts: ['localhost'],
    storage: memory,
    fetchImpl: async () => new Response(new Uint8Array(bytes), { status: 200 }),
    getRevisionState: async () => ({ state: 'completed', sha256: persisted[0].sha256 }),
    persistRevision: async () => { throw new Error('completed callback must not persist'); },
  });
  assert.equal(stale.error, 1);
});

test('OnlyOffice body-token callback takes key, URL, status, and userdata from the signed payload', async () => {
  const secret = 'onlyoffice-body-token-secret-01234567890123456789';
  const bytes = await fixtureDocx();
  const memory = new MemoryStorage();
  const configResponse = await createEditorConfig({
    reviewId: 'review-body',
    versionId: 'version-body',
    revision: 'revision-body',
    fileKey: 'contracts/body/versions/base.docx',
    sourceFileKey: 'contracts/body/versions/base.docx',
    baseUrl: 'http://localhost:3210',
    sessionId: 'session-body',
  }, { secret, documentServerUrl: 'http://localhost:8080', tokenTtlSeconds: 300 });
  const callbackToken = new URL(configResponse.config.editorConfig.callbackUrl).searchParams.get('token');
  const callbackBody = {
    key: configResponse.config.document.key,
    status: 6,
    url: 'http://localhost:9000/private/body.docx',
    userdata: { nonce: 'force-save-1', epoch: 3 },
  };
  const bodyToken = await new SignJWT(callbackBody)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
  let persistedUserData: unknown;
  const result = await handleOnlyOfficeCallback({ token: callbackToken!, body: { token: bodyToken } }, {
    secret,
    trustedDownloadOrigins: ['http://localhost:9000'],
    allowPrivateHosts: ['localhost'],
    storage: memory,
    fetchImpl: async () => new Response(new Uint8Array(bytes), { status: 200 }),
    persistRevision: async (input) => { persistedUserData = input.userData; },
  });
  assert.equal(result.error, 0);
  assert.deepEqual(persistedUserData, callbackBody.userdata);
});

test('OnlyOffice download URL checks block SSRF and redirect escape', async () => {
  assert.equal(isBlockedIpAddress('127.0.0.1'), true);
  assert.equal(isBlockedIpAddress('10.0.0.5'), true);
  assert.equal(isBlockedIpAddress('ff02::1'), true);
  assert.equal(isBlockedIpAddress('fc00::1'), true);
  assert.equal(isBlockedIpAddress('2001:db8::1'), true);
  assert.equal(isBlockedIpAddress('8.8.8.8'), false);
  // Use a reserved TEST-NET address here so the assertion remains isolated
  // when the local .env.local intentionally allows localhost/8081 for DS.
  await assert.rejects(() => assertTrustedDownloadUrl('http://192.0.2.1:8080/file.docx', { trustedDownloadOrigins: ['http://192.0.2.1:8080'] }));
  await assert.rejects(() => assertTrustedDownloadUrl('https://evil.example/file.docx', { trustedDownloadOrigins: ['https://contracts.example.com'] }));

  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = process.env.NODE_ENV;
  env.NODE_ENV = 'development';
  try {
    const allowed = await assertTrustedDownloadUrl('http://host.docker.internal:9000/file.docx', {
      trustedDownloadOrigins: ['http://host.docker.internal:9000'],
      allowPrivateHosts: ['host.docker.internal'],
    });
    assert.equal(allowed.hostname, 'host.docker.internal');
    env.NODE_ENV = 'production';
    try {
      await assert.rejects(() => createEditorConfig({
        reviewId: 'review-private', versionId: 'version-private', revision: 'r1', sessionId: 's1',
        baseUrl: 'http://host.docker.internal:3210',
      }, { secret: 'private-host-secret-01234567890123456789', documentServerUrl: 'http://host.docker.internal:8080' }));
    } finally {
      env.NODE_ENV = 'development';
    }
    const privateConfig = await createEditorConfig({
      reviewId: 'review-private', versionId: 'version-private', revision: 'r1', sessionId: 's1',
      baseUrl: 'http://host.docker.internal:3210',
    }, {
      secret: 'private-host-secret-01234567890123456789',
      documentServerUrl: 'http://host.docker.internal:8080',
      allowPrivateHosts: ['host.docker.internal'],
    });
    assert.equal(privateConfig.documentServerUrl, 'http://host.docker.internal:8080');
  } finally {
    if (previousNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNodeEnv;
  }
});
