import { describe, expect, it } from 'vitest';
import { createJavaIndexer, type JavaIndexResult } from './index.js';

const run = (files: Record<string, string>): Promise<JavaIndexResult> =>
  createJavaIndexer().index({ files: new Map(Object.entries(files)) });
const has = (r: JavaIndexResult, kind: string, from: string, to: string) =>
  r.references.some((x) => x.kind === kind && x.from === from && x.to === to && x.resolved);

const P = 'src/main/java/com/acme/';
const spring: Record<string, string> = {
  [`${P}web/OrderController.java`]: `package com.acme.web;

import com.acme.service.OrderService;
import com.acme.model.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  private final OrderService orders;

  public OrderController(OrderService orders) { this.orders = orders; }

  @PostMapping("/{id}/cancel")
  @PreAuthorize("hasRole('ADMIN')")
  public Order cancel(@PathVariable Long id) {
    return orders.cancel(id);
  }

  @GetMapping
  public java.util.List<Order> all() { return orders.findAll(); }

  @RequestMapping(value = "/legacy", method = RequestMethod.DELETE)
  public void legacy() { Util.log("x"); }
}
`,
  [`${P}web/Util.java`]: `package com.acme.web;
public class Util { public static void log(String s) {} }
`,
  [`${P}service/OrderService.java`]: `package com.acme.service;
import com.acme.model.Order;
import java.util.List;
public interface OrderService {
  Order cancel(Long id);
  List<Order> findAll();
}
`,
  [`${P}service/OrderServiceImpl.java`]: `package com.acme.service;

import com.acme.model.Order;
import com.acme.model.Status;
import com.acme.repo.OrderRepository;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Default impl. */
@Service
@Transactional
public class OrderServiceImpl extends BaseService implements OrderService {
  @Autowired private AuditLog audit;
  private final OrderRepository repo;

  public OrderServiceImpl(OrderRepository repo) { this.repo = repo; }

  @Override
  public Order cancel(Long id) {
    Order o = repo.findById(id).orElseThrow();
    o.setStatus(Status.CANCELLED);
    repo.save(o);
    touch();
    audit.record("cancel");
    return o;
  }

  public Order cancel(Long id, String reason) { return cancel(id); }

  @Override
  public List<Order> findAll() { return repo.findByStatus(Status.OPEN); }

  @Scheduled(cron = "0 0 * * *")
  void nightly() { helper.go(); list.forEach(x -> x.run()); }

  static class Inner { void f() {} }
}
`,
  [`${P}service/BaseService.java`]: `package com.acme.service;
public abstract class BaseService { protected void touch() {} }
`,
  [`${P}service/AuditLog.java`]: `package com.acme.service;
public class AuditLog { public void record(String s) {} }
`,
  [`${P}repo/OrderRepository.java`]: `package com.acme.repo;
import com.acme.model.Order;
import org.springframework.data.jpa.repository.JpaRepository;
public interface OrderRepository extends JpaRepository<Order, Long> {
  java.util.List<Order> findByStatus(com.acme.model.Status s);
}
`,
  [`${P}model/Order.java`]: `package com.acme.model;
import jakarta.persistence.*;
@Entity
@Table(name = "orders")
public class Order {
  @Id private Long id;
  private Status status;
  public void setStatus(Status s) { this.status = s; }
}
`,
  [`${P}model/Status.java`]: `package com.acme.model;
public enum Status { OPEN, CANCELLED }
`,
};

