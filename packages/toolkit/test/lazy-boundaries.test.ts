import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { analyzeAtlasApplication } from '../src/static-analysis.js';
import type { AtlasDiagnostic } from '../src/index.js';

/**
 * Which messages the first render actually needs.
 *
 * Angular splits an application at `loadComponent` and `loadChildren`: the code behind those
 * boundaries is not downloaded until the route activates. The messages used there should not be
 * either, or startup cost grows with the *total* size of an application's catalogs rather than
 * with what the first screen shows, silently, and worse every release.
 *
 * The alternative designs are both wrong. Making every application hand-write a list of startup
 * scopes is wiring that has to be maintained forever and will drift. Loading every scope at
 * startup is the same defect with nobody to blame for it. Atlas already analyses the route tree,
 * so it can see the boundaries and derive the answer, which is what it does now.
 *
 * A file behind a boundary that something eager also imports is eager: the first render already
 * pays for it, so deferring its messages would defer nothing and risk rendering a component whose
 * text has not arrived.
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

async function analyse(
  files: Readonly<Record<string, string>>,
): Promise<readonly string[]> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-lazy-'));
  temporaryRoots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await write(root, path, contents);
  }
  const analysis = analyzeAtlasApplication({
    projectRoot: root,
    rootNames: Object.keys(files).map((path) => resolve(root, path)),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    },
  });
  if (!analysis.ok) throw new Error('analysis failed');
  const { deferredSourcePaths } = analysis.value;
  if (deferredSourcePaths === undefined) {
    // Not `?? []`: an absent list and an empty one are the same value to every assertion below,
    // and only one of them is an answer.
    throw new Error('the analysis reported no deferred-boundary list at all');
  }
  return deferredSourcePaths;
}

async function diagnose(
  files: Readonly<Record<string, string>>,
): Promise<readonly AtlasDiagnostic[]> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-lazy-'));
  temporaryRoots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await write(root, path, contents);
  }
  const analysis = analyzeAtlasApplication({
    projectRoot: root,
    rootNames: Object.keys(files).map((path) => resolve(root, path)),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    },
  });
  return analysis.diagnostics;
}

/** The route file for the check below, with the static import present or absent. */
function sharedComponentApplication(
  staticImport: boolean,
): Readonly<Record<string, string>> {
  return {
    'node_modules/@angular/router/index.d.ts': ROUTER_STUB,
    'node_modules/@angular/router/package.json': ROUTER_MANIFEST,
    'src/second.ts': 'export class Second {}\n',
    'src/app.routes.ts': [
      "import type { Routes } from '@angular/router';",
      ...(staticImport ? ["import { Second } from './second';"] : []),
      '',
      'export const routes: Routes = [',
      ...(staticImport ? ["  { path: 'eager', component: Second },"] : []),
      "  { path: 'lazy', loadComponent: () => import('./second') },",
      '];',
      '',
    ].join('\n'),
  };
}

