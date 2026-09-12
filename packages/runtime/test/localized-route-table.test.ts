import { describe, expect, it } from 'vitest';

import {
  localizedRouteTable,
  type LocalizedRouteTableProblem,
} from '../router/src/route-table.js';
import {
  type LocaleUrlPolicy,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * No Angular here, and that is the point of the suite rather than a convenience.
 *
 * Angular validates a route config only behind `ngDevMode`, so a check that runs inside a
 * bootstrapped application proves nothing about the production path: there, Angular catches the
 * malformed entry for Atlas and the check passes for the wrong reason. `route-table.ts` erases to
 * plain functions over plain objects precisely so this suite can exercise the shipped code with
 * nothing bootstrapped.
 */

// Distinct object identities, so "the branch reuses the canonical loader" can be asserted by
// reference rather than by shape. Two entries that merely look alike would pass a deep comparison
// while emitting two chunks.
//
// Each resolves to a real class because `Routes` requires one: a loader returning `{}` is not a
// component, and typing these loosely is how twenty-one type errors sat here while the tests
// passed and the build reported success.
class StubComponent {}
const HOME = () => Promise.resolve(StubComponent);
const SECOND = () => Promise.resolve(StubComponent);
const ARTICLE = () => Promise.resolve(StubComponent);
const SECTION = () => Promise.resolve([]);

const CANONICAL = [
  { path: '', pathMatch: 'full' as const, loadComponent: HOME },
  { path: 'second', loadComponent: SECOND },
  { path: 'articles/:slug', loadComponent: ARTICLE },
  { path: 'section', loadChildren: SECTION },
  { path: '**', loadComponent: HOME },
];

const POLICY: LocaleUrlPolicy = {
  kind: 'path-prefix',
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  prefixes: { 'en-us': 'en-US', 'ar-eg': 'ar-EG' },
  aliases: {},
  localeNeutralRoots: [],
  omitDefaultPrefix: false,
};

/**
 * The anti-cheat the design requires: at least one address whose spelling differs per locale by
 * more than a prefix. Without it, a derivation that silently reused the authored path for every
 * locale, which is the defect `localizedRoutes` actually has, passes every assertion here.
 */
const PROJECTION: RouteRuntimeProjection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: 'sha256-AtlasRouteProjectionTestIdentity0123456789_',
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'route:second', path: 'second', parameterNames: [] },
      { id: 'article', path: 'articles/:slug', parameterNames: ['slug'] },
      { id: 'route:section', path: 'section', parameterNames: [] },
    ],
  },
  localizedPaths: {
    'route:second': { 'en-US': 'second', 'ar-EG': 'الثاني' },
    article: {
      'en-US': 'articles/:slug',
      'ar-EG': 'مقالات/:slug',
    },
    'route:section': { 'en-US': 'section', 'ar-EG': 'قسم' },
  },
};

function branchFor(
  table: ReturnType<typeof localizedRouteTable>,
  prefix: string,
) {
  const branch = table.branches.find((entry) => entry.path === prefix);
  if (branch === undefined) throw new Error(`no branch for ${prefix}`);
  return branch;
}

function kinds(problems: readonly LocalizedRouteTableProblem[]): string[] {
  return problems.map((problem) => problem.kind);
}

