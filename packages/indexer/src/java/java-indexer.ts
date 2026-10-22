import type { IndexedReference, IndexResult, Indexer, SourceSnapshot } from '@lens/core';
import { getJavaParser, type Node } from './parser.js';
import {
  collectFile, isTypeDecl, moduleId, readModifiers, typeNameOf,
  type Collected, type FieldInfo, type FileInfo, type MethodInfo, type TypeInfo,
} from './model.js';
import { annotateField, annotateMethod, annotateType, BEAN_ANNS, classPrefix, INJECT_ANNS } from './spring.js';

/** IndexResult plus Spring-derived facts per symbol id (routes, beans, transactional, ...). */
export type JavaIndexResult = IndexResult & { annotations?: Record<string, string[]> };

const EXTERNAL_LIMIT =
  'Java: JDK, Spring and other external libraries are not resolved; edges to them are omitted. Resolution is syntactic (no generic inference; overloads merged; Lombok-generated members are not symbols).';
const DI_LIMIT = 'Spring DI resolved to single implementations by type; qualifiers/profiles not evaluated';
const LOMBOK_DATA = new Set(['Data', 'Getter', 'Setter', 'Value']);

type ET = { kind: 'type'; t: TypeInfo; stat: boolean } | { kind: 'ext' } | { kind: 'unk' };
const EXT: ET = { kind: 'ext' };
const UNK: ET = { kind: 'unk' };

class Scope {
  vars = new Map<string, ET>();
  constructor(readonly parent?: Scope) {}
  lookup(n: string): ET | undefined {
    for (let s: Scope | undefined = this; s; s = s.parent) {
      const v = s.vars.get(n);
      if (v) return v;
    }
    return undefined;
  }
}

interface Env { file: FileInfo; cls: TypeInfo; owner: string; scope: Scope; tparams: Set<string> }
interface Hit { decl: TypeInfo; id: string; methods?: MethodInfo[]; field?: FieldInfo }

export function createJavaIndexer(): Indexer {
  return { extensions: ['.java'], index };
}

const short = (s: string) => {
  const c = s.replace(/\s+/g, ' ');
  return c.length > 80 ? c.slice(0, 77) + '...' : c;
};

