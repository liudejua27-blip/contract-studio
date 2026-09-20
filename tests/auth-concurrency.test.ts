import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const databaseAvailable = Boolean(process.env.DATABASE_URL);

test('concurrent mutual admin disables preserve one active administrator', {
  skip: !databaseAvailable,
}, async () => {
  const originalUrl = process.env.DATABASE_URL!;
  const setup = new Pool({ connectionString: originalUrl });
  const schema = `admin_race_${randomUUID().replaceAll('-', '')}`;
  let closeDatabase: (() => Promise<void>) | undefined;
  try {
    // A private schema keeps real accounts and sessions entirely outside this test.
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`CREATE TABLE "${schema}".users (LIKE public.users INCLUDING ALL)`);
    await setup.query(`CREATE TABLE "${schema}".sessions (LIKE public.sessions INCLUDING ALL)`);
    const isolatedUrl = new URL(originalUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = isolatedUrl.toString();
    const db = await import('../src/server/db');
    closeDatabase = db.closeDatabase;
    const { updateUser } = await import('../src/server/auth');
    const firstId = randomUUID();
    const secondId = randomUUID();
    await db.query(
      `INSERT INTO users (id, name, email, email_normalized, password_hash, role, disabled)
       VALUES ($1, 'Admin race A', $2, $2, 'test', 'admin', false),
              ($3, 'Admin race B', $4, $4, 'test', 'admin', false)`,
      [firstId, 'race-a@isolation.test', secondId, 'race-b@isolation.test'],
    );
    const outcomes = await Promise.allSettled([
      updateUser(firstId, { disabled: true }, secondId),
      updateUser(secondId, { disabled: true }, firstId),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(failed.length, 1);
    assert.equal((failed[0] as PromiseRejectedResult).reason?.code, 'LAST_ADMIN_DISABLE_FORBIDDEN');
    const after = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE role = 'admin' AND disabled = false",
    );
    assert.equal(Number(after.rows[0]?.count ?? 0), 1);
  } finally {
    if (closeDatabase) await closeDatabase();
    process.env.DATABASE_URL = originalUrl;
    await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await setup.end();
  }
});
