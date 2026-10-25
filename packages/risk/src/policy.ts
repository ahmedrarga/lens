import { parse } from 'yaml';
import type { RiskPolicy, RiskRule } from '@lens/core';
import { DEFAULT_RULES, DEFAULT_POLICY, LENS_POLICY_RULE } from './rules.js';
import { compileRegex, validateContent } from './match.js';
import picomatch from 'picomatch';

const LEVELS = ['low', 'med', 'high', 'blocker'] as const;
const STATUSES = ['added', 'modified', 'removed', 'renamed'] as const;
const TOP_KEYS = new Set(['extends', 'rules', 'disable', 'neverCollapse']);
const RULE_KEYS = new Set(['id', 'description', 'level', 'mustReview', 'match']);
const MATCH_KEYS = new Set(['paths', 'symbols', 'content', 'fileStatus']);
const MAX_RULES = 200;
const MAX_PATTERN = 500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function strList(v: unknown, where: string, errors: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0 || x.length > MAX_PATTERN)) {
    errors.push(`${where}: must be a list of non-empty strings (max ${MAX_PATTERN} chars each)`);
    return undefined;
  }
  return v as string[];
}

function parseRule(raw: unknown, i: number, errors: string[]): RiskRule | null {
  const at = `rules[${i}]`;
  if (!isObj(raw)) { errors.push(`${at}: must be a mapping`); return null; }
  const before = errors.length;
  for (const k of Object.keys(raw)) if (!RULE_KEYS.has(k)) errors.push(`${at}: unknown key "${k}"`);
  const id = raw.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][\w.-]*$/.test(id)) errors.push(`${at}: "id" must be a string like "my-rule"`);
  const where = typeof id === 'string' ? `rule "${id}"` : at;
  if (!(LEVELS as readonly unknown[]).includes(raw.level)) errors.push(`${where}: "level" must be one of ${LEVELS.join(', ')}`);
  if (raw.mustReview !== undefined && typeof raw.mustReview !== 'boolean') errors.push(`${where}: "mustReview" must be true or false`);
  if (raw.description !== undefined && typeof raw.description !== 'string') errors.push(`${where}: "description" must be a string`);
  const m = raw.match;
  if (!isObj(m)) { errors.push(`${where}: "match" must be a mapping`); return null; }
  for (const k of Object.keys(m)) if (!MATCH_KEYS.has(k)) errors.push(`${where}: unknown match key "${k}"`);
  const paths = strList(m.paths, `${where}: match.paths`, errors);
  const symbols = strList(m.symbols, `${where}: match.symbols`, errors);
  const content = strList(m.content, `${where}: match.content`, errors);
  let fileStatus: RiskRule['match']['fileStatus'];
  if (m.fileStatus !== undefined) {
    if (!Array.isArray(m.fileStatus) || m.fileStatus.some((s) => !(STATUSES as readonly unknown[]).includes(s))) {
      errors.push(`${where}: match.fileStatus must be a list of ${STATUSES.join(', ')}`);
    } else fileStatus = m.fileStatus as NonNullable<RiskRule['match']['fileStatus']>;
  }
  for (const g of paths ?? []) {
    try { picomatch(g.startsWith('!') ? g.slice(1) : g); } catch (e) { errors.push(`${where}: bad glob "${g}": ${(e as Error).message}`); }
  }
  for (const s of symbols ?? []) {
    try { compileRegex(s, 'i'); } catch (e) { errors.push(`${where}: match.symbols: ${(e as Error).message}`); }
  }
  for (const c of content ?? []) {
    try { validateContent(c); } catch (e) { errors.push(`${where}: match.content: ${(e as Error).message}`); }
  }
  if (!paths?.length && !symbols?.length && !content?.length && !fileStatus?.length) {
    errors.push(`${where}: "match" needs at least one of paths, symbols, content, fileStatus`);
  }
  if (errors.length > before) return null;
  return {
    id: id as string,
    description: typeof raw.description === 'string' ? raw.description : (id as string),
    level: raw.level as RiskRule['level'],
    mustReview: raw.mustReview === true,
    match: {
      ...(paths ? { paths } : {}), ...(symbols ? { symbols } : {}), ...(content ? { content } : {}),
      ...(fileStatus ? { fileStatus } : {}),
    },
  };
}

/**
 * Parse `.lens/policy.yml`. Any problem returns the default policy plus readable errors, so a typo can never
 * silently turn review off. `lens-policy` is always present and cannot be disabled or overridden.
 */
export function loadPolicy(yamlText: string | null): { policy: RiskPolicy; errors: string[] } {
  if (yamlText === null || yamlText.trim() === '') return { policy: DEFAULT_POLICY, errors: [] };
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (e) {
    return { policy: DEFAULT_POLICY, errors: [`policy.yml is not valid YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
  if (doc === null || doc === undefined) return { policy: DEFAULT_POLICY, errors: [] };
  if (!isObj(doc)) return { policy: DEFAULT_POLICY, errors: ['policy.yml must be a mapping at the top level'] };

  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) errors.push(`unknown top-level key "${k}" (expected extends, rules, disable, neverCollapse)`);
  const ext = doc.extends ?? 'default';
  if (ext !== 'default' && ext !== 'none') errors.push(`"extends" must be "default" or "none"`);

  const userRules: RiskRule[] = [];
  if (doc.rules !== undefined) {
    if (!Array.isArray(doc.rules)) errors.push('"rules" must be a list');
    else if (doc.rules.length > MAX_RULES) errors.push(`"rules" has more than ${MAX_RULES} entries`);
    else {
      const seen = new Set<string>();
      doc.rules.forEach((r, i) => {
        const rule = parseRule(r, i, errors);
        if (!rule) return;
        if (seen.has(rule.id)) errors.push(`rule "${rule.id}" is defined twice`);
        seen.add(rule.id);
        if (rule.id === LENS_POLICY_RULE.id) errors.push('rule "lens-policy" is built in and cannot be overridden');
        else userRules.push(rule);
      });
    }
  }

  const disable = strList(doc.disable, '"disable"', errors) ?? [];
  const known = new Set([...(ext === 'none' ? [] : DEFAULT_RULES.map((r) => r.id)), ...userRules.map((r) => r.id)]);
  for (const id of disable) {
    if (id === LENS_POLICY_RULE.id) errors.push('"lens-policy" cannot be disabled');
    else if (!known.has(id)) errors.push(`"disable" names unknown rule "${id}"`);
  }
  const neverCollapse = strList(doc.neverCollapse, '"neverCollapse"', errors) ?? [];
  for (const g of neverCollapse) {
    try { picomatch(g); } catch (e) { errors.push(`"neverCollapse": bad glob "${g}": ${(e as Error).message}`); }
  }
  if (errors.length) return { policy: DEFAULT_POLICY, errors };

  const overrides = new Map(userRules.map((r) => [r.id, r]));
  const base = ext === 'none' ? [] : DEFAULT_RULES.filter((r) => r.id !== LENS_POLICY_RULE.id);
  const merged = base.map((r) => overrides.get(r.id) ?? r);
  const baseIds = new Set(base.map((r) => r.id));
  for (const r of userRules) if (!baseIds.has(r.id)) merged.push(r);
  const off = new Set(disable);
  const rules = [...merged.filter((r) => !off.has(r.id)), LENS_POLICY_RULE];
  return { policy: { rules, neverCollapse: [...new Set(['.lens/**', ...neverCollapse])] }, errors: [] };
}
