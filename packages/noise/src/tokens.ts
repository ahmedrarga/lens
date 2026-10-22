// Token streams for JS/TS files, built from the real parser (not the bare scanner) so regex literals,
// template strings and JSX text are tokenised correctly. Comments are kept: they matter for review.
import ts from 'typescript';
import type { Line } from './patch.js';

export interface Tok {
  /** Exact comparison key. */
  key: string;
  /** Key for the lenient comparison (quote style ignored); null = droppable punctuation. */
  loose: string | null;
  first: number;
  last: number;
  /** Module specifier text for import/export-from strings. */
  spec?: string;
}

export interface Stmt { first: number; last: number; declarative: boolean }
export interface FileTokens { toks: Tok[]; stmts: Stmt[]; lines: string[] }

const SK = ts.SyntaxKind;
// Tokens around which a line break changes meaning (ASI, no-line-terminator rules): break position is part of the key.
const NL_SENSITIVE = new Set([
  'return', 'break', 'continue', 'throw', 'yield', 'async', '++', '--', '=>', 'type', 'interface', 'declare',
  'abstract', 'namespace', 'module', 'global', 'enum', 'readonly', 'get', 'set', 'static', 'await', 'of', 'let',
  'using', 'accessor', 'as', 'satisfies', 'is', 'asserts', 'infer', 'keyof', 'unique',
]);
const SEMI_PARENTS = new Set<ts.SyntaxKind>([
  SK.VariableStatement, SK.ExpressionStatement, SK.ReturnStatement, SK.ThrowStatement, SK.BreakStatement,
  SK.ContinueStatement, SK.ImportDeclaration, SK.ExportDeclaration, SK.ExportAssignment, SK.TypeAliasDeclaration,
  SK.PropertyDeclaration, SK.ImportEqualsDeclaration,
]);
const DECLARATIVE = new Set<ts.SyntaxKind>([
  SK.FunctionDeclaration, SK.ClassDeclaration, SK.InterfaceDeclaration, SK.TypeAliasDeclaration, SK.EnumDeclaration,
]);

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function normJsx(t: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!;
  const ws = (s: string) => (s ? (/[\r\n]/.test(s) ? '\n' : ' ') : '');
  if (!m[2]) return ws(m[1]!);
  return ws(m[1]!) + m[2].replace(/\s+/g, ' ') + ws(m[3]!);
}

interface Leaf { node: ts.Node; start: number; end: number; text: string }

const cache = new Map<string, FileTokens | null>();

/** Returns null when the file does not parse cleanly: we then prove nothing about it. */
export function tokenize(path: string, text: string): FileTokens | null {
  const ck = path + '\0' + text;
  if (cache.has(ck)) return cache.get(ck)!;
  const r = build(path, text);
  if (cache.size > 200) cache.clear();
  cache.set(ck, r);
  return r;
}

