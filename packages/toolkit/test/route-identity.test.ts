import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { analyzeAtlasApplication } from '../src/static-analysis.js';
import type { AtlasDiagnostic, AtlasRouteProjection } from '../src/index.js';

/**
 * What a route is called, and whether that name can be relied on.
 *
 * A route identity is the key an application authors indexed copy under: a title and description
 * per route per locale. So the identity has to survive every edit that leaves the address alone.
 * Renaming `:id` to `:orderId` changes no URL and no page, and must therefore change no key, or a
 * rename silently orphans translated copy with nothing to report it.
 *
 * The derivation is also the only thing standing between two routes and a shared name. Sharing one
 * would attach a page's copy to a different page, which is worse than not indexing either, so a
 * collision is reported and neither route is projected.
 */

const temporaryRoots: string[] = [];

async function write(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const absolute = resolve(root, ...path.split('/'));
  await mkdir(resolve(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

// The route contract is recognized by its declaration coming from @angular/router, so the fixture
// supplies a stub at that path rather than a local type of the same name.
const ROUTER_STUB = [
  'export declare interface Route {',
  '  path?: string;',
  '  data?: Record<string, unknown>;',
  '  redirectTo?: string;',
  '  component?: unknown;',
  '  loadComponent?: () => Promise<unknown>;',
  '  loadChildren?: () => Promise<unknown>;',
  '  children?: readonly Route[];',
  '}',
  'export type Routes = readonly Route[];',
  '',
].join('\n');

const ROUTER_MANIFEST = `${JSON.stringify(
  { name: '@angular/router', version: '0.0.0', types: './index.d.ts' },
  null,
  2,
)}
`;

// A stub of the Atlas package. `withRouting` is recognized the same way every other Atlas symbol
// is: the symbol is resolved and its declaration is required to come from inside @neolorn/atlas,
// so a consumer's own function of the same name configures nothing.
const ATLAS_STUB =
  'export declare function withRouting(options: unknown): unknown;\n';

const ATLAS_MANIFEST = `${JSON.stringify(
  { name: '@neolorn/atlas', version: '0.0.0', types: './index.d.ts' },
  null,
  2,
)}
`;

interface Analysed {
  readonly routes: readonly AtlasRouteProjection[];
  readonly diagnostics: readonly AtlasDiagnostic[];
  readonly deferredSourcePaths: readonly string[];
}

async function analyse(
  files: Readonly<Record<string, string>>,
): Promise<Analysed> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-route-id-'));
  temporaryRoots.push(root);
  const all = {
    'node_modules/@angular/router/index.d.ts': ROUTER_STUB,
    'node_modules/@angular/router/package.json': ROUTER_MANIFEST,
    'node_modules/@neolorn/atlas/index.d.ts': ATLAS_STUB,
    'node_modules/@neolorn/atlas/package.json': ATLAS_MANIFEST,
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    await write(root, path, contents);
  }
  const analysis = analyzeAtlasApplication({
    projectRoot: root,
    rootNames: Object.keys(all).map((path) => resolve(root, path)),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    },
  });
  if (!analysis.ok) {
    throw Object.assign(new Error('analysis failed'), {
      diagnostics: analysis.diagnostics,
    });
  }
  return {
    routes: analysis.value.routes,
    diagnostics: analysis.diagnostics,
    deferredSourcePaths: analysis.value.deferredSourcePaths ?? [],
  };
}

/** A route file that defers its children to another, which declares them as a route table. */
function childRouteApplication(): Readonly<Record<string, string>> {
  return {
    'src/section/detail.ts': 'export class Detail {}\n',
    'src/section/routes.ts': [
      "import type { Routes } from '@angular/router';",
      "import { Detail } from './detail';",
      "export const sectionRoutes: Routes = [{ path: 'detail', component: Detail }];",
      '',
    ].join('\n'),
    'src/app.routes.ts': [
      "import type { Routes } from '@angular/router';",
      'export const routes: Routes = [',
      "  { path: 'section', loadChildren: () => import('./section/routes').then((m) => m.sectionRoutes) },",
      '];',
      '',
    ].join('\n'),
  };
}

async function analyseFailure(
  files: Readonly<Record<string, string>>,
): Promise<readonly AtlasDiagnostic[]> {
  try {
    await analyse(files);
  } catch (error) {
    return (error as { readonly diagnostics: readonly AtlasDiagnostic[] })
      .diagnostics;
  }
  throw new Error('the analysis was expected to fail');
}

function routeFile(body: string): Record<string, string> {
  return {
    'src/app.routes.ts': [
      "import type { Routes } from '@angular/router';",
      '',
      // Every route here carries a component, because Angular refuses one that carries nothing:
      // `validateNode` throws on it, though only in a development build, which is why the analysis
      // now refuses it too. A fixture that omitted it was describing a table that cannot run.
      'export class Page {}',
      '',
      `export const routes: Routes = ${body};`,
      '',
    ].join('\n'),
  };
}

function identities(analysed: Analysed): readonly string[] {
  return analysed.routes.map(({ id }) => id);
}

function classes(analysed: Analysed): Readonly<Record<string, string>> {
  return Object.fromEntries(
    analysed.routes.map((route) => [route.id, route.indexing ?? 'absent']),
  );
}

/** A provider file declaring the consumer's own route-data field. */
function routingProvider(indexing: string): Record<string, string> {
  return {
    'src/app.config.ts': [
      "import { withRouting } from '@neolorn/atlas';",
      '',
      `export const routing = withRouting({ indexing: ${indexing} });`,
      '',
    ].join('\n'),
  };
}

/** The same file, with whatever options the case is about. */
function routingOptions(options: string): Record<string, string> {
  return {
    'src/app.config.ts': [
      "import { withRouting } from '@neolorn/atlas';",
      '',
      `export const routing = withRouting({ ${options} });`,
      '',
    ].join('\n'),
  };
}

function claims(
  analysed: Analysed,
): Readonly<Record<string, AtlasRouteProjection['sitemap']>> {
  return Object.fromEntries(
    analysed.routes.map((route) => [route.id, route.sitemap]),
  );
}

function codes(analysed: Analysed): readonly string[] {
  return analysed.diagnostics.map(({ code }) => code);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * Which routes are indexable.
 *
 * Atlas must not read a field name belonging to a particular consumer, so the field is named by
 * the consumer through `withRouting()` and read out of that call's source text when the owner is
 * compiled. Routes default to indexable: an application marks its exceptions rather than
 * annotating every route it has.
 */
describe('route indexing', () => {
  it('treats an unmarked route as indexable', async () => {
    const analysed = await analyse(
      routeFile("[{ path: 'orders', component: Page }]"),
    );

    expect(classes(analysed)).toEqual({ 'route:orders': 'indexable' });
  });

  it('reads its own field when the consumer names none', async () => {
    const analysed = await analyse(
      routeFile(
        "[{ path: 'admin', data: { atlasIndexing: 'private' }, component: Page }, { path: 'draft', data: { atlasIndexing: 'non-indexable' }, component: Page }]",
      ),
    );

    expect(classes(analysed)).toEqual({
      'route:admin': 'private',
      'route:draft': 'non-indexable',
    });
  });

  it("reads the consumer's own field when one is named", async () => {
    // The point of the option. A project that already classifies its routes points Atlas at the
    // field it already has, in its own vocabulary, and writes nothing new on any route.
    const analysed = await analyse({
      ...routingProvider(
        "{ field: 'routeClass', values: { authenticated: 'private', staging: 'non-indexable' } }",
      ),
      ...routeFile(
        "[{ path: 'account', data: { routeClass: 'authenticated' }, component: Page }, { path: 'preview', data: { routeClass: 'staging' }, component: Page }, { path: 'home', data: { routeClass: 'public' }, component: Page }]",
      ),
    });

    expect(classes(analysed)).toEqual({
      'route:account': 'private',
      'route:preview': 'non-indexable',
      // 'public' is not in the table, and does not need to be: unlisted means indexable.
      'route:home': 'indexable',
    });
  });

  it('stops reading its own field once the consumer names one', async () => {
    // Two fields would mean two answers. Naming a field replaces the default rather than adding to
    // it, so `atlasIndexing` left behind by an earlier setup cannot quietly override the field the
    // application actually classifies by.
    const analysed = await analyse({
      ...routingProvider(
        "{ field: 'routeClass', values: { hidden: 'private' } }",
      ),
      ...routeFile(
        "[{ path: 'admin', data: { atlasIndexing: 'private' }, component: Page }]",
      ),
    });

    expect(classes(analysed)).toEqual({ 'route:admin': 'indexable' });
  });

  it('ignores a withRouting that is not the one Atlas exports', async () => {
    const analysed = await analyse({
      'src/app.config.ts': [
        'function withRouting(options: unknown): unknown {',
        '  return options;',
        '}',
        '',
        "export const routing = withRouting({ indexing: { field: 'routeClass', values: { authenticated: 'private' } } });",
        '',
      ].join('\n'),
      ...routeFile(
        "[{ path: 'account', data: { routeClass: 'authenticated' }, component: Page }]",
      ),
    });

    expect(classes(analysed)).toEqual({ 'route:account': 'indexable' });
  });
});

describe('route identity', () => {
  it('names the empty path with something no literal path can produce', async () => {
    // `route:root` was the old answer, and a route at `/root` produced it too.
    const analysed = await analyse(
      routeFile(
        "[{ path: '', component: Page }, { path: 'root', component: Page }, { path: 'index', component: Page }]",
      ),
    );

    expect(identities(analysed)).toEqual([
      'route:_index',
      'route:root',
      'route:index',
    ]);
    expect(analysed.diagnostics).toEqual([]);
  });

  it('collapses a parameter to a mark, so renaming it changes nothing', async () => {
    const before = await analyse(
      routeFile("[{ path: 'orders/:id/items', component: Page }]"),
    );
    const after = await analyse(
      routeFile("[{ path: 'orders/:orderId/items', component: Page }]"),
    );

    expect(identities(before)).toEqual(['route:orders._.items']);
    expect(identities(after)).toEqual(identities(before));

    // The author's names are still reported: they are useful, they are just not the identity.
    expect(before.routes[0]?.parameterNames).toEqual(['id']);
    expect(after.routes[0]?.parameterNames).toEqual(['orderId']);
  });

  it('reads a nested route at its full address', async () => {
    const analysed = await analyse(
      routeFile(
        "[{ path: 'admin', children: [{ path: '', component: Page }, { path: 'users/:id', component: Page }] }]",
      ),
    );

    // The parent and its index child are one address, so they are one route.
    expect(identities(analysed)).toEqual([
      'route:admin',
      'route:admin.users._',
    ]);
    expect(analysed.diagnostics).toEqual([]);
  });

  it('descends through a pathless layout route', async () => {
    // A route with no `path` renders without contributing a URL segment, so a visit that ends at
    // one sees nothing underneath it, lazy boundaries included.
    const analysed = await analyse({
      'src/admin.ts': "export const panel = 'admin';\n",
      ...routeFile(
        "[{ component: null, children: [{ path: 'admin', loadComponent: () => import('./admin') }] }]",
      ),
    });

    expect(identities(analysed)).toEqual(['route:admin']);
    expect(analysed.deferredSourcePaths).toContain('src/admin.ts');
  });

  it('refuses a route with an address and nothing to render it', async () => {
    // Angular's own rule, and the reason Atlas has to restate it: `validateNode` throws on a route
    // carrying none of `component`, `loadComponent`, `redirectTo`, `children` or `loadChildren`,
    // but both of its call sites sit inside `if (typeof ngDevMode === 'undefined' || ngDevMode)`.
    // A production build validates no route config at all, so such a route ships and surfaces only
    // for whoever next runs a development build. Atlas reads the same table before either build.
    const failure = await analyseFailure(routeFile("[{ path: 'orders' }]"));

    const unrenderable = failure.filter(({ code }) => code === 'ATL1405');
    expect(unrenderable).toHaveLength(1);
    expect(unrenderable[0]?.severity).toBe('error');
    expect(unrenderable[0]?.summary).toContain('/orders');
  });

  it('accepts every shape Angular accepts', async () => {
    // The mutation for the check above. Each of the five alternatives has to pass on its own, or
    // the refusal is not Angular's rule but a narrower one wearing its name.
    const analysed = await analyse(
      routeFile(
        "[{ path: 'a', component: Page }, { path: 'b', loadComponent: () => import('./page') }, { path: 'c', redirectTo: 'a' }, { path: 'd', children: [{ path: 'e', component: Page }] }]",
      ),
    );

    expect(
      analysed.diagnostics.filter(({ code }) => code === 'ATL1405'),
    ).toEqual([]);
  });

  it('names an address it cannot know, and keeps reading below it', async () => {
    // A computed path leaves the subtree unnameable. Every address below it is served at its
    // canonical spelling in the default locale, which under a locale prefix means a URL that looks
    // localized and a page that is not, so this is named rather than skipped.
    //
    // Naming it is not the same as stopping. A lazy boundary is a fact about modules, not about
    // URLs, and missing the one below an unnameable address would load those messages eagerly
    // forever. Both halves are asserted here because a refusal would have cost the second.
    const analysed = await analyse({
      'src/admin.ts': "export const panel = 'admin';\n",
      'src/app.routes.ts': [
        "import type { Routes } from '@angular/router';",
        '',
        "const base = 'admin';",
        'export const routes: Routes = [',
        '  {',
        '    path: base,',
        "    children: [{ path: 'panel', loadComponent: () => import('./admin') }],",
        '  },',
        '];',
        '',
      ].join('\n'),
    });

    expect(identities(analysed)).toEqual([]);
    expect(analysed.deferredSourcePaths).toContain('src/admin.ts');

    const uncovered = analysed.diagnostics.filter(
      ({ code }) => code === 'ATL1406',
    );
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.severity).toBe('warning');
    expect(uncovered[0]?.summary).toContain('computes its `path`');
  });

  it('names a route whose children it was never shown', async () => {
    // `loadChildren` is the construct proven to occur, not the condition. The condition is that the
    // authored table names addresses the projection cannot reach, and a table assembled at runtime
    // or returned by a helper hides them the same way.
    const analysed = await analyse(childRouteApplication());

    const uncovered = analysed.diagnostics.filter(
      ({ code }) => code === 'ATL1406',
    );
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.summary).toContain('/section');
    expect(uncovered[0]?.summary).toContain('loadChildren');
  });

  it('does not invent an address for a child table it read on its own', async () => {
    // The half a diagnostic does not fix, and the reason the diagnostic alone is not enough.
    // `src/section/routes.ts` declares a `Routes` constant, so the pass over every source file
    // reaches it with no parent and would project `detail`: an address the application serves at
    // `section/detail` and nowhere else. A localized branch built from it addresses nothing.
    //
    // The control is the same file with nothing referencing it: then it *is* a route table in its
    // own right, `detail` is its real address, and the projection is correct to say so.
    const referenced = await analyse(childRouteApplication());
    expect(identities(referenced)).toEqual(['route:section']);

    const { 'src/app.routes.ts': _root, ...standalone } =
      childRouteApplication();
    expect(identities(await analyse(standalone))).toEqual(['route:detail']);
  });

  it('skips wildcards at every depth', async () => {
    const analysed = await analyse(
      routeFile(
        "[{ path: 'admin', children: [{ path: '**', component: Page }] }, { path: '**', component: Page }]",
      ),
    );

    expect(identities(analysed)).toEqual(['route:admin']);
  });

  it('reports two addresses that resolve to one name and projects neither', async () => {
    // Distinct URLs, one slug. Indexing either under a name that also describes the other attaches
    // a page's copy to the wrong page.
    const analysed = await analyse(
      routeFile(
        "[{ path: 'v1.2', component: Page }, { path: 'v1-2', component: Page }]",
      ),
    );

    expect(identities(analysed)).toEqual([]);

    const collision = analysed.diagnostics.filter(
      ({ code }) => code === 'ATL1404',
    );
    expect(collision).toHaveLength(1);
    expect(collision[0]?.severity).toBe('warning');
    expect(collision[0]?.summary).toContain('route:v1-2');
    expect(collision[0]?.summary).toContain('/v1.2');
  });

  it('reports an address it cannot name at all', async () => {
    const analysed = await analyse(
      routeFile("[{ path: 'الطلبات', component: Page }]"),
    );

    expect(identities(analysed)).toEqual([]);
    expect(
      analysed.diagnostics.filter(({ code }) => code === 'ATL1404'),
    ).toHaveLength(1);
    expect(analysed.diagnostics[0]?.summary).toContain('atlasRouteId');
  });

  it('lets a declared identity name what Atlas could not', async () => {
    const analysed = await analyse(
      routeFile(
        "[{ path: 'الطلبات', data: { atlasRouteId: 'route:orders' }, component: Page }]",
      ),
    );

    expect(identities(analysed)).toEqual(['route:orders']);
    expect(analysed.diagnostics).toEqual([]);
  });

  it('refuses a declared identity the runtime would reject', async () => {
    // Generated routing state is validated again when it is adopted, in the browser. An identity
    // that fails there should fail here, where there is a file and a line to point at.
    const analysed = await analyse(
      routeFile(
        "[{ path: 'orders', data: { atlasRouteId: 'has spaces' }, component: Page }]",
      ),
    );

    expect(identities(analysed)).toEqual([]);
    expect(
      analysed.diagnostics.filter(({ code }) => code === 'ATL1404'),
    ).toHaveLength(1);
  });

  it('prefers the deeper declaration when one address is declared twice', async () => {
    // The index child renders the page, so its route data is the more specific statement about it.
    const analysed = await analyse(
      routeFile(
        "[{ path: 'admin', children: [{ path: '', data: { atlasRouteId: 'route:dashboard' }, component: Page }] }]",
      ),
    );

    expect(identities(analysed)).toEqual(['route:dashboard']);
  });

  it('never derives an identity the runtime would reject', async () => {
    // A deep address can outgrow the identity grammar's 128 characters. Truncating it would invent
    // collisions; the consumer is asked for a name instead.
    const deep = Array.from(
      { length: 30 },
      (_, index) => `segment${index}`,
    ).join('/');
    const analysed = await analyse(
      routeFile(`[{ path: '${deep}', component: Page }]`),
    );

    expect(identities(analysed)).toEqual([]);
    expect(
      analysed.diagnostics.filter(({ code }) => code === 'ATL1404'),
    ).toHaveLength(1);
  });
});