describe('java indexer', () => {
  it('extracts symbols with ranges, kinds, overload merging and nesting', async () => {
    const r = await run(spring);
    const by = Object.fromEntries(r.symbols.map((s) => [s.id, s]));
    const svc = `${P}service/OrderServiceImpl.java`;
    expect(by[`${svc}#OrderServiceImpl`]).toMatchObject({ kind: 'class', exported: true, range: { start: 10, end: 38 } });
    // Javadoc included, merged overloads span both
    expect(by[`${svc}#OrderServiceImpl.cancel`]!.range).toEqual({ start: 19, end: 29 });
    expect(by[`${svc}#OrderServiceImpl.cancel`]).toMatchObject({ kind: 'method', container: `${svc}#OrderServiceImpl` });
    expect(by[`${svc}#OrderServiceImpl.constructor`]).toBeDefined();
    expect(by[`${svc}#OrderServiceImpl.repo`]).toMatchObject({ kind: 'variable', exported: false });
    expect(by[`${svc}#OrderServiceImpl.Inner`]).toMatchObject({ kind: 'class', container: `${svc}#OrderServiceImpl` });
    expect(by[`${svc}#OrderServiceImpl.Inner.f`]).toBeDefined();
    expect(by[`${P}model/Status.java#Status`]!.kind).toBe('enum');
    expect(by[`${P}service/OrderService.java#OrderService`]!.kind).toBe('interface');
    expect(by[`${svc}#<module>`]).toMatchObject({ kind: 'other', range: { start: 1 } });
  });

  it('resolves DI, interface-to-impl calls, repository calls, static calls, inheritance', async () => {
    const r = await run(spring);
    const ctl = `${P}web/OrderController.java`;
    const svcI = `${P}service/OrderService.java`;
    const impl = `${P}service/OrderServiceImpl.java`;
    // controller -> service interface method, plus the single bean implementation
    expect(has(r, 'calls', `${ctl}#OrderController.cancel`, `${svcI}#OrderService.cancel`)).toBe(true);
    expect(has(r, 'calls', `${ctl}#OrderController.cancel`, `${impl}#OrderServiceImpl.cancel`)).toBe(true);
    // DI + type refs
    expect(has(r, 'references', `${ctl}#OrderController`, `${svcI}#OrderService`)).toBe(true);
    expect(has(r, 'references', `${impl}#OrderServiceImpl`, `${P}repo/OrderRepository.java#OrderRepository`)).toBe(true);
    expect(has(r, 'references', `${impl}#OrderServiceImpl`, `${P}service/AuditLog.java#AuditLog`)).toBe(true);
    // wildcard import resolves Order
    expect(has(r, 'references', `${ctl}#OrderController.cancel`, `${P}model/Order.java#Order`)).toBe(true);
    expect(has(r, 'imports', `${ctl}#<module>`, `${P}model/Order.java#<module>`)).toBe(true);
    expect(has(r, 'imports', `${ctl}#<module>`, `${svcI}#<module>`)).toBe(true);
    // static call in same package
    expect(has(r, 'calls', `${ctl}#OrderController.legacy`, `${P}web/Util.java#Util.log`)).toBe(true);
    // repository: declared method resolves; derived (findById/save) omitted
    expect(has(r, 'calls', `${impl}#OrderServiceImpl.findAll`, `${P}repo/OrderRepository.java#OrderRepository.findByStatus`)).toBe(true);
    expect(r.references.some((x) => x.to?.endsWith('OrderRepository.findById') || x.to?.endsWith('.save'))).toBe(false);
    // inherited method from snapshot superclass, call on field
    expect(has(r, 'calls', `${impl}#OrderServiceImpl.cancel`, `${P}service/BaseService.java#BaseService.touch`)).toBe(true);
    expect(has(r, 'calls', `${impl}#OrderServiceImpl.cancel`, `${P}service/AuditLog.java#AuditLog.record`)).toBe(true);
    // local variable receiver
    expect(has(r, 'calls', `${impl}#OrderServiceImpl.cancel`, `${P}model/Order.java#Order.setStatus`)).toBe(true);
    // enum constant usage -> reference to the enum
    expect(has(r, 'references', `${impl}#OrderServiceImpl.cancel`, `${P}model/Status.java#Status`)).toBe(true);
    // overload calling overload: no self edge
    expect(r.references.some((x) => x.from === x.to)).toBe(false);
    expect(r.limits.some((l) => l.includes('Spring DI resolved to single implementations'))).toBe(true);
  });

  it('marks unknown receivers unresolved, and omits externals', async () => {
    const r = await run({
      'a/Foo.java': `package a;
import java.util.List;
class Foo {
  void run(List<String> l) { l.forEach(x -> x.go()); String s = "x"; s.trim(); var v = make(); v.go(); }
  void go() {}
}`,
    });
    const un = r.references.filter((x) => !x.resolved);
    expect(un.map((x) => x.toText)).toEqual(['x.go()']);
    expect(un[0]).toMatchObject({ from: 'a/Foo.java#Foo.run', kind: 'calls', resolved: false });
    expect(r.references.filter((x) => x.resolved)).toEqual([]);
  });

  it('does not wire DI to implementations when ambiguous or not beans', async () => {
    const r = await run({
      'p/I.java': `package p; public interface I { void m(); }`,
      'p/A.java': `package p; @Service public class A implements I { public void m() {} }`,
      'p/B.java': `package p; @Component public class B implements I { public void m() {} }`,
      'p/U.java': `package p; @Service public class U { private final I i; U(I i){this.i=i;} void x(){ i.m(); } }`,
      'q/J.java': `package q; public interface J { void m(); }`,
      'q/C.java': `package q; public class C implements J { public void m() {} }`,
      'q/V.java': `package q; @Service public class V { @Autowired J j; void x(){ j.m(); } }`,
    });
    expect(has(r, 'calls', 'p/U.java#U.x', 'p/I.java#I.m')).toBe(true);
    expect(r.references.some((x) => x.from === 'p/U.java#U.x' && x.to !== 'p/I.java#I.m' && x.kind === 'calls')).toBe(false);
    expect(has(r, 'calls', 'q/V.java#V.x', 'q/J.java#J.m')).toBe(true);
    expect(has(r, 'calls', 'q/V.java#V.x', 'q/C.java#C.m')).toBe(false);
    expect(has(r, 'references', 'q/V.java#V', 'q/J.java#J')).toBe(true); // @Autowired field DI
  });

  it('handles Lombok constructor injection, record accessors and Data getters', async () => {
    const r = await run({
      'a/Dep.java': `package a; public class Dep { public void go() {} }`,
      'a/Dto.java': `package a; @lombok.Data public class Dto { private String name; }`,
      'a/Rec.java': `package a; public record Rec(String id, Dep dep) {}`,
      'a/S.java': `package a;
@Service @RequiredArgsConstructor
public class S {
  private final Dep dep;
  private final String notDep = "x";
  void run(Dto d, Rec r) { dep.go(); d.getName(); r.id(); r.dep().go(); }
}`,
    });
    expect(has(r, 'references', 'a/S.java#S', 'a/Dep.java#Dep')).toBe(true);
    expect(has(r, 'calls', 'a/S.java#S.run', 'a/Dep.java#Dep.go')).toBe(true);
    expect(has(r, 'references', 'a/S.java#S.run', 'a/Dto.java#Dto.name')).toBe(true);
    expect(has(r, 'calls', 'a/S.java#S.run', 'a/Rec.java#Rec.id')).toBe(true);
    const by = Object.fromEntries(r.symbols.map((s) => [s.id, s]));
    expect(by['a/Rec.java#Rec']!.kind).toBe('class');
    expect(by['a/Rec.java#Rec.dep']!.kind).toBe('variable');
  });

  it('resolves nested types, single-type imports over wildcard, and static imports', async () => {
    const r = await run({
      'x/Outer.java': `package x; public class Outer { public static class In { public void a() {} } public static int k() { return 1; } }`,
      'y/Outer.java': `package y; public class Outer {}`,
      'z/Use.java': `package z;
import x.Outer;
import y.*;
import static x.Outer.k;
class Use { void m() { Outer.In i = new Outer.In(); i.a(); k(); } }`,
    });
    expect(has(r, 'calls', 'z/Use.java#Use.m', 'x/Outer.java#Outer.In.a')).toBe(true);
    expect(has(r, 'calls', 'z/Use.java#Use.m', 'x/Outer.java#Outer.k')).toBe(true);
    expect(has(r, 'references', 'z/Use.java#Use.m', 'x/Outer.java#Outer.In')).toBe(true);
    expect(has(r, 'imports', 'z/Use.java#<module>', 'x/Outer.java#<module>')).toBe(true);
    expect(r.references.some((x) => x.to?.startsWith('y/'))).toBe(false);
  });

  it('extracts Spring annotations: routes with class prefix, beans, entities, transactions, schedules, security', async () => {
    const r = await run(spring);
    const a = r.annotations!;
    const ctl = `${P}web/OrderController.java`;
    expect(a[ctl + '#OrderController']).toEqual(expect.arrayContaining(['bean: @RestController', 'route prefix: /api/orders']));
    expect(a[ctl + '#OrderController.cancel']).toEqual(
      expect.arrayContaining(['route: POST /api/orders/{id}/cancel', "security: @PreAuthorize(hasRole('ADMIN'))"]));
    expect(a[ctl + '#OrderController.all']).toContain('route: GET /api/orders');
    expect(a[ctl + '#OrderController.legacy']).toContain('route: DELETE /api/orders/legacy');
    const impl = `${P}service/OrderServiceImpl.java`;
    expect(a[impl + '#OrderServiceImpl']).toEqual(expect.arrayContaining(['bean: @Service', 'transactional']));
    expect(a[impl + '#OrderServiceImpl.nightly']).toContain('scheduled: cron 0 0 * * *');
    expect(a[impl + '#OrderServiceImpl.audit']).toContain('injected: @Autowired');
    expect(a[`${P}model/Order.java#Order`]).toContain('entity: orders table');
    expect(a[`${P}repo/OrderRepository.java#OrderRepository`]).toContain('repository: Spring Data (JpaRepository)');
  });

  it('resolves route path constants', async () => {
    const r = await run({
      'a/Paths.java': `package a; public class Paths { public static final String BASE = "/v1"; }`,
      'a/C.java': `package a; @RestController @RequestMapping(Paths.BASE + "/x") class C { static final String Y = "/y";
        @GetMapping(Y) void m() {} @PostMapping(path = {"/a", "b/"}) void n() {} }`,
    });
    expect(r.annotations!['a/C.java#C.m']).toEqual(['route: GET /v1/x/y']);
    expect(r.annotations!['a/C.java#C.n']).toEqual(['route: POST /v1/x/a', 'route: POST /v1/x/b']);
  });

  it('is robust to empty input and syntax errors', async () => {
    expect((await run({})).symbols).toEqual([]);
    const r = await run({ 'a/Bad.java': 'package a; public class Bad { void m( { ' });
    expect(r.symbols.some((s) => s.id === 'a/Bad.java#<module>')).toBe(true);
  });
});
