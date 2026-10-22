import { createTtlCache } from './queue.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface GitHubClient {
  /** GET a GitHub API path with the given token. Throws GitHubError on non-2xx. Never logs the token. */
  get<T>(path: string, token?: string): Promise<T>;
  /** Can this token read owner/repo? Cached per (user, repo) for 5 minutes. Throws only on transient errors. */
  canRead(cacheUser: string, owner: string, repo: string, token?: string): Promise<boolean>;
}

export function createGitHubClient(opts: { fetch?: typeof fetch; now?: () => number; cacheTtlMs?: number } = {}): GitHubClient {
  const doFetch = opts.fetch ?? fetch;
  const cache = createTtlCache<boolean>(opts.cacheTtlMs ?? 5 * 60_000, opts.now);

  async function get<T>(path: string, token?: string): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'lens-code-review',
          'x-github-api-version': '2022-11-28',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      throw new GitHubError(502, 'Could not reach GitHub');
    }
    if (!res.ok) {
      const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
      throw new GitHubError(limited ? 429 : res.status, `GitHub request failed (${res.status})`);
    }
    return (await res.json()) as T;
  }

  return {
    get,
    async canRead(cacheUser, owner, repo, token) {
      const key = `${cacheUser}\0${owner}/${repo}`.toLowerCase();
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      let ok: boolean;
      try {
        await get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
        ok = true;
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 404 || e.status === 403 || e.status === 401)) ok = false;
        else throw e; // 5xx / rate limit / network: do not cache a denial
      }
      cache.set(key, ok);
      return ok;
    },
  };
}
