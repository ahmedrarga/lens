// Declaration model of a Java snapshot: files, types, members, annotations. Built from tree-sitter trees.
import type { IndexedSymbol, SymbolKind } from '@lens/core';
import type { Node, Tree } from './parser.js';

export interface AnnInfo {
  /** Simple (last segment) name, e.g. `GetMapping`. */
  name: string;
  full: string;
  node: Node;
  /** argument key (`value` for the positional one) -> value nodes (array initialisers flattened). */
  args: Map<string, Node[]>;
}

export interface FieldInfo {
  name: string;
  id: string;
  owner: TypeInfo;
  typeNode: Node | null;
  init: Node | null;
  anns: AnnInfo[];
  mods: Set<string>;
  component: boolean;
}

export interface MethodInfo {
  name: string;
  retNode: Node | null;
  tparams: Set<string>;
  anns: AnnInfo[];
  mods: Set<string>;
  node: Node;
  params: { name: string; typeNode: Node | null; anns: AnnInfo[] }[];
}

export type TypeKind = 'class' | 'interface' | 'enum' | 'record' | 'annotation';

export interface TypeInfo {
  id: string;
  fqn: string;
  path: string;
  pkg: string;
  qname: string;
  simple: string;
  kind: TypeKind;
  node: Node;
  file: FileInfo;
  outer?: TypeInfo;
  nested: Map<string, TypeInfo>;
  fields: Map<string, FieldInfo>;
  methods: Map<string, MethodInfo[]>;
  superclassRaw?: string;
  ifaceRaw: string[];
  anns: AnnInfo[];
  mods: Set<string>;
  tparams: Set<string>;
  members: Node[];
  enumConstants: Node[];
  resolveCache: Map<string, TypeInfo | null>;
  supers?: TypeInfo[];
}

export interface FileInfo {
  path: string;
  pkg: string;
  tree: Tree;
  types: TypeInfo[];
  imports: { fqn: string; line: number; isStatic: boolean; wildcard: boolean }[];
  single: Map<string, string>;
  wildcard: string[];
  staticSingle: Map<string, string>;
  staticWild: string[];
  wildUsed: Set<TypeInfo>;
  resolveCache: Map<string, TypeInfo | null>;
}

const TYPE_KINDS: Record<string, { kind: TypeKind; sym: SymbolKind }> = {
  class_declaration: { kind: 'class', sym: 'class' },
  record_declaration: { kind: 'record', sym: 'class' },
  interface_declaration: { kind: 'interface', sym: 'interface' },
  enum_declaration: { kind: 'enum', sym: 'enum' },
  annotation_type_declaration: { kind: 'annotation', sym: 'type' },
};
export const isTypeDecl = (n: Node) => n.type in TYPE_KINDS;

export const moduleId = (path: string) => `${path}#<module>`;

export function typeNameOf(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'type_identifier': return n.text;
    case 'scoped_type_identifier': return n.text.replace(/\s+/g, '');
    case 'generic_type': return typeNameOf(n.firstNamedChild);
    case 'annotated_type': return typeNameOf(n.lastNamedChild);
    default: return undefined;
  }
}

function parseAnnotation(n: Node): AnnInfo {
  const full = n.childForFieldName('name')?.text.replace(/\s+/g, '') ?? '';
  const args = new Map<string, Node[]>();
  const list = n.childForFieldName('arguments');
  const put = (k: string, v: Node) => {
    args.set(k, v.type === 'element_value_array_initializer' ? v.namedChildren : [v]);
  };
  if (list) {
    for (const c of list.namedChildren) {
      if (c.type === 'element_value_pair') {
        const k = c.childForFieldName('key')?.text;
        const v = c.childForFieldName('value');
        if (k && v) put(k, v);
      } else if (c.type !== 'line_comment' && c.type !== 'block_comment') put('value', c);
    }
  }
  return { name: full.slice(full.lastIndexOf('.') + 1), full, node: n, args };
}

export function readModifiers(decl: Node): { anns: AnnInfo[]; mods: Set<string> } {
  const anns: AnnInfo[] = [];
  const mods = new Set<string>();
  const m = decl.children.find((c) => c.type === 'modifiers');
  if (m) {
    for (const c of m.children) {
      if (c.type === 'annotation' || c.type === 'marker_annotation') anns.push(parseAnnotation(c));
      else mods.add(c.type);
    }
  }
  return { anns, mods };
}

