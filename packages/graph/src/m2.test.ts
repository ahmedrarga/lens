import { describe, expect, it } from 'vitest';
import {
  ChangeGraph, type BuildGraphInput, type CollapsedSummary, type HunkNoise, type NoiseResult, type ParsedHunk, type PrFile, type PrRef,
} from '@lens/core';
import { createTsIndexer } from '../../indexer/src/index.js';
import { assertCoverage, buildGraph, suggestedFocus } from './index.js';

const pr: PrRef = {
  provider: 'github', owner: 'o', repo: 'r', number: 1, url: 'u', title: 't', body: null, author: null,
  baseSha: 'b', headSha: 'h', baseRef: 'main', headRef: 'feat',
};
function hunk(id: string, path: string, oldStart: number, newStart: number, body: string[]): ParsedHunk {
  const added = body.filter((l) => l[0] === '+').length;
  const removed = body.filter((l) => l[0] === '-').length;
  const oldLines = body.length - added;
  const newLines = body.length - removed;
  return { id, path, oldStart, oldLines, newStart, newLines, added, removed, patch: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${body.join('\n')}` };
}
const file = (path: string, status: PrFile['status'], additions: number, deletions: number): PrFile => ({ path, status, additions, deletions });
const summary = (id: string, kind: CollapsedSummary['kind'], hunks: ParsedHunk[], extra: Partial<CollapsedSummary> = {}): CollapsedSummary => ({
  id, kind, label: `${kind} label`, hunkIds: hunks.map((h) => h.id), files: [...new Set(hunks.map((h) => h.path))],
  added: hunks.reduce((n, h) => n + h.added, 0), removed: hunks.reduce((n, h) => n + h.removed, 0), verified: true, ...extra,
});
const noiseOf = (collapsed: CollapsedSummary[], hunkIds: string[]): NoiseResult => ({
  hunkNoise: new Map<string, HunkNoise>(hunkIds.map((id) => [id, { kind: collapsed.find((c) => c.hunkIds.includes(id))!.kind }])),
  collapsed,
});

async function build(base: Record<string, string>, head: Record<string, string>, files: PrFile[], hunks: ParsedHunk[], noise?: NoiseResult) {
  const idx = createTsIndexer();
  const input: BuildGraphInput = {
    pr, files, hunks, skippedFiles: [], limits: [], durationMs: 1, ...(noise ? { noise } : {}),
    head: await idx.index({ files: new Map(Object.entries(head)) }),
    base: await idx.index({ files: new Map(Object.entries(base)) }),
  };
  const g = buildGraph(input, { now: () => new Date(0) });
  expect(() => ChangeGraph.parse(g)).not.toThrow();
  expect(assertCoverage(g)).toEqual([]);
  return g;
}
const node = (g: ChangeGraph, id: string) => g.nodes.find((n) => n.id === id);
const fn = (n: string, body: string) => `export function ${n}() {\n  return ${body};\n}\n`;
const edit = (id: string, path: string) => hunk(id, path, 2, 2, ['-  return 1;', '+  return 2;']);

describe('noise integration', () => {
  it('noise-only symbol disappears; group nodes live under ~collapsed', async () => {
    const hs = [edit('n1', 'src/a.ts'), edit('r1', 'src/b.ts')];
    const noise = noiseOf([summary('collapsed:formatting', 'formatting', [hs[0]!])], ['n1']);
    const g = await build(
      { 'src/a.ts': fn('a', '1'), 'src/b.ts': fn('b', '1') }, { 'src/a.ts': fn('a', '2'), 'src/b.ts': fn('b', '2') },
      [file('src/a.ts', 'modified', 1, 1), file('src/b.ts', 'modified', 1, 1)], hs, noise,
    );
    expect(node(g, 'symbol:src/a.ts#a')).toBeUndefined();
    expect(node(g, 'file:src/a.ts')).toBeUndefined();
    expect(node(g, 'symbol:src/b.ts#b')).toMatchObject({ stats: { added: 1, removed: 1 } });
    expect(node(g, 'group:collapsed:formatting')).toMatchObject({
      kind: 'group', level: 2, state: 'modified', collapsedId: 'collapsed:formatting', parent: 'cluster:~collapsed:formatting', stats: { added: 1, removed: 1 },
    });
    expect(node(g, 'cluster:~collapsed:formatting')).toMatchObject({ kind: 'cluster', level: 1, label: 'Formatting', parent: 'module:~collapsed' });
    expect(node(g, 'module:~collapsed')).toMatchObject({ kind: 'module', level: 0, label: 'Collapsed changes' });
    const h = g.hunks.find((x) => x.id === 'n1')!;
    expect(h.owner).toBe('group:collapsed:formatting');
    expect(h.noise).toEqual({ kind: 'formatting' });
    expect(g.hunks.find((x) => x.id === 'r1')!.noise).toBeUndefined();
    expect(g.collapsed).toEqual(noise.collapsed);
  });

  it('mixed symbol keeps only real-change stats', async () => {
    const base = `export function m() {\n  const a = 1;\n  return 1;\n}\n`;
    const head = `export function m() {\n  const a  =  1;\n  return 2;\n}\n`;
    const hs = [hunk('n1', 'src/m.ts', 2, 2, ['-  const a = 1;', '+  const a  =  1;']), hunk('r1', 'src/m.ts', 3, 3, ['-  return 1;', '+  return 2;'])];
    const g = await build({ 'src/m.ts': base }, { 'src/m.ts': head }, [file('src/m.ts', 'modified', 2, 2)], hs,
      noiseOf([summary('collapsed:formatting', 'formatting', [hs[0]!])], ['n1']));
    expect(node(g, 'symbol:src/m.ts#m')!.stats).toEqual({ added: 1, removed: 1 });
    expect(g.hunks.find((x) => x.id === 'r1')!.owner).toBe('symbol:src/m.ts#m');
  });

  it('outlier hunks stay real and get a note', async () => {
    const hs = [edit('m1', 'src/a.ts'), edit('o1', 'src/b.ts')];
    const noise = noiseOf([summary('collapsed:mechanical:x', 'mechanical', hs, { outlierHunkIds: ['o1'] })], ['m1']);
    const g = await build(
      { 'src/a.ts': fn('a', '1'), 'src/b.ts': fn('b', '1') }, { 'src/a.ts': fn('a', '2'), 'src/b.ts': fn('b', '2') },
      [file('src/a.ts', 'modified', 1, 1), file('src/b.ts', 'modified', 1, 1)], hs, noise,
    );
    expect(g.hunks.find((x) => x.id === 'o1')).toMatchObject({ owner: 'symbol:src/b.ts#b' });
    expect(node(g, 'symbol:src/b.ts#b')!.notes).toEqual(['Deviates from mechanical pattern: mechanical label']);
    expect(node(g, 'cluster:~collapsed:mechanical')!.label).toBe('Mechanical edits');
  });

  it('noise on a non-code file (lockfile) is covered by a group', async () => {
    const lock = hunk('l1', 'package-lock.json', 1, 1, ['-a', '+b']);
    const g = await build({}, {}, [file('package-lock.json', 'modified', 1, 1)], [lock],
      noiseOf([summary('collapsed:lockfile', 'lockfile', [lock])], ['l1']));
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['cluster:~collapsed:lockfile', 'group:collapsed:lockfile', 'module:~collapsed']);
    expect(suggestedFocus(g)).toEqual({ level: 0 });
  });
});

describe('clustering', () => {
  it('test files join the cluster of the code they call, across modules', async () => {
    const lib = fn('sub', '1');
    const libH = fn('sub', '2');
    const t = (v: string) => `import { sub } from '../../lib/core/s';\nexport function check() {\n  return sub() + ${v};\n}\n`;
    const g = await build(
      { 'lib/core/s.ts': lib, 'tests/unit/s.test.ts': t('1') }, { 'lib/core/s.ts': libH, 'tests/unit/s.test.ts': t('2') },
      [file('lib/core/s.ts', 'modified', 1, 1), file('tests/unit/s.test.ts', 'modified', 1, 1)],
      [edit('h1', 'lib/core/s.ts'), hunk('h2', 'tests/unit/s.test.ts', 3, 3, ['-  return sub() + 1;', '+  return sub() + 2;'])],
    );
    const sub = node(g, 'symbol:lib/core/s.ts#sub')!;
    const chk = node(g, 'symbol:tests/unit/s.test.ts#check')!;
    expect(chk.parent).toBe(sub.parent);
    expect(node(g, sub.parent!)).toMatchObject({ parent: 'module:lib/core', label: 'sub (+1)' });
    expect(node(g, 'module:tests/unit')).toBeUndefined();
  });

  it('unlinked tests group by directory', async () => {
    const g = await build(
      { 'x/tests/a.test.ts': fn('ta', '1'), 'x/tests/b.spec.ts': fn('tb', '1') },
      { 'x/tests/a.test.ts': fn('ta', '2'), 'x/tests/b.spec.ts': fn('tb', '2') },
      [file('x/tests/a.test.ts', 'modified', 1, 1), file('x/tests/b.spec.ts', 'modified', 1, 1)],
      [edit('h1', 'x/tests/a.test.ts'), edit('h2', 'x/tests/b.spec.ts')],
    );
    expect(g.nodes.filter((n) => n.kind === 'cluster').map((n) => n.label)).toEqual(['Tests: x/tests']);
  });

  it('symbols sharing a newly added symbol join one cluster', async () => {
    const helper = `export function helper() {\n  return 1;\n}\n`;
    const user = (n: string, v: string) => `import { helper } from '../../../lib/helper';\nexport function ${n}() {\n  return ${v};\n}\n`;
    const mk = (withHelper: boolean) => ({
      'src/m/a/p.ts': user('p', withHelper ? 'helper()' : '1'), 'src/m/b/q.ts': user('q', withHelper ? 'helper()' : '1'),
      ...(withHelper ? { 'lib/helper.ts': helper } : {}),
    });
    const edits = (id: string, path: string) => hunk(id, path, 3, 3, ['-  return 1;', '+  return helper();']);
    const g = await build(mk(false), mk(true),
      [file('src/m/a/p.ts', 'modified', 1, 1), file('src/m/b/q.ts', 'modified', 1, 1), file('lib/helper.ts', 'added', 3, 0)],
      [edits('hp', 'src/m/a/p.ts'), edits('hq', 'src/m/b/q.ts'), hunk('hh', 'lib/helper.ts', 0, 1, ['+export function helper() {', '+  return 1;', '+}'])],
    );
    expect(node(g, 'symbol:src/m/a/p.ts#p')!.parent).toBe(node(g, 'symbol:src/m/b/q.ts#q')!.parent);
  });

  it('caps clusters per module and merges by directory', async () => {
    // 4 dirs -> 4 singleton clusters in module src/app; use 12 dirs to exceed cap
    const b3: Record<string, string> = {}, h3: Record<string, string> = {};
    const f3: PrFile[] = [], hk3: ParsedHunk[] = [];
    for (let i = 0; i < 12; i++) {
      const p = `src/app/s${i}/f${i}.ts`;
      b3[p] = fn(`f${i}`, '1'); h3[p] = fn(`f${i}`, '2');
      f3.push(file(p, 'modified', 1, 1)); hk3.push(edit(`h${i}`, p));
    }
    const g = await build(b3, h3, f3, hk3);
    const clusters = g.nodes.filter((n) => n.kind === 'cluster' && n.parent === 'module:src/app');
    expect(clusters.length).toBe(8);
    expect(clusters.reduce((n, c) => n + 1 + Number(/\(\+(\d+)\)/.exec(c.label)?.[1] ?? 0), 0)).toBe(12);
  });
});

describe('top-level ghost callers', () => {
  it('emits the caller file as a ghost', async () => {
    const routes = `import { handler } from './handler';\nexport const x = 1;\nregister('/x', handler);\ndeclare function register(a: string, b: unknown): void;\n`;
    const g = await build(
      { 'api/handler.ts': fn('handler', '1'), 'api/routes.ts': routes }, { 'api/handler.ts': fn('handler', '2'), 'api/routes.ts': routes },
      [file('api/handler.ts', 'modified', 1, 1)], [edit('h1', 'api/handler.ts')],
    );
    expect(node(g, 'file:api/routes.ts')).toMatchObject({ kind: 'file', state: 'unchanged', label: 'api/routes.ts (top-level)', parent: 'module:api' });
    expect(g.edges.some((e) => e.from === 'file:api/routes.ts' && e.to === 'symbol:api/handler.ts#handler')).toBe(true);
  });
});

describe('suggestedFocus', () => {
  it('drills down on small PRs', async () => {
    const one = await build({ 'src/a.ts': fn('a', '1') }, { 'src/a.ts': fn('a', '2') }, [file('src/a.ts', 'modified', 1, 1)], [edit('h', 'src/a.ts')]);
    expect(suggestedFocus(one)).toEqual({ level: 2, parentId: 'cluster:src:src-a.ts-a' });
    const two = await build(
      { 'src/x/a.ts': fn('a', '1'), 'src/x/sub/b.ts': fn('b', '1') }, { 'src/x/a.ts': fn('a', '2'), 'src/x/sub/b.ts': fn('b', '2') },
      [file('src/x/a.ts', 'modified', 1, 1), file('src/x/sub/b.ts', 'modified', 1, 1)], [edit('h1', 'src/x/a.ts'), edit('h2', 'src/x/sub/b.ts')],
    );
    expect(suggestedFocus(two)).toEqual({ level: 1, parentId: 'module:src/x' });
    const multi = await build(
      { 'a/x/a.ts': fn('a', '1'), 'b/y/b.ts': fn('b', '1') }, { 'a/x/a.ts': fn('a', '2'), 'b/y/b.ts': fn('b', '2') },
      [file('a/x/a.ts', 'modified', 1, 1), file('b/y/b.ts', 'modified', 1, 1)], [edit('h1', 'a/x/a.ts'), edit('h2', 'b/y/b.ts')],
    );
    expect(suggestedFocus(multi)).toEqual({ level: 0 });
  });

  it('ignores the collapsed module', async () => {
    const hs = [edit('n1', 'src/a.ts'), edit('r1', 'src/b.ts')];
    const g = await build(
      { 'src/a.ts': fn('a', '1'), 'src/b.ts': fn('b', '1') }, { 'src/a.ts': fn('a', '2'), 'src/b.ts': fn('b', '2') },
      [file('src/a.ts', 'modified', 1, 1), file('src/b.ts', 'modified', 1, 1)], hs,
      noiseOf([summary('collapsed:formatting', 'formatting', [hs[0]!])], ['n1']),
    );
    expect(suggestedFocus(g)).toEqual({ level: 2, parentId: 'cluster:src:src-b.ts-b' });
  });
});

describe('determinism with noise', () => {
  it('same input, same output', async () => {
    const hs = [edit('n1', 'src/a.ts'), edit('r1', 'src/b.ts')];
    const run = () => build(
      { 'src/a.ts': fn('a', '1'), 'src/b.ts': fn('b', '1') }, { 'src/a.ts': fn('a', '2'), 'src/b.ts': fn('b', '2') },
      [file('src/a.ts', 'modified', 1, 1), file('src/b.ts', 'modified', 1, 1)], hs,
      noiseOf([summary('collapsed:formatting', 'formatting', [hs[0]!])], ['n1']),
    );
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });
});