describe('localizedRouteTable', () => {
  it('leaves the authored routes untouched as the canonical branch', () => {
    const table = localizedRouteTable(CANONICAL, POLICY, PROJECTION);
    expect(table.canonical).toBe(CANONICAL);
    expect(table.problems).toEqual([]);
  });

  it('emits one branch per locale, under that locale prefix', () => {
    const table = localizedRouteTable(CANONICAL, POLICY, PROJECTION);
    expect(table.branches.map((branch) => branch.path)).toEqual([
      'en-us',
      'ar-eg',
    ]);
  });

  it('spells each address in its own locale, not just behind a prefix', () => {
    const table = localizedRouteTable(CANONICAL, POLICY, PROJECTION);
    expect(
      branchFor(table, 'ar-eg').children?.map((child) => child.path),
    ).toEqual(['', 'الثاني', 'مقالات/:slug', 'قسم']);
    expect(
      branchFor(table, 'en-us').children?.map((child) => child.path),
    ).toEqual(['', 'second', 'articles/:slug', 'section']);
  });

  it('reuses the canonical loader rather than emitting its own', () => {
    const table = localizedRouteTable(CANONICAL, POLICY, PROJECTION);
    const children = branchFor(table, 'ar-eg').children ?? [];
    // By reference. Both layers naming the same dynamic import is what makes the second layer
    // nearly free: one emitted chunk, one modulepreload set. A copy would double the graph while
    // every other signal (chunk names, prerendered output) still read correct.
    expect(children[0]?.loadComponent).toBe(HOME);
    expect(children[1]?.loadComponent).toBe(SECOND);
    expect(children[2]?.loadComponent).toBe(ARTICLE);
    expect(children[3]?.loadChildren).toBe(SECTION);
  });

  it('carries pathMatch on the empty path so the index address still resolves', () => {
    const table = localizedRouteTable(CANONICAL, POLICY, PROJECTION);
    expect(branchFor(table, 'ar-eg').children?.[0]).toMatchObject({
      path: '',
      pathMatch: 'full',
    });
  });

  it('never names the wildcard, which is an address nothing can prerender', () => {
    const table = localizedRouteTable(CANONICAL, POLICY, PROJECTION);
    for (const branch of table.branches) {
      expect(branch.children?.some((child) => child.path === '**')).toBe(false);
    }
  });

  it('emits only renderable entries, asserted over the output', () => {
    // Asserted here, over what the function returned, rather than as a check inside the derivation
    // where it would agree by construction and could not fail. An edit that drops the target on
    // the way into a branch turns this red.
    const table = localizedRouteTable(CANONICAL, POLICY, PROJECTION);
    for (const branch of table.branches) {
      for (const child of branch.children ?? []) {
        expect(
          child.component ??
            child.loadComponent ??
            child.loadChildren ??
            child.redirectTo,
        ).toBeDefined();
      }
    }
  });

  it('flattens a nested route to the address it actually answers at', () => {
    const DETAIL = () => Promise.resolve(StubComponent);
    const table = localizedRouteTable(
      [
        {
          path: 'shop',
          children: [{ path: 'item/:id', loadComponent: DETAIL }],
        },
      ],
      POLICY,
      {
        generated: {
          profile: 'atlas-route-projection/1',
          identity: 'sha256-AtlasRouteProjectionTestIdentity0123456789_',
          routes: [
            { id: 'item', path: 'shop/item/:id', parameterNames: ['id'] },
          ],
        },
        localizedPaths: {
          item: {
            'en-US': 'shop/item/:id',
            'ar-EG': 'متجر/item/:id',
          },
        },
      },
    );
    expect(table.problems).toEqual([]);
    expect(branchFor(table, 'ar-eg').children?.[0]).toMatchObject({
      path: 'متجر/item/:id',
      loadComponent: DETAIL,
    });
  });

  it('drops the default locale branch when the policy omits its prefix', () => {
    const table = localizedRouteTable(
      CANONICAL,
      { ...POLICY, omitDefaultPrefix: true },
      PROJECTION,
    );
    expect(table.branches.map((branch) => branch.path)).toEqual(['ar-eg']);
  });

  it('composes canonical first, and keeps both halves separable', () => {
    // Ordering is a result rather than a constraint: the strategy delocalizes before the Router
    // matches, so a prefixed address never reaches it and either order renders the canonical
    // branch. That end of it needs a Router and is asserted in `three-path-equality.spec.ts`, which
    // registers these branches ahead of the application's routes and compares the arrivals. What is
    // asserted here is the half that makes the other order expressible at all.
    const table = localizedRouteTable(CANONICAL, POLICY, PROJECTION);
    expect(table.routes).toEqual([...table.canonical, ...table.branches]);
    expect([...table.branches, ...table.canonical]).toHaveLength(
      table.routes.length,
    );
  });

  /**
   * The branches say for themselves that they do not match.
   *
   * They never did match: Atlas removes the locale prefix before the Router is asked anything,
   * so the canonical layer answers every navigation. But that was true by construction and stated
   * nowhere, which is a different thing: a change that stopped delocalizing would silently promote
   * the branches from a reading of the addresses into a second set of routes competing with the
   * canonical layer, and the first sign of it would be a page rendered twice or a route-scoped
   * service instantiated once per locale.
   *
   * The guard is asserted to decline rather than merely to exist, and the canonical layer is
   * asserted not to carry one: a table that put the guard everywhere would answer nothing.
   */
  it('declines on every locale branch, and on no canonical route', () => {
    const table = localizedRouteTable(CANONICAL, POLICY, PROJECTION);
    expect(table.branches.length).toBeGreaterThan(0);
    for (const branch of table.branches) {
      expect(branch.canMatch).toHaveLength(1);
      const guard = branch.canMatch?.[0] as () => unknown;
      expect(guard()).toBe(false);
    }
    for (const route of table.canonical) {
      expect(route.canMatch).toBeUndefined();
    }
    // One shared function across every branch, not one closure each. Asserted because the bundle
    // carries what this emits, and because a per-branch closure would read as a per-branch rule.
    expect(
      new Set(table.branches.map((branch) => branch.canMatch?.[0])).size,
    ).toBe(1);
  });

  describe('what it refuses to do silently', () => {
    it('reports a projection route no authored route renders', () => {
      const table = localizedRouteTable(CANONICAL, POLICY, {
        ...PROJECTION,
        generated: {
          ...PROJECTION.generated,
          routes: [
            ...PROJECTION.generated.routes,
            { id: 'ghost', path: 'ghost', parameterNames: [] },
          ],
        },
      });
      const reported = table.problems.filter(
        (problem) => problem.kind === 'unmatched-projection-route',
      );
      // Once per locale: which locales lose the address is part of the fact.
      expect(reported.map((problem) => problem.locale)).toEqual([
        'en-US',
        'ar-EG',
      ]);
      expect(reported[0]?.message).toContain('"ghost"');
    });

    it('reports an authored route the projection does not cover', () => {
      // The failure this prevents is the quiet one. An address with no projection entry gets no
      // branch in any locale, so it is reachable only at its canonical spelling, and the locale
      // source resolves that address to nothing, so the page renders in the default language at an
      // address that looks localized. A missing page is obvious; this is not.
      //
      // Stated against the general condition. `loadChildren` is the construct known to do it, but
      // a table assembled at runtime or spread in from elsewhere hides routes identically, and the
      // check names none of them: it compares the authored addresses against the projected ones.
      const DEEP = () => Promise.resolve(StubComponent);
      const table = localizedRouteTable(
        [...CANONICAL, { path: 'reports/quarterly', loadComponent: DEEP }],
        POLICY,
        PROJECTION,
      );
      const reported = table.problems.filter(
        (problem) => problem.kind === 'uncovered-authored-route',
      );
      expect(reported).toHaveLength(1);
      expect(reported[0]?.message).toContain('/reports/quarterly');
      // Once, not once per locale: the address is missing from the projection, which is one fact
      // about the application rather than one fact about each locale.
      expect(
        table.branches.every((branch) =>
          branch.children?.every((child) => child.path !== 'reports/quarterly'),
        ),
      ).toBe(true);
    });

    it('reports an authored route that renders nothing, rather than skipping it', () => {
      const table = localizedRouteTable(
        [...CANONICAL, { path: 'orphan' }],
        POLICY,
        PROJECTION,
      );
      expect(kinds(table.problems)).toContain('unrenderable-branch-entry');
      expect(table.problems[0]?.message).toContain('/orphan');
    });

    it('reports a localized spelling that renames a parameter', () => {
      const table = localizedRouteTable(CANONICAL, POLICY, {
        ...PROJECTION,
        localizedPaths: {
          ...PROJECTION.localizedPaths,
          article: {
            'en-US': 'articles/:slug',
            'ar-EG': 'مقالات/:identifier',
          },
        },
      });
      const reported = table.problems.filter(
        (problem) => problem.kind === 'parameter-mismatch',
      );
      expect(reported).toHaveLength(1);
      expect(reported[0]?.locale).toBe('ar-EG');
      expect(reported[0]?.message).toContain('identifier');
      // And the bad entry is not emitted, because an address whose parameter the codec cannot
      // round-trip renders in the wrong locale rather than failing.
      expect(
        branchFor(table, 'ar-eg').children?.map((child) => child.path),
      ).not.toContain('مقالات/:identifier');
    });

    it('reports a localized spelling that adds a parameter', () => {
      // Found by mutation, not by design. Removing the length comparison left the suite green,
      // because comparing name-by-name over the *declared* names cannot see a name the spelling
      // adds. An unfilled `:version` would reach the address bar verbatim: `buildLocalizedRoute`
      // serializes the parameters the route declares and knows nothing about this one.
      const table = localizedRouteTable(CANONICAL, POLICY, {
        ...PROJECTION,
        localizedPaths: {
          ...PROJECTION.localizedPaths,
          article: {
            'en-US': 'articles/:slug',
            'ar-EG': 'مقالات/:slug/:version',
          },
        },
      });
      const reported = table.problems.filter(
        (problem) => problem.kind === 'parameter-mismatch',
      );
      expect(reported).toHaveLength(1);
      expect(reported[0]?.message).toContain('version');
    });

    it('reports a localized spelling that drops a parameter', () => {
      const table = localizedRouteTable(CANONICAL, POLICY, {
        ...PROJECTION,
        localizedPaths: {
          ...PROJECTION.localizedPaths,
          article: {
            'en-US': 'articles/:slug',
            'ar-EG': 'مقالات',
          },
        },
      });
      expect(kinds(table.problems)).toEqual(['parameter-mismatch']);
    });
  });

  describe('policies that carry one address space', () => {
    const NEUTRAL: LocaleUrlPolicy = {
      kind: 'locale-neutral',
      defaultLocale: 'en-US',
      locales: { 'en-US': '', 'ar-EG': '' },
      localeNeutralRoots: [],
    };

    it('emits no branches, because there is no second address space to put them in', () => {
      const table = localizedRouteTable(CANONICAL, NEUTRAL, {
        generated: PROJECTION.generated,
      });
      expect(table.branches).toEqual([]);
      expect(table.routes).toBe(table.canonical);
      expect(table.problems).toEqual([]);
    });

    it('says nothing when the projection carries spellings it cannot express, because that is refused at configuration', () => {
      // Pushing `unlocalizable-policy` here for `provideLocalizedRouter` to print as a warning
      // answers the wrong question. A policy kind is served or refused by name and never warned
      // about, so the combination is refused before an application starts. What the table answers
      // is a table, and this one is correct.
      const table = localizedRouteTable(CANONICAL, NEUTRAL, PROJECTION);
      expect(table.branches).toEqual([]);
      expect(table.routes).toBe(table.canonical);
      expect(kinds(table.problems)).toEqual([]);
    });

    it('treats a host policy the same way', () => {
      const table = localizedRouteTable(
        CANONICAL,
        {
          kind: 'locale-host',
          defaultLocale: 'en-US',
          locales: {
            'en-US': 'https://example.com',
            'ar-EG': 'https://example.eg',
          },
          origins: {
            'https://example.com': 'en-US',
            'https://example.eg': 'ar-EG',
          },
          localeNeutralRoots: [],
        },
        PROJECTION,
      );
      expect(table.branches).toEqual([]);
      expect(kinds(table.problems)).toEqual([]);
    });
  });
});
