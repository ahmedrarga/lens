import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalysisRecord, AnalysisStore } from '@lens/core';

/** AnalysisRecord plus optional extra fields the UI tolerates. */
export type StoredRecord = AnalysisRecord & { progress?: string };

const ID_RE = /^[A-Za-z0-9-]+$/;

export function defaultDataDir(): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return process.env.LENS_DATA_DIR ?? join(repoRoot, '.data');
}

/** One JSON file per analysis, written atomically (tmp + rename). Postgres replaces this in M2. */
export function createFileStore(dir: string = defaultDataDir()): AnalysisStore {
  const root = join(dir, 'analyses');
  const fileOf = (id: string) => join(root, `${id}.json`);

  async function write(rec: StoredRecord): Promise<void> {
    await mkdir(root, { recursive: true });
    const tmp = `${fileOf(rec.id)}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(rec));
    await rename(tmp, fileOf(rec.id));
  }

  async function get(id: string): Promise<StoredRecord | null> {
    if (!ID_RE.test(id)) return null;
    try {
      return JSON.parse(await readFile(fileOf(id), 'utf8')) as StoredRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  return {
    async create(prUrl) {
      const now = new Date().toISOString();
      const rec: StoredRecord = { id: randomUUID(), prUrl, status: 'pending', createdAt: now, updatedAt: now };
      await write(rec);
      return rec;
    },
    async update(id, patch) {
      const cur = await get(id);
      if (!cur) throw new Error(`Analysis ${id} not found`);
      const next = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() };
      await write(next);
      return next;
    },
    get,
    async list(limit = 20) {
      let names: string[] = [];
      try {
        names = (await readdir(root)).filter((n) => n.endsWith('.json'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const recs = (await Promise.all(names.map((n) => get(n.slice(0, -5))))).filter((r): r is StoredRecord => !!r);
      return recs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
  };
}
