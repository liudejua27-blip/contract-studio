import test from 'node:test';
import assert from 'node:assert/strict';
import { PATCH, POST } from '../src/app/api/[...path]/route';
import { AppError } from '../src/server/db';
import { assertMutationRequest, assertRequestSize, trustedSourceIdentifier } from '../src/server/http-security';

function context(path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) };
}

test('mutation guard rejects cross-site and mismatched origins', () => {
  assert.throws(
    () => assertMutationRequest(new Request('http://127.0.0.1:3210/api/users/u1', { headers: { 'sec-fetch-site': 'cross-site' } })),
    (error: unknown) => error instanceof AppError && error.code === 'CSRF_BLOCKED' && error.status === 403,
  );
  assert.throws(
    () => assertMutationRequest(new Request('http://127.0.0.1:3210/api/users/u1', { headers: { origin: 'https://evil.example' } })),
    (error: unknown) => error instanceof AppError && error.code === 'CSRF_BLOCKED' && error.status === 403,
  );
  assert.doesNotThrow(() => assertMutationRequest(new Request('http://127.0.0.1:3210/api/users/u1', { headers: { origin: 'http://127.0.0.1:3210' } })));
});

test('source identifier uses proxy headers only when explicitly trusted', () => {
  const previous = process.env.CONTRACT_TRUST_PROXY;
  try {
    delete process.env.CONTRACT_TRUST_PROXY;
    assert.equal(trustedSourceIdentifier(new Request('http://127.0.0.1:3210', { headers: { 'x-real-ip': '203.0.113.7' } })), undefined);
    process.env.CONTRACT_TRUST_PROXY = 'true';
    assert.equal(
      trustedSourceIdentifier(new Request('http://127.0.0.1:3210', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } })),
      '203.0.113.7',
    );
    assert.equal(
      trustedSourceIdentifier(new Request('http://127.0.0.1:3210', { headers: { 'x-real-ip': 'not-an-ip', 'x-forwarded-for': 'still-not-an-ip' } })),
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.CONTRACT_TRUST_PROXY;
    else process.env.CONTRACT_TRUST_PROXY = previous;
  }
});

test('request size guard rejects oversized JSON before route work', () => {
  assert.throws(
    () => assertRequestSize(new Request('http://127.0.0.1:3210/api/users/u1', { headers: { 'content-length': '2097153' } }), 2 * 1024 * 1024),
    (error: unknown) => error instanceof AppError && error.code === 'REQUEST_TOO_LARGE' && error.status === 413,
  );
  assert.doesNotThrow(() => assertRequestSize(new Request('http://127.0.0.1:3210/api/users/u1', { headers: { 'content-length': '12' } }), 2 * 1024 * 1024));
});

test('PATCH user route applies CSRF before authentication and callback caps body size', async () => {
  const patchResponse = await PATCH(
    new Request('http://127.0.0.1:3210/api/users/u1', {
      method: 'PATCH',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    }),
    context(['users', 'u1']),
  );
  assert.equal(patchResponse.status, 403);
  assert.equal((await patchResponse.json()).code, 'CSRF_BLOCKED');

  const callbackResponse = await POST(
    new Request('http://127.0.0.1:3210/api/onlyoffice/callback?token=ignored', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) },
      body: '{}',
    }),
    context(['onlyoffice', 'callback']),
  );
  assert.equal(callbackResponse.status, 413);
  assert.equal((await callbackResponse.json()).code, 'REQUEST_TOO_LARGE');
});


test('body reader limits actual chunks without trusting Content-Length', async () => {
  const {readRequestBytes}=await import('../src/server/http-security');
  for(const declared of [undefined,'1']){
    let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(700));},cancel(){cancelled=true;}});
    const request=new Request('http://localhost/',{method:'POST',body:stream,duplex:'half',headers:declared?{'content-length':declared}:{}} as RequestInit);
    await assert.rejects(readRequestBytes(request,1024),(e:unknown)=>e instanceof AppError&&e.status===413);
    assert.equal(cancelled,true);
  }
});
test('login and editor callback reject actual oversized bodies before database/auth', async()=>{
  for(const path of [['auth','login'],['onlyoffice','callback']]){
    const response=await POST(new Request('http://127.0.0.1:3210/api/'+path.join('/'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'x'.repeat(2*1024*1024)})}),context(path));
    assert.equal(response.status,413);
  }
});
