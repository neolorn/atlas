/**
 * Strict freshness is an opt-in, and both halves are asserted.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 12 keeps source-freshness findings
 * non-blocking in friendly mode and makes strict freshness an explicit opt-in. The advisory was
 * intended and present; the opt-in was missing, so there was no way to ask `check` to fail on
 * stale generated output at all.
 *
 * It is one of four separate policy switches rather than a share in one strictness flag. Separate
 * switches can be aggregated behind a convenience flag later; a single switch cannot be split
 * without breaking every caller that set it. The orthogonality test at the bottom is what makes
 * that shape checkable rather than a stated intention.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { atlasDiagnosticsBlock } from '../src/diagnostics.js';
import { checkAtlasProject, generateAtlasProject } from '../src/index.js';
import { initializeAtlasProject } from '../src/project-host.js';

/**
 * Whether the gate can fail at all.
 *
 * Everything else here is verified by `atlas check` or by the `verify` scripts, and until this
 * existed neither could fail on the things the rest of it depends on. `atlas check --require-complete` returned
 * exit 0 and `"status": "success"` while carrying `ATL1310` at `severity: error`; `atlas generate`
 * did the same on the same input. A gate that cannot report a failure is not a weaker gate, it is
 * a claim nobody is holding.
 *
 * These are the criteria for 0.1 and 0.2, written so that the fix each one warns against fails
 * them.
 */

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function write(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const absolute = resolve(root, ...path.split('/'));
  await mkdir(resolve(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

/** A project that generates cleanly, so staleness later is the only thing under test. */
async function createProject(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryRoots.push(root);
  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: '@example/atlas-gate-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );
  const initialized = await initializeAtlasProject({
    project: root,
    configuration: {
      sourceLocale: 'en-US',
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
    },
  });
  expect(initialized.ok).toBe(true);
  for (const [locale, lines] of [
    [
      'en-US',
      [
        '  app-title: Atlas gate fixture',
        '  recovery.unavailable: Localization is temporarily unavailable.',
      ],
    ],
    [
      'ar-EG',
      [
        '  app-title: تطبيق Atlas',
        '  recovery.unavailable: الترجمة غير متاحة مؤقتًا.',
      ],
    ],
  ] as const) {
    await write(
      root,
      `i18n/shell/${locale}.yaml`,
      ['messages:', ...lines, ''].join('\n'),
    );
  }
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
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await write(
    root,
    'src/app.ts',
    [
      "import { messages } from '#i18n/shell';",
      '',
      'export const title = messages.appTitle.messageId;',
      '',
    ].join('\n'),
  );
  return root;
}
describe('strict freshness is an opt-in, and both halves are asserted', () => {
  it('advises on stale output by default and blocks on it under the opt-in', async () => {
    const root = await createProject('atlas-freshness-');
    const generated = await generateAtlasProject({ project: root });
    expect(generated.ok).toBe(true);

    const fresh = await checkAtlasProject({ project: root });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.freshness.fresh).toBe(true);
    expect(fresh.diagnostics.some(({ code }) => code === 'ATL1704')).toBe(
      false,
    );

    // Authoring a message without regenerating is the ordinary way output goes stale, and the
    // reason friendly mode must not fail on it.
    await write(
      root,
      'i18n/shell/en-US.yaml',
      [
        'messages:',
        '  app-title: Atlas gate fixture',
        '  added-later: Added after generation',
        '  recovery.unavailable: Localization is temporarily unavailable.',
        '',
      ].join('\n'),
    );

    // Off: the advisory is raised, and it does not block. Asserting the off case is the point:
    // a flag that is parsed and never consulted makes both halves pass unless this half pins the
    // advisory to `warning`.
    const advisory = await checkAtlasProject({ project: root });
    expect(advisory.ok).toBe(true);
    if (!advisory.ok) return;
    expect(advisory.value.freshness.fresh).toBe(false);
    const advised = advisory.diagnostics.find(({ code }) => code === 'ATL1704');
    expect(advised?.severity).toBe('warning');
    expect(atlasDiagnosticsBlock(advisory.diagnostics)).toBe(false);

    // On: same input, same finding, now blocking.
    const strict = await checkAtlasProject({
      project: root,
      requireFreshOutput: true,
    });
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;
    const blocked = strict.diagnostics.find(({ code }) => code === 'ATL1704');
    expect(blocked?.severity).toBe('error');
    expect(atlasDiagnosticsBlock(strict.diagnostics)).toBe(true);
  });

  it('is separate from completeness, so neither switch implies the other', async () => {
    const root = await createProject('atlas-freshness-orthogonal-');
    expect((await generateAtlasProject({ project: root })).ok).toBe(true);
    // Added to *both* locales, so the catalogs stay complete and staleness is the only thing left
    // for either switch to react to. Adding it to the source alone would make the check fail on
    // completeness, which proves nothing about freshness.
    await write(
      root,
      'i18n/shell/ar-EG.yaml',
      [
        'messages:',
        '  app-title: تطبيق Atlas',
        '  added-later: أضيف بعد التوليد',
        '  recovery.unavailable: الترجمة غير متاحة مؤقتًا.',
        '',
      ].join('\n'),
    );
    await write(
      root,
      'i18n/shell/en-US.yaml',
      [
        'messages:',
        '  app-title: Atlas gate fixture',
        '  added-later: Added after generation',
        '  recovery.unavailable: Localization is temporarily unavailable.',
        '',
      ].join('\n'),
    );

    // Completeness alone must not block on staleness. If freshness were folded into one strictness
    // switch, this would fail, which is what makes the two-switch shape checkable rather than a
    // stated intention.
    const completeOnly = await checkAtlasProject({
      project: root,
      requireCompleteTargets: true,
    });
    expect(completeOnly.ok).toBe(true);
    if (!completeOnly.ok) return;
    expect(
      completeOnly.diagnostics.find(({ code }) => code === 'ATL1704')?.severity,
    ).toBe('warning');
  });
});