function typeParamNames(decl: Node): Set<string> {
  const out = new Set<string>();
  const tp = decl.children.find((c) => c.type === 'type_parameters');
  if (tp) for (const p of tp.namedChildren) {
    const id = p.namedChildren.find((c) => c.type === 'type_identifier');
    if (id) out.add(id.text);
  }
  return out;
}

export interface Collected {
  files: Map<string, FileInfo>;
  types: Map<string, TypeInfo>;
  /** FQNs declared more than once in the snapshot (resolution treats them as unknown). */
  ambiguous: Set<string>;
  symbols: Map<string, IndexedSymbol>;
}

const startLine = (n: Node, docOwner: Node = n): number => {
  let start = n.startPosition.row + 1;
  const prev = docOwner.previousSibling;
  if (prev && prev.type === 'block_comment' && prev.text.startsWith('/**')) start = Math.min(start, prev.startPosition.row + 1);
  return start;
};

export function collectFile(path: string, src: string, tree: Tree, out: Collected): void {
  const root = tree.rootNode;
  let pkg = '';
  const file: FileInfo = {
    path, pkg, tree, types: [], imports: [], single: new Map(), wildcard: [], staticSingle: new Map(),
    staticWild: [], wildUsed: new Set(), resolveCache: new Map(),
  };
  const lineCount = src.split('\n').length;
  out.files.set(path, file);
  const modId = moduleId(path);
  out.symbols.set(modId, {
    id: modId, path, name: '<module>', qualifiedName: '<module>', kind: 'other',
    range: { start: 1, end: lineCount }, exported: false,
  });

  for (const c of root.namedChildren) {
    if (c.type === 'package_declaration') {
      pkg = c.namedChildren.find((x) => x.type === 'scoped_identifier' || x.type === 'identifier')?.text.replace(/\s+/g, '') ?? '';
      file.pkg = pkg;
    } else if (c.type === 'import_declaration') {
      const nameNode = c.namedChildren.find((x) => x.type === 'scoped_identifier' || x.type === 'identifier');
      if (!nameNode) continue;
      const fqn = nameNode.text.replace(/\s+/g, '');
      const isStatic = c.children.some((x) => x.type === 'static');
      const wildcard = c.children.some((x) => x.type === 'asterisk');
      file.imports.push({ fqn, line: c.startPosition.row + 1, isStatic, wildcard });
      const last = fqn.slice(fqn.lastIndexOf('.') + 1);
      const parent = fqn.slice(0, Math.max(0, fqn.lastIndexOf('.')));
      if (isStatic) {
        if (wildcard) file.staticWild.push(fqn);
        else file.staticSingle.set(last, parent);
      } else if (wildcard) file.wildcard.push(fqn);
      else file.single.set(last, fqn);
    }
  }

  const add = (
    id: string, qualifiedName: string, kind: SymbolKind, node: Node, docOwner: Node, exported: boolean, container?: string,
  ) => {
    const start = startLine(node, docOwner);
    const end = node.endPosition.row + 1;
    const prev = out.symbols.get(id);
    if (prev) {
      prev.range = { start: Math.min(prev.range.start, start), end: Math.max(prev.range.end, end) };
      return;
    }
    out.symbols.set(id, {
      id, path, name: qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1), qualifiedName, kind,
      range: { start, end }, exported, ...(container ? { container } : {}),
    });
  };

  const collectType = (node: Node, outer: TypeInfo | undefined): void => {
    const info = TYPE_KINDS[node.type]!;
    const simple = node.childForFieldName('name')?.text;
    if (!simple) return;
    const qname = outer ? `${outer.qname}.${simple}` : simple;
    const fqn = pkg ? `${pkg}.${qname}` : qname;
    const { anns, mods } = readModifiers(node);
    const body = node.childForFieldName('body');
    const members: Node[] = [];
    const enumConstants: Node[] = [];
    if (body) {
      for (const m of body.namedChildren) {
        if (m.type === 'enum_body_declarations') members.push(...m.namedChildren);
        else if (m.type === 'enum_constant') enumConstants.push(m);
        else members.push(m);
      }
    }
    const t: TypeInfo = {
      id: `${path}#${qname}`, fqn, path, pkg, qname, simple, kind: info.kind, node, file, ...(outer ? { outer } : {}),
      nested: new Map(), fields: new Map(), methods: new Map(), ifaceRaw: [], anns, mods,
      tparams: typeParamNames(node), members, enumConstants, resolveCache: new Map(),
    };
    const sc = node.childForFieldName('superclass');
    if (sc) t.superclassRaw = typeNameOf(sc.namedChildren.find((c) => c.type !== 'line_comment' && c.type !== 'block_comment'));
    for (const c of node.children) {
      if (c.type === 'super_interfaces' || c.type === 'extends_interfaces') {
        const list = c.namedChildren.find((x) => x.type === 'type_list');
        for (const tn of list?.namedChildren ?? []) {
          const nm = typeNameOf(tn);
          if (nm) t.ifaceRaw.push(nm);
        }
      }
    }
    if (outer) outer.nested.set(simple, t); else file.types.push(t);
    if (out.types.has(fqn)) out.ambiguous.add(fqn); else out.types.set(fqn, t);

    const inInterface = info.kind === 'interface' || info.kind === 'annotation';
    const outerPublic = outer ? outer.kind === 'interface' || outer.kind === 'annotation' : false;
    add(t.id, qname, info.sym, node, node, mods.has('public') || outerPublic, outer?.id);

    const addField = (name: string, typeNode: Node | null, init: Node | null, f: { anns: AnnInfo[]; mods: Set<string> },
      node: Node, docOwner: Node, component: boolean) => {
      const id = `${t.id}.${name}`;
      t.fields.set(name, { name, id, owner: t, typeNode, init, anns: f.anns, mods: f.mods, component });
      add(id, `${qname}.${name}`, 'variable', node, docOwner, f.mods.has('public') || inInterface, t.id);
    };
    const addMethod = (name: string, node: Node, m: { anns: AnnInfo[]; mods: Set<string> }) => {
      const params: MethodInfo['params'] = [];
      const pl = node.childForFieldName('parameters');
      for (const p of pl?.namedChildren ?? []) {
        if (p.type !== 'formal_parameter' && p.type !== 'spread_parameter') continue;
        const pn = p.childForFieldName('name')?.text ?? p.namedChildren.find((c) => c.type === 'variable_declarator')?.childForFieldName('name')?.text;
        params.push({
          name: pn ?? '', anns: readModifiers(p).anns,
          typeNode: p.type === 'spread_parameter' ? null : p.childForFieldName('type'),
        });
      }
      const mi: MethodInfo = {
        name, retNode: node.childForFieldName('type'), tparams: typeParamNames(node), anns: m.anns, mods: m.mods, node, params,
      };
      const list = t.methods.get(name);
      if (list) list.push(mi); else t.methods.set(name, [mi]);
      add(`${t.id}.${name}`, `${qname}.${name}`, 'method', node, node, m.mods.has('public') || inInterface, t.id);
    };

    if (info.kind === 'record') {
      const pl = node.childForFieldName('parameters');
      for (const p of pl?.namedChildren ?? []) {
        if (p.type !== 'formal_parameter') continue;
        const pn = p.childForFieldName('name')?.text;
        if (pn) addField(pn, p.childForFieldName('type'), null, readModifiers(p), p, p, true);
      }
    }

    for (const m of members) {
      if (isTypeDecl(m)) { collectType(m, t); continue; }
      if (m.type === 'field_declaration' || m.type === 'constant_declaration') {
        const f = readModifiers(m);
        const decls = m.namedChildren.filter((c) => c.type === 'variable_declarator');
        for (const d of decls) {
          const nm = d.childForFieldName('name')?.text;
          if (nm) addField(nm, m.childForFieldName('type'), d.childForFieldName('value'), f, decls.length === 1 ? m : d, m, false);
        }
      } else if (m.type === 'method_declaration' || m.type === 'annotation_type_element_declaration') {
        const nm = m.childForFieldName('name')?.text;
        if (nm) addMethod(nm, m, readModifiers(m));
      } else if (m.type === 'constructor_declaration' || m.type === 'compact_constructor_declaration') {
        addMethod('constructor', m, readModifiers(m));
      }
    }
  };

  for (const c of root.namedChildren) if (isTypeDecl(c)) collectType(c, undefined);
}
