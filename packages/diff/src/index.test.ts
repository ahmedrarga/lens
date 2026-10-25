import { describe, expect, it } from 'vitest';
import { changedLines, parseFilePatch } from './index.js';

const f = (patch?: string) => ({ path: 'src/a.ts', patch });

describe('parseFilePatch', () => {
  it('returns [] for missing/empty patch', () => {
    expect(parseFilePatch(f())).toEqual([]);
    expect(parseFilePatch(f(''))).toEqual([]);
  });

  it('parses multiple hunks and omitted counts', () => {
    const patch = ['@@ -1,3 +1,4 @@ fn', ' a', '-b', '+B', '+B2', ' c', '@@ -10 +11 @@', '-x', '+y'].join('\n');
    const h = parseFilePatch(f(patch));
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ id: 'hunk:src/a.ts:0', oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, added: 2, removed: 1 });
    expect(h[0]!.patch).toBe(['@@ -1,3 +1,4 @@ fn', ' a', '-b', '+B', '+B2', ' c'].join('\n'));
    expect(h[1]).toMatchObject({ id: 'hunk:src/a.ts:1', oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, added: 1, removed: 1 });
    expect(changedLines(h[0]!)).toEqual({ added: [2, 3], removed: [2] });
  });

  it('handles add-only file', () => {
    const [h] = parseFilePatch(f('@@ -0,0 +1,2 @@\n+one\n+two'));
    expect(h).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, added: 2, removed: 0 });
    expect(changedLines(h!)).toEqual({ added: [1, 2], removed: [] });
  });

  it('handles delete-only file', () => {
    const [h] = parseFilePatch(f('@@ -1,2 +0,0 @@\n-one\n-two\n'));
    expect(h).toMatchObject({ oldLines: 2, newStart: 0, newLines: 0, added: 0, removed: 2 });
    expect(changedLines(h!)).toEqual({ added: [], removed: [1, 2] });
  });

  it('does not count no-newline markers', () => {
    const patch = '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file';
    const [h] = parseFilePatch(f(patch));
    expect(h).toMatchObject({ added: 1, removed: 1 });
    expect(h!.patch).toBe(patch);
    expect(changedLines(h!)).toEqual({ added: [1], removed: [1] });
  });

  it('sets oldPath only when renamed', () => {
    const p = '@@ -1 +1 @@\n-a\n+b';
    expect(parseFilePatch({ path: 'b.ts', oldPath: 'a.ts', patch: p })[0]!.oldPath).toBe('a.ts');
    expect(parseFilePatch({ path: 'b.ts', oldPath: 'b.ts', patch: p })[0]).not.toHaveProperty('oldPath');
  });

  it('property: added/removed sums equal +/- line counts', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    for (let iter = 0; iter < 200; iter++) {
      const parts: string[] = [];
      let plus = 0, minus = 0, oldPos = 1, newPos = 1;
      for (let hn = 0; hn < 1 + Math.floor(rnd() * 4); hn++) {
        const body: string[] = [];
        let ol = 0, nl = 0;
        for (let i = 0; i < 1 + Math.floor(rnd() * 8); i++) {
          const r = rnd();
          if (r < 0.35) { body.push('+' + 'x'.repeat(i)); nl++; plus++; }
          else if (r < 0.7) { body.push('-- y' + i); ol++; minus++; } // content "-- y" -> still a removed line
          else { body.push(' ctx'); ol++; nl++; }
        }
        parts.push(`@@ -${oldPos},${ol} +${newPos},${nl} @@`, ...body);
        oldPos += ol + 3; newPos += nl + 3;
      }
      const hunks = parseFilePatch(f(parts.join('\n')));
      expect(hunks.reduce((s, h) => s + h.added, 0)).toBe(plus);
      expect(hunks.reduce((s, h) => s + h.removed, 0)).toBe(minus);
      for (const h of hunks) {
        const c = changedLines(h);
        expect(c.added).toHaveLength(h.added);
        expect(c.removed).toHaveLength(h.removed);
      }
    }
  });
});
