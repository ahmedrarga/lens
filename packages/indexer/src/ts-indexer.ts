import { Project, ts } from 'ts-morph';
import type {
  IndexedReference, IndexedSymbol, IndexResult, Indexer, SourceSnapshot, SymbolKind,
} from '@lens/core';

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const EXTERNAL_LIMIT = 'External packages are not resolved (no node_modules); edges to them are omitted.';
const K = ts.SyntaxKind;

export const moduleSymbolId = (path: string) => `${path}#<module>`;

const isPascal = (s: string) => /^[A-Z][A-Za-z0-9]*$/.test(s);
const hasModifier = (n: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind);

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  return !!ts.forEachChild(node, (c) => (containsJsx(c) ? true : undefined));
}

function stripOuter(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
  return e;
}

export function createTsIndexer(): Indexer {
  return { extensions: EXTENSIONS, index };
}

async function index(snapshot: SourceSnapshot): Promise<IndexResult> {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      noLib: true,
      types: [],
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
    },
  });
  const paths: string[] = [];
  for (const [path, content] of [...snapshot.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!EXTENSIONS.some((e) => path.endsWith(e))) continue;
    project.createSourceFile('/' + path, content, { overwrite: true });
    paths.push(path);
  }
  const program = project.getProgram().compilerObject;
  const checker = program.getTypeChecker();
  const pathSet = new Set(paths);
  const toPath = (fileName: string) => fileName.replace(/^\//, '');

  const symbols = new Map<string, IndexedSymbol>();
  const declMap = new Map<ts.Node, string>();
  const sfs: { sf: ts.SourceFile; path: string }[] = [];

  for (const path of paths) {
    const sf = program.getSourceFile('/' + path);
    if (!sf) continue;
    sfs.push({ sf, path });
    collectSymbols(sf, path, symbols, declMap);
  }

  const refs = new Map<string, IndexedReference>();
  const pushRef = (r: IndexedReference) => {
    const key = `${r.kind}|${r.from}|${r.to ?? r.toText}|${r.resolved}`;
    if (!refs.has(key)) refs.set(key, r);
  };

  for (const { sf, path } of sfs) {
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const calleeNodes = new Set<ts.Node>();
    const modId = moduleSymbolId(path);

    const resolveId = (id: ts.Identifier): string | undefined => {
      let sym =
        id.parent && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
          ? checker.getShorthandAssignmentValueSymbol(id.parent)
          : checker.getSymbolAtLocation(id);
      if (!sym) return undefined;
      if (sym.flags & ts.SymbolFlags.Alias) {
        try { sym = checker.getAliasedSymbol(sym); } catch { return undefined; }
      }
      for (const d of sym.declarations ?? []) {
        const t = declMap.get(d) ?? (ts.isEnumMember(d) ? declMap.get(d.parent) : undefined);
        if (t) return t;
      }
      return undefined;
    };

    // Is the leftmost value of an expression chain a local (non-import, non-global) thing?
    const rootIsLocal = (e: ts.Expression): boolean => {
      for (;;) {
        e = stripOuter(e);
        if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
        else break;
      }
      if (e.kind === K.ThisKeyword) return true;
      if (!ts.isIdentifier(e)) return false;
      const s = checker.getSymbolAtLocation(e);
      return !!s && !(s.flags & ts.SymbolFlags.Alias) && !!s.declarations?.length;
    };

    const keep = (from: string, to: string | undefined) =>
      !!to && to !== from && !from.startsWith(to + '.');

    const handleCall = (call: ts.CallExpression, from: string) => {
      const callee = stripOuter(call.expression);
      let nameNode: ts.Identifier | undefined;
      if (ts.isIdentifier(callee)) nameNode = callee;
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) nameNode = callee.name;
      if (nameNode) {
        calleeNodes.add(nameNode);
        const to = resolveId(nameNode);
        if (to) {
          if (keep(from, to)) pushRef({ from, to, kind: 'calls', resolved: true, line: lineOf(call) });
          return;
        }
        if (checker.getSymbolAtLocation(nameNode) || ts.isIdentifier(callee)) return; // external / global / local non-snapshot
        if (!ts.isPropertyAccessExpression(callee)) return;
        const recv = checker.getTypeAtLocation(callee.expression);
        if (!(recv.flags & ts.TypeFlags.Any) || !rootIsLocal(callee.expression)) return;
      } else if (!(ts.isElementAccessExpression(callee) && rootIsLocal(callee))) {
        return;
      }
      const text = callee.getText(sf).replace(/\s+/g, ' ');
      pushRef({
        from, toText: (text.length > 80 ? text.slice(0, 77) + '...' : text) + '()',
        kind: 'calls', resolved: false, line: lineOf(call),
      });
    };

    const visit = (node: ts.Node, owner: string): void => {
      owner = declMap.get(node) ?? owner;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return; // imports handled below
      if (ts.isCallExpression(node)) handleCall(node, owner);
      else if (ts.isIdentifier(node)) {
        if (!calleeNodes.has(node)) {
          const to = resolveId(node);
          if (keep(owner, to)) pushRef({ from: owner, to, kind: 'references', resolved: true, line: lineOf(node) });
        }
        return;
      }
      ts.forEachChild(node, (c) => visit(c, owner));
    };

    for (const stmt of sf.statements) {
      if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier) {
        const target = checker.getSymbolAtLocation(stmt.moduleSpecifier)?.declarations?.[0];
        if (target && ts.isSourceFile(target)) {
          const tp = toPath(target.fileName);
          if (tp !== path && pathSet.has(tp)) {
            pushRef({ from: modId, to: moduleSymbolId(tp), kind: 'imports', resolved: true, line: lineOf(stmt) });
          }
        }
        continue;
      }
      visit(stmt, modId);
    }
  }

  return {
    symbols: [...symbols.values()],
    references: [...refs.values()],
    limits: [EXTERNAL_LIMIT],
  };
}

