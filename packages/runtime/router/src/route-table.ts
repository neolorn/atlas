import type { Route, Routes } from '@angular/router';

import type { LocaleUrlPolicy, RouteRuntimeProjection } from '@neolorn/atlas';

/**
 * Why this module imports nothing at runtime.
 *
 * Every import here is `import type`, so the module erases to plain functions over plain objects.
 * That is deliberate rather than incidental: Angular's own route validation is dead in production
 * builds, `validateConfig` is called only behind `(typeof ngDevMode === 'undefined' || ngDevMode)`
 * at both of its call sites, so a malformed branch ships and surfaces only when someone happens
 * to run a development build. Atlas therefore has to carry the check itself, and a check that can
 * only run inside a bootstrapped application is a check that proves nothing about the production
 * path. Keeping the derivation Angular-free is what lets the check run against the code that ships.
 *
 * Both imports name a package rather than a path. A relative import of `../../src/routing.js`
 * would erase at emit and still break the build: ngc sets `rootDir` to this entry point's own
 * `src`, and a type-only import is enough to pull the file into the program. Erasure happens after
 * the program is built, not before it.
 */

/**
 * A locale branch declines, always, and that is the branch saying so in its own entry.
 *
 * The branches exist to be read, not to be matched. Atlas removes the locale prefix before the
 * Router is asked anything, so a prefixed address never reaches one: the canonical layer answers
 * every navigation. That has been true by construction, which is a different thing from being
 * stated: nothing in the table said a branch must not match, so a change that stopped delocalizing
 * would silently promote the branches from a reading of the addresses to a second set of routes
 * competing with the canonical layer, and the first sign of it would be a page rendered twice or
 * a service instantiated per locale.
 *
 * One shared function rather than one per branch, so the entries can be compared by identity and
 * the bundle carries it once. It takes no arguments because there is no question to ask: a branch
 * declines for every address, in every locale, at every point in the application's life. The array
 * around it is per-branch and unfrozen, because `Route.canMatch` is declared mutable and Angular
 * reads it: the same reason the composed table is handed over unfrozen.
 */
const declines = (): false => false;

/**
 * A route the derivation could not build a locale branch for.
 *
 * Not a `LocalizationDiagnostic`. That type describes a localization failing at runtime for a
 * visitor (it carries a target locale, a supplying locale, a transition id) and none of those
 * name what is wrong here. A table that cannot be built is a configuration mistake, discovered
 * before anyone navigates, and it needs to say which route and which locale rather than borrow a
 * vocabulary built for a different failure.
 */
export interface LocalizedRouteTableProblem {
  /**
   * What went wrong, as one of four cases.
   *
   * A projection route the authored routes do not cover, an authored route the projection does not
   * name, an entry with nothing to render, and a path whose parameters differ between the authored
   * spelling and the projected one.
   */
  readonly kind:
    | 'unmatched-projection-route'
    | 'uncovered-authored-route'
    | 'unrenderable-branch-entry'
    | 'parameter-mismatch';
  /** What is wrong, in a sentence, naming the route and the locale where it can. */
  readonly message: string;
  /** The route id this is about, absent when the problem is not attributable to one route. */
  readonly routeId?: string;
  /** The locale branch this is about, absent for a problem that holds in every locale. */
  readonly locale?: string;
}

/**
 * The route configuration to hand to the Router, and what the derivation could not do.
 *
 * Returned rather than thrown, because a table with problems in it is still the table this
 * application has to run on, and the problems are what a build gate reports.
 */
export interface LocalizedRouteTable {
  /** The authored routes, unchanged. This is the branch the Router actually matches. */
  readonly canonical: Routes;
  /**
   * One branch per locale, carrying that locale's spelling of every projected address.
   *
   * Matched by nothing, ever. `@angular/ssr` computes a prerenderable address by walking the
   * client route config and joining `path` segments, and `@angular/build` writes the file at
   * `posix.join(routeWithoutBaseHref, 'index.html')`, so an address can be prerendered only if
   * its shape appears in that config. No `LocationStrategy` can change that, because the strategy
   * is a runtime object and the traversal is a static walk. These entries exist to be walked.
   */
  readonly branches: readonly Route[];
  /**
   * `canonical` and `branches` composed in the order Atlas ships.
   *
   * `readonly Route[]` rather than `Routes`, which is mutable, because the arrays are frozen. A
   * caller handing this to `provideRouter` spreads it: Angular's own signature asks for a mutable
   * array, and handing a framework a frozen one on the strength of it not mutating today is a bet
   * on an implementation detail rather than on a contract.
   */
  readonly routes: readonly Route[];
  /**
   * Everything the derivation could not do, empty when the table is complete.
   *
   * Each entry is a configuration mistake rather than a runtime failure, so this is worth
   * asserting on in a test or reporting at start-up, where it is still cheap to fix.
   */
  readonly problems: readonly LocalizedRouteTableProblem[];
}

