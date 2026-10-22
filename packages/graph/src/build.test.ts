import { describe, expect, it } from 'vitest';
import { ChangeGraph, type BuildGraphInput, type ParsedHunk, type PrFile, type PrRef } from '@lens/core';
import { createTsIndexer } from '../../indexer/src/index.js';
import { assertCoverage, buildGraph, changedLines } from './index.js';

const pr: PrRef = {
  provider: 'github', owner: 'o', repo: 'r', number: 1, url: 'u', title: 't', body: null, author: null,
  baseSha: 'b', headSha: 'h', baseRef: 'main', headRef: 'feat',
};

/** Hunk from body lines ('+x', '-x', ' x'). */
function hunk(id: string, path: string, oldStart: number, newStart: number, body: string[], oldPath?: string): ParsedHunk {
  const added = body.filter((l) => l[0] === '+').length;
  const removed = body.filter((l) => l[0] === '-').length;
  const oldLines = body.length - added;
  const newLines = body.length - removed;
  return {
    id, path, ...(oldPath ? { oldPath } : {}), oldStart, oldLines, newStart, newLines, added, removed,
    patch: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${body.join('\n')}`,
  };
}

async function build(
  base: Record<string, string>, headFiles: Record<string, string>, files: PrFile[], hunks: ParsedHunk[],
) {
  const idx = createTsIndexer();
  const input: BuildGraphInput = {
    pr, files, hunks,
    head: await idx.index({ files: new Map(Object.entries(headFiles)) }),
    base: await idx.index({ files: new Map(Object.entries(base)) }),
    skippedFiles: [], limits: [], durationMs: 5,
  };
  const g = buildGraph(input, { now: () => new Date(0) });
  expect(() => ChangeGraph.parse(g)).not.toThrow();
  expect(assertCoverage(g)).toEqual([]);
  return { g, input };
}
const node = (g: ChangeGraph, id: string) => g.nodes.find((n) => n.id === id);
const file = (path: string, status: PrFile['status'], additions: number, deletions: number, oldPath?: string): PrFile =>
  ({ path, status, additions, deletions, ...(oldPath ? { oldPath } : {}) });

const A_BASE = `import { b } from './b';
export function a() {
  return b();
}
export function other() {
  return 1;
}
`;
const B = `export function b() {
  return 1;
}
`;

describe('changedLines', () => {
  it('maps added to head and removed to base lines', () => {
    const h = hunk('h', 'f', 10, 20, [' ctx', '-old1', '-old2', '+new1', ' ctx2']);
    expect(changedLines(h)).toEqual({ added: [21], removed: [11, 12] });
  });
});

describe('buildGraph', () => {
  it('modified function with caller edge, ghost neighbour and hierarchy', async () => {
    const head = A_BASE.replace('return b();', 'return b() + 1;');
    const { g } = await build(
      { 'src/a.ts': A_BASE, 'src/b.ts': B }, { 'src/a.ts': head, 'src/b.ts': B },
      [file('src/a.ts', 'modified', 1, 1)],
      [hunk('h1', 'src/a.ts', 2, 2, [' export function a() {', '-  return b();', '+  return b() + 1;', ' }'])],
    );
    const a = node(g, 'symbol:src/a.ts#a')!;
    expect(a).toMatchObject({ state: 'modified', level: 2, stats: { added: 1, removed: 1 }, symbolKind: 'function' });
    expect(node(g, 'symbol:src/a.ts#other')).toBeUndefined();
    expect(node(g, 'symbol:src/b.ts#b')).toMatchObject({ state: 'unchanged', parent: 'module:src' });
    expect(g.edges.find((e) => e.id === 'calls:symbol:src/a.ts#a->symbol:src/b.ts#b')).toMatchObject({ state: 'unchanged' });
    expect(g.hunks[0]!.owner).toBe('symbol:src/a.ts#a');
    const cluster = node(g, a.parent!)!;
    expect(cluster).toMatchObject({ kind: 'cluster', level: 1, parent: 'module:src', label: 'a' });
    expect(cluster.id).toBe('cluster:src:src-a.ts-a');
    expect(node(g, 'module:src')).toMatchObject({ level: 0, state: 'modified' });
  });

  it('added file: symbols added, import edge added, top-level lines go to file node', async () => {
    const src = `import { b } from './b';\nexport function c() {\n  return b();\n}\n`;
    const { g } = await build(
      { 'src/b.ts': B }, { 'src/b.ts': B, 'src/c.ts': src },
      [file('src/c.ts', 'added', 4, 0)],
      [hunk('h1', 'src/c.ts', 0, 1, src.trimEnd().split('\n').map((l) => '+' + l))],
    );
    expect(node(g, 'symbol:src/c.ts#c')).toMatchObject({ state: 'added', stats: { added: 3, removed: 0 } });
    expect(node(g, 'file:src/c.ts')).toMatchObject({ state: 'added', stats: { added: 1, removed: 0 } });
    expect(g.edges.find((e) => e.id === 'calls:symbol:src/c.ts#c->symbol:src/b.ts#b')!.state).toBe('added');
    expect(g.edges.find((e) => e.id === 'imports:file:src/c.ts->file:src/b.ts')).toBeUndefined(); // b.ts is not changed, not a ghost
    expect(g.hunks[0]!.owner).toBe('symbol:src/c.ts#c'); // 3 of 4 lines
  });

  it('removed function owns a pure-removal hunk; caller edge is removed', async () => {
    const head = `import { b } from './b';\nexport function a() {\n  return 2;\n}\n`;
    const { g } = await build(
      { 'src/a.ts': A_BASE, 'src/b.ts': B }, { 'src/a.ts': head, 'src/b.ts': B },
      [file('src/a.ts', 'modified', 1, 4)],
      [
        hunk('h1', 'src/a.ts', 3, 3, ['-  return b();', '+  return 2;']),
        hunk('h2', 'src/a.ts', 5, 5, ['-export function other() {', '-  return 1;', '-}']),
      ],
    );
    expect(node(g, 'symbol:src/a.ts#other')).toMatchObject({ state: 'removed', stats: { added: 0, removed: 3 } });
    expect(g.hunks.find((h) => h.id === 'h2')!.owner).toBe('symbol:src/a.ts#other');
    expect(g.edges.find((e) => e.id === 'calls:symbol:src/a.ts#a->symbol:src/b.ts#b')!.state).toBe('removed');
  });

  it('pure rename does not show removed+added', async () => {
    const { g } = await build(
      { 'src/old.ts': B }, { 'src/new.ts': B },
      [file('src/new.ts', 'renamed', 0, 0, 'src/old.ts')], [],
    );
    expect(g.nodes.filter((n) => n.state === 'added' || n.state === 'removed')).toEqual([]);
    expect(node(g, 'file:src/new.ts')).toMatchObject({ state: 'renamed' });
  });

  it('rename with an edit maps base symbols through oldPath', async () => {
    const head = B.replace('return 1', 'return 2');
    const { g } = await build(
      { 'src/old.ts': B }, { 'src/new.ts': head },
      [file('src/new.ts', 'renamed', 1, 1, 'src/old.ts')],
      [hunk('h1', 'src/new.ts', 1, 1, [' export function b() {', '-  return 1;', '+  return 2;', ' }'], 'src/old.ts')],
    );
    expect(node(g, 'symbol:src/new.ts#b')).toMatchObject({ state: 'modified', stats: { added: 1, removed: 1 } });
    expect(g.nodes.some((n) => n.state === 'removed')).toBe(false);
  });

  it('hunk spanning two functions credits both and picks the larger owner', async () => {
    const base = `export function f() {\n  return 1;\n}\nexport function g() {\n  return 2;\n  // x\n}\n`;
    const head = `export function f() {\n  return 10;\n}\nexport function g() {\n  return 20;\n  // y\n}\n`;
    const { g: graph } = await build(
      { 'src/m.ts': base }, { 'src/m.ts': head }, [file('src/m.ts', 'modified', 3, 3)],
      [hunk('h1', 'src/m.ts', 2, 2, ['-  return 1;', '+  return 10;', ' }', ' export function g() {', '-  return 2;', '-  // x', '+  return 20;', '+  // y'])],
    );
    expect(node(graph, 'symbol:src/m.ts#f')).toMatchObject({ state: 'modified', stats: { added: 1, removed: 1 } });
    expect(node(graph, 'symbol:src/m.ts#g')).toMatchObject({ state: 'modified', stats: { added: 2, removed: 2 } });
    expect(graph.hunks[0]!.owner).toBe('symbol:src/m.ts#g');
  });

  it('non-TS files become file nodes', async () => {
    const { g } = await build(
      {}, {}, [file('config/app.json', 'modified', 1, 1)],
      [hunk('h1', 'config/app.json', 1, 1, ['-{"a":1}', '+{"a":2}'])],
    );
    expect(node(g, 'file:config/app.json')).toMatchObject({ kind: 'file', state: 'modified', stats: { added: 1, removed: 1 }, parent: 'cluster:config:config-app.json' });
    expect(node(g, 'module:config')).toBeDefined();
    expect(g.hunks[0]!.owner).toBe('file:config/app.json');
  });

  it('surfaces unresolved calls as notes, not edges', async () => {
    const base = `const h: any = {};\nexport function d(t: string) {\n  return 1;\n}\n`;
    const head = `const h: any = {};\nexport function d(t: string) {\n  return h[t]();\n}\n`;
    const { g } = await build(
      { 'src/d.ts': base }, { 'src/d.ts': head }, [file('src/d.ts', 'modified', 1, 1)],
      [hunk('h1', 'src/d.ts', 3, 3, ['-  return 1;', '+  return h[t]();'])],
    );
    expect(node(g, 'symbol:src/d.ts#d')!.notes).toEqual(['calls 1 unresolved target: h[t]()']);
    expect(g.edges.filter((e) => e.kind === 'calls')).toEqual([]);
  });

  it('clusters connected changes together and merges singletons per directory', async () => {
    const mk = (n: string, body: string) => `export function ${n}() {\n  return ${body};\n}\n`;
    const base: Record<string, string> = {};
    const headF: Record<string, string> = {};
    const files: PrFile[] = [];
    const hunks: ParsedHunk[] = [];
    for (const n of ['p', 'q', 'r', 's']) {
      base[`src/${n}.ts`] = mk(n, '1');
      headF[`src/${n}.ts`] = mk(n, '2');
      files.push(file(`src/${n}.ts`, 'modified', 1, 1));
      hunks.push(hunk(`h${n}`, `src/${n}.ts`, 2, 2, ['-  return 1;', '+  return 2;']));
    }
    // p calls q in head and base
    for (const o of [base, headF]) o['src/p.ts'] = `import { q } from './q';\n` + o['src/p.ts']!.replace('return 1', 'return q()').replace('return 2', 'return q()');
    base['src/p.ts'] = `import { q } from './q';\nexport function p() {\n  return q() + 1;\n}\n`;
    headF['src/p.ts'] = `import { q } from './q';\nexport function p() {\n  return q() + 2;\n}\n`;
    hunks[0] = hunk('hp', 'src/p.ts', 3, 3, ['-  return q() + 1;', '+  return q() + 2;']);
    const { g } = await build(base, headF, files, hunks);
    const clusters = g.nodes.filter((n) => n.kind === 'cluster');
    expect(clusters.map((c) => c.label).sort()).toEqual(['p (+1)', 'r (+1)']);
  });

  it('is deterministic, covers all hunks and totals match', async () => {
    const head = A_BASE.replace('return b();', 'return b() + 1;');
    const run = () =>
      build({ 'src/a.ts': A_BASE, 'src/b.ts': B }, { 'src/a.ts': head, 'src/b.ts': B },
        [file('src/a.ts', 'modified', 1, 1)],
        [hunk('h1', 'src/a.ts', 2, 2, [' export function a() {', '-  return b();', '+  return b() + 1;', ' }'])]);
    const [x, y] = [await run(), await run()];
    expect(JSON.stringify(x.g)).toBe(JSON.stringify(y.g));
    const ids = new Set(x.g.nodes.map((n) => n.id));
    expect(x.g.hunks.every((h) => ids.has(h.owner))).toBe(true);
    expect(x.g.hunks.reduce((n, h) => n + h.added, 0)).toBe(x.g.stats.added);
    expect(x.g.nodes.map((n) => n.id)).toEqual([...x.g.nodes.map((n) => n.id)].sort());
  });

  it('assertCoverage flags a bad owner', async () => {
    const { g } = await build({}, {}, [file('x.json', 'modified', 1, 0)], [hunk('h', 'x.json', 1, 1, ['+a'])]);
    expect(assertCoverage({ ...g, hunks: [{ ...g.hunks[0]!, owner: 'nope' }] })).not.toEqual([]);
  });
});
