import { randomBytes } from 'node:crypto';
import { decryptToken, encryptToken, sha256Hex } from './crypto.js';
import { withUser, type Pool } from './tenant.js';

export interface GithubUser { id: number; login: string; name?: string | null; avatarUrl?: string | null }
export interface SessionInfo {
  userId: string;
  tenantId: string;
  user: { login: string; name: string | null; avatarUrl: string | null };
  githubToken: string;
  expiresAt: Date;
}

/** Upsert the user and their personal tenant + owner membership. Returns ids. */
export async function upsertUser(pool: Pool, gh: GithubUser): Promise<{ userId: string; tenantId: string }> {
  const u = await pool.query(
    `INSERT INTO users (github_id, login, name, avatar_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url
     RETURNING id`,
    [gh.id, gh.login, gh.name ?? null, gh.avatarUrl ?? null],
  );
  const userId: string = u.rows[0].id;
  const tenantId = await withUser(pool, userId, async (c) => {
    const ex = await c.query(
      `SELECT m.tenant_id FROM memberships m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 AND t.kind = 'user' AND m.role = 'owner' LIMIT 1`,
      [userId],
    );
    if (ex.rows[0]) return ex.rows[0].tenant_id as string;
    // A login can be reused by a different account after a rename; disambiguate rather than share a tenant.
    const t = await c.query(
      `INSERT INTO tenants (kind, github_login) VALUES ('user', $1)
       ON CONFLICT (kind, github_login) DO NOTHING RETURNING id`,
      [gh.login],
    );
    const id: string = t.rows[0]
      ? t.rows[0].id
      : (await c.query(`INSERT INTO tenants (kind, github_login) VALUES ('user', $1) RETURNING id`, [`${gh.login}~${gh.id}`])).rows[0].id;
    await c.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [userId, id]);
    return id;
  });
  return { userId, tenantId };
}

/** Returns the raw cookie token; only its sha256 is stored. */
export async function createSession(
  pool: Pool,
  o: { userId: string; githubToken: string; secret: string; ttlMs?: number },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at, encrypted_github_token) VALUES ($1, $2, $3, $4)`,
    [sha256Hex(token), o.userId, new Date(Date.now() + (o.ttlMs ?? 14 * 86400_000)), encryptToken(o.githubToken, o.secret)],
  );
  return token;
}

export async function getSession(pool: Pool, token: string, secret: string): Promise<SessionInfo | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await pool.query(
    `SELECT s.user_id, s.expires_at, s.encrypted_github_token, u.login, u.name, u.avatar_url
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [sha256Hex(token)],
  );
  const r = rows[0];
  if (!r) return null;
  if (new Date(r.expires_at).getTime() <= Date.now()) {
    await deleteSession(pool, token);
    return null;
  }
  const tenantId = await withUser(pool, r.user_id, async (c) => {
    const m = await c.query(
      `SELECT m.tenant_id FROM memberships m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 AND t.kind = 'user' AND m.role = 'owner' LIMIT 1`,
      [r.user_id],
    );
    return m.rows[0]?.tenant_id as string | undefined;
  });
  if (!tenantId) return null;
  let githubToken: string;
  try {
    githubToken = decryptToken(r.encrypted_github_token, secret);
  } catch {
    return null; // SESSION_SECRET rotated: force re-login
  }
  return {
    userId: r.user_id, tenantId, githubToken, expiresAt: new Date(r.expires_at),
    user: { login: r.login, name: r.name, avatarUrl: r.avatar_url },
  };
}

export async function deleteSession(pool: Pool, token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sha256Hex(token)]);
}

/** The single tenant used when GitHub auth is disabled (local dev with Postgres). */
export async function ensureLocalTenant(pool: Pool): Promise<string> {
  const r = await pool.query(
    `INSERT INTO tenants (kind, github_login) VALUES ('user', 'local')
     ON CONFLICT (kind, github_login) DO UPDATE SET github_login = EXCLUDED.github_login RETURNING id`,
  );
  return r.rows[0].id;
}