async function index(snapshot: SourceSnapshot): Promise<JavaIndexResult> {
  const paths = [...snapshot.files.keys()].filter((p) => p.endsWith('.java')).sort();
  if (!paths.length) return { symbols: [], references: [], limits: [] };
  const parser = await getJavaParser();
  const col: Collected = { files: new Map(), types: new Map(), ambiguous: new Set(), symbols: new Map() };
  const methodNames = new Set<string>();

  for (const path of paths) {
    const src = snapshot.files.get(path)!;
    const tree = parser.parse(src);
    collectFile(path, src, tree, col);
  }
  for (const t of col.types.values()) for (const n of t.methods.keys()) methodNames.add(n);

  // ---------- type resolution ----------
  const lookupFqn = (fqn: string): TypeInfo | null => (col.ambiguous.has(fqn) ? null : (col.types.get(fqn) ?? null));

  const resolveSimple = (name: string, file: FileInfo, ctx: TypeInfo | undefined): TypeInfo | null => {
    for (let t = ctx; t; t = t.outer) {
      if (t.simple === name) return t;
      const n = t.nested.get(name);
      if (n) return n;
    }
    for (const t of file.types) if (t.simple === name) return t;
    const imp = file.single.get(name);
    if (imp) return lookupFqn(imp);
    const same = lookupFqn(file.pkg ? `${file.pkg}.${name}` : name);
    if (same) return same;
    let found: TypeInfo | null = null;
    for (const w of file.wildcard) {
      const c = lookupFqn(`${w}.${name}`);
      if (c) {
        if (found && found !== c) return null; // ambiguous
        found = c;
      }
    }
    if (found) file.wildUsed.add(found);
    return found;
  };

  const resolveType = (name: string, file: FileInfo, ctx: TypeInfo | undefined): TypeInfo | null => {
    const cache = ctx ? ctx.resolveCache : file.resolveCache;
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    let r: TypeInfo | null;
    if (!name.includes('.')) r = resolveSimple(name, file, ctx);
    else {
      const parts = name.split('.');
      const head = resolveSimple(parts[0]!, file, ctx);
      if (head) {
        let cur: TypeInfo | undefined = head;
        for (const p of parts.slice(1)) cur = cur?.nested.get(p);
        r = cur ?? null;
      } else r = lookupFqn(name);
    }
    cache.set(name, r);
    return r;
  };

  const supersOf = (t: TypeInfo): TypeInfo[] => {
    if (t.supers) return t.supers;
    t.supers = [];
    const out: TypeInfo[] = [];
    if (t.superclassRaw) {
      const s = resolveType(t.superclassRaw, t.file, t);
      if (s && s !== t) out.push(s);
    }
    for (const r of t.ifaceRaw) {
      const s = resolveType(r, t.file, t);
      if (s && s !== t) out.push(s);
    }
    t.supers = out;
    return out;
  };

  const closureCache = new Map<TypeInfo, TypeInfo[]>();
  const closure = (t: TypeInfo): TypeInfo[] => {
    const cached = closureCache.get(t);
    if (cached) return cached;
    const seen = new Set<TypeInfo>([t]);
    const q = [t];
    for (let i = 0; i < q.length; i++) for (const s of supersOf(q[i]!)) if (!seen.has(s)) { seen.add(s); q.push(s); }
    closureCache.set(t, q);
    return q;
  };

  const tparamsChain = (t: TypeInfo | undefined): Set<string> => {
    const s = new Set<string>();
    for (let x = t; x; x = x.outer) for (const n of x.tparams) s.add(n);
    return s;
  };

  // ---------- Spring bean model ----------
  const beanMemo = new Map<TypeInfo, boolean>();
  const isBean = (t: TypeInfo, depth = 0): boolean => {
    const m = beanMemo.get(t);
    if (m !== undefined) return m;
    beanMemo.set(t, false);
    let r = false;
    for (const a of t.anns) {
      if (BEAN_ANNS.has(a.name)) { r = true; break; }
      if (depth < 4) {
        const at = resolveType(a.full, t.file, t);
        if (at && at.kind === 'annotation' && isBean(at, depth + 1)) { r = true; break; }
      }
    }
    beanMemo.set(t, r);
    return r;
  };

  let implementors: Map<TypeInfo, TypeInfo[]> | undefined;
  const singleBeanImpl = (iface: TypeInfo): TypeInfo | undefined => {
    if (iface.kind !== 'interface') return undefined;
    if (!implementors) {
      implementors = new Map();
      for (const t of col.types.values()) {
        if (t.kind === 'interface' || t.kind === 'annotation' || t.mods.has('abstract') || !isBean(t)) continue;
        for (const s of closure(t)) {
          if (s.kind !== 'interface') continue;
          const l = implementors.get(s);
          if (l) l.push(t); else implementors.set(s, [t]);
        }
      }
    }
    const l = implementors.get(iface);
    return l && l.length === 1 ? l[0] : undefined;
  };

  // ---------- member lookup ----------
  const lookupMember = (t: TypeInfo, name: string): Hit | undefined => {
    for (const c of closure(t)) {
      const ms = c.methods.get(name);
      if (ms) return { decl: c, id: `${c.id}.${name}`, methods: ms };
      if (c.kind === 'record') {
        const f = c.fields.get(name);
        if (f?.component) return { decl: c, id: f.id, field: f };
      }
    }
    return undefined;
  };
  const lookupField = (t: TypeInfo, name: string): FieldInfo | undefined => {
    for (const c of closure(t)) { const f = c.fields.get(name); if (f) return f; }
    return undefined;
  };
  const lookupFieldLexical = (t: TypeInfo, name: string): FieldInfo | undefined => {
    for (let x: TypeInfo | undefined = t; x; x = x.outer) { const f = lookupField(x, name); if (f) return f; }
    return undefined;
  };
  const hasLombokAccess = (c: TypeInfo, f: FieldInfo) =>
    c.anns.some((a) => LOMBOK_DATA.has(a.name)) || f.anns.some((a) => a.name === 'Getter' || a.name === 'Setter');
  const lombokAccessor = (t: TypeInfo, name: string): FieldInfo | undefined => {
    const m = /^(get|set|is)([A-Z]\w*)$/.exec(name);
    if (!m) return undefined;
    const fname = m[2]![0]!.toLowerCase() + m[2]!.slice(1);
    for (const c of closure(t)) {
      const f = c.fields.get(fname) ?? (m[1] === 'is' ? c.fields.get(name) : undefined);
      if (f && hasLombokAccess(c, f)) return f;
    }
    return undefined;
  };

  // ---------- expression typing ----------
  const declET = (typeNode: Node | null | undefined, file: FileInfo, ctx: TypeInfo | undefined, tparams: Set<string>): ET => {
    const name = typeNameOf(typeNode);
    if (!name || tparams.has(name)) return EXT;
    const t = resolveType(name, file, ctx);
    return t ? { kind: 'type', t, stat: false } : EXT;
  };
  const fieldET = (f: FieldInfo): ET => declET(f.typeNode, f.owner.file, f.owner, tparamsChain(f.owner));

  const retET = (h: Hit): ET => {
    if (h.field) return fieldET(h.field);
    let res: ET | undefined;
    for (const m of h.methods ?? []) {
      const tp = tparamsChain(h.decl);
      for (const x of m.tparams) tp.add(x);
      const e = declET(m.retNode, h.decl.file, h.decl, tp);
      if (res === undefined) res = e;
      else if (!(res.kind === 'type' && e.kind === 'type' && res.t === e.t)) return EXT;
    }
    return res ?? EXT;
  };

  const lookupUnqualified = (name: string, env: Env): Hit | undefined => {
    for (let t: TypeInfo | undefined = env.cls; t; t = t.outer) {
      const h = lookupMember(t, name);
      if (h && !h.field) return h;
    }
    const sp = env.file.staticSingle.get(name);
    if (sp) {
      const t = lookupFqn(sp);
      const h = t && lookupMember(t, name);
      if (h) return h;
    }
    let found: Hit | undefined;
    for (const w of env.file.staticWild) {
      const t = lookupFqn(w);
      const h = t && lookupMember(t, name);
      if (h) { if (found) return undefined; found = h; }
    }
    return found;
  };

  const strConst = (n: Node, t: TypeInfo, depth = 0): string | undefined => {
    if (depth > 6) return undefined;
    switch (n.type) {
      case 'string_literal': {
        const tx = n.text;
        return tx.startsWith('"""') ? tx.slice(3, -3).trim() : tx.slice(1, -1);
      }
      case 'parenthesized_expression': return n.firstNamedChild ? strConst(n.firstNamedChild, t, depth + 1) : undefined;
      case 'binary_expression': {
        if (n.childForFieldName('operator')?.text !== '+') return undefined;
        const l = n.childForFieldName('left'); const r = n.childForFieldName('right');
        const a = l && strConst(l, t, depth + 1); const b = r && strConst(r, t, depth + 1);
        return a !== undefined && a !== null && b !== undefined && b !== null ? a + b : undefined;
      }
      case 'identifier': {
        const f = lookupFieldLexical(t, n.text);
        return f?.init ? strConst(f.init, f.owner, depth + 1) : undefined;
      }
      case 'field_access': {
        const o = n.childForFieldName('object'); const fld = n.childForFieldName('field');
        if (!o || !fld) return undefined;
        const name = o.text.replace(/\s+/g, '');
        const ot = resolveType(name, t.file, t);
        const f = ot && lookupField(ot, fld.text);
        return f?.init ? strConst(f.init, f.owner, depth + 1) : undefined;
      }
      default: return undefined;
    }
  };
  const springCtx = { evalStr: (n: Node, t: TypeInfo) => strConst(n, t) };

  const typeOf = (n: Node, env: Env): ET => {
    switch (n.type) {
      case 'this': return { kind: 'type', t: env.cls, stat: false };
      case 'super': {
        const s = env.cls.superclassRaw ? resolveType(env.cls.superclassRaw, env.file, env.cls) : null;
        return s ? { kind: 'type', t: s, stat: false } : EXT;
      }
      case 'parenthesized_expression': return n.firstNamedChild ? typeOf(n.firstNamedChild, env) : EXT;
      case 'cast_expression': return declET(n.childForFieldName('type'), env.file, env.cls, env.tparams);
      case 'object_creation_expression': return declET(n.childForFieldName('type'), env.file, env.cls, env.tparams);
      case 'identifier': {
        const v = env.scope.lookup(n.text);
        if (v) return v;
        const f = lookupFieldLexical(env.cls, n.text);
        if (f) return fieldET(f);
        const t = resolveType(n.text, env.file, env.cls);
        return t && !env.tparams.has(n.text) ? { kind: 'type', t, stat: true } : EXT;
      }
      case 'field_access': {
        const o = n.childForFieldName('object'); const fld = n.childForFieldName('field');
        if (!o || !fld) return EXT;
        const fname = fld.text;
        if (o.type !== 'this' && /^[\w.\s]+$/.test(o.text) && !hasVarRoot(o, env)) {
          const full = resolveType((o.text + '.' + fname).replace(/\s+/g, ''), env.file, env.cls);
          if (full) return { kind: 'type', t: full, stat: true };
        }
        const ot = typeOf(o, env);
        if (ot.kind !== 'type') return ot.kind === 'unk' ? UNK : EXT;
        if (ot.stat) {
          const nested = ot.t.nested.get(fname);
          if (nested) return { kind: 'type', t: nested, stat: true };
        }
        const f = lookupField(ot.t, fname);
        return f ? fieldET(f) : EXT;
      }
      case 'method_invocation': {
        const r = callTarget(n, env);
        return r.hit ? retET(r.hit) : EXT;
      }
      default: return EXT;
    }
  };
  const hasVarRoot = (o: Node, env: Env): boolean => {
    let r: Node | null = o;
    while (r && r.type === 'field_access') r = r.childForFieldName('object');
    return !r || r.type !== 'identifier' || !!env.scope.lookup(r.text) || !!lookupFieldLexical(env.cls, r.text);
  };

  /** Resolve the target of a method call without emitting anything. */
  const callTarget = (n: Node, env: Env): { hit?: Hit; recv?: ET; lombok?: FieldInfo } => {
    const name = n.childForFieldName('name')?.text;
    if (!name) return {};
    const objN = n.childForFieldName('object');
    if (!objN) return { hit: lookupUnqualified(name, env) };
    const recv = typeOf(objN, env);
    if (recv.kind !== 'type') return { recv };
    const hit = lookupMember(recv.t, name);
    if (hit) return { hit, recv };
    const lombok = lombokAccessor(recv.t, name);
    if (lombok) return { recv, lombok, hit: { decl: lombok.owner, id: lombok.id, field: lombok } };
    return { recv };
  };

  // ---------- references ----------
  const refs = new Map<string, IndexedReference>();
  let diUsed = false;
  const pushRef = (r: IndexedReference) => {
    const key = `${r.kind}|${r.from}|${r.to ?? r.toText}|${r.resolved}`;
    if (!refs.has(key)) refs.set(key, r);
  };
  const keep = (from: string, to: string) => to !== from && !from.startsWith(to + '.');
  const link = (from: string, to: string, kind: 'calls' | 'references', line: number) => {
    if (keep(from, to)) pushRef({ from, to, kind, resolved: true, line });
  };

  const refType = (name: string, node: Node, env: Env) => {
    if (env.tparams.has(name)) return;
    const t = resolveType(name, env.file, env.cls);
    if (t) link(env.owner, t.id, 'references', node.startPosition.row + 1);
  };

  const emitCall = (n: Node, name: string, env: Env) => {
    const line = n.startPosition.row + 1;
    const objN = n.childForFieldName('object');
    const { hit, recv, lombok } = callTarget(n, env);
    if (hit) {
      link(env.owner, hit.id, lombok ? 'references' : 'calls', line);
      if (recv?.kind === 'type' && recv.t.kind === 'interface' && !lombok) {
        const impl = singleBeanImpl(recv.t);
        const ih = impl && lookupMember(impl, name);
        if (ih && ih.id !== hit.id) { link(env.owner, ih.id, 'calls', line); diUsed = true; }
      }
      return;
    }
    if (!objN) return;
    if (recv?.kind === 'unk') {
      if (methodNames.has(name)) {
        pushRef({ from: env.owner, toText: short(`${objN.text}.${name}()`), kind: 'calls', resolved: false, line });
      }
    } else if (recv?.kind === 'type' && recv.stat) {
      link(env.owner, recv.t.id, 'references', line);
    }
  };

  const handleNew = (n: Node, env: Env) => {
    const et = declET(n.childForFieldName('type'), env.file, env.cls, env.tparams);
    if (et.kind === 'type' && et.t.methods.has('constructor')) {
      link(env.owner, `${et.t.id}.constructor`, 'calls', n.startPosition.row + 1);
    }
  };

  const addVar = (scope: Scope, name: string | undefined, et: ET) => {
    if (!name) return;
    const prev = scope.vars.get(name);
    if (prev && !(prev.kind === 'type' && et.kind === 'type' && prev.t === et.t)) scope.vars.set(name, prev.kind === 'unk' || et.kind === 'unk' ? UNK : EXT);
    else scope.vars.set(name, et);
  };

  const SCOPED = new Set([
    'block', 'for_statement', 'enhanced_for_statement', 'catch_clause', 'try_with_resources_statement',
    'switch_block', 'constructor_body', 'class_body',
  ]);

  const visitAll = (n: Node, env: Env, skip?: (c: Node) => boolean) => {
    for (const c of n.namedChildren) if (!skip || !skip(c)) visit(c, env);
  };

  const visit = (n: Node, env: Env): void => {
    switch (n.type) {
      case 'type_identifier': refType(n.text, n, env); return;
      case 'scoped_type_identifier': refType(n.text.replace(/\s+/g, ''), n, env); return;
      case 'marker_annotation': case 'annotation': {
        const nm = n.childForFieldName('name');
        if (nm) refType(nm.text.replace(/\s+/g, ''), nm, env);
        const args = n.childForFieldName('arguments');
        if (args) visit(args, env);
        return;
      }
      case 'method_invocation': {
        const nameN = n.childForFieldName('name');
        if (nameN) emitCall(n, nameN.text, env);
        visitAll(n, env, (c) => c.id === nameN?.id);
        return;
      }
      case 'object_creation_expression':
        handleNew(n, env);
        visitAll(n, env);
        return;
      case 'explicit_constructor_invocation': {
        if (n.childForFieldName('constructor')?.type === 'super' && env.cls.superclassRaw) {
          const s = resolveType(env.cls.superclassRaw, env.file, env.cls);
          if (s?.methods.has('constructor')) link(env.owner, `${s.id}.constructor`, 'calls', n.startPosition.row + 1);
        }
        visitAll(n, env);
        return;
      }
      case 'local_variable_declaration': {
        const typeNode = n.childForFieldName('type');
        visitAll(n, env, (c) => c.type === 'variable_declarator');
        const isVar = typeNode?.text === 'var';
        for (const d of n.namedChildren) {
          if (d.type !== 'variable_declarator') continue;
          const value = d.childForFieldName('value');
          if (value) visit(value, env);
          const et = isVar ? (value ? typeOf(value, env) : UNK) : declET(typeNode, env.file, env.cls, env.tparams);
          addVar(env.scope, d.childForFieldName('name')?.text, et);
        }
        return;
      }
      case 'formal_parameter': case 'spread_parameter': case 'catch_formal_parameter': {
        const tn = n.childForFieldName('type');
        const nm = n.childForFieldName('name') ?? n.namedChildren.find((c) => c.type === 'variable_declarator')?.childForFieldName('name');
        addVar(env.scope, nm?.text, n.type === 'formal_parameter' ? declET(tn, env.file, env.cls, env.tparams) : EXT);
        visitAll(n, env, (c) => c.id === nm?.id);
        return;
      }
      case 'resource': {
        const tn = n.childForFieldName('type');
        const value = n.childForFieldName('value');
        if (value) visit(value, env);
        if (tn) visit(tn, env);
        const nm = n.childForFieldName('name')?.text;
        addVar(env.scope, nm, tn ? (tn.text === 'var' ? (value ? typeOf(value, env) : UNK) : declET(tn, env.file, env.cls, env.tparams)) : EXT);
        return;
      }
      case 'enhanced_for_statement': {
        const e2 = { ...env, scope: new Scope(env.scope) };
        const tn = n.childForFieldName('type');
        const value = n.childForFieldName('value');
        if (value) visit(value, env);
        if (tn) visit(tn, e2);
        addVar(e2.scope, n.childForFieldName('name')?.text, tn?.text === 'var' ? UNK : declET(tn, env.file, env.cls, env.tparams));
        const body = n.childForFieldName('body');
        if (body) visit(body, e2);
        return;
      }
      case 'lambda_expression': {
        const e2 = { ...env, scope: new Scope(env.scope) };
        const ps = n.childForFieldName('parameters');
        if (ps) {
          if (ps.type === 'identifier') addVar(e2.scope, ps.text, UNK);
          else if (ps.type === 'inferred_parameters') for (const p of ps.namedChildren) addVar(e2.scope, p.text, UNK);
          else visit(ps, e2);
        }
        const body = n.childForFieldName('body');
        if (body) visit(body, e2);
        return;
      }
      case 'instanceof_expression': {
        const nm = n.childForFieldName('name');
        const right = n.childForFieldName('right');
        if (nm && right) addVar(env.scope, nm.text, declET(right, env.file, env.cls, env.tparams));
        visitAll(n, env, (c) => c.id === nm?.id);
        return;
      }
      case 'type_pattern': {
        const tn = n.firstNamedChild;
        const nm = n.lastNamedChild;
        if (tn && nm && tn !== nm) addVar(env.scope, nm.text, declET(tn, env.file, env.cls, env.tparams));
        if (tn) visit(tn, env);
        return;
      }
      case 'field_access': {
        const o = n.childForFieldName('object');
        if (o) visit(o, env);
        return;
      }
      case 'method_reference': {
        const first = n.firstNamedChild;
        if (first) visit(first, env);
        return;
      }
      case 'identifier': {
        const p = n.parent;
        if (!p || !/^[A-Z]/.test(n.text)) return;
        const isObj = (p.type === 'field_access' && p.childForFieldName('object')?.id === n.id) ||
          (p.type === 'method_reference' && p.firstNamedChild?.id === n.id);
        if (!isObj || env.scope.lookup(n.text) || lookupFieldLexical(env.cls, n.text)) return;
        refType(n.text, n, env);
        return;
      }
      default:
        if (SCOPED.has(n.type)) {
          visitAll(n, { ...env, scope: new Scope(env.scope) });
        } else visitAll(n, env);
    }
  };

  // ---------- walk declarations ----------
  const annotations: Record<string, string[]> = {};
  const note = (id: string, lines: string[]) => {
    if (!lines.length) return;
    const cur = annotations[id] ?? (annotations[id] = []);
    for (const l of lines) if (!cur.includes(l)) cur.push(l);
  };
  const typesIn = (n: Node | null, env: Env): TypeInfo[] => {
    const out = new Set<TypeInfo>();
    const walk = (x: Node) => {
      if (x.type === 'type_identifier' || x.type === 'scoped_type_identifier') {
        const t = resolveType(x.text.replace(/\s+/g, ''), env.file, env.cls);
        if (t) out.add(t);
        if (x.type === 'scoped_type_identifier') return;
      }
      for (const c of x.namedChildren) walk(c);
    };
    if (n) walk(n);
    return [...out];
  };

  const walkType = (t: TypeInfo): void => {
    const root = new Scope();
    const tparams = tparamsChain(t);
    const base: Env = { file: t.file, cls: t, owner: t.id, scope: root, tparams };
    const body = t.node.childForFieldName('body');
    const name = t.node.childForFieldName('name');
    visitAll(t.node, base, (c) => c.id === body?.id || c.id === name?.id || (t.kind === 'record' && c.type === 'formal_parameters'));
    const bean = isBean(t);
    note(t.id, annotateType(t, springCtx, bean));
    const controller = t.anns.some((a) => a.name === 'RestController' || a.name === 'Controller');
    const prefix = classPrefix(t, springCtx);
    const lombokRequired = t.anns.some((a) => a.name === 'RequiredArgsConstructor' || a.name === 'AllArgsConstructor');
    const diTypes = (n: Node | null, e: Env) => {
      for (const d of typesIn(n, e)) link(t.id, d.id, 'references', (n ?? t.node).startPosition.row + 1);
    };

    if (t.kind === 'record') {
      for (const f of t.fields.values()) {
        if (!f.component) continue;
        const e = { ...base, owner: f.id };
        const pl = t.node.childForFieldName('parameters');
        const p = pl?.namedChildren.find((c) => c.childForFieldName('name')?.text === f.name);
        if (p) visitAll(p, e, (c) => c.id === p.childForFieldName('name')?.id);
        note(f.id, annotateField(f, springCtx));
      }
      if (bean) for (const f of t.fields.values()) diTypes(f.typeNode, base);
    }

    for (const ec of t.enumConstants) visit(ec, base);

    for (const m of t.members) {
      if (isTypeDecl(m)) {
        const nested = t.nested.get(m.childForFieldName('name')?.text ?? '');
        if (nested) walkType(nested);
        continue;
      }
      if (m.type === 'field_declaration' || m.type === 'constant_declaration') {
        const typeNode = m.childForFieldName('type');
        const decls = m.namedChildren.filter((c) => c.type === 'variable_declarator');
        const { anns, mods } = readModifiers(m);
        const injected = anns.some((a) => INJECT_ANNS.has(a.name));
        for (const d of decls) {
          const nm = d.childForFieldName('name')?.text;
          const f = nm ? t.fields.get(nm) : undefined;
          if (!f) continue;
          const e: Env = { ...base, owner: f.id, scope: new Scope(root) };
          visitAll(m, e, (c) => c.type === 'variable_declarator');
          const value = d.childForFieldName('value');
          if (value) visit(value, e);
          note(f.id, annotateField(f, springCtx));
          const lombokDep = lombokRequired && !mods.has('static') &&
            (t.anns.some((a) => a.name === 'AllArgsConstructor') || (mods.has('final') && !value) || anns.some((a) => a.name === 'NonNull'));
          if (injected || (bean || lombokRequired) && lombokDep) diTypes(typeNode, e);
        }
        continue;
      }
      const isMethod = m.type === 'method_declaration' || m.type === 'annotation_type_element_declaration';
      const isCtor = m.type === 'constructor_declaration' || m.type === 'compact_constructor_declaration';
      if (isMethod || isCtor) {
        const nm = isCtor ? 'constructor' : m.childForFieldName('name')?.text;
        if (!nm) continue;
        const id = `${t.id}.${nm}`;
        const mi = t.methods.get(nm)?.find((x) => x.node === m);
        const tp = new Set(tparams);
        for (const x of mi?.tparams ?? []) tp.add(x);
        const e: Env = { ...base, owner: id, scope: new Scope(root), tparams: tp };
        visitAll(m, e, (c) => c.id === m.childForFieldName('name')?.id);
        if (mi) note(id, annotateMethod(t, [mi], springCtx, controller, prefix));
        const injectedMethod = mi?.anns.some((a) => INJECT_ANNS.has(a.name));
        if (mi && ((isCtor && bean) || injectedMethod)) for (const p of mi.params) diTypes(p.typeNode, e);
        continue;
      }
      // initializer blocks
      visit(m, { ...base, scope: new Scope(root) });
    }
  };

  for (const f of col.files.values()) for (const t of f.types) walkType(t);

  // imports
  for (const f of col.files.values()) {
    const from = moduleId(f.path);
    const target = (t: TypeInfo | null) => {
      if (t && t.path !== f.path) pushRef({ from, to: moduleId(t.path), kind: 'imports', resolved: true, line: 1 });
    };
    for (const i of f.imports) {
      const add = (t: TypeInfo | null) => {
        if (t && t.path !== f.path) pushRef({ from, to: moduleId(t.path), kind: 'imports', resolved: true, line: i.line });
      };
      if (i.wildcard) {
        if (i.isStatic) add(lookupFqn(i.fqn));
        continue; // plain wildcard imports are emitted below for types actually used
      }
      add(lookupFqn(i.isStatic ? i.fqn.slice(0, Math.max(0, i.fqn.lastIndexOf('.'))) : i.fqn));
    }
    for (const t of f.wildUsed) target(t);
  }

  for (const f of col.files.values()) f.tree.delete();

  const limits = [EXTERNAL_LIMIT];
  if (diUsed) limits.push(DI_LIMIT);
  // annotate Spring facts per method symbol for overload-merged ids happened per overload via note()
  return {
    symbols: [...col.symbols.values()],
    references: [...refs.values()],
    limits,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}
