import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createGitLabProvider, parseAnyPrUrl, providerForUrl, stripDiffHeaders } from './index.js';

const j = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function mockFetch(routes: (url: URL, init?: RequestInit) => Response | undefined) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string> });
    return routes(url, init) ?? new Response('nf', { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('parseAnyPrUrl', () => {
  it.each([
    ['https://gitlab.com/g/p/-/merge_requests/12', { provider: 'gitlab', owner: 'g', repo: 'p', number: 12, host: 'gitlab.com' }],
    ['https://gitlab.com/a/b/c/p/-/merge_requests/3/diffs?x=1#n', { provider: 'gitlab', owner: 'a/b/c', repo: 'p', number: 3, host: 'gitlab.com' }],
    ['https://git.corp.io:8443/team/app/-/merge_requests/9/', { provider: 'gitlab', owner: 'team', repo: 'app', number: 9, host: 'git.corp.io:8443' }],
    ['https://github.com/o/r/pull/5/files', { provider: 'github', owner: 'o', repo: 'r', number: 5, host: 'github.com' }],
    ['o/r#7', { provider: 'github', owner: 'o', repo: 'r', number: 7, host: 'github.com' }],
  ])('%s', (url, want) => expect(parseAnyPrUrl(url)).toEqual(want));

  it('rejects others helpfully', () => {
    expect(() => parseAnyPrUrl('https://example.com/x')).toThrow(/merge_requests/);
    expect(() => parseAnyPrUrl('https://gitlab.com/-/merge_requests/1')).toThrow();
  });
});

describe('providerForUrl', () => {
  it('routes GitHub to api.github.com and GitLab to its host with PRIVATE-TOKEN', async () => {
    const { fn, calls } = mockFetch((u) => {
      if (u.host === 'api.github.com') return j({ title: 'T', user: { login: 'u' }, base: { sha: 'b', ref: 'main' }, head: { sha: 'h', ref: 'f' } });
      return j({ title: 'M', description: null, author: { username: 'bob' }, diff_refs: { base_sha: 'b1', head_sha: 'h1' }, source_branch: 'f', target_branch: 'main', web_url: 'https://git.corp.io/a/b/p/-/merge_requests/4' });
    });
    const gh = await providerForUrl('o/r#1', { fetch: fn, githubToken: 'x' }).getPr('o/r#1');
    expect(gh).toMatchObject({ provider: 'github', host: 'github.com' });
    const gl = await providerForUrl('https://git.corp.io/a/b/p/-/merge_requests/4', { fetch: fn, gitlabToken: 'sekret' })
      .getPr('https://git.corp.io/a/b/p/-/merge_requests/4');
    expect(gl).toEqual({
      provider: 'gitlab', host: 'git.corp.io', owner: 'a/b', repo: 'p', number: 4, url: 'https://git.corp.io/a/b/p/-/merge_requests/4',
      title: 'M', body: null, author: 'bob', baseSha: 'b1', headSha: 'h1', baseRef: 'main', headRef: 'f',
    });
    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('https://git.corp.io/api/v4/projects/a%2Fb%2Fp/merge_requests/4');
    expect(last.headers['private-token']).toBe('sekret');
  });
});

describe('gitlab listFiles', () => {
  const pr = { owner: 'g', repo: 'p', number: 1 } as any;
  const d = (o: object) => ({ old_path: 'a.ts', new_path: 'a.ts', new_file: false, deleted_file: false, renamed_file: false, diff: '', ...o });

  it('paginates, maps statuses, strips headers, counts', async () => {
    const { fn } = mockFetch((u) => {
      if (!u.pathname.endsWith('/diffs')) return undefined;
      if (u.searchParams.get('page') === '1') {
        return j([
          d({ new_path: 'n.ts', old_path: 'n.ts', new_file: true, diff: '--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n' }),
          d({ new_path: 'gone.ts', old_path: 'gone.ts', deleted_file: true, diff: '@@ -1 +0,0 @@\n-x\n' }),
        ], { headers: { 'x-next-page': '2' } });
      }
      return j([
        d({ new_path: 'new.ts', old_path: 'old.ts', renamed_file: true, diff: '' }),
        d({ new_path: 'big.ts', too_large: true, diff: '@@ -1 +1 @@\n-a\n+b\n' }),
        d({ new_path: 'm.ts', diff: '@@ -1,2 +1,2 @@\n--- removed line starting with dashes\n+++ added\n ctx\n\\ No newline at end of file\n' }),
      ], { headers: { 'x-next-page': '' } });
    });
    const files = await createGitLabProvider({ fetch: fn, token: 't' }).listFiles(pr);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['n.ts', 'added', 2, 0], ['gone.ts', 'removed', 0, 1], ['new.ts', 'renamed', 0, 0], ['big.ts', 'modified', 0, 0], ['m.ts', 'modified', 1, 1],
    ]);
    expect(files[0]!.patch).toBe('@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(files[2]).toMatchObject({ oldPath: 'old.ts' });
    expect(files[3]!.patch).toBeUndefined();
    expect(files[4]!.patch).toContain('--- removed line'); // in-hunk lines untouched
  });

  it('falls back to /changes on old GitLab', async () => {
    const { fn } = mockFetch((u) =>
      u.pathname.endsWith('/changes') ? j({ changes: [d({ diff: '@@ -1 +1 @@\n-a\n+b\n' })] }) : undefined);
    const files = await createGitLabProvider({ fetch: fn }).listFiles(pr);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('stripDiffHeaders', () => {
    expect(stripDiffHeaders('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toBe('@@ -1 +1 @@\n-a\n+b');
    expect(stripDiffHeaders('Binary files differ')).toBe('');
  });
});

describe('gitlab errors, getFile, archive', () => {
  const pr = { owner: 'g/sub', repo: 'p', number: 1 } as any;

  it('maps 401 and 404', async () => {
    const p401 = createGitLabProvider({ fetch: mockFetch(() => new Response('', { status: 401 })).fn });
    await expect(p401.getPr('https://gitlab.com/g/p/-/merge_requests/1')).rejects.toThrow(/GITLAB_TOKEN/);
    const p404 = createGitLabProvider({ fetch: mockFetch(() => undefined).fn });
    await expect(p404.getPr('https://gitlab.com/g/p/-/merge_requests/1')).rejects.toThrow(/not found or no access/);
  });

  it('getFile encodes path, 404 -> null, binary -> null', async () => {
    const { fn, calls } = mockFetch((u) => {
      if (u.pathname.includes('bin.png')) return new Response(Buffer.from([1, 0, 2]));
      if (u.pathname.includes('src%2Fa.ts')) return new Response('hello');
      return undefined;
    });
    const p = createGitLabProvider({ fetch: fn });
    expect(await p.getFile(pr, 'src/a.ts', 'abc')).toBe('hello');
    expect(calls[0]!.url).toContain('/projects/g%2Fsub%2Fp/repository/files/src%2Fa.ts/raw?ref=abc');
    expect(await p.getFile(pr, 'missing.ts', 'abc')).toBeNull();
    expect(await p.getFile(pr, 'bin.png', 'abc')).toBeNull();
  });

  it('getSourceFiles strips the top-level dir', async () => {
    const blk = (name: string, content: string) => {
      const b = Buffer.from(content);
      const h = Buffer.alloc(512);
      h.write(name, 0); h.write(b.length.toString(8).padStart(11, '0'), 124); h.write('0', 156); h.write('ustar\0', 257);
      return Buffer.concat([h, b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
    };
    const tgz = gzipSync(Buffer.concat([blk('p-abc-abc/src/a.ts', 'A'), blk('p-abc-abc/README.md', 'R'), Buffer.alloc(1024)]));
    const { fn, calls } = mockFetch(() => new Response(tgz));
    const files = await createGitLabProvider({ fetch: fn }).getSourceFiles(pr, 'abc', (p) => p.endsWith('.ts'));
    expect([...files.entries()]).toEqual([['src/a.ts', 'A']]);
    expect(calls[0]!.url).toContain('/repository/archive.tar.gz?sha=abc');
  });
});
