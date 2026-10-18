import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/** An error that can safely be converted to the public API error envelope. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

const connectionString = process.env.DATABASE_URL;

// Pool construction is intentionally lazy from PostgreSQL's perspective: creating the
// pool does not open a socket. This keeps capability/session pages importable in a
// local UI build while still returning a clear configuration error on a database call.
export const pool = new Pool({
  connectionString,
  max: Number(process.env.CONTRACT_DB_POOL_MAX ?? 10),
  idleTimeoutMillis: Number(process.env.CONTRACT_DB_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.CONTRACT_DB_CONNECT_TIMEOUT_MS ?? 5_000),
  application_name: 'contract-studio',
});

export function databaseConfigured(): boolean {
  return Boolean(connectionString);
}

function ensureDatabaseConfigured(): void {
  if (!databaseConfigured()) {
    throw new AppError(
      503,
      'Database is not configured. Set DATABASE_URL for Contract Studio.',
      'DATABASE_NOT_CONFIGURED',
    );
  }
}

function logDatabaseFailure(error:unknown,operation:string){
  const detail=error as {code?:unknown;constraint?:unknown};
  const safe=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_]{1,120}$/.test(v)?v:undefined;
  console.error(JSON.stringify({event:'database_failure',operation,code:safe(detail?.code),constraint:safe(detail?.constraint)}));
}

export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  ensureDatabaseConfigured();
  try {
    return await pool.query<R>(text, values as unknown[]);
  } catch (error) {
    logDatabaseFailure(error,'query');
    // Do not leak connection strings, SQL values, or server diagnostics to clients.
    const message = error instanceof Error ? error.message : 'Database query failed';
    if (/unique|duplicate/i.test(message)) {
      throw new AppError(409, 'The requested record already exists.', 'CONFLICT');
    }
    throw new AppError(500, 'Database operation failed.', 'DATABASE_ERROR');
  }
}

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  ensureDatabaseConfigured();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original error. The connection is released below.
    }
    if (error instanceof AppError) throw error;
    logDatabaseFailure(error,'transaction');
    const message = error instanceof Error ? error.message : 'Database transaction failed';
    if (/unique|duplicate/i.test(message)) {
      throw new AppError(409, 'The requested operation conflicts with a concurrent change.', 'CONFLICT');
    }
    throw new AppError(500, 'Database transaction failed.', 'DATABASE_ERROR');
  } finally {
    client.release();
  }
}

/** Run schema setup from scripts/setup.ts without exposing a database error to the UI. */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}