/** The properties that make a route entry renderable, in Angular's own terms. */
type RouteTarget = Pick<
  Route,
  'component' | 'loadComponent' | 'loadChildren' | 'redirectTo' | 'children'
>;

interface FlattenedRoute {
  readonly path: string;
  readonly target: RouteTarget;
}

const TARGET_KEYS = [
  'component',
  'loadComponent',
  'loadChildren',
  'redirectTo',
] as const satisfies readonly (keyof RouteTarget)[];

/**
 * Whether an entry is renderable in the sense the prerender walk requires.
 *
 * `children` counts, but only a non-empty one: `{ path: 'x', children: [] }` satisfies Angular's
 * own validator and still names no address the walk can emit.
 */
function routeTarget(route: Route): RouteTarget | undefined {
  for (const key of TARGET_KEYS) {
    if (route[key] !== undefined) {
      return { [key]: route[key] } as RouteTarget;
    }
  }
  return undefined;
}

function joinPath(parent: string, segment: string | undefined): string {
  const own = segment ?? '';
  if (parent === '') return own;
  if (own === '') return parent;
  return `${parent}/${own}`;
}

/**
 * Flatten the authored tree to full addresses paired with what renders them.
 *
 * The branches are flat by construction rather than mirroring the authored nesting, and that is
 * safe precisely because nothing matches them. A nested layout still renders correctly, because
 * the address is delocalized before the Router matches and the *canonical* branch, nesting
 * intact, is what answers. A branch entry only has to name an address and look renderable to
 * the walk.
 *
 * A wildcard is skipped. `**` names no address, and a projection never contains one.
 */
function flatten(
  routes: Routes,
  problems: LocalizedRouteTableProblem[],
  parent = '',
): FlattenedRoute[] {
  const flattened: FlattenedRoute[] = [];
  for (const route of routes) {
    if (route.path === '**') continue;
    const path = joinPath(parent, route.path);
    if (route.children !== undefined && route.children.length > 0) {
      // A parent that also renders is still an address of its own: `{ path: 'a', component: A,
      // children: [{ path: '', component: B }] }` answers at `/a`. The empty-path child produces
      // that same address below, so recording it here as well would emit the branch twice.
      flattened.push(...flatten(route.children, problems, path));
      continue;
    }
    const target = routeTarget(route);
    if (target === undefined) {
      // Reported rather than skipped. This is the check Angular will not run: `validateConfig` is
      // called only behind `(typeof ngDevMode === 'undefined' || ngDevMode)` at both of its call
      // sites, so an entry carrying `path` and nothing else builds and ships, and throws only for
      // whoever next runs a development build. Skipping it silently would drop the address from
      // every locale branch and report nothing: the address is then missing from the built site
      // and present in the authored routes, which is the shape nobody goes looking for.
      problems.push({
        kind: 'unrenderable-branch-entry',
        message: `The authored route at ${JSON.stringify(`/${path}`)} carries no component, loadComponent, loadChildren, redirectTo or children, so no locale branch can name its address.`,
      });
      continue;
    }
    flattened.push({ path, target });
  }
  return flattened;
}

function parameterNames(path: string): string[] {
  const names: string[] = [];
  for (const segment of path.split('/')) {
    if (segment.startsWith(':')) names.push(segment.slice(1));
  }
  return names;
}

/**
 * Build the two-layer table.
 *
 * Pure, and takes the authored routes rather than reading them from anywhere, so the branches
 * reuse the loaders the consumer already wrote. That is what keeps the second layer nearly free:
 * both layers name the same dynamic import, so the bundler emits one chunk and computes one
 * `modulepreload` set. A design that emitted its own loaders would double the graph.
 */
