import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateAtlasProject } from '../src/index.js';
import {
  cleanAtlasProject,
  uninstallAtlasProject,
} from '../src/project-host.js';

/**
 * Removing Atlas from an application.
 *
 * `clean` means "remove build output" everywhere else (`cargo clean`, `make clean`,
 * `ng cache clean` all leave project configuration alone) so it keeps that meaning and this is
 * a separate command. A flag that turns "remove build output" into "remove the tool" is one that
 * eventually runs in a pipeline by accident.
 *
 * Two rules give this its shape. Authored catalogs are the consumer's content and survive unless
 * their removal is asked for by name; deleting a project's translations as a side effect of
 * uninstalling a tool would be indefensible. And only what Atlas wrote is taken back: a `#i18n`
 * specifier somebody repointed, or a script somebody edited, is theirs now.
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

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

interface ProjectOptions {
  /** A `#i18n` specifier the consumer has repointed at something of their own. */
  readonly repointed?: boolean;
  /** An Atlas script the consumer has edited. */
  readonly editedScript?: boolean;
  /** A script of the consumer's own, beside Atlas's. */
  readonly ownScript?: boolean;
}

async function project(options: ProjectOptions = {}): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-uninstall-'));
  temporaryRoots.push(root);

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: '@example/atlas-uninstall',
        version: '0.0.0',
        private: true,
        type: 'module',
        imports: {
          '#i18n': options.repointed
            ? './src/hand-written/index.ts'
            : './src/generated/i18n/index.ts',
          '#i18n/*': './src/generated/i18n/*.ts',
        },
        scripts: {
          'atlas:generate': options.editedScript
            ? 'atlas generate --project . --json'
            : 'atlas generate',
          'atlas:check': 'atlas check',
          ...(options.ownScript === true ? { build: 'ng build' } : {}),
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
    )}\n`,
  );
  await write(root, 'src/app.ts', 'export const marker = 1;\n');
  await write(root, 'i18n/shell/en-US.yaml', 'messages:\n  app-title: Atlas\n');
  return root;
}

async function manifest(
  root: string,
): Promise<Readonly<Record<string, unknown>>> {
  return JSON.parse(
    await readFile(resolve(root, 'package.json'), 'utf8'),
  ) as Readonly<Record<string, unknown>>;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('uninstalling Atlas', () => {
  it('takes back what Atlas wrote and leaves the content alone', async () => {
    const root = await project({ ownScript: true });
    expect((await generateAtlasProject({ project: root })).ok).toBe(true);

    const result = await uninstallAtlasProject({ project: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = await manifest(root);
    expect(after['imports']).toBeUndefined();
    expect(after['scripts']).toEqual({ build: 'ng build' });
    expect(after['name']).toBe('@example/atlas-uninstall');

    expect(await exists(resolve(root, 'atlas.config.json'))).toBe(false);
    expect(await exists(resolve(root, 'src/generated/i18n/index.ts'))).toBe(
      false,
    );

    // The consumer's translations. Removing these as a side effect would be indefensible.
    expect(await exists(resolve(root, 'i18n/shell/en-US.yaml'))).toBe(true);
    expect(result.value.catalogs).toEqual([]);
  });

  it('leaves a repointed specifier and an edited script exactly as they are', async () => {
    const root = await project({ repointed: true, editedScript: true });

    const result = await uninstallAtlasProject({ project: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = await manifest(root);
    expect(after['imports']).toEqual({
      '#i18n': './src/hand-written/index.ts',
    });
    expect(after['scripts']).toEqual({
      'atlas:generate': 'atlas generate --project . --json',
    });

    // Named rather than reverted, so nothing about it is a surprise.
    expect(result.value.retained).toEqual([
      'imports.#i18n',
      'scripts.atlas:generate',
    ]);
  });

  it('removes authored catalogs only when asked by name', async () => {
    const root = await project();

    const result = await uninstallAtlasProject({
      project: root,
      catalogs: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.catalogs).toEqual(['i18n/shell/en-US.yaml']);
    expect(await exists(resolve(root, 'i18n/shell/en-US.yaml'))).toBe(false);
  });

  it('changes nothing under --dry-run', async () => {
    const root = await project();
    const before = await readFile(resolve(root, 'package.json'), 'utf8');

    const result = await uninstallAtlasProject({
      project: root,
      dryRun: true,
      catalogs: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.changed).toBe(true);
    expect(result.value.removed).toContain('atlas.config.json');
    expect(await readFile(resolve(root, 'package.json'), 'utf8')).toBe(before);
    expect(await exists(resolve(root, 'atlas.config.json'))).toBe(true);
    expect(await exists(resolve(root, 'i18n/shell/en-US.yaml'))).toBe(true);
  });

  it('is not what clean does', async () => {
    // The distinction the two commands exist to keep. `clean` removes build output; project
    // configuration is not build output.
    const root = await project();
    expect((await generateAtlasProject({ project: root })).ok).toBe(true);

    expect((await cleanAtlasProject({ project: root })).ok).toBe(true);

    expect(await exists(resolve(root, 'atlas.config.json'))).toBe(true);
    expect((await manifest(root))['imports']).toBeDefined();
    expect(await exists(resolve(root, 'i18n/shell/en-US.yaml'))).toBe(true);
    expect(await exists(resolve(root, 'src/generated/i18n/index.ts'))).toBe(
      false,
    );
  });
});
