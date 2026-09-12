import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { formatAtlasProject } from '../src/project-host.js';

/**
 * What `atlas format` is allowed to change.
 *
 * Building a plain object from the semantic model and stringifying it drops every comment, because
 * comments are not in that model: they go when the YAML becomes the model, several steps before
 * anything writes a file. A command whose name promises presentation changes then deletes every
 * comment in a consumer's catalogs. On one real catalog set that is twelve comments across four
 * files, recoverable only because the files were committed, two of them load-bearing, including the
 * note recording that one message in the *English* catalog is deliberately Arabic.
 *
 * The rule underneath: a tool never destroys input it cannot reproduce.
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

async function project(catalog: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-lossless-'));
  temporaryRoots.push(root);

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: '@example/atlas-lossless',
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
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}
`,
  );
  await write(root, 'src/app.ts', 'export const marker = 1;\n');
  await write(root, 'i18n/shell/en-US.yaml', catalog);
  return root;
}

async function formatted(catalog: string): Promise<string> {
  const root = await project(catalog);
  const result = await formatAtlasProject({ project: root });
  if (!result.ok)
    throw new Error(
      result.diagnostics.map((d) => `${d.code} ${d.summary}`).join(' | '),
    );
  return readFile(resolve(root, 'i18n', 'shell', 'en-US.yaml'), 'utf8');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('formatting an authored catalog', () => {
  it('keeps every comment', async () => {
    const output = await formatted(
      [
        '# The application shell.',
        'messages:',
        '  # Deliberately Arabic in the English catalog: the toggle offers the other language.',
        '  locale-toggle: العربية',
        '  app-title: Atlas # trailing note',
        '',
      ].join('\n'),
    );

    expect(output).toContain('# The application shell.');
    expect(output).toContain('# Deliberately Arabic in the English catalog');
    expect(output).toContain('# trailing note');
  });

  it('keeps the order the author chose', async () => {
    // Ordering is authorial information. Sorting it is a change to the file that the author did
    // not ask for and cannot undo without fighting the tool on every run.
    const output = await formatted(
      [
        'messages:',
        '  zebra: Last alphabetically, first in the file.',
        '  alpha: First alphabetically, last in the file.',
        '',
      ].join('\n'),
    );

    expect(output.indexOf('zebra')).toBeLessThan(output.indexOf('alpha'));
  });

  it('leaves a message that only quoting keeps readable quoted', async () => {
    // A MessageFormat placeholder opens a YAML flow mapping, so unquoting it would change what
    // the file means rather than how it looks.
    const output = await formatted(
      [
        'messages:',
        "  greeting: '{$name} is here'",
        '  literal-number: "42"',
        '  literal-boolean: "true"',
        '  quoted-apostrophe: "it\'s here"',
        '',
      ].join('\n'),
    );

    expect(output).toContain("'{$name} is here'");
    // Still quoted, because unquoting would make them a number and a boolean. Single quotes
    // where nothing needs escaping: the least a scalar needs, not the most.
    expect(output).toContain("'42'");
    expect(output).toContain("'true'");
    // An apostrophe is special only at the start of a plain scalar, so this one needs no quotes
    // at all.
    expect(output).toContain("quoted-apostrophe: it's here");
  });

  it('drops quotes a scalar does not need', async () => {
    const output = await formatted(
      ['messages:', '  app-title: "Atlas feature lab"', ''].join('\n'),
    );

    expect(output).toContain('app-title: Atlas feature lab');
  });

  it('keeps a block scalar written as one', async () => {
    // A block scalar is a choice about line structure. Quoting it would keep the characters and
    // lose the shape.
    const output = await formatted(
      [
        'messages:',
        '  terms: |-',
        '    First line.',
        '    Second line.',
        '',
      ].join('\n'),
    );

    expect(output).toContain('|-');
    expect(output).toContain('    First line.');
  });

  it('is idempotent', async () => {
    const source = [
      '# Shell.',
      'messages:',
      '  app-title: "Atlas"',
      "  greeting: '{$name}'",
      '',
    ].join('\n');
    const once = await formatted(source);
    const twice = await formatted(once);

    expect(twice).toBe(once);
  });
});
