import { describe, expect, it } from 'vitest';

import { parseAtlasCatalog } from '../src/index.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';
import { testProjectConfiguration } from './fixtures.js';

/**
 * NEW-1: a target catalog that omits a required source message.
 *
 * `semantic-model.ts` errored when a target *invented* a message (ATL1304) and returned silently
 * when a target *omitted* one. So an incomplete locale looked finished: `atlas check` exited 0,
 * generation succeeded, a re-check reported output current, and the message fell back to the
 * source locale in a production build with nothing said anywhere.
 *
 * This matters wherever a target locale is a first-class production locale rather than a
 * best-effort one: a missing required message is then a defect to be blocked, not a gap to be
 * filled later.
 *
 * The severity is settled: warn during development, fail in CI through an explicit
 * `atlas check --require-complete`. English lands before Arabic in ordinary authoring order, so
 * erroring during development would break the dev loop on every new message and train a team to
 * bypass the check.
 */

const configuration = testProjectConfiguration(['en-US', 'ar-EG']);

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

const complete = catalog(
  'target',
  'ar-EG',
  'messages:\n  nav.home: الرئيسية\n  nav.products: المنتجات\n  nav.about: من نحن\n',
);

const missingOne = catalog(
  'target',
  'ar-EG',
  'messages:\n  nav.home: الرئيسية\n  nav.about: من نحن\n',
);

const missingTwo = catalog(
  'target',
  'ar-EG',
  'messages:\n  nav.home: الرئيسية\n',
);

const analyze = (target: ReturnType<typeof catalog>, requireComplete = false) =>
  analyzeAtlasCatalogSet({
    configuration,
    catalogs: [source, target],
    ...(requireComplete ? { requireCompleteTargets: true } : {}),
  });

describe('a target locale that omits a source message', () => {
  it('says nothing when the target is complete', () => {
    const graph = analyze(complete);
    expect(graph.ok).toBe(true);
    expect(graph.diagnostics).toHaveLength(0);
  });

  it('reports each omission by name', () => {
    const graph = analyze(missingTwo);
    const omissions = graph.diagnostics.filter((d) => d.code === 'ATL1307');

    expect(omissions).toHaveLength(2);
    const summaries = omissions.map((d) => d.summary).join(' ');
    expect(summaries).toContain('nav.products');
    expect(summaries).toContain('nav.about');

    // Naming the fallback matters: the reader needs to know the message still renders, in the
    // wrong language, rather than disappearing.
    expect(summaries).toContain('en-US');
  });

  it('warns during development without blocking', () => {
    const graph = analyze(missingOne);

    expect(graph.ok).toBe(true);
    const omissions = graph.diagnostics.filter((d) => d.code === 'ATL1307');
    expect(omissions).toHaveLength(1);
    expect(omissions[0]?.severity).toBe('warning');
  });

  it('blocks when completeness is required', () => {
    const graph = analyze(missingOne, true);

    // On the severity, and `ok` stays true: an escalated completeness finding says the
    // locale is unfinished, not that the analysis has no graph to give. What blocks the
    // run is the severity, and the run is what `checkAtlasProject` and the CLI decide.
    expect(graph.ok).toBe(true);
    const omissions = graph.diagnostics.filter((d) => d.code === 'ATL1307');
    expect(omissions).toHaveLength(1);
    expect(omissions[0]?.severity).toBe('error');
  });

  it('still treats an invented message as an error either way', () => {
    // The pre-existing half of the contract, kept honest: extra and missing are now both
    // reportable, and the invention does not depend on the completeness policy.
    const invented = catalog(
      'target',
      'ar-EG',
      'messages:\n  nav.home: الرئيسية\n  nav.products: المنتجات\n  nav.about: من نحن\n  nav.extra: زائد\n',
    );

    for (const requireComplete of [false, true]) {
      const graph = analyze(invented, requireComplete);
      expect(graph.ok).toBe(false);
      expect(graph.diagnostics.map((d) => d.code)).toContain('ATL1304');
    }
  });

  it('carries the message identity in the diagnostic path', () => {
    const graph = analyze(missingOne);
    const omission = graph.diagnostics.find((d) => d.code === 'ATL1307');

    expect(omission?.path).toEqual(['messages', 'nav.products']);
  });
});
