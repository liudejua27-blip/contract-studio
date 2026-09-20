import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuthContext, hashPassword, verifyPassword } from '../src/server/auth';
import { buildAuthRateLimitKeys } from '../src/server/rate-limit';

test('password hashes use a fresh salt and verify without exposing the password', async () => {
  const first = await hashPassword('正确的本地测试密码-1');
  const second = await hashPassword('正确的本地测试密码-1');
  assert.match(first, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('正确的本地测试密码-1', first), true);
  assert.equal(await verifyPassword('错误密码', first), false);
});

test('password verification rejects non-approved work factors and malformed lengths', async () => {
  const encoded = await hashPassword('参数边界测试密码');
  const parts = encoded.split('$');
  parts[1] = '32768';
  assert.equal(await verifyPassword('参数边界测试密码', parts.join('$')), false);

  const validParts = encoded.split('$');
  validParts[4] = '';
  assert.equal(await verifyPassword('参数边界测试密码', validParts.join('$')), false);

  const invalidHash = encoded.split('$');
  invalidHash[5] = 'AA';
  assert.equal(await verifyPassword('参数边界测试密码', invalidHash.join('$')), false);
});

test('auth rate-limit keys use normalized email and include optional source scope', () => {
  const keys = buildAuthRateLimitKeys('login', '  USER@Example.COM ', ' 203.0.113.7 ');
  assert.deepEqual(keys.map((key) => key.scope), ['login_email', 'login_pair', 'login_source']);
  assert.ok(keys.every((key) => /^[0-9a-f]{64}$/.test(key.keyHash)));
  assert.deepEqual(
    buildAuthRateLimitKeys('login', 'USER@example.com').map((key) => key.scope),
    ['login_email'],
  );
});

test('malformed session cookies are treated as absent sessions', async () => {
  const request = new Request('http://127.0.0.1:3210/api/session', {
    headers: { cookie: 'contract_studio_session=%E0%A4%A' },
  });
  assert.equal(await getAuthContext(request), null);
});

