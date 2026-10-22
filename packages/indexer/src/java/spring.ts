// Spring-specific facts derived from annotations. Pure functions over the declaration model.
import type { Node } from './parser.js';
import type { AnnInfo, FieldInfo, MethodInfo, TypeInfo } from './model.js';

export const BEAN_ANNS = new Set([
  'Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration', 'ControllerAdvice',
  'RestControllerAdvice', 'Named', 'SpringBootApplication', 'FeignClient',
]);
export const INJECT_ANNS = new Set(['Autowired', 'Inject', 'Resource']);
const REPO_RE = /(^|\.)\w*Repository$/;
const HTTP: Record<string, string> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};

export interface SpringCtx {
  /** Evaluate a string expression (literals, constants, `+`) in the scope of class `t`. */
  evalStr(node: Node, t: TypeInfo): string | undefined;
}

const clip = (s: string, n = 110) => {
  const c = s.replace(/\s+/g, ' ').trim();
  return c.length > n ? c.slice(0, n - 3) + '...' : c;
};
const find = (anns: AnnInfo[], ...names: string[]) => anns.find((a) => names.includes(a.name));
const strs = (a: AnnInfo, key: string, t: TypeInfo, ctx: SpringCtx): string[] =>
  (a.args.get(key) ?? []).map((n) => ctx.evalStr(n, t) ?? clip(n.text, 40));
const firstStr = (a: AnnInfo | undefined, t: TypeInfo, ctx: SpringCtx, ...keys: string[]): string | undefined => {
  if (!a) return undefined;
  for (const k of keys) { const v = strs(a, k, t, ctx)[0]; if (v !== undefined) return v; }
  return undefined;
};
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const raw = (a: AnnInfo) => clip(a.node.text, 100);

export function joinPath(prefix: string, path: string): string {
  const j = `/${prefix}/${path}`.replace(/\/+/g, '/');
  return j.length > 1 && j.endsWith('/') ? j.slice(0, -1) : j;
}

export function classPrefix(t: TypeInfo, ctx: SpringCtx): string {
  return firstStr(find(t.anns, 'RequestMapping'), t, ctx, 'value', 'path') ?? '';
}

function routes(anns: AnnInfo[], prefix: string, t: TypeInfo, ctx: SpringCtx): string[] {
  const out: string[] = [];
  for (const a of anns) {
    const fixed = HTTP[a.name];
    if (!fixed && a.name !== 'RequestMapping') continue;
    let methods = fixed ? [fixed] : [];
    if (!fixed) {
      const txt = (a.args.get('method') ?? []).map((n) => n.text).join(' ');
      methods = [...new Set(txt.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\b/g) ?? [])];
      if (!methods.length) methods = ['ANY'];
    }
    const paths = [...strs(a, 'value', t, ctx), ...strs(a, 'path', t, ctx)];
    if (!paths.length) paths.push('');
    for (const m of methods) for (const p of paths) out.push(`route: ${m} ${joinPath(prefix, p)}`);
  }
  return out;
}

function common(anns: AnnInfo[], t: TypeInfo, ctx: SpringCtx): string[] {
  const out: string[] = [];
  const tx = find(anns, 'Transactional');
  if (tx) {
    const ro = (tx.args.get('readOnly') ?? []).some((n) => n.text === 'true');
    out.push(ro ? 'transactional (readOnly)' : 'transactional');
  }
  for (const a of anns) {
    switch (a.name) {
      case 'Scheduled': {
        const k = ['cron', 'fixedRate', 'fixedDelay', 'fixedRateString', 'fixedDelayString'].find((x) => a.args.has(x));
        out.push(`scheduled: ${k ? `${k} ${strs(a, k, t, ctx)[0]}` : raw(a)}`);
        break;
      }
      case 'PreAuthorize': case 'PostAuthorize': case 'PreFilter': case 'PostFilter':
        out.push(`security: @${a.name}(${strs(a, 'value', t, ctx)[0] ?? ''})`);
        break;
      case 'Secured': case 'RolesAllowed':
        out.push(`security: @${a.name}(${strs(a, 'value', t, ctx).join(', ')})`);
        break;
      case 'PermitAll': case 'DenyAll':
        out.push(`security: @${a.name}`);
        break;
      case 'Async': out.push('async'); break;
      case 'EventListener': case 'KafkaListener': case 'RabbitListener': case 'JmsListener': case 'SqsListener':
      case 'TransactionalEventListener':
        out.push(`listener: ${raw(a)}`);
        break;
      case 'Cacheable': case 'CacheEvict': case 'CachePut': case 'Caching':
        out.push(`cache: ${raw(a)}`);
        break;
      default:
    }
  }
  return out;
}

