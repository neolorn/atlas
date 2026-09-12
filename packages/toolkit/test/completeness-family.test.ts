import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkAtlasProject,
  generateAtlasProject,
  parseAtlasCatalog,
} from '../src/index.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';
import { testProjectConfiguration } from './fixtures.js';

/**
 * Is the release gate about completeness, or about two of its findings?
 *
 * `requireCompleteTargets` escalated `ATL1307` and `ATL1308` and nothing else, so the gate had a
 * hole exactly where the failure is largest. Measured before this changed: with the gate **on**, a
 * locale with no catalog at all returned `ok: true` and one warning, identical to the same call
 * with the gate off, while the same locale missing one message of three returned `ok: false`.
 * Translate two messages of three and the release stopped; translate none of them and it shipped.
 *
 * So the family escalates as one. `ATL1306` (no catalog for this scope), `ATL1307` (a message
 * missing) and `ATL1308` (a plural category missing) are one question at three granularities, and
 * `ATL1309` (a translation written against an older source) is the fourth: it needs a project on
 * disk and a published translation record, so its cases build one below, and the whole gate is run
 * end-to-end through the built CLI in `tools/verify-package-consumer.mjs`.
 *
 * The exemption is the other half. A locale nobody has said anything about is required, because the
 * strict state has to be the default one; a locale the project declares still in progress keeps
 * every finding, at `warning`, with the declared reason quoted into it.
 */

const configuration = testProjectConfiguration(['en-US', 'ar-EG']);
const withDeclaration = testProjectConfiguration(['en-US', 'ar-EG'], {
  inProgress: {
    'ar-EG': { note: 'Launch is Q4; translation starts in October.' },
  },
});

function catalog(role: 'source' | 'target', locale: string, body: string) {
  const result = parseAtlasCatalog(body, {
    role,
    providerId: 'home',
    scopeId: 'shell',
    locale,
    sourcePath: `i18n/shell/${locale}.yaml`,
  });
  if (!result.ok) throw new Error(`fixture ${locale} failed to parse`);
  return result.value;
}

const source = catalog(
  'source',
  'en-US',
  'messages:\n  nav.home: Home\n  nav.products: Products\n  nav.about: About\n',
);

const missingOne = catalog(
  'target',
  'ar-EG',
  'messages:\n  nav.home: الرئيسية\n  nav.about: من نحن\n',
);

const analyze = (
  catalogs: readonly ReturnType<typeof catalog>[],
  requireComplete: boolean,
  declared = false,
) =>
  analyzeAtlasCatalogSet({
    configuration: declared ? withDeclaration : configuration,
    catalogs: [...catalogs],
    ...(requireComplete ? { requireCompleteTargets: true } : {}),
  });

const codes = (graph: ReturnType<typeof analyze>) =>
  graph.diagnostics.map(({ code, severity }) => `${code} ${severity}`);

describe('the release gate covers the completeness family', () => {
  it('blocks a locale that omits one message, which it always did', () => {
    const graph = analyze([source, missingOne], true);
    // The graph survives the escalation, and that is the point rather than an accident: a
    // severity a release policy raised says a locale is unfinished, not that there is no model
    // here. Everything the run reports after the compile depends on it.
    expect(graph.ok).toBe(true);
    expect(codes(graph)).toContain('ATL1307 error');
  });

  it('blocks a locale that has no catalog at all', () => {
    // A locale with nothing translated is the most complete form of incompleteness, and the one a
    // gate keyed on missing messages inside an existing catalog lets through.
    const graph = analyze([source], true);
    // The graph survives the escalation, and that is the point rather than an accident: a
    // severity a release policy raised says a locale is unfinished, not that there is no model
    // here. Everything the run reports after the compile depends on it.
    expect(graph.ok).toBe(true);
    expect(codes(graph)).toContain('ATL1306 error');
  });

  it('leaves that same locale a warning when no release gate asked', () => {
    // The control that keeps the row above meaningful: nothing about ordinary authoring changed.
    // A source message lands before its translations, and a command that failed on that would be
    // unusable.
    const graph = analyze([source], false);
    expect(graph.ok).toBe(true);
    expect(codes(graph)).toEqual(['ATL1306 warning']);
  });
});

