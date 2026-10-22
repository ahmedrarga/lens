import { describe, expect, it } from 'vitest';
import { extractRelativeSpecifiers, makeSourceFilter, resolveSpecifier, selectSnapshot } from './select.js';

const EXT = ['.ts', '.tsx'];

describe('specifiers', () => {
  it('extracts relative import forms only', () => {
    const src = `import a from './a.js';\nexport * from "../b";\nconst c = require('./c');\nawait import('./d');\nimport x from 'react';`;
    expect(extractRelativeSpecifiers(src).sort()).toEqual(['../b', './a.js', './c', './d']);
  });
  it('resolves extensions, .js->.ts and index files', () => {
    const files = new Set(['src/a.ts', 'src/util/index.ts', 'lib/x.tsx']);
    const has = (p: string) => files.has(p);
    expect(resolveSpecifier('src/m.ts', './a.js', has, EXT)).toBe('src/a.ts');
    expect(resolveSpecifier('src/m.ts', './a', has, EXT)).toBe('src/a.ts');
    expect(resolveSpecifier('src/m.ts', './util', has, EXT)).toBe('src/util/index.ts');
    expect(resolveSpecifier('src/deep/m.ts', '../../lib/x', has, EXT)).toBe('lib/x.tsx');
    expect(resolveSpecifier('src/m.ts', './nope', has, EXT)).toBeNull();
  });
});

describe('selectSnapshot', () => {
  const allFiles = new Map([
    ['src/changed.ts', `import { d } from './dep.js'; import { n } from './nested/index';`],
    ['src/dep.ts', ''],
    ['src/nested/index.ts', ''],
    ['src/caller.ts', `import { c } from './changed';`],
    ['src/unrelated.ts', `import { d } from './dep';`],
  ]);
  it('picks changed, importers and imported neighbours; excludes the rest', () => {
    const r = selectSnapshot({ allFiles, changed: ['src/changed.ts'], extensions: EXT });
    expect(r.paths[0]).toBe('src/changed.ts');
    expect(new Set(r.paths)).toEqual(new Set(['src/changed.ts', 'src/caller.ts', 'src/dep.ts', 'src/nested/index.ts']));
    expect(r.limits).toEqual([]);
  });
  it('caps with changed files first and a note', () => {
    const r = selectSnapshot({ allFiles, changed: ['src/changed.ts'], extensions: EXT, cap: 2 });
    expect(r.paths).toHaveLength(2);
    expect(r.paths[0]).toBe('src/changed.ts');
    expect(r.limits[0]).toMatch(/2 of 4/);
  });
  it('ignores changed paths absent from the snapshot', () => {
    expect(selectSnapshot({ allFiles, changed: ['gone.ts'], extensions: EXT }).paths).toEqual([]);
  });
});

describe('makeSourceFilter', () => {
  const f = makeSourceFilter(EXT);
  it('filters', () => {
    expect(f('src/a.ts')).toBe(true);
    expect(f('src/a.md')).toBe(false);
    expect(f('node_modules/x/a.d.ts')).toBe(false);
    expect(f('packages/p/dist/a.ts')).toBe(false);
    expect(f('a.min.js')).toBe(false);
  });
});
