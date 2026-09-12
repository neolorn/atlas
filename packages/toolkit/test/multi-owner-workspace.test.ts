import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateAtlasProject } from '../src/index.js';
import { initializeAtlasProject } from '../src/project-host.js';

/**
 * A multi-application workspace: four `projectType: application` entries and two libraries in one
 * `angular.json`.
 *
 * A multi-application workspace can run Atlas.
 * The accurate statement is narrower and worse: it works only under a layout `ng generate
 * application` does not produce, and an application sitting at the workspace root beside a second
 * application can never be selected.
 *
 * The shape is taken from a real workspace of this kind: four declared applications, growing, and
 * exactly one of them carrying its own package.json, which is why it is the only one that
 * works. That is the base case for a workspace of this layout, not an edge case, which is what
 * makes supporting it a requirement rather than an accommodation.
 */

const temporaryRoots: string[] = [];
const APPLICATIONS = ['account', 'home', 'identity', 'management'] as const;
const LIBRARIES = ['dev-tools', 'ui'] as const;

async function write(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const absolute = resolve(root, ...path.split('/'));
  await mkdir(resolve(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

interface WorkspaceOptions {
  /** Which applications carry their own package.json. The observed case is exactly one. */
  readonly ownersWithManifest: readonly string[];
  /** Place `home` at the workspace root rather than under `apps/`. */
  readonly homeAtRoot?: boolean;
}

async function multiApplicationWorkspace(
  options: WorkspaceOptions,
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-multi-owner-'));
  temporaryRoots.push(root);

  const projects: Record<string, unknown> = {};
  for (const application of APPLICATIONS) {
    const atRoot = options.homeAtRoot === true && application === 'home';
    projects[application] = {
      projectType: 'application',
      root: atRoot ? '' : `apps/${application}`,
      architect: {
        build: {
          options: {
            tsConfig: atRoot
              ? 'tsconfig.app.json'
              : `apps/${application}/tsconfig.app.json`,
          },
        },
      },
    };
  }
  for (const library of LIBRARIES) {
    projects[library] = { projectType: 'library', root: `libs/${library}` };
  }

  await write(
    root,
    'angular.json',
    `${JSON.stringify({ version: 1, projects }, null, 2)}\n`,
  );
  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: '@example/workspace',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );

  for (const application of APPLICATIONS) {
    const atRoot = options.homeAtRoot === true && application === 'home';
    const base = atRoot ? '' : `apps/${application}/`;

    await write(
      root,
      `${base}atlas.config.json`,
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
    await write(
      root,
      `${base}i18n/shell/en-US.yaml`,
      `messages:\n  app-title: ${application}\n`,
    );
    await write(
      root,
      `${base}i18n/shell/ar-EG.yaml`,
      `messages:\n  app-title: ${application}\n`,
    );
    await write(
      root,
      `${base}tsconfig.app.json`,
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
    await write(
      root,
      `${base}src/app.ts`,
      "import { messages } from '#i18n/shell';\n\nexport const title = messages.appTitle.messageId;\n",
    );

    if (options.ownersWithManifest.includes(application)) {
      await write(
        root,
        `${base}package.json`,
        `${JSON.stringify(
          {
            name: `@example/${application}`,
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
    }
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

describe('a multi-application workspace with one manifest', () => {
  it('generates for the one owner that carries its own package.json, and refuses the rest', async () => {
    // The observed shape: four declared applications, one manifest.
    const root = await multiApplicationWorkspace({
      ownersWithManifest: ['home'],
    });

    const home = await generateAtlasProject({
      project: resolve(root, 'apps', 'home'),
    });
    expect(home.ok).toBe(true);

    for (const application of ['identity', 'management', 'account'] as const) {
      const generated = await generateAtlasProject({
        project: resolve(root, 'apps', application),
      });
      expect(generated.ok).toBe(false);
      expect(generated.diagnostics.map((d) => d.code)).toContain('ATL1702');
    }
  });

  it('supports every owner once each carries a package.json', async () => {
    // The layout works. It is simply not the one `ng generate application` produces, which is the
    // substance of H1 and the reason three of the four applications are blocked.
    const root = await multiApplicationWorkspace({
      ownersWithManifest: [...APPLICATIONS],
    });

    for (const application of APPLICATIONS) {
      const generated = await generateAtlasProject({
        project: resolve(root, 'apps', application),
      });
      expect(generated.ok, `${application} should generate`).toBe(true);
    }
  });

  it('keeps each owner generated output inside its own project', async () => {
    // One owner's generation must not reach into another's output.
    const root = await multiApplicationWorkspace({
      ownersWithManifest: [...APPLICATIONS],
    });

    for (const application of APPLICATIONS) {
      await generateAtlasProject({
        project: resolve(root, 'apps', application),
      });
    }

    for (const application of APPLICATIONS) {
      const index = await readFile(
        resolve(root, 'apps', application, 'src/generated/i18n/shell.ts'),
        'utf8',
      );
      expect(index).toContain(application);
      for (const other of APPLICATIONS) {
        if (other === application) continue;
        expect(index).not.toContain(`@example/${other}`);
      }
    }
  });

  it('cannot select an application that sits at the workspace root beside another', async () => {
    // H1's worse half. The owner root is the workspace root, whose angular.json declares several
    // applications, so tsconfig selection refuses and there is no narrower path to select.
    const root = await multiApplicationWorkspace({
      ownersWithManifest: [...APPLICATIONS],
      homeAtRoot: true,
    });

    const generated = await generateAtlasProject({ project: root });

    expect(generated.ok).toBe(false);
    const summaries = generated.diagnostics.map((d) => d.summary);
    expect(
      summaries.some((summary) =>
        summary.includes('multiple Angular application TypeScript graphs'),
      ),
    ).toBe(true);
  });
});

describe('onboarding an application that has no manifest', () => {
  it('creates the manifest from atlas init and then generates', async () => {
    // The whole of what the three blocked applications need. Authoring files belongs to init and
    // nowhere else, so the command a developer runs deliberately is the one that writes them.
    const root = await multiApplicationWorkspace({
      ownersWithManifest: ['home'],
    });
    const identity = resolve(root, 'apps', 'identity');

    const initialized = await initializeAtlasProject({ project: identity });
    expect(initialized.ok).toBe(true);

    const manifest = JSON.parse(
      await readFile(resolve(identity, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['name']).toBe('identity');
    expect(manifest['private']).toBe(true);
    expect(manifest['imports']).toMatchObject({
      '#i18n': './src/generated/i18n/index.ts',
    });

    expect((await generateAtlasProject({ project: identity })).ok).toBe(true);
  });

  it('reports nothing but the remedy when a build command meets a missing manifest', async () => {
    const root = await multiApplicationWorkspace({
      ownersWithManifest: ['home'],
    });

    const generated = await generateAtlasProject({
      project: resolve(root, 'apps', 'account'),
    });

    expect(generated.ok).toBe(false);
    const summaries = generated.diagnostics.map(({ summary }) => summary);
    // Naming the command is the entire remedy. A diagnostic that says the owner "requires an
    // ordinary package.json" and stops there leaves the reader to guess it.
    expect(
      summaries.some((summary) => summary.includes('Run atlas init')),
    ).toBe(true);
    expect(
      summaries.some((summary) => summary.includes('never author files')),
    ).toBe(true);
  });

  it('leaves the manifest alone when a build command runs, whatever the outcome', async () => {
    // The reason the rule exists. generate, check, format and watch run unattended in build
    // pipelines and dev servers, where a mistyped --project would otherwise scatter manifests.
    const root = await multiApplicationWorkspace({
      ownersWithManifest: ['home'],
    });
    const account = resolve(root, 'apps', 'account');

    await generateAtlasProject({ project: account });

    await expect(
      readFile(resolve(account, 'package.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('refuses to name a package after a directory that is not a package name', async () => {
    // The provider identity is durable and reaches every compiled artifact, so a name Atlas had to
    // repair would be the wrong identity forever.
    const root = await multiApplicationWorkspace({
      ownersWithManifest: ['home'],
    });
    const awkward = resolve(root, 'apps', 'Identity Portal');
    await mkdir(resolve(awkward, 'src'), { recursive: true });
    await writeFile(
      resolve(awkward, 'atlas.config.json'),
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
      'utf8',
    );

    const initialized = await initializeAtlasProject({ project: awkward });

    expect(initialized.ok).toBe(false);
    expect(
      initialized.diagnostics.some(({ summary }) =>
        summary.includes('not a valid package name'),
      ),
    ).toBe(true);
  });
});

describe('an owner with no TypeScript graph', () => {
  it('says so instead of succeeding with nothing analyzed', async () => {
    // Silence was the worst available answer: with no graph Atlas sees no template and no call
    // site, so every message looks unused, reachability is empty, and it all reports success
    // at all. Every new owner meets first-time configuration exactly once, so this is
    // where a workspace adopting Atlas is most likely to hit it.
    const root = await multiApplicationWorkspace({
      ownersWithManifest: ['home'],
    });
    const home = resolve(root, 'apps', 'home');
    await rm(resolve(home, 'tsconfig.app.json'));
    const angularPath = resolve(root, 'angular.json');
    const angular = JSON.parse(await readFile(angularPath, 'utf8')) as {
      projects: Record<string, { architect?: unknown }>;
    };
    delete angular.projects['home']?.architect;
    await writeFile(
      angularPath,
      `${JSON.stringify(angular, null, 2)}\n`,
      'utf8',
    );

    const generated = await generateAtlasProject({ project: home });

    expect(generated.ok).toBe(false);
    expect(
      generated.diagnostics.some(({ summary }) =>
        summary.includes('no TypeScript graph'),
      ),
    ).toBe(true);
  });
});

describe('an owner at the workspace root whose application is nested', () => {
  async function nestedApplicationWorkspace(): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), 'atlas-nested-app-'));
    temporaryRoots.push(root);
    await write(
      root,
      'angular.json',
      `${JSON.stringify(
        {
          version: 1,
          projects: {
            home: {
              projectType: 'application',
              root: 'apps/home',
              architect: {
                build: { options: { tsConfig: 'apps/home/tsconfig.app.json' } },
              },
            },
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
      'i18n/shell/en-US.yaml',
      ['messages:', '  app-title: Home', ''].join('\n'),
    );
    await write(
      root,
      'apps/home/tsconfig.app.json',
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
    await write(
      root,
      'apps/home/src/app.ts',
      [
        "import { messages } from '#i18n/shell';",
        '',
        'export const title = messages.appTitle.messageId;',
        '',
      ].join('\n'),
    );
    return root;
  }

  it('generates into the application, not into a directory no project owns', async () => {
    // Writing to the owner's own src/generated/i18n and reporting success creates a source
    // directory at the workspace root that belongs to no Angular project and sits outside the
    // tsconfig of the application just analyzed.
    const root = await nestedApplicationWorkspace();
    await write(
      root,
      'package.json',
      `${JSON.stringify(
        {
          name: '@example/workspace',
          private: true,
          type: 'module',
          imports: {
            '#i18n': './apps/home/src/generated/i18n/index.ts',
            '#i18n/*': './apps/home/src/generated/i18n/*.ts',
          },
        },
        null,
        2,
      )}\n`,
    );

    const generated = await generateAtlasProject({ project: root });
    expect(generated.ok, JSON.stringify(generated.diagnostics)).toBe(true);

    expect(
      await readdir(resolve(root, 'apps/home/src/generated/i18n')),
    ).toContain('shell.ts');
    await expect(readdir(resolve(root, 'src'))).rejects.toThrow();
  });

  it('writes an imports map that reaches the application', async () => {
    const root = await nestedApplicationWorkspace();

    // A workspace root already has a manifest; what is under test is where its imports map points.
    await write(
      root,
      'package.json',
      `${JSON.stringify({ name: '@example/workspace', private: true }, null, 2)}
`,
    );

    const initialized = await initializeAtlasProject({ project: root });
    expect(initialized.ok, JSON.stringify(initialized.diagnostics)).toBe(true);

    const manifest = JSON.parse(
      await readFile(resolve(root, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['imports']).toEqual({
      '#i18n': './apps/home/src/generated/i18n/index.ts',
      '#i18n/*': './apps/home/src/generated/i18n/*.ts',
    });
  });
});