describe('a locale the project declares still in progress', () => {
  it('passes the gate with its findings still printed', () => {
    const graph = analyze([source, missingOne], true, true);
    expect(graph.ok).toBe(true);
    // Reported, not silenced. The difference between an exemption and a blind spot is whether the
    // finding still reaches the person reading the output.
    expect(codes(graph)).toContain('ATL1307 warning');
  });

  it('quotes the declared reason into the finding it downgraded', () => {
    const graph = analyze([source, missingOne], true, true);
    const summaries = graph.diagnostics.map((d) => d.summary).join(' ');
    expect(summaries).toContain('ar-EG is declared still in progress');
    expect(summaries).toContain('Launch is Q4');
  });

  it('exempts the whole family for that locale, not the message half of it', () => {
    const graph = analyze([source], true, true);
    expect(graph.ok).toBe(true);
    expect(codes(graph)).toEqual(['ATL1306 warning']);
  });

  it('says nothing extra when no gate is on, because nothing was downgraded', () => {
    // A declared locale under no gate produces the same warning as an undeclared one. The clause
    // exists for the case that is otherwise invisible, a gate that is on and a result that is
    // green, and adding it everywhere would make it noise nobody reads.
    const graph = analyze([source, missingOne], false, true);
    const summaries = graph.diagnostics.map((d) => d.summary).join(' ');
    expect(summaries).not.toContain('still in progress');
  });

  it('exempts only the locale it names', () => {
    // Non-vacuity in the direction that matters: a declaration is not a way to turn the gate off.
    const threeLocales = testProjectConfiguration(['en-US', 'ar-EG', 'fr-FR'], {
      inProgress: { 'ar-EG': { note: 'Translation starts in October.' } },
    });
    const graph = analyzeAtlasCatalogSet({
      configuration: threeLocales,
      catalogs: [source],
      requireCompleteTargets: true,
    });
    expect(graph.ok).toBe(true);
    expect(codes(graph)).toContain('ATL1306 warning');
    expect(codes(graph)).toContain('ATL1306 error');
  });
});

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

/**
 * A project whose only fault is that its translation answers an older question.
 *
 * The lab consumer cannot show this member escalating on its own: it ships a message `ar-EG`
 * deliberately does not translate, so under the gate an `ATL1307` error stops the compile before
 * the translation record is ever reconciled. Here the target is complete, the source moves after
 * the record is written, and staleness is the only thing left to find.
 */
async function staleProject(
  options: {
    /** Merged into `atlas.config.json`. */
    readonly configuration?: Readonly<Record<string, unknown>>;
    /** Drop a message from the target too, so the project is incomplete as well as stale. */
    readonly incomplete?: boolean;
  } = {},
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-stale-family-'));
  temporaryRoots.push(root);
  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'stale-family',
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
        ...options.configuration,
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
  // A second message only when the project also has to be incomplete: incompleteness needs a
  // message the target can lose while the record still has something to be stale about.
  const tagline =
    options.incomplete === true ? '\n  app-tagline: Localization' : '';
  await write(
    root,
    'i18n/shell/en-US.yaml',
    `messages:\n  app-title: Atlas${tagline}\n`,
  );
  await write(
    root,
    'i18n/shell/ar-EG.yaml',
    `messages:\n  app-title: أطلس${
      options.incomplete === true ? '\n  app-tagline: توطين' : ''
    }\n`,
  );
  await write(
    root,
    'src/app.ts',
    [
      "import { messages } from '#i18n/shell';",
      '',
      'export const title = messages.appTitle.messageId;',
      ...(options.incomplete === true
        ? ['export const tagline = messages.appTagline.messageId;']
        : []),
      '',
    ].join('\n'),
  );

  // Publishing is what writes the translation record; nothing is stale until there is a record of
  // what the translation was written against.
  const generated = await generateAtlasProject({ project: root });
  if (!generated.ok) {
    throw new Error(
      `the stale-translation fixture did not generate: ${JSON.stringify(
        generated.diagnostics,
      )}`,
    );
  }
  await write(
    root,
    'i18n/shell/en-US.yaml',
    `messages:\n  app-title: Atlas, renamed${tagline}\n`,
  );
  if (options.incomplete === true) {
    await write(
      root,
      'i18n/shell/ar-EG.yaml',
      'messages:\n  app-title: أطلس\n',
    );
  }
  return root;
}