// The route contract is recognised by its declaration coming from @angular/router, so the
// fixture supplies a stub at that path rather than a local type of the same name: the same
// discipline the analysis uses to avoid mistaking a consumer's `Routes` for Angular's.
const ROUTER_STUB = [
  'export declare interface Route {',
  '  path?: string;',
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

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('routes that split the bundle', () => {
  it('defers what only a lazily loaded route reaches', async () => {
    const deferred = await analyse({
      'node_modules/@angular/router/index.d.ts': ROUTER_STUB,
      'node_modules/@angular/router/package.json': ROUTER_MANIFEST,
      'src/admin.ts': "export const panel = 'admin';\n",
      'src/app.routes.ts': [
        "import type { Routes } from '@angular/router';",
        '',
        'export const routes: Routes = [',
        "  { path: 'admin', loadComponent: () => import('./admin') },",
        '];',
        '',
      ].join('\n'),
    });

    expect(deferred).toContain('src/admin.ts');
  });

  it('follows the boundary transitively', async () => {
    // A file the lazy route imports is just as absent from the first render as the route itself.
    const deferred = await analyse({
      'node_modules/@angular/router/index.d.ts': ROUTER_STUB,
      'node_modules/@angular/router/package.json': ROUTER_MANIFEST,
      'src/admin-detail.ts': "export const detail = 'detail';\n",
      'src/admin.ts':
        "import { detail } from './admin-detail';\n\nexport const panel = detail;\n",
      'src/app.routes.ts': [
        "import type { Routes } from '@angular/router';",
        '',
        'export const routes: Routes = [',
        "  { path: 'admin', loadComponent: () => import('./admin') },",
        '];',
        '',
      ].join('\n'),
    });

    expect(deferred).toContain('src/admin.ts');
    expect(deferred).toContain('src/admin-detail.ts');
  });

  it('keeps a shared file eager', async () => {
    // The case that makes a naive answer wrong. `shared.ts` sits behind the boundary *and* in the
    // first render, so it is downloaded either way. Deferring its messages would defer nothing
    // and risk rendering eager UI whose text has not arrived.
    const deferred = await analyse({
      'node_modules/@angular/router/index.d.ts': ROUTER_STUB,
      'node_modules/@angular/router/package.json': ROUTER_MANIFEST,
      'src/shared.ts': "export const label = 'shared';\n",
      'src/admin.ts':
        "import { label } from './shared';\n\nexport const panel = label;\n",
      'src/app.ts':
        "import { label } from './shared';\n\nexport const title = label;\n",
      'src/app.routes.ts': [
        "import type { Routes } from '@angular/router';",
        '',
        'export const routes: Routes = [',
        "  { path: 'admin', loadComponent: () => import('./admin') },",
        '];',
        '',
      ].join('\n'),
    });

    expect(deferred).toContain('src/admin.ts');
    expect(deferred).not.toContain('src/shared.ts');
  });

  it('defers nothing when every route is eager', async () => {
    const deferred = await analyse({
      'node_modules/@angular/router/index.d.ts': ROUTER_STUB,
      'node_modules/@angular/router/package.json': ROUTER_MANIFEST,
      'src/admin.ts': "export const panel = 'admin';\n",
      'src/app.routes.ts': [
        "import type { Routes } from '@angular/router';",
        "import { panel } from './admin';",
        '',
        'export const routes: Routes = [{ path: '.concat(
          "'admin'",
          ', component: Page }];',
        ),
        'export class Page {}',
        'export const eager = panel;',
        '',
      ].join('\n'),
    });

    expect(deferred).toEqual([]);
  });

  it('reports a lazy boundary that defers nothing', async () => {
    // Found while building the lazy fixture, and invisible to everything else. Keeping a static
    // import of a component a route also lazy-loads pulls it into the initial bundle while every
    // other signal stays correct: chunk names, prerendered output, and the route table all read
    // exactly as they do when the split works.
    //
    // Keyed on the loader's target sitting in the eager closure, never on the route table
    // mentioning it: `staticImportClosure` follows `import` and `export` declarations only, so the
    // dynamic import inside the loader never puts its own target in the eager set. A check keyed
    // on mentions would report every lazy route in the application, because a route table always
    // names its own loaders.
    const diagnostics = await diagnose(sharedComponentApplication(true));

    const eager = diagnostics.filter(({ code }) => code === 'ATL1407');
    expect(eager).toHaveLength(1);
    expect(eager[0]?.severity).toBe('warning');
    expect(eager[0]?.summary).toContain('/lazy');
    expect(eager[0]?.summary).toContain('src/second.ts');
  });

  it('says nothing when the same boundary is the only way in', async () => {
    // The mutation. Removing the static import is the whole difference: the loader is unchanged,
    // the route table still names it, and the file is still reachable from an eagerly imported
    // route file through the dynamic import the closure does not follow.
    const diagnostics = await diagnose(sharedComponentApplication(false));

    expect(diagnostics.filter(({ code }) => code === 'ATL1407')).toEqual([]);
    expect(await analyse(sharedComponentApplication(false))).toContain(
      'src/second.ts',
    );
  });

  it('treats a specifier it cannot resolve at build time as eager', async () => {
    // A computed specifier is one no bundler can split either, so calling it a boundary would be a
    // guess. Guessing wrong here means messages that never arrive.
    const deferred = await analyse({
      'node_modules/@angular/router/index.d.ts': ROUTER_STUB,
      'node_modules/@angular/router/package.json': ROUTER_MANIFEST,
      'src/admin.ts': "export const panel = 'admin';\n",
      'src/app.routes.ts': [
        "import type { Routes } from '@angular/router';",
        '',
        "const which = './admin';",
        'export const routes: Routes = [',
        "  { path: 'admin', loadComponent: () => import(which) },",
        '];',
        '',
      ].join('\n'),
    });

    expect(deferred).toEqual([]);
  });
});
