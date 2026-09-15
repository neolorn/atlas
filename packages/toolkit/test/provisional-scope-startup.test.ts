import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { compileAtlasProject, parseAtlasCatalog } from '../src/index.js';
import { generateAtlasContracts } from '../src/generated-contracts.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';
import { analyzeAtlasApplication } from '../src/static-analysis.js';
import { testProjectConfiguration } from './fixtures.js';

/**
 * What this guards is the claim the analysis overlay makes about which scopes the first render
 * needs.
 *
 * Which scopes are deferred is derived from where the application uses their messages, which the
 * analysis pass discovers, so the overlay that pass starts from cannot know it. Written as a
 * deferred set that happens to be empty, the overlay states that every scope is a startup scope,
 * which is false for any application with a scope behind a lazy boundary. Absent is the answer the
 * runtime contract already has a spelling for.
 */

function catalog(scopeId: string, body: string) {
  const parsed = parseAtlasCatalog(body, {
    role: 'source',
    providerId: 'home',
    scopeId,
    locale: 'en-US',
    sourcePath: `i18n/${scopeId}/en-US.yaml`,
  });
  if (!parsed.ok) throw new Error(`fixture ${scopeId} failed to parse`);
  return parsed.value;
}

const indexModule = (
  options: Parameters<typeof generateAtlasContracts>[1],
): string => {
  const graph = analyzeAtlasCatalogSet({
    configuration: testProjectConfiguration(['en-US']),
    catalogs: [
      catalog('shell', 'messages:\n  nav.home: Home\n'),
      catalog('lazy', 'messages:\n  panel.title: Panel\n'),
    ],
  });
  if (!graph.ok) throw new Error(JSON.stringify(graph.diagnostics));
  const contracts = generateAtlasContracts(graph.value, options);
  if (!contracts.ok) throw new Error(JSON.stringify(contracts.diagnostics));
  const file = contracts.value.find(({ path }) => path === 'index.ts');
  if (file === undefined) throw new Error('no index.ts was generated');
  return file.contents;
};

describe('the scope table the analysis overlay starts from', () => {
  it('claims nothing about which scopes the first render needs', () => {
    const contents = indexModule({});

    expect(contents).not.toContain('startup:');
  });

  it('still names every scope, with the rest of what a scope carries', () => {
    const contents = indexModule({});

    expect(contents).toContain('scopeId: "shell"');
    expect(contents).toContain('scopeId: "lazy"');
    expect(contents).toContain('applicationContractFingerprint:');
    expect(contents).toContain('requiredExtensions:');
  });
});

describe('the scope table a generation writes', () => {
  it('states a startup scope for every scope when nothing is deferred', () => {
    // Distinct from the overlay above, and the reason the two cases cannot share one spelling: an
    // analysis that found nothing behind a lazy boundary knows that every scope is needed at
    // startup, and says so.
    const contents = indexModule({ deferredScopeIds: [] });

    expect(contents).toContain('startup: true');
    expect(contents).not.toContain('startup: false');
  });

  it('states the deferred scope it was given', () => {
    const contents = indexModule({ deferredScopeIds: ['lazy'] });

    expect(contents).toMatch(/scopeId: "lazy",[^\n]*startup: false/u);
    expect(contents).toMatch(/scopeId: "shell",[^\n]*startup: true/u);
  });
});

const projectRoot = resolve('fixtures/semantic-analysis/scope-startup');
const appPath = resolve(projectRoot, 'src/app.ts');

const compiledIndexModule = (analysed: boolean): string => {
  const compiled = compileAtlasProject({
    owner: { providerId: 'home', generatedRootPath: 'src/generated/i18n' },
    configuration: testProjectConfiguration(['en-US']),
    catalogs: [
      catalog('shell', 'messages:\n  nav.home: Home\n'),
      catalog('lazy', 'messages:\n  panel.title: Panel\n'),
    ],
    ...(analysed
      ? {
          analysis: {
            projectRoot,
            rootNames: [appPath],
            sources: [
              { path: appPath, contents: "export const name = 'app';\n" },
            ],
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.Preserve,
              moduleResolution: ts.ModuleResolutionKind.Bundler,
              strict: true,
              skipLibCheck: true,
            },
          },
        }
      : {}),
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const file = compiled.value.artifacts.outputPlan.files.find(({ path }) =>
    path.endsWith('index.ts'),
  );
  if (file === undefined) throw new Error('no index.ts was planned');
  return file.contents;
};

describe('the scope table a compilation writes', () => {
  it('states a startup scope for every scope when the pass found nothing deferred', () => {
    // The answer an empty deferred set carries. Reached only by passing the set through when the
    // pass ran, which is what tells it apart from a compilation that never asked.
    expect(compiledIndexModule(true)).toContain('startup: true');
  });

  it('claims nothing when no analysis ran', () => {
    expect(compiledIndexModule(false)).not.toContain('startup:');
  });
});

/**
 * The reading an application performs on the table it declared.
 *
 * `startup` is part of the runtime's scope contract, so an application may ask which scopes its
 * first render needs. It compiles that reading against the real table, and Atlas compiles the same
 * lines against the overlay, so a field the overlay drops out of the type is reported back to the
 * application as a property that does not exist on a table it wrote correctly.
 */
const readsTheStartupField = [
  "import { configuration } from '#i18n';",
  '',
  'export function startupScopeIds(): readonly string[] {',
  '  return configuration.scopes',
  '    .filter(({ startup }) => startup !== false)',
  '    .map(({ scopeId }) => scopeId);',
  '}',
  '',
  'export function deferredScopeIds(): readonly string[] {',
  '  return configuration.scopes',
  '    .filter(({ startup }) => startup === false)',
  '    .map(({ scopeId }) => scopeId);',
  '}',
  '',
].join('\n');

const readingPath = resolve(projectRoot, 'src/reads-startup.ts');

function findingsAgainstTheApplication(
  options: Parameters<typeof generateAtlasContracts>[1],
): readonly string[] {
  const analysis = analyzeAtlasApplication({
    projectRoot,
    rootNames: [readingPath],
    sources: [{ path: readingPath, contents: readsTheStartupField }],
    virtualModules: [{ specifier: '#i18n', contents: indexModule(options) }],
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      baseUrl: projectRoot,
    },
  });
  // Read from either outcome: a finding inside the overlay fails the analysis, and the point here
  // is which file the findings are located in.
  return analysis.diagnostics
    .filter(({ span }) => span?.sourcePath === 'src/reads-startup.ts')
    .map(({ summary }) => summary);
}

describe('an application reading the scope table it declared', () => {
  it('is not reported against by the overlay the pass starts from', () => {
    expect(findingsAgainstTheApplication({})).toEqual([]);
  });

  it('is not reported against once the pass has an answer either', () => {
    expect(
      findingsAgainstTheApplication({ deferredScopeIds: ['lazy'] }),
    ).toEqual([]);
  });
});

describe('the helper the unknown case carries the field with', () => {
  it('wraps every row, so each one admits the field', () => {
    const contents = indexModule({});

    expect(contents).toContain(
      'const provisionalScope = <Scope extends object>(',
    );
    expect(
      contents.match(/provisionalScope\(Object\.freeze\(\{/gu),
    ).toHaveLength(2);
  });

  it('is absent once the table states the field itself', () => {
    expect(indexModule({ deferredScopeIds: [] })).not.toContain(
      'provisionalScope',
    );
  });
});