describe('a translation written against an older source', () => {
  it('blocks the release under the same switch as the rest', async () => {
    const result = await checkAtlasProject({
      project: await staleProject(),
      requireCompleteTargets: true,
    });
    // On the severity, and deliberately not on `result.ok`: `ok` reports whether the compile
    // produced output, and gating an assertion on anything but severity is the bug `diagnostics.ts`
    // already records. What turns an error into a failed run is the exit code, and that is asserted
    // through the built CLI in `tools/verify-package-consumer.mjs`.
    expect(
      result.diagnostics
        .filter(({ code }) => code === 'ATL1309')
        .map(({ severity }) => severity),
    ).toEqual(['error']);
  });

  it('is an advisory when no release gate asked', async () => {
    const result = await checkAtlasProject({ project: await staleProject() });
    expect(
      result.diagnostics.map(({ code, severity }) => `${code} ${severity}`),
    ).toContain('ATL1309 warning');
  });

  it('is exempted by the same declaration, with its reason carried in', async () => {
    const result = await checkAtlasProject({
      project: await staleProject({
        configuration: {
          inProgress: {
            'ar-EG': { note: 'Arabic copy lands with the Q4 launch.' },
          },
        },
      }),
      requireCompleteTargets: true,
    });
    const stale = result.diagnostics.filter(({ code }) => code === 'ATL1309');
    expect(stale.map(({ severity }) => severity)).toEqual(['warning']);
    expect(stale[0]?.summary).toContain('Q4 launch');
  });
});

/**
 * Three findings under the gate rather than one.
 *
 * Returning the moment the catalog analysis reports an error means that under the release gate,
 * where an incomplete locale *is* an error, output freshness goes uninspected and the translation
 * record goes unreconciled, so the two findings they would have produced are absent rather than
 * downgraded. On this project, both incomplete and stale: gate off reports `ATL1307`, `ATL1309`
 * and `ATL1704`; gate on reports `ATL1307` alone. A team that turns the gate on to learn more
 * learns less.
 *
 * A run reports every member it can observe, and stops at the first only when it cannot go further.
 * A missing message stops neither comparison: both have everything they need.
 */
describe('a stricter run reports more', () => {
  it('reports every member either way, and escalates what the run asked about', async () => {
    const root = await staleProject({ incomplete: true });
    const shape = (result: Awaited<ReturnType<typeof checkAtlasProject>>) =>
      result.diagnostics.map(({ code, severity }) => `${code} ${severity}`);

    expect(shape(await checkAtlasProject({ project: root }))).toEqual([
      'ATL1307 warning',
      'ATL1309 warning',
      'ATL1704 warning',
    ]);
    expect(
      shape(
        await checkAtlasProject({
          project: root,
          requireCompleteTargets: true,
        }),
      ),
    ).toEqual(['ATL1307 error', 'ATL1309 error', 'ATL1704 warning']);
    // Freshness is a second switch and answers for itself. This row exists so that "everything is
    // reported" cannot be satisfied by reporting everything at one severity.
    expect(
      shape(
        await checkAtlasProject({
          project: root,
          requireCompleteTargets: true,
          requireFreshOutput: true,
        }),
      ),
    ).toEqual(['ATL1307 error', 'ATL1309 error', 'ATL1704 error']);
  });
});
