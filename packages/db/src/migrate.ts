import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../drizzle');

/** Apply SQL migrations. Use the OWNER/admin URL (it creates the `lens_app` role); not the app URL. */
export async function migrate(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await drizzleMigrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
