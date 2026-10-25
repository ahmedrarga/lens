import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(databaseUrl: string, opts: { max?: number } = {}): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: opts.max ?? 10 });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

async function inTx<T>(pool: Pool, setting: string, value: string, fn: (c: Client) => Promise<T>): Promise<T> {
  if (!isUuid(value)) throw new Error(`Invalid ${setting}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(..., is_local = true) == SET LOCAL, but accepts a bind parameter (no string interpolation).
    await client.query('SELECT set_config($1, $2, true)', [setting, value]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Run `fn` in a transaction with `app.tenant_id` set, so RLS scopes every query to this tenant. */
export const withTenant = <T>(pool: Pool, tenantId: string, fn: (c: Client) => Promise<T>) =>
  inTx(pool, 'app.tenant_id', tenantId, fn);

/** Transaction with `app.user_id` set (lets a user see their own memberships before a tenant is chosen). */
export const withUser = <T>(pool: Pool, userId: string, fn: (c: Client) => Promise<T>) =>
  inTx(pool, 'app.user_id', userId, fn);
