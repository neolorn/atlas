import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateAtlasProject } from '../src/index.js';

/**
 * Which scopes the first render needs, when the messages are used in templates.
 *
 * A message used in a component's template is reported against the template, because that is the
 * file a developer opens to change it. The module graph has never heard of that file: a `.html`
 * is not imported by anything, so read literally every template usage sits outside every lazy
 * boundary.
 *
 * Found by migrating a real application. Its home page is a `loadComponent` route whose sections
 * put every message in templates, and the derived startup set contained the page's scope anyway,
 * so the derivation agreed exactly with the hand-written list it replaced, and looked correct
 * for that reason. Reachability is a question about modules, so it has to be asked about the
 * component that owns the template.
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

const ANGULAR_CORE = [
  'export interface ComponentMetadata {',
  '  selector?: string;',
  '  template?: string;',
  '  templateUrl?: string;',
  '}',
  'export declare function Component(',
  '  metadata: ComponentMetadata,',
  '): ClassDecorator;',
  '',
].join('\n');

const ANGULAR_ROUTER = [
  'export declare interface Route {',
  '  path?: string;',
  '  loadComponent?: () => Promise<unknown>;',
  '  children?: readonly Route[];',
  '}',
  'export type Routes = readonly Route[];',
  '',
].join('\n');

function manifest(name: string): string {
  return `${JSON.stringify(
    { name, version: '0.0.0', types: './index.d.ts' },
    null,
    2,
  )}\n`;
}

/** A project whose only use of the `page` scope is a template behind a lazy route. */
async function project(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-template-reach-'));
  temporaryRoots.push(root);

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: '@example/atlas-template-reachability',
        version: '0.0.0',
        private: true,
        type: 'module',
        imports: {
          '#i18n': './src/generated/i18n/index.ts',
          '#i18n/*': './src/generated/i18n/*.ts',
        },
      },
      null,
      2,
    )}\n`,
  );
  await write(
    root,
    'atlas.config.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US'],
      },
      null,
      2,
    )}\n`,
  );
  await write(
    root,
    'tsconfig.app.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'preserve',
          moduleResolution: 'bundler',
          resolvePackageJsonImports: true,
          skipLibCheck: true,
          experimentalDecorators: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await write(root, 'node_modules/@angular/core/index.d.ts', ANGULAR_CORE);
  await write(
    root,
    'node_modules/@angular/core/package.json',
    manifest('@angular/core'),
  );
  await write(root, 'node_modules/@angular/router/index.d.ts', ANGULAR_ROUTER);
  await write(
    root,
    'node_modules/@angular/router/package.json',
    manifest('@angular/router'),
  );

  await write(root, 'i18n/shell/en-US.yaml', 'messages:\n  app-title: Shell\n');
  await write(root, 'i18n/page/en-US.yaml', 'messages:\n  heading: Page\n');

  // The shell, eager, using its message from TypeScript.
  await write(
    root,
    'src/shell.ts',
    [
      "import { messages } from '#i18n/shell';",
      '',
      'export const title = messages.appTitle.messageId;',
      '',
    ].join('\n'),
  );

  // The page, behind a lazy boundary, using its message only from a template file.
  await write(
    root,
    'src/page.html',
    '<h1>{{ messages.heading.messageId }}</h1>\n',
  );
  await write(
    root,
    'src/page.ts',
    [
      "import { Component } from '@angular/core';",
      "import { messages } from '#i18n/page';",
      '',
      '@Component({',
      "  selector: 'app-page',",
      "  templateUrl: './page.html',",
      '})',
      'export class Page {',
      '  protected readonly messages = messages;',
      '}',
      '',
    ].join('\n'),
  );

  await write(
    root,
    'src/app.routes.ts',
    [
      "import type { Routes } from '@angular/router';",
      '',
      'export const routes: Routes = [',
      "  { path: 'page', loadComponent: () => import('./page') },",
      '];',
      '',
    ].join('\n'),
  );

  return root;
}

function startupOf(generated: string): Readonly<Record<string, boolean>> {
  const scopes: Record<string, boolean> = {};
  for (const match of generated.matchAll(
    /scopeId: "([a-z-]+)"[^}]*?startup: (true|false)/gu,
  )) {
    scopes[match[1] as string] = match[2] === 'true';
  }
  return scopes;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('a route behind a lazy boundary', () => {
  it('carries the scopes it has to have ready before it renders', async () => {
    // Deferring a scope is only safe if something loads it at the right time. Atlas already knows
    // which scopes a lazily loaded page uses, so the route table says so and the router adapter
    // loads them on activation: no application lists scopes per route.
    //
    // The startup scope is in the list too. "Startup" means loaded for the locale the page started
    // in, and a locale transition has to have every scope the page renders ready in the new locale
    // before it commits.
    const root = await project();
    expect((await generateAtlasProject({ project: root })).ok).toBe(true);

    const routes = await readFile(
      resolve(root, 'src/generated/i18n/routes.ts'),
      'utf8',
    );

    expect(routes).toContain('scopeId: "page"');
    expect(routes).toContain('scopeId: "shell"');
  });
});

describe('a scope used only from a template', () => {
  it('is deferred when the component that owns the template is', async () => {
    const root = await project();
    const generated = await generateAtlasProject({ project: root });
    expect(generated.ok).toBe(true);

    const index = await readFile(
      resolve(root, 'src/generated/i18n/index.ts'),
      'utf8',
    );

    expect(startupOf(index)).toEqual({ page: false, shell: true });
  });
});
