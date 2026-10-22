-- Non-superuser role the app connects as. RLS does not apply to superusers / BYPASSRLS roles,
-- so the app must never connect as the owner. CHANGE THE PASSWORD in any shared environment:
--   ALTER ROLE lens_app PASSWORD '...';
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lens_app') THEN
    CREATE ROLE lens_app LOGIN PASSWORD 'lens_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO lens_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, memberships, sessions, repos, analyses TO lens_app;
--> statement-breakpoint
ALTER TABLE repos ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE repos FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON repos
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE analyses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON analyses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- memberships are visible within a tenant context, or to the user themself (app.user_id) at login.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_or_self ON memberships
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
