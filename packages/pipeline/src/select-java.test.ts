import { describe, expect, it } from 'vitest';
import { javaPackageFromPath, selectJavaSnapshot } from './select-java.js';

const R = 'svc/src/main/java/';
const files = new Map<string, string>([
  [`${R}com/a/web/OrderController.java`, `package com.a.web;\nimport com.a.service.OrderService;\nclass OrderController { OrderService s; }`],
  [`${R}com/a/web/Other.java`, `package com.a.web;\nclass Other {}`],
  [`${R}com/a/service/OrderService.java`, `package com.a.service;\npublic interface OrderService {}`],
  [`${R}com/a/service/OrderServiceImpl.java`, `package com.a.service;\nimport com.a.base.*;\n@Service class OrderServiceImpl extends BaseService implements OrderService {}`],
  [`${R}com/a/base/BaseService.java`, `package com.a.base;\npublic abstract class BaseService extends Root {}`],
  [`${R}com/a/base/Root.java`, `package com.a.base;\npublic class Root {}`],
  [`${R}com/a/base/Unused.java`, `package com.a.base;\nclass Unused {}`],
  [`${R}com/a/job/Wild.java`, `package com.a.job;\nimport com.a.service.*;\nclass Wild { OrderService s; }`],
  [`${R}com/a/job/WildNoMention.java`, `package com.a.job;\nimport com.a.service.*;\nclass WildNoMention { }`],
  [`${R}com/a/job/Static.java`, `package com.a.job;\nimport static com.a.base.Root.helper;\nclass Static { }`],
  [`${R}com/a/misc/Far.java`, `package com.a.misc;\nclass Far {}`],
]);

describe('selectJavaSnapshot', () => {
  it('changed impl pulls in importers of its interface, supertypes and same-package files', () => {
    const r = selectJavaSnapshot({ allFiles: files, changed: [`${R}com/a/service/OrderServiceImpl.java`] });
    const set = new Set(r.paths);
    expect(r.paths[0]).toBe(`${R}com/a/service/OrderServiceImpl.java`);
    for (const p of [
      'web/OrderController', 'service/OrderService', 'base/BaseService', 'base/Root', 'job/Wild',
    ]) expect(set.has(`${R}com/a/${p}.java`)).toBe(true);
    expect(set.has(`${R}com/a/job/WildNoMention.java`)).toBe(false);
    expect(set.has(`${R}com/a/misc/Far.java`)).toBe(false);
    expect(set.has(`${R}com/a/web/Other.java`)).toBe(false);
  });
  it('imports of a changed type by FQN, static import of members, and package siblings', () => {
    const r = selectJavaSnapshot({ allFiles: files, changed: [`${R}com/a/base/Root.java`] });
    const set = new Set(r.paths);
    expect(set.has(`${R}com/a/job/Static.java`)).toBe(true);
    expect(set.has(`${R}com/a/base/Unused.java`)).toBe(true);
    expect(set.has(`${R}com/a/misc/Far.java`)).toBe(false);
  });
  it('caps with a note, changed files first', () => {
    const r = selectJavaSnapshot({ allFiles: files, changed: [`${R}com/a/base/Root.java`], cap: 2 });
    expect(r.paths).toHaveLength(2);
    expect(r.paths[0]).toBe(`${R}com/a/base/Root.java`);
    expect(r.limits[0]).toMatch(/2 of \d+ relevant Java files/);
  });
  it('derives packages from Maven/Gradle source roots', () => {
    expect(javaPackageFromPath('mod/sub/src/test/java/com/x/FooTest.java')).toBe('com.x');
    expect(javaPackageFromPath('src/main/java/Top.java')).toBe('');
    expect(javaPackageFromPath('README.md')).toBeNull();
  });
});
