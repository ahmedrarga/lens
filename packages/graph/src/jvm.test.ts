import { describe, expect, it } from 'vitest';
import { ChangeGraph, type BuildGraphInput, type ParsedHunk, type PrFile, type PrRef } from '@lens/core';
import { assertCoverage, buildGraph, isTestPath } from './index.js';
import { createModuleResolver } from './jvm.js';

const pr: PrRef = {
  provider: 'gitlab', owner: 'o', repo: 'r', number: 1, url: 'u', title: 't', body: null, author: null,
  baseSha: 'b', headSha: 'h', baseRef: 'main', headRef: 'feat',
};
const J = 'src/main/java/com/acme/shop';
const T = 'src/test/java/com/acme/shop';

function build(paths: string[]) {
  const files: PrFile[] = paths.map((path) => ({ path, status: 'modified', additions: 1, deletions: 0 }));
  const hunks: ParsedHunk[] = paths.map((path, i) => ({
    id: `h${i}`, path, oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, added: 1, removed: 0, patch: '@@ -1,0 +1,1 @@\n+x',
  }));
  const empty = { symbols: [], references: [], limits: [] };
  const input: BuildGraphInput = { pr, files, hunks, head: empty, base: empty, skippedFiles: [], limits: [], durationMs: 1 };
  const g = buildGraph(input, { now: () => new Date(0) });
  expect(() => ChangeGraph.parse(g)).not.toThrow();
  expect(assertCoverage(g)).toEqual([]);
  return g;
}
const modules = (g: ChangeGraph) => g.nodes.filter((n) => n.kind === 'module').map((n) => `${n.id} | ${n.label}`).sort();
const parentModule = (g: ChangeGraph, id: string) => {
  let n = g.nodes.find((x) => x.id === id);
  while (n?.parent) n = g.nodes.find((x) => x.id === n!.parent);
  return n?.id;
};

describe('JVM module mapping', () => {
  it('splits a single-module Spring Boot app by package under the common base', () => {
    const g = build([
      `${J}/orders/OrderService.java`, `${J}/orders/OrderController.java`, `${J}/billing/InvoiceService.java`,
      `${J}/orders/dto/OrderDto.java`,
    ]);
    expect(modules(g)).toEqual(['module:java:com.acme.shop.billing | billing', 'module:java:com.acme.shop.orders | orders']);
  });

  it('module ids and labels for sub-packages', () => {
    const r = createModuleResolver([`${J}/orders/OrderService.java`, `${J}/orders/dto/OrderDto.java`, `${J}/billing/Invoice.java`]);
    expect(r(`${J}/orders/OrderService.java`)).toMatchObject({ key: 'java:com.acme.shop.orders', label: 'orders', path: `${J}/orders` });
    // deeper packages roll up into the first segment below the base package
    expect(r(`${J}/orders/dto/OrderDto.java`).key).toBe('java:com.acme.shop.orders');
    expect(r(`${J}/billing/Invoice.java`).label).toBe('billing');
  });

  it('a single changed package still gets a readable module name', () => {
    const r = createModuleResolver([`${J}/orders/OrderService.java`, `${J}/orders/OrderRepository.java`]);
    expect(r(`${J}/orders/OrderService.java`)).toMatchObject({ key: 'java:com.acme.shop.orders', label: 'orders' });
  });

  it('files in the base package itself use the base package name', () => {
    const r = createModuleResolver([`${J}/Application.java`, `${J}/orders/OrderService.java`]);
    expect(r(`${J}/Application.java`)).toMatchObject({ key: 'java:com.acme.shop', label: 'shop' });
    expect(r(`${J}/orders/OrderService.java`).label).toBe('orders');
  });

  it('maps test sources to the same module as the main package', () => {
    const g = build([`${J}/orders/OrderService.java`, `${T}/orders/OrderServiceTest.java`, `${J}/billing/Invoice.java`]);
    expect(parentModule(g, `file:${T}/orders/OrderServiceTest.java`)).toBe('module:java:com.acme.shop.orders');
    expect(parentModule(g, `file:${J}/orders/OrderService.java`)).toBe('module:java:com.acme.shop.orders');
    expect(modules(g)).toEqual(['module:java:com.acme.shop.billing | billing', 'module:java:com.acme.shop.orders | orders']);
  });

  it('puts migrations and other resources into their own modules', () => {
    const r = createModuleResolver([
      `${J}/orders/OrderService.java`, 'src/main/resources/db/migration/V2__add_col.sql',
      'src/main/resources/application.yml', 'src/main/resources/templates/mail.html', 'src/test/resources/application-test.yml',
      'src/main/resources/db/changelog/db.changelog-master.yaml',
    ]);
    expect(r('src/main/resources/db/migration/V2__add_col.sql')).toMatchObject({ key: 'resources:db-migration', label: 'db migrations' });
    expect(r('src/main/resources/db/changelog/db.changelog-master.yaml').label).toBe('db migrations');
    expect(r('src/main/resources/application.yml')).toMatchObject({ key: 'resources:config', label: 'config & resources' });
    expect(r('src/main/resources/templates/mail.html').key).toBe('resources:config');
    expect(r('src/test/resources/application-test.yml').key).toBe('resources:config');
  });

  it('Java migrations in a db.migration package do not pull the base package up', () => {
    const r = createModuleResolver([
      'src/main/java/com/acme/shop/orders/OrderService.java', 'src/main/java/db/migration/V3__Backfill.java',
    ]);
    expect(r('src/main/java/db/migration/V3__Backfill.java').label).toBe('db migrations');
    expect(r('src/main/java/com/acme/shop/orders/OrderService.java').label).toBe('orders');
  });

  it('prefixes multi-module repos with the build module', () => {
    const r = createModuleResolver([
      'billing/src/main/java/com/acme/billing/invoice/Invoice.java', 'billing/src/test/java/com/acme/billing/invoice/InvoiceTest.java',
      'orders/src/main/java/com/acme/orders/api/OrderApi.java', 'orders/src/main/java/com/acme/orders/core/Core.java',
      'orders/src/main/resources/application.yml',
    ]);
    expect(r('billing/src/main/java/com/acme/billing/invoice/Invoice.java')).toMatchObject({
      key: 'billing/java:com.acme.billing.invoice', label: 'billing: invoice', path: 'billing/src/main/java/com/acme/billing/invoice',
    });
    expect(r('billing/src/test/java/com/acme/billing/invoice/InvoiceTest.java').key).toBe('billing/java:com.acme.billing.invoice');
    expect(r('orders/src/main/java/com/acme/orders/api/OrderApi.java').label).toBe('orders: api');
    expect(r('orders/src/main/resources/application.yml')).toMatchObject({ key: 'orders/resources:config', label: 'orders: config & resources' });
  });

  it('supports Kotlin and keeps the same module as Java in the same package', () => {
    const r = createModuleResolver(['src/main/kotlin/com/acme/a/X.kt', 'src/main/java/com/acme/a/Y.java', 'src/main/kotlin/com/acme/b/Z.kt']);
    expect(r('src/main/kotlin/com/acme/a/X.kt').key).toBe(r('src/main/java/com/acme/a/Y.java').key);
  });

  it('keeps the first-two-segments rule for non-JVM paths', () => {
    const r = createModuleResolver(['web/src/app/x.ts', 'pom.xml', 'billing/pom.xml']);
    expect(r('web/src/app/x.ts')).toMatchObject({ key: 'web/src', label: 'web/src' });
    expect(r('pom.xml').key).toBe('.');
    expect(r('billing/pom.xml').key).toBe('billing');
  });
});

