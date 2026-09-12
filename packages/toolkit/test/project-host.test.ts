import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ATLAS_TOOLKIT_EVENT_CODES,
  ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
  checkAtlasProject,
  generateAtlasProject,
  watchAtlasProject,
  type AtlasToolkitObservabilityEvent,
} from '../src/index.js';
import { ATLAS_COMPILER_CACHE_PATH } from '../src/output-host.js';
import {
  cleanAtlasProject,
  formatAtlasProject,
  initializeAtlasProject,
} from '../src/project-host.js';

const temporaryRoots: string[] = [];

async function temporaryProject(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeProjectFile(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const absolute = resolve(root, ...path.split('/'));
  await mkdir(resolve(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

async function createPackage(root: string): Promise<void> {
  await writeProjectFile(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: '@example/atlas-host-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );
}

async function createInitializedProject(root: string): Promise<void> {
  await createPackage(root);
  const initialized = await initializeAtlasProject({
    project: root,
    configuration: {
      sourceLocale: 'en-US',
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
    },
  });
  expect(initialized.ok).toBe(true);
  await writeProjectFile(
    root,
    'i18n/shell/en-US.yaml',
    [
      'messages:',
      '  app-title: Atlas host fixture',
      "  welcome: 'Welcome, {$name}!'",
      '  recovery.unavailable: Localization is temporarily unavailable.',
      '',
    ].join('\n'),
  );
  await writeProjectFile(
    root,
    'i18n/shell/ar-EG.yaml',
    [
      'messages:',
      '  app-title: تطبيق Atlas',
      "  welcome: 'مرحبًا، {$name}!'",
      '  recovery.unavailable: الترجمة غير متاحة مؤقتًا.',
      '',
    ].join('\n'),
  );
  await writeProjectFile(
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
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await writeProjectFile(
    root,
    'src/app.ts',
    [
      "import { messages } from '#i18n/shell';",
      '',
      'export const title = messages.appTitle.messageId;',
      '',
    ].join('\n'),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Atlas standalone project host', () => {
  it('initializes compatible setup idempotently and refuses mapping conflicts', async () => {
    const root = await temporaryProject('atlas-init-');
    await createPackage(root);

    const first = await initializeAtlasProject({
      project: root,
      configuration: {
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US', 'ar-EG'],
        aliases: { en: 'en-US' },
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.changed).toBe(true);
    expect(first.value.files).toEqual([
      'atlas.config.json',
      'i18n',
      'package.json',
    ]);

    // `init` writes containers and never content, so the catalog directory it just made has to
    // be empty: no example message, no placeholder, nothing that would put Atlas's words in a
    // consumer's product. `init` writes no catalog at all, so the assertion is at the directory.
    expect(await readdir(resolve(root, 'i18n'))).toEqual([]);

    // And because it writes neither, it names both. The first catalog was already named at the next
    // `generate`, by `ATL1702`; the recovery message was named by nothing until `ATL1310` refused a
    // build, by which time the reader has composed `provideLocalization` believing every feature
    // optional. Asserted on the substrings a reader needs rather than on the sentence, so rewording
    // is free and dropping either half is not.
    const guidance = first.diagnostics.find(({ code }) => code === 'ATL1706');
    expect(guidance?.severity).toBe('info');
    expect(guidance?.summary).toContain('i18n/shell/en-US.yaml');
    expect(guidance?.summary).toContain('withRecoveryMessage');

    const second = await initializeAtlasProject({
      project: root,
      configuration: {
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US', 'ar-EG'],
        aliases: { en: 'en-US' },
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.changed).toBe(false);

    const manifest = JSON.parse(
      await readFile(resolve(root, 'package.json'), 'utf8'),
    ) as Record<string, Record<string, string>>;
    expect(manifest['imports']).toEqual({
      '#i18n': './src/generated/i18n/index.ts',
      '#i18n/*': './src/generated/i18n/*.ts',
    });
    expect(manifest['scripts']?.['atlas:generate']).toBe('atlas generate');
    manifest['imports'] = {
      ...manifest['imports'],
      '#i18n': './consumer-owned.ts',
    };
    await writeFile(
      resolve(root, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    const conflict = await initializeAtlasProject({ project: root });
    expect(conflict.ok).toBe(false);
    expect(conflict.diagnostics[0]?.code).toBe('ATL1705');
  });

  it('never selects a configuration above the package it is standing in', async () => {
    // The accident this closes shows up two ways. By hand: `atlas init` inside a child package
    // whose parent carries a configuration initializes the **parent**, reports success, and names
    // three files the reader cannot find where they are standing. Through the gate: a stray
    // configuration at this repository's root makes every consumer materialized under `tmp/`
    // select that root as its owner instead of itself, so four stages fail with "Atlas init is
    // already complete" against a consumer whose configuration does not exist.
    const parent = await temporaryProject('atlas-boundary-');
    await writeProjectFile(
      parent,
      'package.json',
      `${JSON.stringify({ name: '@example/outer', private: true }, null, 2)}\n`,
    );
    await initializeAtlasProject({
      project: parent,
      configuration: {
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US'],
      },
    });

    const child = resolve(parent, 'child');
    await mkdir(child, { recursive: true });
    await writeProjectFile(
      child,
      'package.json',
      `${JSON.stringify({ name: '@example/inner', private: true }, null, 2)}\n`,
    );

    // A build command standing in the child finds nothing rather than the parent's project, and
    // the refusal names the configuration it declined and why, because a reader who can see one is
    // otherwise told none exists.
    const generated = await generateAtlasProject({ cwd: child });
    expect(generated.ok).toBe(false);
    const refusal = generated.diagnostics.find(
      ({ code }) => code === 'ATL1702',
    );
    expect(refusal?.summary).toContain(JSON.stringify(child));
    expect(refusal?.summary).toContain(JSON.stringify(parent));

    // And `init` standing in the child initializes the child.
    const initialized = await initializeAtlasProject({
      cwd: child,
      configuration: {
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US'],
      },
    });
    expect(initialized.ok).toBe(true);
    expect(await stat(resolve(child, 'atlas.config.json'))).toBeTruthy();
    expect(await readdir(resolve(child, 'i18n'))).toEqual([]);
    // The parent is untouched: its own `i18n` is the one its own init made, and nothing was added
    // to it.
    expect(await readdir(resolve(parent, 'i18n'))).toEqual([]);
  });

  it('still finds a workspace-root owner from a directory inside it', async () => {
    // The boundary is the nearest `package.json`, not the nearest directory, which is what keeps
    // section 134's layout working: an owner at a workspace root with its application nested.
    // Nothing between the two carries a manifest, so the search reaches the root and stops there.
    const root = await temporaryProject('atlas-nested-');
    await createPackage(root);
    await initializeAtlasProject({
      project: root,
      configuration: {
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US'],
      },
    });
    const nested = resolve(root, 'projects', 'application', 'src');
    await mkdir(nested, { recursive: true });

    const checked = await checkAtlasProject({ cwd: nested });
    expect(
      checked.diagnostics.some(
        ({ summary }) =>
          summary.includes('No atlas.config.json') ||
          summary.includes('discovery is ambiguous'),
      ),
    ).toBe(false);
  });

  it('preserves a pre-existing consumer file at the authoring-lock path', async () => {
    const root = await temporaryProject('atlas-lock-');
    await createPackage(root);
    const lockPath = resolve(root, '.atlas-authoring.lock');
    await writeFile(lockPath, 'consumer-owned\n', 'utf8');
    const initialized = await initializeAtlasProject({
      project: root,
      configuration: {
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US'],
      },
    });
    expect(initialized.ok).toBe(false);
    expect(await readFile(lockPath, 'utf8')).toBe('consumer-owned\n');
  });

  it('generates, checks, caches, formats, and cleans without touching unchanged output', async () => {
    const root = await temporaryProject('atlas-generate-');
    await createInitializedProject(root);

    const first = await generateAtlasProject({ project: root });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.publication.changed).toBe(true);
    expect(first.value.compilation.invalidation.kind).toBe('initial');
    const manifestPath = resolve(
      root,
      'src/generated/i18n/.atlas-manifest.json',
    );
    const firstMtime = (await stat(manifestPath)).mtimeMs;
    expect(
      await readFile(
        resolve(root, '.atlas', ...ATLAS_COMPILER_CACHE_PATH.split('/')),
        'utf8',
      ),
    ).toContain('atlas-compiler-cache/1');

    const second = await generateAtlasProject({ project: root });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.publication.changed).toBe(false);
    expect(second.value.compilation.invalidation.kind).toBe('none');
    expect((await stat(manifestPath)).mtimeMs).toBe(firstMtime);

    const checked = await checkAtlasProject({ project: root });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.freshness.fresh).toBe(true);

    await writeProjectFile(
      root,
      'atlas.config.json',
      '{"schemaVersion":1,"sourceLocale":"en-US","defaultLocale":"en-US","locales":["en-US","ar-EG"]}\n',
    );
    const dryFormat = await formatAtlasProject({ project: root, dryRun: true });
    expect(dryFormat.ok).toBe(true);
    if (!dryFormat.ok) return;
    expect(dryFormat.value.files).toContain('atlas.config.json');
    const formatted = await formatAtlasProject({ project: root });
    expect(formatted.ok).toBe(true);
    expect(
      await readFile(resolve(root, 'atlas.config.json'), 'utf8'),
    ).toContain('\n  "sourceLocale": "en-US"');

    const cleaned = await cleanAtlasProject({ project: root });
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) return;
    expect(cleaned.value.changed).toBe(true);
    expect(await pathMetadataForTest(resolve(root, 'src/generated/i18n'))).toBe(
      undefined,
    );
    expect(await pathMetadataForTest(resolve(root, '.atlas'))).toBe(undefined);
    const again = await cleanAtlasProject({ project: root });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.changed).toBe(false);
  });

  it('propagates content-free observability through generation, host integration, and compilation', async () => {
    const root = await temporaryProject('atlas-observability-host-');
    await createInitializedProject(root);
    const events: AtlasToolkitObservabilityEvent[] = [];
    const generated = await generateAtlasProject({
      project: root,
      observability: {
        emit(event): void {
          events.push(event);
        },
      },
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const outputCount =
      generated.value.compilation.artifacts.outputPlan.files.length;
    const publishedCount =
      generated.value.publication.written.length +
      generated.value.publication.removed.length;
    expect(events).toEqual([
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
        phase: 'generation',
        status: 'started',
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
        phase: 'integration',
        status: 'started',
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
        phase: 'compilation',
        status: 'started',
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
        phase: 'compilation',
        status: 'succeeded',
        count: outputCount,
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
        phase: 'integration',
        status: 'succeeded',
        count: outputCount,
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
        phase: 'generation',
        status: 'succeeded',
        count: publishedCount,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(root);
    expect(JSON.stringify(events)).not.toContain('Welcome');
  });

  it('discovers, validates, formats, and compiles the conventional extension registry', async () => {
    const root = await temporaryProject('atlas-extensions-');
    await createInitializedProject(root);
    await writeProjectFile(
      root,
      'atlas.extensions.json',
      JSON.stringify({
        profile: 'atlas-extension-registry/1',
        descriptors: [
          {
            kind: 'message-function',
            id: 'fixture:uppercase',
            operandType: 'string',
            resultType: 'string',
            selector: 'none',
            maximumOutputLength: 64,
          },
        ],
      }),
    );
    await writeProjectFile(
      root,
      'i18n/shell/en-US.yaml',
      'messages:\n  app-title: "{$name :fixture:uppercase}"\n',
    );
    await writeProjectFile(
      root,
      'i18n/shell/ar-EG.yaml',
      'messages:\n  app-title: "{$name :fixture:uppercase}"\n',
    );

    const generated = await generateAtlasProject({ project: root });
    expect(generated.ok, JSON.stringify(generated.diagnostics, null, 2)).toBe(
      true,
    );
    if (!generated.ok) return;
    expect(
      await readFile(resolve(root, 'src/generated/i18n/index.ts'), 'utf8'),
    ).toContain('fixture:uppercase');

    const formatted = await formatAtlasProject({ project: root });
    expect(formatted.ok).toBe(true);
    expect(
      await readFile(resolve(root, 'atlas.extensions.json'), 'utf8'),
    ).toContain('\n  "profile": "atlas-extension-registry/1"');
  });

  it('ignores corrupt disposable cache state and reconciles a foreground watch event', async () => {
    const root = await temporaryProject('atlas-watch-');
    await createInitializedProject(root);
    const generated = await generateAtlasProject({ project: root });
    expect(generated.ok).toBe(true);
    await writeFile(
      resolve(root, '.atlas', ...ATLAS_COMPILER_CACHE_PATH.split('/')),
      '{broken',
      'utf8',
    );
    const checked = await checkAtlasProject({ project: root });
    expect(checked.ok).toBe(true);
    expect(checked.diagnostics.some(({ code }) => code === 'ATL1703')).toBe(
      true,
    );

    const controller = new AbortController();
    const catalogPath = resolve(root, 'i18n/shell/en-US.yaml');
    const watched = watchAtlasProject({
      project: root,
      signal: controller.signal,
      debounceMilliseconds: 20,
      onCycle: ({ sequence }) => {
        if (sequence === 1) {
          setTimeout(() => {
            void readFile(catalogPath, 'utf8').then((source) =>
              writeFile(
                catalogPath,
                source.replace('Atlas host fixture', 'Atlas watched fixture'),
                'utf8',
              ),
            );
          }, 75);
        } else {
          controller.abort();
        }
      },
    });
    // Waited on directly, under the suite's own `testTimeout`. A bound inside that one fires first
    // whenever the machine is busy, so it reports how loaded the gate was rather than anything
    // about the watcher, and its rejection leaves the watch running: the cleanup that follows then
    // removes a directory something still holds open.
    const result = await watched;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cycles).toBeGreaterThanOrEqual(2);
  });

  it('refuses clean when the generated root contains a consumer-owned file', async () => {
    const root = await temporaryProject('atlas-clean-refusal-');
    await createInitializedProject(root);
    const generated = await generateAtlasProject({ project: root });
    expect(generated.ok).toBe(true);
    const consumerFile = resolve(root, 'src/generated/i18n/consumer-owned.txt');
    await writeFile(consumerFile, 'keep me\n', 'utf8');
    const cleaned = await cleanAtlasProject({ project: root });
    expect(cleaned.ok).toBe(false);
    expect(cleaned.diagnostics[0]?.code).toBe('ATL1601');
    expect(await readFile(consumerFile, 'utf8')).toBe('keep me\n');
  });
});

async function pathMetadataForTest(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
}
