import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { analyzeAtlasApplication } from '../src/static-analysis.js';

/**
 * What this guards is the path a forwarded finding carries when it sits inside a generated module.
 *
 * Analysis overlays the generated modules rather than reading them from disk, and a finding inside
 * one is forwarded to the consumer with the overlay's path on it. The path has to spell the module
 * it came from, because it is the only thing telling a reader which generated module to look at.
 */

const projectRoot = resolve('fixtures/semantic-analysis/virtual-module-paths');
const appPath = resolve(projectRoot, 'app.ts');

function pathsOfFindings(specifier: string): readonly string[] {
  const analysis = analyzeAtlasApplication({
    projectRoot,
    rootNames: [appPath],
    sources: [
      {
        path: appPath,
        contents: [
          `import { answer } from '${specifier}';`,
          'export const value: number = answer;',
          '',
        ].join('\n'),
      },
    ],
    virtualModules: [
      {
        specifier,
        // A finding of its own, so the overlay is the file a diagnostic is located in.
        contents: "export const answer: number = 'not a number';\n",
      },
    ],
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      baseUrl: projectRoot,
    },
  });
  // The overlay's own finding fails the analysis, which is the case being described rather than a
  // fixture problem, so the diagnostics are read from either outcome.
  return analysis.diagnostics
    .map(({ span }) => span?.sourcePath)
    .filter((path): path is string => path !== undefined);
}

describe('the path a finding inside a generated module carries', () => {
  it('spells the module the overlay stands in for', () => {
    expect(pathsOfFindings('#i18n/lazy')).toContain('.atlas-virtual/lazy.ts');
  });

  it('spells a nested generated module the same way', () => {
    expect(pathsOfFindings('#i18n/catalogs/shell')).toContain(
      '.atlas-virtual/catalogs/shell.ts',
    );
  });

  it('names the root module index', () => {
    expect(pathsOfFindings('#i18n')).toContain('.atlas-virtual/index.ts');
  });
});
