import picomatch from 'picomatch';
import type { FileStatus, Hunk, RiskRule } from '@lens/core';

export type PathMatcher = (path: string) => boolean;

const pathCache = new Map<string, { inc: PathMatcher | null; exc: PathMatcher | null }>();

/** Globs starting with `!` exclude. No include globs = every path is included. */
export function pathsMatcher(globs: string[]): { included: PathMatcher; excluded: PathMatcher; hasIncludes: boolean } {
  const key = globs.join('\u0000');
  let c = pathCache.get(key);
  if (!c) {
    const inc = globs.filter((g) => !g.startsWith('!'));
    const exc = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
    c = {
      inc: inc.length ? picomatch(inc, { dot: true }) : null,
      exc: exc.length ? picomatch(exc, { dot: true }) : null,
    };
    pathCache.set(key, c);
  }
  const { inc, exc } = c;
  return { included: (p) => (inc ? inc(p) : true), excluded: (p) => (exc ? exc(p) : false), hasIncludes: inc !== null };
}

export type ContentMode = 'both' | 'added' | 'removed' | 'net-removed';
export interface ContentPattern { mode: ContentMode; re: RegExp }

const reCache = new Map<string, RegExp | Error>();

/** Compile `[added:|removed:|net-removed:][(?i)]regex`. Throws on invalid regex. */
export function compileRegex(src: string, defaultFlags = ''): RegExp {
  const key = `${defaultFlags}\u0000${src}`;
  const hit = reCache.get(key);
  if (hit instanceof RegExp) return hit;
  if (hit instanceof Error) throw hit;
  let body = src;
  let flags = defaultFlags;
  if (body.startsWith('(?i)')) { body = body.slice(4); if (!flags.includes('i')) flags += 'i'; }
  try {
    const re = new RegExp(body, flags);
    reCache.set(key, re);
    return re;
  } catch (e) {
    const err = new Error(`invalid regex /${src}/: ${(e as Error).message}`);
    reCache.set(key, err);
    throw err;
  }
}

export function compileContent(src: string): ContentPattern {
  const m = /^(added|removed|net-removed):/.exec(src);
  const mode = (m ? m[1] : 'both') as ContentMode;
  return { mode, re: compileRegex(m ? src.slice(m[0].length) : src, 'g') };
}

export function validateContent(src: string): void {
  compileContent(src);
}

export interface HunkText { id: string; added: string; removed: string }

const textCache = new WeakMap<Hunk, HunkText>();
export function hunkText(h: Hunk): HunkText {
  let t = textCache.get(h);
  if (!t) {
    const added: string[] = [];
    const removed: string[] = [];
    for (const line of h.patch.split('\n').slice(1)) {
      if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
      else if (line.startsWith('-') && !line.startsWith('---')) removed.push(line.slice(1));
    }
    t = { id: h.id, added: added.join('\n'), removed: removed.join('\n') };
    textCache.set(h, t);
  }
  return t;
}

function count(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) { n++; if (re.lastIndex === 0) break; }
  return n;
}

/** Evidence text for the first pattern matching this hunk, or null. */
export function matchContent(patterns: ContentPattern[], t: HunkText): string | null {
  for (const { mode, re } of patterns) {
    let hit: RegExpExecArray | null = null;
    re.lastIndex = 0;
    if (mode === 'net-removed') {
      if (count(re, t.removed) > count(re, t.added)) { re.lastIndex = 0; hit = re.exec(t.removed); }
    } else {
      if (mode !== 'removed') { re.lastIndex = 0; hit = re.exec(t.added); }
      if (!hit && mode !== 'added') { re.lastIndex = 0; hit = re.exec(t.removed); }
    }
    if (hit) return hit[0].replace(/\s+/g, ' ').trim().slice(0, 48);
  }
  return null;
}

export interface CompiledRule {
  rule: RiskRule;
  paths: ReturnType<typeof pathsMatcher> | null;
  symbols: RegExp[];
  content: ContentPattern[];
  fileStatus: Set<FileStatus> | null;
}

const ruleCache = new WeakMap<RiskRule, CompiledRule>();
export function compileRule(rule: RiskRule): CompiledRule {
  let c = ruleCache.get(rule);
  if (!c) {
    c = {
      rule,
      paths: rule.match.paths?.length ? pathsMatcher(rule.match.paths) : null,
      symbols: (rule.match.symbols ?? []).map((s) => compileRegex(s, 'i')),
      content: (rule.match.content ?? []).map(compileContent),
      fileStatus: rule.match.fileStatus?.length ? new Set(rule.match.fileStatus) : null,
    };
    ruleCache.set(rule, c);
  }
  return c;
}

/** Matcher for a list of picomatch globs (dotfiles included). Empty list matches nothing. */
export function pathMatcher(globs: string[]): PathMatcher {
  if (globs.length === 0) return () => false;
  const m = picomatch(globs, { dot: true });
  return (p) => m(p);
}