function build(path: string, text: string): FileTokens | null {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  if ((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0) return null;

  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (off: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= off) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const leaves: Leaf[] = [];
  const visit = (n: ts.Node): void => {
    if (n.kind >= SK.FirstJSDocNode && n.kind <= SK.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) {
      const isJsx = n.kind === SK.JsxText;
      const start = isJsx ? n.pos : n.getStart(sf);
      const end = n.end;
      if (end > start) leaves.push({ node: n, start, end, text: text.slice(start, end) });
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(sf);

  const toks: Tok[] = [];
  const pushComments = (from: number, to: number): void => {
    if (!text.slice(from, to).trim()) return;
    const sc = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text, undefined, from, to - from);
    for (let k = sc.scan(); k !== SK.EndOfFileToken; k = sc.scan()) {
      if (k === SK.SingleLineCommentTrivia || k === SK.MultiLineCommentTrivia || k === SK.ShebangTrivia || k === SK.ConflictMarkerTrivia) {
        const s = sc.getTokenStart();
        const e = sc.getTokenEnd();
        const key = 'C:' + text.slice(s, e);
        toks.push({ key, loose: key, first: lineOf(s), last: lineOf(Math.max(s, e - 1)) });
      }
    }
  };
  let prevEnd = 0;
  let prevText = '';
  leaves.forEach((lf, i) => {
    const gap = text.slice(prevEnd, lf.start);
    const nl = /[\r\n\u2028\u2029]/.test(gap);
    pushComments(prevEnd, lf.start);
    const kind = lf.node.kind;
    const isJsx = kind === SK.JsxText;
    const t = isJsx ? normJsx(lf.text) : lf.text;
    const sens = nl && (NL_SENSITIVE.has(prevText) || NL_SENSITIVE.has(t));
    const key = (sens ? '\n' : '') + (isJsx ? 'J:' : 'T:') + t;
    const tok: Tok = { key, loose: key, first: lineOf(lf.start), last: lineOf(lf.end - 1) };

    if (kind === SK.StringLiteral) {
      tok.loose = (sens ? '\n' : '') + 'S:' + (lf.node as ts.StringLiteral).text;
      const p = lf.node.parent;
      if (
        ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === lf.node) ||
        ts.isExternalModuleReference(p) ||
        (ts.isCallExpression(p) && p.expression.kind === SK.ImportKeyword)
      ) tok.spec = (lf.node as ts.StringLiteral).text;
    } else if (kind === SK.SemicolonToken && SEMI_PARENTS.has(lf.node.parent.kind)) {
      const next = leaves[i + 1];
      const nk = next?.node.kind;
      const okNext =
        !next || nk === SK.CloseBraceToken || nk === SK.OpenBraceToken || nk === SK.Identifier ||
        nk === SK.StringLiteral || nk === SK.NumericLiteral ||
        (nk! >= SK.FirstKeyword && nk! <= SK.LastKeyword && nk !== SK.InKeyword && nk !== SK.InstanceOfKeyword);
      const nlAfter = !next || nk === SK.CloseBraceToken || /[\r\n]/.test(text.slice(lf.end, next.start));
      if (okNext && nlAfter) tok.loose = null;
    } else if (kind === SK.CommaToken) {
      const next = leaves[i + 1]?.node.kind;
      const prev = leaves[i - 1]?.node.kind;
      if (
        (next === SK.CloseParenToken || next === SK.CloseBracketToken || next === SK.CloseBraceToken) &&
        prev !== SK.CommaToken && prev !== SK.OpenBracketToken && prev !== SK.OpenParenToken && prev !== SK.OpenBraceToken
      ) tok.loose = null;
    }
    toks.push(tok);
    prevEnd = lf.end;
    prevText = t;
  });

  pushComments(prevEnd, text.length); // comments after the last token

  const stmts: Stmt[] = sf.statements.map((s) => {
    let declarative = DECLARATIVE.has(s.kind);
    if (ts.isVariableStatement(s)) {
      declarative = s.declarationList.declarations.every((d) =>
        !!d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer) || ts.isClassExpression(d.initializer)));
    }
    return { first: lineOf(s.getStart(sf, true)), last: lineOf(s.end - 1), declarative };
  });

  return { toks, stmts, lines: text.split('\n').map((l) => l.replace(/\r$/, '')) };
}

/** Tokens overlapping the given (contiguous) lines. */
export function tokensOn(ft: FileTokens, lines: Line[]): Tok[] {
  if (lines.length === 0) return [];
  const lo = lines[0]!.n, hi = lines[lines.length - 1]!.n;
  return ft.toks.filter((t) => t.first <= hi && t.last >= lo);
}

/** Do the patch lines really sit at these line numbers of the file? Guards against stale or mismatched contents. */
export const linesMatch = (ft: FileTokens, lines: Line[]): boolean =>
  lines.every((l) => ft.lines[l.n - 1] === l.text);

export type Eq = 'strict' | 'loose' | 'diff';
export function compareTokens(a: Tok[], b: Tok[]): Eq {
  if (a.length === b.length && a.every((t, i) => t.key === b[i]!.key)) return 'strict';
  const la = a.filter((t) => t.loose !== null).map((t) => t.loose);
  const lb = b.filter((t) => t.loose !== null).map((t) => t.loose);
  return la.length === lb.length && la.every((t, i) => t === lb[i]) ? 'loose' : 'diff';
}
