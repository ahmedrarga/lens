import { sql } from 'drizzle-orm';
import {
  bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  kind: text('kind', { enum: ['user', 'org'] }).notNull(),
  githubLogin: text('github_login').notNull(),
  createdAt: createdAt(),
}, (t) => [unique('tenants_kind_login').on(t.kind, t.githubLogin)]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
  login: text('login').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: createdAt(),
});

export const memberships = pgTable('memberships', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
}, (t) => [primaryKey({ columns: [t.userId, t.tenantId] })]);

export const sessions = pgTable('sessions', {
  /** sha256(hex) of the random cookie token; the raw token is never stored. */
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** AES-256-GCM (base64 iv|tag|ciphertext) of the user's GitHub access token. */
  encryptedGithubToken: text('encrypted_github_token').notNull(),
  createdAt: createdAt(),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

export const repos = pgTable('repos', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  private: boolean('private').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [unique('repos_tenant_owner_name').on(t.tenantId, t.owner, t.name)]);

export const analyses = pgTable('analyses', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'set null' }),
  prUrl: text('pr_url').notNull(),
  prNumber: integer('pr_number'),
  headSha: text('head_sha'),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull().default('pending'),
  progress: text('progress'),
  error: text('error'),
  graph: jsonb('graph'),
  title: text('title'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [
  index('analyses_tenant_created_idx').on(t.tenantId, t.createdAt),
  index('analyses_tenant_pr_idx').on(t.tenantId, t.prUrl),
]);
