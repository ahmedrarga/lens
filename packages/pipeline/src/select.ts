// Pure snapshot selection: which repo files are worth indexing for a PR.

export const MAX_INDEXED_FILES = 400;

const JS_EXT_MAP: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const SPEC_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}(?:\/[^'"\n]*)?)\1/g;

/** Relative import/require specifiers in a source text (cheap, regex based). */
export function extractRelativeSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(SPEC_RE)) if (m[2]) out.add(m[2]);
  return [...out];
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Resolve a relative specifier from `from` to a path satisfying `has`, trying extension/index forms. */
export function resolveSpecifier(
  from: string,
  spec: string,
  has: (p: string) => boolean,
  extensions: string[],
): string | null {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const base = normalize(`${dir}/${spec}`);
  const candidates = [base];
  const dot = base.lastIndexOf('.');
  const ext = dot > base.lastIndexOf('/') ? base.slice(dot) : '';
  for (const alt of JS_EXT_MAP[ext] ?? []) candidates.push(base.slice(0, dot) + alt);
  for (const e of extensions) candidates.push(base + e);
  for (const e of extensions) candidates.push(`${base}/index${e}`);
  return candidates.find((c) => c && has(c)) ?? null;
}

export interface SelectInput {
  /** All source files at head (path -> content). */
  allFiles: Map<string, string>;
  /** Changed, indexable files that exist at head. */
  changed: string[];
  extensions: string[];
  cap?: number;
}

export interface Selection {
  /** Ordered: changed files first, then importers, then imported neighbours. */
  paths: string[];
  limits: string[];
}

export function selectSnapshot({ allFiles, changed, extensions, cap = MAX_INDEXED_FILES }: SelectInput): Selection {
  const has = (p: string) => allFiles.has(p);
  const changedSet = new Set(changed.filter(has));
  const importers = new Set<string>();
  const imported = new Set<string>();

  for (const [path, src] of allFiles) {
    const isChanged = changedSet.has(path);
    for (const spec of extractRelativeSpecifiers(src)) {
      const target = resolveSpecifier(path, spec, has, extensions);
      if (!target) continue;
      if (isChanged && !changedSet.has(target)) imported.add(target);
      if (!isChanged && changedSet.has(target)) importers.add(path);
    }
  }

  const ordered = [...changedSet, ...[...importers].sort(), ...[...imported].filter((p) => !importers.has(p)).sort()];
  const limits: string[] = [];
  let paths = ordered;
  if (ordered.length > cap) {
    paths = ordered.slice(0, cap);
    limits.push(
      `Indexed ${cap} of ${ordered.length} relevant files; ${ordered.length - cap} neighbouring files were left out.`,
    );
  }
  return { paths, limits };
}

/** Filter for provider.getSourceFiles: indexable sources only, no vendored/built/minified output. */
export function makeSourceFilter(extensions: string[]): (path: string) => boolean {
  return (path) => {
    if (!extensions.some((e) => path.endsWith(e))) return false;
    if (/(^|\/)(node_modules|dist|build)\//.test(path)) return false;
    if (path.endsWith('.java') && /(^|\/)(target|out)\//.test(path)) return false; // Maven/IDE output
    if (/\.min\.[cm]?js$/.test(path)) return false;
    return true;
  };
}