export function annotateType(t: TypeInfo, ctx: SpringCtx, isBean: boolean): string[] {
  const out: string[] = [];
  const direct = t.anns.filter((a) => BEAN_ANNS.has(a.name));
  for (const a of direct) out.push(`bean: @${a.name}`);
  if (!direct.length && isBean) out.push('bean: via meta-annotation');
  if (t.kind === 'interface' && t.ifaceRaw.some((n) => REPO_RE.test(n))) {
    out.push(`repository: Spring Data (${t.ifaceRaw.find((n) => REPO_RE.test(n))!.replace(/^.*\./, '')})`);
  }
  const prefix = classPrefix(t, ctx);
  if (find(t.anns, 'RequestMapping') && prefix) out.push(`route prefix: ${joinPath('', prefix)}`);
  const ent = find(t.anns, 'Entity', 'Table');
  if (ent) {
    const tbl = firstStr(find(t.anns, 'Table'), t, ctx, 'name');
    out.push(tbl ? `entity: ${tbl} table` : `entity: ${snake(t.simple)} table (default naming)`);
  }
  if (find(t.anns, 'Embeddable')) out.push('entity: embeddable');
  if (find(t.anns, 'MappedSuperclass')) out.push('entity: mapped superclass');
  const doc = find(t.anns, 'Document');
  if (doc) out.push(`entity: document ${firstStr(doc, t, ctx, 'collection', 'value') ?? t.simple}`);
  const cp = find(t.anns, 'ConfigurationProperties');
  if (cp) out.push(`config: prefix ${firstStr(cp, t, ctx, 'prefix', 'value') ?? ''}`.trim());
  const fc = find(t.anns, 'FeignClient');
  if (fc) out.push(`client: Feign ${firstStr(fc, t, ctx, 'name', 'value', 'url') ?? ''}`.trim());
  out.push(...common(t.anns, t, ctx));
  return out;
}

export function annotateMethod(t: TypeInfo, overloads: MethodInfo[], ctx: SpringCtx, controller: boolean, prefix: string): string[] {
  const out: string[] = [];
  for (const m of overloads) {
    if (controller || t.kind === 'interface') out.push(...routes(m.anns, prefix, t, ctx));
    out.push(...common(m.anns, t, ctx));
    if (find(m.anns, 'Bean')) out.push('bean: @Bean');
    const ex = find(m.anns, 'ExceptionHandler');
    if (ex) out.push(`exception handler: ${raw(ex)}`);
    const q = find(m.anns, 'Query');
    if (q) {
      const sql = strs(q, 'value', t, ctx)[0] ?? '';
      out.push(`query: ${clip(sql)}${(q.args.get('nativeQuery') ?? []).some((n) => n.text === 'true') ? ' (native)' : ''}`);
    }
    if (find(m.anns, 'Modifying')) out.push('modifying query');
  }
  return out;
}

export function annotateField(f: FieldInfo, ctx: SpringCtx): string[] {
  const out: string[] = [];
  const t = f.owner;
  for (const a of f.anns) {
    if (INJECT_ANNS.has(a.name)) out.push(`injected: @${a.name}`);
    else if (a.name === 'Value') out.push(`config: ${raw(a)}`);
    else if (a.name === 'Id' || a.name === 'EmbeddedId' || a.name === 'Version') out.push(`jpa: @${a.name}`);
    else if (a.name === 'Column' || a.name === 'JoinColumn') out.push(`column: ${firstStr(a, t, ctx, 'name') ?? snake(f.name)}`);
    else if (['OneToMany', 'ManyToOne', 'OneToOne', 'ManyToMany'].includes(a.name)) out.push(`relation: @${a.name}`);
  }
  return out;
}
