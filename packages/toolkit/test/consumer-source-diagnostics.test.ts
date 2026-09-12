import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkAtlasProject, generateAtlasProject } from '../src/index.js';

/**
 * A consumer mid-refactor must not have its Atlas build fail because of its own TypeScript errors.
 *
 * The 100-diagnostic cap region was unreachable because every fixture compiled clean, so nothing
 * exercised what happens on the other side of it, and crossing the cap turns findings that are
 * deliberately non-blocking into a fatal error.
 *
 * Also covered: no fixture `tsconfig` carried `compilerOptions.paths`, so the path that analyses
 * a consumer under its own compiler configuration was never exercised from the CLI-facing API.
 *
 * Every project below is built with deliberate errors that belong to the consumer, never to a
 * generated `#i18n` module. Atlas's own generated defects must still block, and that distinction
 * is the point of the severity split in `static-analysis.ts`.
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

interface ProjectOptions {
  readonly consumerErrors: number;
  readonly paths?: boolean;
  /** Declare a component whose templateUrl resolves outside the owner. */
  readonly escapingTemplate?: boolean;
}

async function consumerProject(options: ProjectOptions): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-consumer-source-'));
  temporaryRoots.push(root);

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: '@example/atlas-consumer-source',
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
        locales: ['en-US', 'ar-EG'],
      },
      null,
      2,
    )}\n`,
  );
  await write(root, 'i18n/shell/en-US.yaml', 'messages:\n  app-title: Atlas\n');
  await write(root, 'i18n/shell/ar-EG.yaml', 'messages:\n  app-title: أطلس\n');
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
          ...(options.paths === true
            ? { baseUrl: '.', paths: { '@app/*': ['./src/*'] } }
            : {}),
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  if (options.paths === true) {
    // The alias has to be used, not merely declared. A tsconfig carrying `paths` that no source
    // imports through proves nothing: Atlas could discard the consumer's paths entirely and the
    // project would still analyse cleanly.
    await write(root, 'src/toolbox.ts', 'export const toolboxLabel = "t";\n');
  }
  await write(
    root,
    'src/app.ts',
    [
      "import { messages } from '#i18n/shell';",
      ...(options.paths === true
        ? ["import { toolboxLabel } from '@app/toolbox';"]
        : []),
      '',
      'export const title = messages.appTitle.messageId;',
      ...(options.paths === true ? ['export const label = toolboxLabel;'] : []),
      '',
    ].join('\n'),
  );

  if (options.escapingTemplate === true) {
    // Component detection resolves the @Component symbol and requires its declaration to come
    // from a path containing '/@angular/core/'. A stub declaration is enough: this exercises
    // Atlas's containment rule, not Angular.
    await write(
      root,
      'node_modules/@angular/core/index.d.ts',
      [
        'export interface ComponentMetadata {',
        '  selector?: string;',
        '  template?: string;',
        '  templateUrl?: string;',
        '}',
        'export declare function Component(',
        '  metadata: ComponentMetadata,',
        '): ClassDecorator;',
        '',
      ].join('\n'),
    );
    await write(
      root,
      'node_modules/@angular/core/package.json',
      `${JSON.stringify(
        { name: '@angular/core', version: '0.0.0', types: './index.d.ts' },
        null,
        2,
      )}\n`,
    );

    // The secret lives beside the owner, not inside it. Atlas must never open it.
    await write(
      resolve(root, '..'),
      `outside-${basename(root)}.html`,
      '<p>ATLAS_MUST_NOT_READ_THIS</p>\n',
    );
    await write(
      root,
      'src/escaping.component.ts',
      [
        "import { Component } from '@angular/core';",
        '',
        '@Component({',
        "  selector: 'escaping-component',",
        `  templateUrl: '../../outside-${basename(root)}.html',`,
        '})',
        'export class EscapingComponent {}',
        '',
      ].join('\n'),
    );
  }

  if (options.consumerErrors > 0) {
    const lines: string[] = [];
    for (let index = 0; index < options.consumerErrors; index += 1) {
      lines.push(`export const broken${index}: number = 'not a number';`);
    }
    await write(root, 'src/broken.ts', `${lines.join('\n')}\n`);
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("a consumer's own TypeScript errors", () => {
  it('does not block generation below the diagnostic cap', async () => {
    const root = await consumerProject({ consumerErrors: 99 });
    const generated = await generateAtlasProject({ project: root });

    expect(generated.ok).toBe(true);

    const diagnostics = generated.diagnostics;
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(
      diagnostics.filter((d) => d.severity === 'warning').length,
    ).toBeGreaterThanOrEqual(99);
  });

  it('reports them as warnings rather than errors', async () => {
    const root = await consumerProject({ consumerErrors: 50 });
    const generated = await generateAtlasProject({ project: root });

    expect(generated.ok).toBe(true);
    for (const diagnostic of generated.diagnostics) {
      expect(diagnostic.severity).toBe('warning');
    }
  });

  it('refuses to read a component template that escapes the owner', async () => {
    // B2. The project host filtered escaping paths out of suppliedSources by containment, and the
    // analysis fallback then read them from disk anyway, so a templateUrl of
    // '../../secret/leak.html' was opened and parsed. Atlas analyses the selected owner and
    // nothing else.
    const root = await consumerProject({
      consumerErrors: 0,
      escapingTemplate: true,
    });
    const generated = await generateAtlasProject({ project: root });

    const diagnostics = generated.diagnostics;
    const refusal = diagnostics.filter((d) =>
      d.summary.includes('resolves outside the selected Atlas owner'),
    );

    expect(refusal).toHaveLength(1);

    // The refusal must not carry what it refused to read.
    for (const diagnostic of diagnostics) {
      expect(diagnostic.summary).not.toContain('ATLAS_MUST_NOT_READ_THIS');
    }
  });

  it('analyses a consumer that configures compilerOptions.paths', async () => {
    // No fixture tsconfig carried `paths`, so nothing proved Atlas analyses a consumer
    // under the consumer's own compiler configuration rather than one Atlas invents.
    const root = await consumerProject({ consumerErrors: 3, paths: true });
    const generated = await generateAtlasProject({ project: root });

    expect(generated.ok).toBe(true);
    expect(
      generated.diagnostics.filter((d) => d.severity === 'error'),
    ).toHaveLength(0);

    // The assertion that can fail. Discarding the consumer's paths leaves the alias unresolved,
    // and an unresolved import is a consumer-owned problem, so it reports as a warning, which an
    // error filter cannot see. That is exactly how a fixture goes blind.
    expect(
      generated.diagnostics.filter(({ summary }) =>
        summary.includes('@app/toolbox'),
      ),
    ).toEqual([]);

    const checked = await checkAtlasProject({ project: root });
    expect(checked.ok).toBe(true);
    expect(
      checked.diagnostics.filter(({ summary }) =>
        summary.includes('@app/toolbox'),
      ),
    ).toEqual([]);
  });

  it('does not become fatal once the volume crosses the diagnostic cap', async () => {
    // 150 consumer errors cross the 100-diagnostic cap, and a blocking overflow diagnostic there
    // makes findings that are individually non-blocking collectively fatal, so a consumer
    // mid-refactor cannot generate at all.
    //
    // The cap bounds reporting volume. It is not a judgement about whether the consumer's code
    // compiles, so it does not change the outcome.
    const root = await consumerProject({ consumerErrors: 150 });
    const generated = await generateAtlasProject({ project: root });

    expect(generated.ok).toBe(true);

    const diagnostics = generated.diagnostics;
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);

    // Reporting is still bounded, and the truncation is stated rather than silent.
    const truncation = diagnostics.filter((d) =>
      d.summary.includes('findings in consumer source'),
    );
    expect(truncation).toHaveLength(1);
    expect(truncation[0]?.severity).toBe('warning');
    expect(truncation[0]?.summary).toContain('150');
  });

  it('caps how many consumer findings it reports without capping the outcome', async () => {
    const root = await consumerProject({ consumerErrors: 150 });
    const generated = await generateAtlasProject({ project: root });

    const warnings = generated.diagnostics.filter(
      (d) => d.severity === 'warning',
    );

    // 100 findings plus the notice that there were more. Bounded output, unbounded tolerance.
    expect(warnings.length).toBeLessThanOrEqual(101);
    expect(warnings.length).toBeGreaterThanOrEqual(100);
  });
});
