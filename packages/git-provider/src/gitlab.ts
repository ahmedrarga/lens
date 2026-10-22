import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { GitProvider, PrFile, PrRef } from '@lens/core';
import { untar } from './tar.js';

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const MAX_GET_FILE_BYTES = 1024 * 1024;
const MAX_PAGES = 50;

const MR_RE = /^(https?):\/\/([^/\s?#]+)\/((?:[^/\s?#]+\/)*[^/\s?#]+)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i;

export function parseGitLabUrl(input: string): { owner: string; repo: string; number: number; host: string; scheme: 'http' | 'https' } {
  const m = MR_RE.exec(input.trim());
  if (!m) {
    throw new Error(`Invalid GitLab merge request URL "${input}". Expected https://<host>/<group>/<project>/-/merge_requests/<number>`);
  }
  const segs = m[3]!.split('/');
  const repo = segs.pop()!;
  if (!segs.length) throw new Error(`Invalid GitLab merge request URL "${input}": missing namespace`);
  return {
    owner: segs.join('/'), repo, number: Number(m[4]), host: m[2]!.toLowerCase(), scheme: m[1]!.toLowerCase() as 'http' | 'https',
  };
}

/** Drop everything before the first hunk header (`diff --git`, `index`, `--- a/x`, `+++ b/x`). Hunk bodies are untouched. */
export function stripDiffHeaders(diff: string): string {
  if (diff.startsWith('@@')) return diff;
  const i = diff.search(/^@@/m);
  return i < 0 ? '' : diff.slice(i);
}

export function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+')) additions++;
    else if (l.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

const isBinary = (b: Buffer) => b.subarray(0, 8192).includes(0);

export function createGitLabProvider(
  opts: { host?: string; token?: string; fetch?: typeof fetch } = {},
): GitProvider {
  const rawHost = (opts.host ?? 'gitlab.com').trim().replace(/\/+$/, '');
  const base = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
  const host = base.replace(/^https?:\/\//i, '').toLowerCase();
  const token = opts.token ?? process.env.GITLAB_TOKEN;
  const doFetch = opts.fetch ?? fetch;

  // No custom user-agent: gitlab.com's edge answers archive downloads from unknown agents with 406.
  const headers = (): Record<string, string> => ({
    accept: '*/*',
    ...(token ? { 'private-token': token } : {}),
  });

  function fail(res: Response, what: string): never {
    if (res.status === 401) {
      throw new Error('GitLab token missing or invalid: set GITLAB_TOKEN (scopes: read_api, read_repository)');
    }
    if (res.status === 404) {
      throw new Error(`Merge request not found or no access (${what}). Check the URL, and that GITLAB_TOKEN can read this project (scopes: read_api, read_repository).`);
    }
    if (res.status === 403) throw new Error(`GitLab denied access to ${what} (403). The token may lack scopes read_api / read_repository.`);
    if (res.status === 429) throw new Error(`GitLab rate limit reached while fetching ${what}; try again later.`);
    throw new Error(`GitLab request for ${what} failed: ${res.status} ${res.statusText}`);
  }

  const get = (path: string) => doFetch(`${base}/api/v4${path}`, { headers: headers() });
  const projectId = (pr: Pick<PrRef, 'owner' | 'repo'>) => encodeURIComponent(`${pr.owner}/${pr.repo}`);

  function parsePrUrl(url: string) {
    const { owner, repo, number, host: h } = parseGitLabUrl(url);
    return { owner, repo, number, host: h };
  }

  function toFile(d: any): PrFile {
    const status: PrFile['status'] = d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified';
    const skip = d.too_large || d.collapsed;
    const patch = !skip && typeof d.diff === 'string' && d.diff ? stripDiffHeaders(d.diff) : '';
    const counts = patch ? countPatch(patch) : { additions: 0, deletions: 0 };
    return {
      path: d.new_path,
      ...(status === 'renamed' || (d.old_path && d.old_path !== d.new_path) ? { oldPath: d.old_path } : {}),
      status,
      ...counts,
      ...(patch ? { patch } : {}),
    };
  }

  return {
    parsePrUrl,

    async getPr(url) {
      const { owner, repo, number, host: h } = parseGitLabUrl(url);
      if (h !== host) throw new Error(`This GitLab provider is configured for ${host}, but the URL points to ${h}`);
      const what = `${owner}/${repo}!${number}`;
      const res = await get(`/projects/${encodeURIComponent(`${owner}/${repo}`)}/merge_requests/${number}`);
      if (!res.ok) fail(res, what);
      const mr: any = await res.json();
      const baseSha = mr.diff_refs?.base_sha ?? mr.diff_refs?.start_sha;
      const headSha = mr.diff_refs?.head_sha ?? mr.sha;
      if (!baseSha || !headSha) throw new Error(`GitLab did not return diff refs for ${what} (is the merge request empty or still being created?)`);
      return {
        provider: 'gitlab', host: h, owner, repo, number,
        url: mr.web_url ?? `${base}/${owner}/${repo}/-/merge_requests/${number}`,
        title: mr.title,
        body: mr.description ?? null,
        author: mr.author?.username ?? null,
        baseSha, headSha,
        baseRef: mr.target_branch, headRef: mr.source_branch,
      } satisfies PrRef;
    },

    async listFiles(pr) {
      const id = projectId(pr);
      const what = `files of ${pr.owner}/${pr.repo}!${pr.number}`;
      const out: PrFile[] = [];
      let page: string | null = '1';
      for (let n = 0; page && n < MAX_PAGES; n++) {
        const res = await get(`/projects/${id}/merge_requests/${pr.number}/diffs?page=${page}&per_page=100`);
        if (res.status === 404 && n === 0) {
          // Older GitLab (< 15.7): /changes returns everything in one response.
          const old = await get(`/projects/${id}/merge_requests/${pr.number}/changes`);
          if (!old.ok) fail(old, what);
          const j: any = await old.json();
          return (j.changes ?? []).map(toFile);
        }
        if (!res.ok) fail(res, what);
        for (const d of (await res.json()) as any[]) out.push(toFile(d));
        page = res.headers.get('x-next-page') || null;
      }
      return out;
    },

    async getFile(pr, path, sha) {
      const res = await get(`/projects/${projectId(pr)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(sha)}`);
      if (res.status === 404) return null;
      if (!res.ok) fail(res, `file ${path}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_GET_FILE_BYTES || isBinary(buf)) return null;
      return buf.toString('utf8');
    },

    async getSourceFiles(pr, sha, filter, o = {}) {
      const max = o.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
      const url = `/projects/${projectId(pr)}/repository/archive.tar.gz?sha=${encodeURIComponent(sha)}`;
      let res = await get(url);
      // gitlab.com rate-limits archive downloads (~5/min per user): honour Retry-After; retry transient errors.
      for (let attempt = 1; attempt < 4 && (res.status === 429 || res.status === 406 || res.status >= 500); attempt++) {
        const wait = res.status === 429 ? Math.min(Number(res.headers.get('retry-after')) || 20, 60) * 1000 : 1000 * attempt;
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, wait));
        res = await get(url);
      }
      if (!res.ok || !res.body) fail(res, `archive of ${pr.owner}/${pr.repo}@${sha}`);
      const gunzip = Readable.fromWeb(res.body as any).pipe(createGunzip());
      const files = new Map<string, string>();
      // Top-level dir is `<project>-<sha>-<sha>/` (or similar): strip whatever the first segment is.
      const rel = (p: string) => p.slice(p.indexOf('/') + 1);
      const wanted = (e: { path: string; type: string; size: number }) =>
        e.type === '0' && e.size <= max && e.path.includes('/') && filter(rel(e.path));
      for await (const e of untar(gunzip, wanted)) {
        if (!e.data || isBinary(e.data)) continue;
        files.set(rel(e.path), e.data.toString('utf8'));
      }
      return files;
    },
  };
}