export function localizedRouteTable(
  routes: Routes,
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
): LocalizedRouteTable {
  const problems: LocalizedRouteTableProblem[] = [];
  const canonical: Routes = routes;
  const flattened = new Map(
    flatten(routes, problems).map((entry) => [entry.path, entry] as const),
  );

  if (policy.kind !== 'path-prefix') {
    // No branches, and that is the correct table rather than a reduced one. Under `locale-neutral`
    // every locale shares one address space, so a second layer would be the same addresses twice.
    // Under `locale-host` the locale is carried by the origin, and one client route config cannot
    // hold two locales' spellings of the same address: that would need a build per origin, which
    // Atlas does not do.
    //
    // Pushing an `unlocalizable-policy` problem here when the projection carries per-locale
    // spellings, for `provideLocalizedRouter` to print as a warning and carry on from, warns about
    // a correct table. A policy kind is served or refused by name and never warned about, so that
    // combination is refused at configuration by `refusePolicyAtConfiguration`, where a build sees
    // it. A table with no branches under a one-address-space policy is not a problem and says
    // nothing.
    return Object.freeze({
      canonical,
      branches: Object.freeze([]),
      routes: canonical,
      problems: Object.freeze(problems),
    });
  }

  // The other direction, and the one that fails quietly.
  //
  // An authored address the projection does not name gets no branch in any locale, so it is
  // reachable only at its canonical spelling. Under this design that means the strategy declines
  // it, the Router matches it, and the locale source resolves the same address to nothing: a
  // page served at a localized-looking address in the default language, which is worse than a page
  // that is missing, because nothing about it looks wrong.
  //
  // Written against the general condition rather than against any construct. `loadChildren` is the
  // case known to occur, but a table assembled at runtime, spread in from elsewhere, or built by a
  // helper hides routes from the projection in exactly the same way, and none of them is a keyword
  // to look for. What they share is this: the authored table names an address and the projection
  // does not. Routes a `loadChildren` module holds are invisible to both and are the generator's
  // to report: it can see the boundary that hides them, and this cannot.
  const projected = new Set(
    projection.generated.routes.map((entry) => entry.path),
  );
  for (const path of flattened.keys()) {
    if (projected.has(path)) continue;
    problems.push({
      kind: 'uncovered-authored-route',
      message: `The authored route at ${JSON.stringify(`/${path}`)} is not in the route projection, so it has no localized spelling and no locale branch names it.`,
    });
  }

  const branches: Route[] = [];
  for (const [locale, prefix] of Object.entries(policy.locales)) {
    if (policy.omitDefaultPrefix && locale === policy.defaultLocale) continue;
    const children: Route[] = [];
    for (const entry of projection.generated.routes) {
      const source = flattened.get(entry.path);
      if (source === undefined) {
        // Reported once per locale rather than once overall, because which locales are affected is
        // part of the fact: a projection entry naming an address no authored route renders leaves
        // a hole in every branch, and the message should not imply one.
        problems.push({
          kind: 'unmatched-projection-route',
          message: `The projection declares route ${JSON.stringify(entry.id)} at ${JSON.stringify(`/${entry.path}`)}, which no authored route renders, so ${JSON.stringify(locale)} has no branch entry for it.`,
          routeId: entry.id,
          locale,
        });
        continue;
      }
      const path =
        projection.localizedPaths?.[entry.id]?.[locale] ?? entry.path;
      const declared = [...entry.parameterNames].sort();
      const spelled = parameterNames(path).sort();
      if (
        declared.length !== spelled.length ||
        declared.some((name, index) => name !== spelled[index])
      ) {
        // A localized spelling that renames or drops a parameter produces an address the codec
        // cannot round-trip, and the failure surfaces as a page rendered in the wrong locale
        // rather than as an error. Caught here, where both spellings are in hand.
        problems.push({
          kind: 'parameter-mismatch',
          message: `Route ${JSON.stringify(entry.id)} declares parameters [${declared.join(', ')}] but its ${JSON.stringify(locale)} spelling ${JSON.stringify(`/${path}`)} carries [${spelled.join(', ')}].`,
          routeId: entry.id,
          locale,
        });
        continue;
      }
      children.push(
        path === ''
          ? { path: '', pathMatch: 'full', ...source.target }
          : { path, ...source.target },
      );
    }
    branches.push({ path: prefix, children, canMatch: [declines] });
  }

  // Ordering is a result, not a constraint: both orderings render the canonical branch, because
  // the strategy delocalizes before the Router matches, so a prefixed address never reaches it.
  // Canonical first is the order Atlas emits; `three-path-equality.spec.ts` boots a Router with
  // these branches registered ahead of the application's own routes and asserts every arrival is
  // identical, so a future Angular that makes ordering load-bearing turns this into a visible
  // change rather than a silent one.
  const composed = Object.freeze([...canonical, ...branches]);
  return Object.freeze({
    canonical,
    branches: Object.freeze(branches),
    routes: composed,
    problems: Object.freeze(problems),
  });
}
