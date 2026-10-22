import { describe, expect, it } from 'vitest';
import { createTsIndexer } from './index.js';

const run = (files: Record<string, string>) =>
  createTsIndexer().index({ files: new Map(Object.entries(files)) });
const has = (r: Awaited<ReturnType<typeof run>>, kind: string, from: string, to: string) =>
  r.references.some((x) => x.kind === kind && x.from === from && x.to === to);

describe('ts indexer', () => {
  it('indexes symbols with ranges, containers and a module pseudo-symbol', async () => {
    const r = await run({
      'src/a.ts': `import x from 'lodash';
/** doc */
export class Svc {
  constructor() {}
  create() { return 1; }
  get size() { return 2; }
}
export interface I {}
type T = string;
enum E { A }
export const f = () => 1;
const n = 5;
`,
    });
    const by = Object.fromEntries(r.symbols.map((s) => [s.id, s]));
    expect(by['src/a.ts#<module>']).toMatchObject({ kind: 'other', range: { start: 1, end: 13 } });
    expect(by['src/a.ts#Svc']).toMatchObject({ kind: 'class', exported: true, range: { start: 2, end: 7 } });
    expect(by['src/a.ts#Svc.create']).toMatchObject({ kind: 'method', container: 'src/a.ts#Svc' });
    expect(by['src/a.ts#Svc.constructor']).toBeDefined();
    expect(by['src/a.ts#Svc.size']).toBeDefined();
    expect(by['src/a.ts#I']!.kind).toBe('interface');
    expect(by['src/a.ts#T']!.kind).toBe('type');
    expect(by['src/a.ts#E']!.kind).toBe('enum');
    expect(by['src/a.ts#f']).toMatchObject({ kind: 'function', exported: true });
    expect(by['src/a.ts#n']).toMatchObject({ kind: 'variable', exported: false });
    expect(r.limits).toHaveLength(1);
    // external import is omitted
    expect(r.references.filter((x) => x.to?.includes('lodash'))).toEqual([]);
  });

  it('resolves cross-file calls via named, default, aliased imports and re-exports', async () => {
    const r = await run({
      'src/util.ts': `export function helper() {}\nexport default function dflt() {}\nexport function other() {}\n`,
      'src/index.ts': `export { helper as h } from './util';\nexport * from './util';\n`,
      'src/main.ts': `import dflt, { other as o } from './util';
import { h } from './index';
import * as ns from './util';
export function run() { dflt(); o(); h(); ns.helper(); }
`,
    });
    const from = 'src/main.ts#run';
    expect(has(r, 'calls', from, 'src/util.ts#dflt')).toBe(true);
    expect(has(r, 'calls', from, 'src/util.ts#other')).toBe(true);
    expect(has(r, 'calls', from, 'src/util.ts#helper')).toBe(true);
    expect(has(r, 'imports', 'src/main.ts#<module>', 'src/util.ts#<module>')).toBe(true);
    expect(has(r, 'imports', 'src/index.ts#<module>', 'src/util.ts#<module>')).toBe(true);
    // deduped
    expect(r.references.filter((x) => x.kind === 'calls' && x.from === from && x.to === 'src/util.ts#helper')).toHaveLength(1);
  });

  it('handles class methods, new, type references', async () => {
    const r = await run({
      'src/svc.ts': `export class Svc { create() { return this.log(); } log() {} }\nexport interface Opts {}\n`,
      'src/use.ts': `import { Svc, Opts } from './svc';
export function go(o: Opts) { const s = new Svc(); s.create(); }
`,
    });
    expect(has(r, 'calls', 'src/svc.ts#Svc.create', 'src/svc.ts#Svc.log')).toBe(true);
    expect(has(r, 'references', 'src/use.ts#go', 'src/svc.ts#Svc')).toBe(true);
    expect(has(r, 'references', 'src/use.ts#go', 'src/svc.ts#Opts')).toBe(true);
    expect(has(r, 'calls', 'src/use.ts#go', 'src/svc.ts#Svc.create')).toBe(true);
  });

  it('detects React components and JSX references', async () => {
    const r = await run({
      'src/Button.tsx': `export const Button = () => <button/>;\n`,
      'src/App.tsx': `import { Button } from './Button';\nexport function App() { return <div><Button/></div>; }\n`,
    });
    const by = Object.fromEntries(r.symbols.map((s) => [s.id, s]));
    expect(by['src/Button.tsx#Button']!.kind).toBe('component');
    expect(by['src/App.tsx#App']!.kind).toBe('component');
    expect(has(r, 'references', 'src/App.tsx#App', 'src/Button.tsx#Button')).toBe(true);
  });

  it('marks dynamic calls unresolved and omits externals', async () => {
    const r = await run({
      'src/h.ts': `import ext from 'external';
const handlers: any = {};
export function dispatch(type: string, a: any) {
  handlers[type]();
  a.foo();
  ext.bar();
  console.log(1);
}
`,
    });
    const un = r.references.filter((x) => !x.resolved);
    expect(un.map((x) => x.toText).sort()).toEqual(['a.foo()', 'handlers[type]()']);
    expect(un.every((x) => x.from === 'src/h.ts#dispatch' && x.kind === 'calls')).toBe(true);
  });
});