describe('Java test attachment', () => {
  it('recognises JVM test paths', () => {
    for (const p of [
      'src/test/java/a/B.java', 'x/src/main/java/a/OrderServiceTest.java', 'a/OrderServiceTests.java', 'a/OrderRepoIT.java',
      'a/OrderTestCase.java', 'a/OrderServiceTest.kt',
    ]) expect(isTestPath(p), p).toBe(true);
    for (const p of ['src/main/java/a/WAIT.java', 'src/main/java/a/Contest.java', 'src/main/java/a/OrderService.java', 'a/Test.txt']) {
      expect(isTestPath(p), p).toBe(false);
    }
  });

  it('attaches OrderServiceTest to the OrderService cluster by name', () => {
    const g = build([
      `${J}/orders/OrderService.java`, `${J}/billing/Invoice.java`, `${T}/orders/OrderServiceTest.java`,
      `${T}/billing/InvoiceIT.java`, `${T}/orders/OrderServiceIntegrationTest.java`,
    ]);
    const cl = (p: string) => g.nodes.find((n) => n.id === `file:${p}`)!.parent;
    expect(cl(`${T}/orders/OrderServiceTest.java`)).toBe(cl(`${J}/orders/OrderService.java`));
    expect(cl(`${T}/orders/OrderServiceIntegrationTest.java`)).toBe(cl(`${J}/orders/OrderService.java`));
    expect(cl(`${T}/billing/InvoiceIT.java`)).toBe(cl(`${J}/billing/Invoice.java`));
    expect(cl(`${J}/orders/OrderService.java`)).not.toBe(cl(`${J}/billing/Invoice.java`));
  });

  it('groups an unmatched test under its module as a Tests cluster', () => {
    const g = build([`${J}/orders/OrderService.java`, `${T}/orders/SomethingElseTest.java`]);
    const t = g.nodes.find((n) => n.id === `file:${T}/orders/SomethingElseTest.java`)!;
    const cluster = g.nodes.find((n) => n.id === t.parent)!;
    expect(cluster.parent).toBe('module:java:com.acme.shop.orders');
    expect(cluster.label).toMatch(/^Tests:/);
  });
});
