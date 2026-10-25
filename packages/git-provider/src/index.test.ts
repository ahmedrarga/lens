import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createGitHubProvider, mapStatus, parsePrUrl } from './index.js';
import { untar } from './tar.js';

function header(name: string, size: number, type = '0', prefix = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write(size.toString(8).padStart(11, '0'), 124);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write(prefix, 345);
  return h;
}
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
const entry = (name: string, content: string | Buffer, type = '0', prefix = '') => {
  const b = Buffer.from(content);
  return Buffer.concat([header(name, b.length, type, prefix), pad(b)]);
};
const tar = (...e: Buffer[]) => Buffer.concat([...e, Buffer.alloc(1024)]);
const stream = async function* (b: Buffer, n = 700) { for (let i = 0; i < b.length; i += n) yield b.subarray(i, i + n); };

describe('parsePrUrl', () => {
  it.each([
    ['https://github.com/o/r/pull/123', 123],
    ['https://github.com/o/r/pull/123/files?w=1#diff-abc', 123],
    ['o/r#45', 45],
  ])('%s', (url, number) => {
    expect(parsePrUrl(url)).toEqual({ owner: 'o', repo: 'r', number });
  });
  it('throws on junk', () => {
    expect(() => parsePrUrl('https://github.com/o/r/issues/1')).toThrow(/Invalid PR/);
  });
});

it('mapStatus', () => {
  expect(['added', 'removed', 'renamed', 'modified', 'changed', 'copied'].map(mapStatus))
    .toEqual(['added', 'removed', 'renamed', 'modified', 'modified', 'modified']);
});

describe('untar', () => {
  it('reads files, pax and GNU long names, skipping unwanted data', async () => {
    const long = 'repo-sha/' + 'd/'.repeat(80) + 'long.ts';
    const rec = 'path=repo-sha/pax.ts\n';
    const paxBody = `${rec.length + 3} ${rec}`;
    expect(paxBody.length).toBe(Number(paxBody.split(' ')[0]));
    const t = tar(
      entry('repo-sha/a.ts', 'A'.repeat(1000)),
      entry('././@LongLink', long + '\0', 'L'),
      entry('x', 'long'),
      entry('PaxHeader', paxBody, 'x'),
      entry('x', 'pax'),
      entry('skip.bin', 'zzz'),
      entry('pre.ts', 'p', '0', 'repo-sha/dir'),
    );
    const got: Record<string, string | null> = {};
    for await (const e of untar(stream(t), (e) => e.path !== 'skip.bin')) got[e.path] = e.data?.toString() ?? null;
    expect(got).toEqual({
      'repo-sha/a.ts': 'A'.repeat(1000),
      [long]: 'long',
      'repo-sha/pax.ts': 'pax',
      'skip.bin': null,
      'repo-sha/dir/pre.ts': 'p',
    });
  });
});

describe('getSourceFiles', () => {
  it('strips the top dir, filters, skips dirs/binary/large', async () => {
    const t = gzipSync(tar(
      entry('repo-sha/', '', '5'),
      entry('repo-sha/src/a.ts', 'const a = 1;'),
      entry('repo-sha/src/b.js', 'nope'),
      entry('repo-sha/src/bin.ts', Buffer.from([1, 0, 2])),
      entry('repo-sha/src/big.ts', 'x'.repeat(100)),
      entry('repo-sha/src/link.ts', '', '2'),
    ));
    let url = '';
    const fakeFetch = (async (u: string) => { url = u; return new Response(t); }) as unknown as typeof fetch;
    const p = createGitHubProvider({ token: 't', fetch: fakeFetch });
    const files = await p.getSourceFiles({ owner: 'o', repo: 'r' }, 'sha', (f) => f.endsWith('.ts'), { maxFileBytes: 50 });
    expect(url).toBe('https://codeload.github.com/o/r/tar.gz/sha');
    expect([...files]).toEqual([['src/a.ts', 'const a = 1;']]);
  });
});

describe('errors and API mapping', () => {
  const mk = (res: Response) => createGitHubProvider({ token: '', fetch: (async () => res) as unknown as typeof fetch });
  it('404 hints at GITHUB_TOKEN', async () => {
    await expect(mk(new Response('', { status: 404 })).getPr('o/r#1')).rejects.toThrow(/GITHUB_TOKEN/);
  });
  it('403 includes reset time', async () => {
    const res = new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' } });
    await expect(mk(res).getPr('o/r#1')).rejects.toThrow(/2023-11-14T22:13:20/);
  });
  it('listFiles maps fields', async () => {
    const body = [{ filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed', additions: 1, deletions: 2, patch: '@@ -1 +1 @@' },
      { filename: 'c.ts', status: 'changed', additions: 0, deletions: 0 }];
    const files = await mk(Response.json(body)).listFiles({ owner: 'o', repo: 'r', number: 1 } as any);
    expect(files).toEqual([
      { path: 'b.ts', oldPath: 'a.ts', status: 'renamed', additions: 1, deletions: 2, patch: '@@ -1 +1 @@' },
      { path: 'c.ts', status: 'modified', additions: 0, deletions: 0 },
    ]);
  });
  it('getFile: 404 null, binary null, encodes path', async () => {
    let url = '';
    const f = (r: Response) => createGitHubProvider({ fetch: (async (u: string) => { url = u; return r; }) as unknown as typeof fetch });
    expect(await f(new Response('', { status: 404 })).getFile({ owner: 'o', repo: 'r' }, 'a b/c#.ts', 's')).toBeNull();
    expect(url).toBe('https://raw.githubusercontent.com/o/r/s/a%20b/c%23.ts');
    expect(await f(new Response(Buffer.from([65, 0]))).getFile({ owner: 'o', repo: 'r' }, 'x', 's')).toBeNull();
    expect(await f(new Response('hi')).getFile({ owner: 'o', repo: 'r' }, 'x', 's')).toBe('hi');
  });
});
