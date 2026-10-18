import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/api/[...path]/route';
import {auditStore} from '../src/server/access-audit';
import { storage } from '../src/server/documents';
import { createEditorConfig } from '../src/server/onlyoffice';
import { onlyOfficeAccess } from '../src/server/contracts';
import { AppError } from '../src/server/db';

test('reopening an editor serves its latest session bytes and preserves original provenance', async () => {
  const originalSecret = process.env.ONLYOFFICE_JWT_SECRET;
  const originalGet = storage.get;const originalAudit=auditStore.append;const originalCheck=onlyOfficeAccess.check;const audits:number[]=[];auditStore.append=async(_actor,_action,_resource,status)=>{audits.push(status);};
  process.env.ONLYOFFICE_JWT_SECRET = 'editor-reopen-test-secret-01234567890123456789';
  try {
    const original = Buffer.from('original submitted bytes');
    const latest = Buffer.from('latest lawyer saved bytes');
    storage.get = async (key) => key === 'contracts/test/session.docx' ? latest : original;
    let allowed=true;
    onlyOfficeAccess.check=async claims=>{assert.equal(claims.authSessionId,'web-session');if(!allowed)throw new AppError(403,'revoked','EDITOR_SESSION_INVALID')};
    const config = await createEditorConfig({
      reviewId: 'reopen-review', versionId: 'submitted-version', revision: 'session-one',
      sessionId: 'session-one', fileKey: 'contracts/test/session.docx',authSessionId:'web-session',userId:'lawyer',
      sourceFileKey: 'contracts/test/original.docx', baseUrl: 'http://localhost:3210', role: 'edit',
    }, { documentServerUrl: 'http://localhost:8080' });
    const response = await GET(new Request(config.config.document.url), {
      params: Promise.resolve({path: ['files', 'onlyoffice']}),
    });
    assert.equal(response.status, 200);assert.deepEqual(audits,[0,200]);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), latest);
    allowed=false;
    assert.equal((await GET(new Request(config.config.document.url),{params:Promise.resolve({path:['files','onlyoffice']})})).status,403);
  } finally {
    storage.get = originalGet;auditStore.append=originalAudit;onlyOfficeAccess.check=originalCheck;
    if (originalSecret === undefined) delete process.env.ONLYOFFICE_JWT_SECRET;
    else process.env.ONLYOFFICE_JWT_SECRET = originalSecret;
  }
});
