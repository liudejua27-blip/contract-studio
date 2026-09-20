import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/api/[...path]/route';
import { storage } from '../src/server/documents';
import { createEditorConfig } from '../src/server/onlyoffice';

test('reopening an editor serves its latest session bytes and preserves original provenance', async () => {
  const originalSecret = process.env.ONLYOFFICE_JWT_SECRET;
  const originalGet = storage.get;
  process.env.ONLYOFFICE_JWT_SECRET = 'editor-reopen-test-secret-01234567890123456789';
  try {
    const original = Buffer.from('original submitted bytes');
    const latest = Buffer.from('latest lawyer saved bytes');
    storage.get = async (key) => key === 'contracts/test/session.docx' ? latest : original;
    const config = await createEditorConfig({
      reviewId: 'reopen-review', versionId: 'submitted-version', revision: 'session-one',
      sessionId: 'session-one', fileKey: 'contracts/test/session.docx',
      sourceFileKey: 'contracts/test/original.docx', baseUrl: 'http://localhost:3210', role: 'edit',
    }, { documentServerUrl: 'http://localhost:8080' });
    const response = await GET(new Request(config.config.document.url), {
      params: Promise.resolve({path: ['files', 'onlyoffice']}),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), latest);
  } finally {
    storage.get = originalGet;
    if (originalSecret === undefined) delete process.env.ONLYOFFICE_JWT_SECRET;
    else process.env.ONLYOFFICE_JWT_SECRET = originalSecret;
  }
});
