import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  parseAtlasCatalog,
  parseAtlasConfiguration,
  type AtlasCatalog,
  type AtlasProjectConfiguration,
} from '../src/index.js';
import { generateAtlasContracts } from '../src/generated-contracts.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';
import { analyzeAtlasApplication } from '../src/static-analysis.js';

function configuration(): AtlasProjectConfiguration {
  const result = parseAtlasConfiguration(
    JSON.stringify({
      schemaVersion: 1,
      sourceLocale: 'en-US',
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
    }),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Configuration fixture failed');
  return result.value;
}

function catalog(
  role: 'source' | 'target',
  locale: string,
  source: string,
): AtlasCatalog {
  const result = parseAtlasCatalog(source, {
    role,
    providerId: '@neolorn/feature-lab',
    scopeId: 'shell',
    locale,
    sourcePath: `i18n/shell/${locale}.yaml`,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Catalog fixture failed');
  return result.value;
}

const sourceCatalog = catalog(
  'source',
  'en-US',
  [
    'messages:',
    '  app-title: Atlas feature lab',
    '  welcome: "Welcome {$name}!"',
    '  balance: "Balance: {$amount :currency currency=USD}"',
    '  status:',
    '    message: "Status: {$value}"',
    '    inputs:',
    '      value:',
    '        type: string',
    '        enum: [active, disabled]',
    '  learn-more: "Read the {#strong}guide{/strong}."',
    '  recovery: Recovery',
    '  recovery.unavailable: Localization is temporarily unavailable.',
    '',
  ].join('\n'),
);

const targetCatalog = catalog(
  'target',
  'ar-EG',
  [
    'messages:',
    '  app-title: مختبر Atlas',
    '  welcome: "مرحبًا {$name}!"',
    '  balance: "الرصيد: {$amount :currency currency=USD}"',
    '  status: "الحالة: {$value}"',
    '  learn-more: "اقرأ {#strong}الدليل{/strong}."',
    '  recovery: استرداد',
    '  recovery.unavailable: الترجمة غير متاحة مؤقتًا.',
    '',
  ].join('\n'),
);

describe('Atlas catalog-set semantic analysis', () => {
  it('derives effective input, rich-slot, target, and compatibility contracts', () => {
    const result = analyzeAtlasCatalogSet({
      configuration: configuration(),
      catalogs: [targetCatalog, sourceCatalog],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scope = result.value.scopes[0];
    expect(scope?.availableLocales).toEqual(['ar-EG', 'en-US']);
    expect(scope?.applicationContractFingerprint).toMatch(
      /^sha256-[\w-]{43}$/u,
    );
    expect(result.value.applicationContractFingerprint).toMatch(
      /^sha256-[\w-]{43}$/u,
    );

    const messages = new Map(
      scope?.messages.map((message) => [message.messageId, message]),
    );
    expect(messages.get('welcome')?.inputs).toEqual([
      {
        name: 'name',
        type: 'string',
        optional: false,
        nullable: false,
      },
    ]);
    expect(messages.get('balance')?.inputs[0]?.type).toBe('number');
    expect(messages.get('status')?.inputs[0]?.enum).toEqual([
      'active',
      'disabled',
    ]);
    expect(messages.get('learn-more')?.slots).toEqual([
      {
        name: 'strong',
        kind: 'strong',
        shape: 'paired',
        optional: false,
        repeatable: false,
        within: ['@root'],
      },
    ]);
    expect(messages.get('welcome')?.targets).toMatchObject([
      { locale: 'ar-EG', kind: 'message' },
    ]);
  });

  it('rejects source refinements and target structures that change inferred contracts', () => {
    const invalidSource = catalog(
      'source',
      'en-US',
      [
        'messages:',
        '  amount:',
        '    message: "{$value :number}"',
        '    inputs:',
        '      value: string',
        '',
      ].join('\n'),
    );
    const invalidTarget = catalog(
      'target',
      'ar-EG',
      'messages:\n  amount: "{#strong}{$value :number}{/strong}"\n',
    );
    const result = analyzeAtlasCatalogSet({
      configuration: configuration(),
      catalogs: [invalidSource, invalidTarget],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain('ATL1302');
    expect(result.diagnostics.map(({ code }) => code)).toContain('ATL1304');
  });
});

describe('Atlas generated contracts and bounded application analysis', () => {
  it('generates typed deep handle trees and analyzes TypeScript, templates, and routes through public APIs', () => {
    const graph = analyzeAtlasCatalogSet({
      configuration: configuration(),
      catalogs: [sourceCatalog, targetCatalog],
    });
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    const recoveryIdentity = '@neolorn/feature-lab:shell:recovery.unavailable';
    const generated = generateAtlasContracts(graph.value, {
      recoveryMessageIdentities: [recoveryIdentity],
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.map(({ path }) => path)).toEqual([
      'index.ts',
      'recovery.ts',
      'routes.ts',
      'shell.ts',
    ]);
    const shell = generated.value.find(({ path }) => path === 'shell.ts');
    expect(shell?.contents).toContain('readonly "name": string;');
    expect(shell?.contents).toContain('"learnMore"');
    expect(shell?.contents).toContain('Object.assign');

    const fixtureRoot = resolve(
      'fixtures/semantic-analysis/generated-contracts',
    );
    const appPath = resolve(fixtureRoot, 'app.component.ts');
    const templatePath = resolve(fixtureRoot, 'app.component.html');
    const routesPath = resolve(fixtureRoot, 'routes.ts');
    const aboutPath = resolve(fixtureRoot, 'about.component.ts');
    const appSource = [
      "import { Component } from '@angular/core';",
      "import { messages } from '#i18n/shell';",
      '@Component({',
      "  selector: 'atlas-generated-probe',",
      "  templateUrl: './app.component.html',",
      '})',
      'export class AppComponent {',
      '  protected readonly title = messages.appTitle;',
      '  protected readonly recovery = messages.recovery.unavailable;',
      '}',
      '',
    ].join('\n');
    const routeSource = [
      "import type { Routes } from '@angular/router';",
      "import { AppComponent } from './app.component';",
      'export const routes = [',
      "  { path: '', component: AppComponent, data: { atlasRouteId: 'home', atlasIndexing: 'indexable' } },",
      "  { path: 'about/:id', loadComponent: () => import('./about.component').then((value) => value.AboutComponent), data: { atlasRouteId: 'about', atlasIndexing: 'non-indexable' } },",
      '] satisfies Routes;',
      '',
    ].join('\n');
    const aboutSource = [
      "import { Component } from '@angular/core';",
      "@Component({ selector: 'atlas-about', template: '<p>About</p>' })",
      'export class AboutComponent {}',
      '',
    ].join('\n');
    const analysis = analyzeAtlasApplication({
      projectRoot: fixtureRoot,
      rootNames: [appPath, routesPath, aboutPath],
      sources: [
        { path: appPath, contents: appSource },
        {
          path: templatePath,
          contents: '<h1>{{ title }}</h1><p>{{ recovery }}</p>',
        },
        { path: routesPath, contents: routeSource },
        { path: aboutPath, contents: aboutSource },
      ],
      virtualModules: generated.value
        .filter(({ path }) => path.endsWith('.ts'))
        .map(({ path, contents }) => ({
          specifier:
            path === 'index.ts'
              ? '#i18n'
              : `#i18n/${path.replace(/\.ts$/u, '')}`,
          contents,
        })),
      knownMessageIdentities: graph.value.scopes.flatMap((scope) =>
        scope.messages.map(({ identity }) => identity),
      ),
    });
    expect(analysis.ok, JSON.stringify(analysis.diagnostics, null, 2)).toBe(
      true,
    );
    if (!analysis.ok) return;
    expect(
      new Set(analysis.value.messageUsages.map(({ identity }) => identity)),
    ).toEqual(
      new Set([
        '@neolorn/feature-lab:shell:app-title',
        '@neolorn/feature-lab:shell:recovery.unavailable',
      ]),
    );
    expect(
      analysis.value.messageUsages.some(
        ({ surface }) => surface === 'template',
      ),
    ).toBe(true);
    expect(
      analysis.value.routes.map(({ id, path, parameterNames, indexing }) => ({
        id,
        path,
        parameterNames,
        indexing,
      })),
    ).toEqual([
      {
        id: 'home',
        path: '',
        parameterNames: [],
        indexing: 'indexable',
      },
      {
        id: 'about',
        path: 'about/:id',
        parameterNames: ['id'],
        indexing: 'non-indexable',
      },
    ]);
    const projected = generateAtlasContracts(graph.value, {
      routes: analysis.value.routes,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const routeContract = projected.value.find(
      ({ path }) => path === 'routes.ts',
    );
    expect(routeContract?.contents).toMatch(
      /profile: 'atlas-route-projection\/1'/u,
    );
    expect(routeContract?.contents).toMatch(/identity: "sha256-/u);
    expect(routeContract?.contents).toContain(
      'id: "about", path: "about/:id", parameterNames: Object.freeze(["id"] as const), indexing: "non-indexable"',
    );
    expect(
      analysis.value.components.map(({ componentName }) => componentName),
    ).toEqual(['AboutComponent', 'AppComponent']);
  });
});

describe('Atlas analysis under consumer compiler configuration', () => {
  function analysisFixture(): {
    readonly fixtureRoot: string;
    readonly virtualModules: readonly {
      readonly specifier: string;
      readonly contents: string;
    }[];
    readonly knownMessageIdentities: readonly string[];
  } {
    const graph = analyzeAtlasCatalogSet({
      configuration: configuration(),
      catalogs: [sourceCatalog, targetCatalog],
    });
    expect(graph.ok).toBe(true);
    if (!graph.ok) throw new Error('Catalog fixture failed');
    const generated = generateAtlasContracts(graph.value, {
      recoveryMessageIdentities: [
        '@neolorn/feature-lab:shell:recovery.unavailable',
      ],
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error('Contract fixture failed');
    return {
      fixtureRoot: resolve('fixtures/semantic-analysis/consumer-options'),
      virtualModules: generated.value
        .filter(({ path }) => path.endsWith('.ts'))
        .map(({ path, contents }) => ({
          specifier:
            path === 'index.ts'
              ? '#i18n'
              : `#i18n/${path.replace(/\.ts$/u, '')}`,
          contents,
        })),
      knownMessageIdentities: graph.value.scopes.flatMap((scope) =>
        scope.messages.map(({ identity }) => identity),
      ),
    };
  }

  // Guards the consumer-configuration contract: Atlas analyzes the program the
  // consumer's compiler builds. Imposing stricter options or discarding the
  // consumer's path aliases reports defects in a program that does not exist,
  // and makes generation unreachable for ordinary Angular workspaces.
  it('honors consumer path aliases and strictness instead of imposing its own', () => {
    const { fixtureRoot, virtualModules, knownMessageIdentities } =
      analysisFixture();
    const aliasPath = resolve(fixtureRoot, 'vendor/toolbox.ts');
    const appPath = resolve(fixtureRoot, 'app.component.ts');
    const aliasSource = [
      'export function describeCount(values: readonly string[]): string {',
      // Valid without noUncheckedIndexedAccess; an error when Atlas imposes it.
      '  const first = values[0];',
      '  return first.toUpperCase();',
      '}',
      '',
    ].join('\n');
    const appSource = [
      "import { Component } from '@angular/core';",
      "import { messages } from '#i18n/shell';",
      // Resolvable only when the consumer's own paths survive.
      "import { describeCount } from '@fixture/toolbox';",
      'interface Label {',
      '  readonly text?: string;',
      '}',
      // Valid without exactOptionalPropertyTypes; an error when Atlas imposes it.
      'const label: Label = { text: undefined };',
      '@Component({',
      "  selector: 'atlas-consumer-options-probe',",
      "  template: '<p>{{ title }}</p>',",
      '})',
      'export class AppComponent {',
      '  protected readonly title = messages.appTitle;',
      "  protected readonly summary = describeCount([label.text ?? '']);",
      '}',
      '',
    ].join('\n');

    const analysis = analyzeAtlasApplication({
      projectRoot: fixtureRoot,
      rootNames: [appPath, aliasPath],
      sources: [
        { path: appPath, contents: appSource },
        { path: aliasPath, contents: aliasSource },
      ],
      virtualModules,
      knownMessageIdentities,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        experimentalDecorators: true,
        strict: true,
        skipLibCheck: true,
        baseUrl: fixtureRoot,
        paths: { '@fixture/toolbox': [aliasPath] },
      },
    });

    // Every regression this fixture exists to catch reports as a *warning*, because a consumer's
    // own TypeScript problems are consumer-owned and Atlas does not treat them as fatal. An
    // assertion that filters for errors therefore sees none of them: dropping the consumer's
    // paths, or imposing noUncheckedIndexedAccess, or imposing exactOptionalPropertyTypes, all
    // leave this test green. The subject has to be every diagnostic collected, rather than the
    // outcome flag or one severity.
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) return;
    expect(
      analysis.value.messageUsages.map(({ identity }) => identity),
    ).toContain('@neolorn/feature-lab:shell:app-title');
  });

  it('reports consumer source findings as advisories without blocking generation', () => {
    const { fixtureRoot, virtualModules, knownMessageIdentities } =
      analysisFixture();
    const appPath = resolve(fixtureRoot, 'broken.component.ts');
    const appSource = [
      "import { messages } from '#i18n/shell';",
      // A genuine consumer defect: the consumer's own build owns this verdict.
      "const broken: number = 'not a number';",
      'export const title = messages.appTitle;',
      'export const value = broken;',
      '',
    ].join('\n');

    const analysis = analyzeAtlasApplication({
      projectRoot: fixtureRoot,
      rootNames: [appPath],
      sources: [{ path: appPath, contents: appSource }],
      virtualModules,
      knownMessageIdentities,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
        baseUrl: fixtureRoot,
      },
    });

    expect(analysis.ok).toBe(true);
    const advisories = analysis.diagnostics.filter(
      ({ code, severity }) => code === 'ATL1401' && severity === 'warning',
    );
    expect(advisories.length).toBeGreaterThan(0);
    expect(
      analysis.diagnostics.filter(({ severity }) => severity === 'error'),
    ).toEqual([]);
  });

  it('still fails when a generated #i18n module is itself defective', () => {
    const { fixtureRoot, knownMessageIdentities } = analysisFixture();
    const appPath = resolve(fixtureRoot, 'consumer.ts');

    const analysis = analyzeAtlasApplication({
      projectRoot: fixtureRoot,
      rootNames: [appPath],
      sources: [
        {
          path: appPath,
          contents: "export { broken } from '#i18n/shell';\n",
        },
      ],
      virtualModules: [
        {
          specifier: '#i18n/shell',
          contents: 'export const broken: number = "not a number";\n',
        },
      ],
      knownMessageIdentities,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
        baseUrl: fixtureRoot,
      },
    });

    expect(analysis.ok).toBe(false);
    expect(
      analysis.diagnostics.some(
        ({ code, severity }) => code === 'ATL1401' && severity === 'error',
      ),
    ).toBe(true);
  });
});