function collectSymbols(
  sf: ts.SourceFile, path: string, symbols: Map<string, IndexedSymbol>, declMap: Map<ts.Node, string>,
): void {
  const jsxFile = /\.(tsx|jsx)$/.test(path);
  const exportedNames = new Set<string>();
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const el of s.exportClause.elements) exportedNames.add((el.propertyName ?? el.name).text);
    } else if (ts.isExportAssignment(s) && ts.isIdentifier(s.expression)) {
      exportedNames.add(s.expression.text);
    }
  }
  const lineCount = sf.getLineAndCharacterOfPosition(sf.end).line + 1;
  const modId = moduleSymbolId(path);
  symbols.set(modId, {
    id: modId, path, name: '<module>', qualifiedName: '<module>', kind: 'other',
    range: { start: 1, end: lineCount }, exported: false,
  });

  const add = (
    decl: ts.Node, rangeNode: ts.Node, qualifiedName: string, kind: SymbolKind, exported: boolean, container?: string,
  ) => {
    const id = `${path}#${qualifiedName}`;
    const start = sf.getLineAndCharacterOfPosition(rangeNode.getStart(sf, true)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(rangeNode.getEnd()).line + 1;
    declMap.set(decl, id);
    const prev = symbols.get(id);
    if (prev) { // overloads / declaration merging: widen the range
      prev.range = { start: Math.min(prev.range.start, start), end: Math.max(prev.range.end, end) };
      return id;
    }
    const name = qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1);
    symbols.set(id, { id, path, name, qualifiedName, kind, range: { start, end }, exported, ...(container ? { container } : {}) });
    return id;
  };

  const fnKind = (name: string, fn: ts.Node): SymbolKind =>
    isPascal(name) && (jsxFile || containsJsx(fn)) ? 'component' : 'function';

  // `const X = memo(() => ...)` style wrappers count as functions too.
  const functionInit = (init: ts.Expression | undefined): ts.Node | undefined => {
    if (!init) return undefined;
    const e = stripOuter(init);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
    if (ts.isCallExpression(e)) return e.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    return undefined;
  };

  for (const s of sf.statements) {
    const exp = hasModifier(s, K.ExportKeyword);
    const isDefault = hasModifier(s, K.DefaultKeyword);
    if (ts.isFunctionDeclaration(s)) {
      const name = s.name?.text ?? 'default';
      add(s, s, name, fnKind(name, s), exp || exportedNames.has(name));
    } else if (ts.isClassDeclaration(s)) {
      const name = s.name?.text ?? 'default';
      const cid = add(s, s, name, 'class', exp || exportedNames.has(name) || isDefault);
      for (const m of s.members) {
        let mname: string | undefined;
        if (ts.isConstructorDeclaration(m)) mname = 'constructor';
        else if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name) {
          mname = ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : undefined;
        }
        if (mname) add(m, m, `${name}.${mname}`, 'method', false, cid);
      }
    } else if (ts.isInterfaceDeclaration(s)) {
      add(s, s, s.name.text, 'interface', exp || exportedNames.has(s.name.text));
    } else if (ts.isTypeAliasDeclaration(s)) {
      add(s, s, s.name.text, 'type', exp || exportedNames.has(s.name.text));
    } else if (ts.isEnumDeclaration(s)) {
      add(s, s, s.name.text, 'enum', exp || exportedNames.has(s.name.text));
    } else if (ts.isVariableStatement(s)) {
      const decls = s.declarationList.declarations;
      for (const d of decls) {
        if (!ts.isIdentifier(d.name)) continue;
        const name = d.name.text;
        const fn = functionInit(d.initializer);
        add(d, decls.length === 1 ? s : d, name, fn ? fnKind(name, fn) : 'variable', exp || exportedNames.has(name));
      }
    } else if (ts.isExportAssignment(s) && !ts.isIdentifier(s.expression)) {
      const fn = functionInit(s.expression);
      add(s, s, 'default', fn ? 'function' : 'variable', true);
    }
  }
}
