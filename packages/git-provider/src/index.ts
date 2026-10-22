import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { GitProvider, PrFile, PrRef } from '@lens/core';
import { untar } from './tar.js';

export { untar } from './tar.js';

const API = 'https://api.github.com';
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const MAX_GET_FILE_BYTES = 1024 * 1024;

export function parsePrUrl(input: string): { owner: string; repo: string; number: number } {
  const s = input.trim();
  const m =
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(s) ??
    /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Error(`Invalid PR reference "${input}". Expected https://github.com/owner/repo/pull/123 or owner/repo#123`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export function mapStatus(status: string): PrFile['status'] {
  switch (status) {
    case 'added': case 'removed': case 'renamed': return status;
    default: return 'modified'; // modified, changed, copied, unchanged
  }
}

const isBinary = (b: Buffer) => b.subarray(0, 8192).includes(0);

export function createGitHubProvider(opts: { token?: string; fetch?: typeof fetch } = {}): GitProvider {
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const doFetch = opts.fetch ?? fetch;

  const headers = (extra: Record<string, string> = {}) => ({
    'user-agent': 'lens-code-review',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  function fail(res: Response, what: string): never {
    if (res.status === 404) {
      throw new Error(`${what} not found (404). It may not exist or be private${token ? ' or your token lacks access' : '; set GITHUB_TOKEN to access private repos'}.`);
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      let msg = `GitHub denied the request for ${what} (${res.status}).`;
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        msg += ` Rate limit exhausted${reset ? `, resets at ${new Date(reset * 1000).toISOString()}` : ''}.`;
        if (!token) msg += ' Set GITHUB_TOKEN for a higher limit.';
      } else if (res.status === 401) msg += ' The token is invalid or expired.';
      throw new Error(msg);
    }
    throw new Error(`GitHub request for ${what} failed: ${res.status} ${res.statusText}`);
  }

  async function api<T>(path: string, what: string): Promise<T> {
    const res = await doFetch(`${API}${path}`, { headers: headers({ accept: 'application/vnd.github+json' }) });
    if (!res.ok) fail(res, what);
    return (await res.json()) as T;
  }

  const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

  return {
    parsePrUrl,

    async getPr(url) {
      const { owner, repo, number } = parsePrUrl(url);
      const pr = await api<any>(`/repos/${owner}/${repo}/pulls/${number}`, `PR ${owner}/${repo}#${number}`);
      const ref: PrRef = {
        provider: 'github', owner, repo, number,
        url: `https://github.com/${owner}/${repo}/pull/${number}`,
        title: pr.title,
        body: pr.body ?? null,
        author: pr.user?.login ?? null,
        baseSha: pr.base.sha, headSha: pr.head.sha,
        baseRef: pr.base.ref, headRef: pr.head.ref,
      };
      return ref;
    },

    async listFiles(pr) {
      const out: PrFile[] = [];
      for (let page = 1; page <= 30; page++) { // GitHub caps at 3000 files
        const batch = await api<any[]>(
          `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`,
          `files of ${pr.owner}/${pr.repo}#${pr.number}`,
        );
        for (const f of batch) {
          out.push({
            path: f.filename,
            ...(f.previous_filename ? { oldPath: f.previous_filename } : {}),
            status: mapStatus(f.status),
            additions: f.additions ?? 0,
            deletions: f.deletions ?? 0,
            ...(f.patch ? { patch: f.patch } : {}),
          });
        }
        if (batch.length < 100) break;
      }
      return out;
    },

    async getFile(pr, path, sha) {
      const url = `https://raw.githubusercontent.com/${pr.owner}/${pr.repo}/${sha}/${encPath(path)}`;
      const res = await doFetch(url, { headers: headers() });
      if (res.status === 404) return null;
      if (!res.ok) fail(res, `file ${path}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_GET_FILE_BYTES || isBinary(buf)) return null;
      return buf.toString('utf8');
    },

    async getSourceFiles(pr, sha, filter, o = {}) {
      const max = o.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
      const res = await doFetch(`https://codeload.github.com/${pr.owner}/${pr.repo}/tar.gz/${sha}`, {
        headers: headers(), redirect: 'follow',
      });
      if (!res.ok || !res.body) fail(res, `archive of ${pr.owner}/${pr.repo}@${sha}`);
      const gunzip = Readable.fromWeb(res.body as any).pipe(createGunzip());
      const files = new Map<string, string>();
      const rel = (p: string) => p.slice(p.indexOf('/') + 1);
      const wanted = (e: { path: string; type: string; size: number }) =>
        (e.type === '0') && e.size <= max && e.path.includes('/') && filter(rel(e.path));
      for await (const e of untar(gunzip, wanted)) {
        if (!e.data || isBinary(e.data)) continue;
        files.set(rel(e.path), e.data.toString('utf8'));
      }
      return files;
    },
  };
}