/**
 * What a route claims about itself in a sitemap.
 *
 * The same shape as the indexing declaration above and for the same reason: Atlas reads a field
 * name it was given rather than one of its own invention, from source text, because it does not
 * execute consumer code. What differs is that there is no Atlas default field. A route that claims
 * nothing is published with its address and its alternates, which is a complete entry, where a
 * route with no indexing class has to be sorted into one.
 *
 * The refusals here are refusals rather than omissions. `changefreq` is a closed enumeration and
 * `priority` is bounded, both in the schema, so a value outside either produces a document a
 * validator rejects. Dropping it silently would turn a typo into a page that quietly says nothing.
 */
describe('route sitemap claims', () => {
  it('reads the class the route names, and leaves an unlisted class claiming nothing', async () => {
    const analysed = await analyse({
      ...routeFile(
        "[{ path: 'news', component: Page, data: { section: 'editorial' } }, { path: 'terms', component: Page, data: { section: 'boilerplate' } }]",
      ),
      ...routingOptions(
        "sitemap: { field: 'section', values: { editorial: { changefreq: 'daily', priority: 0.9 } } }",
      ),
    });
    expect(claims(analysed)).toEqual({
      'route:news': { changefreq: 'daily', priority: 0.9 },
      // `boilerplate` is a word this project uses for its own reasons and the table says nothing
      // about it, so the route claims nothing rather than being given a default.
      'route:terms': undefined,
    });
  });

  it('claims nothing anywhere when the owner declares no sitemap policy', async () => {
    const analysed = await analyse(
      routeFile(
        "[{ path: 'news', component: Page, data: { section: 'editorial' } }]",
      ),
    );
    expect(claims(analysed)).toEqual({ 'route:news': undefined });
  });

  it('reads lastmod from the field it was pointed at, as written', async () => {
    const analysed = await analyse({
      ...routeFile(
        "[{ path: 'news', component: Page, data: { updated: '2026-09-01' } }]",
      ),
      ...routingOptions(
        "sitemap: { field: 'section', lastmodField: 'updated' }",
      ),
    });
    // Read and not computed. A build time or a file time is a date the page did not change on,
    // and the one element a crawler actually reads is worth less than nothing when it is wrong.
    expect(claims(analysed)).toEqual({
      'route:news': { lastmod: '2026-09-01' },
    });
  });

  it('refuses a lastmod that is not a W3C date and says so', async () => {
    const analysed = await analyse({
      ...routeFile(
        "[{ path: 'news', component: Page, data: { updated: 'last Tuesday' } }]",
      ),
      ...routingOptions(
        "sitemap: { field: 'section', lastmodField: 'updated' }",
      ),
    });
    expect(codes(analysed)).toContain('ATL1412');
    expect(claims(analysed)).toEqual({ 'route:news': undefined });
  });

  it('refuses a changefreq the protocol does not list', async () => {
    const analysed = await analyse({
      ...routeFile(
        "[{ path: 'news', component: Page, data: { section: 'editorial' } }]",
      ),
      ...routingOptions(
        "sitemap: { field: 'section', values: { editorial: { changefreq: 'fortnightly' } } }",
      ),
    });
    expect(codes(analysed)).toContain('ATL1412');
    expect(claims(analysed)).toEqual({ 'route:news': undefined });
  });

  it('refuses a priority outside the range, and keeps the rest of the class', async () => {
    const analysed = await analyse({
      ...routeFile(
        "[{ path: 'news', component: Page, data: { section: 'editorial' } }]",
      ),
      ...routingOptions(
        "sitemap: { field: 'section', values: { editorial: { changefreq: 'daily', priority: 1.5 } } }",
      ),
    });
    expect(codes(analysed)).toContain('ATL1412');
    // The bad half is refused and the good half stands. An entry with a changefreq and no priority
    // is a valid entry, so throwing the class away would lose something the consumer got right.
    expect(claims(analysed)).toEqual({ 'route:news': { changefreq: 'daily' } });
  });

  it('reports an owner that declares two sitemap fields and uses the first', async () => {
    const analysed = await analyse({
      ...routeFile(
        "[{ path: 'news', component: Page, data: { section: 'editorial' } }]",
      ),
      'src/app.config.ts': [
        "import { withRouting } from '@neolorn/atlas';",
        '',
        "export const routing = withRouting({ sitemap: { field: 'section', values: { editorial: { priority: 0.9 } } } });",
        "export const other = withRouting({ sitemap: { field: 'kind', values: { editorial: { priority: 0.1 } } } });",
        '',
      ].join('\n'),
    });
    expect(codes(analysed)).toContain('ATL1412');
    expect(claims(analysed)).toEqual({ 'route:news': { priority: 0.9 } });
  });
});
