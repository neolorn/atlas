import { describe, expect, it } from 'vitest';

import { atlasShippedFallbackChain } from '../../toolkit/src/locales.js';
import type { CompiledCatalog } from '../src/catalog-runtime.js';
import {
  catalogConsultationOrder,
  findEvaluationCandidate,
} from '../src/evaluator.js';
import { LocalizationError, type MessageHandle } from '@neolorn/atlas/core';

/**
 * The runtime half of the parent-locale chain: which catalog answers, and in what order.
 *
 * The chains here are not written out. `atlasShippedFallbackChain` is the toolkit function the
 * build calls, so what these cases consult is what a real generated configuration would carry for
 * the same locale set. That matters more than it looks: the two halves of this feature live in
 * different packages, and a runtime case fed a hand-written chain proves the runtime walks a list
 * rather than that it walks the list the build produces.
 *
 * `catalogConsultationOrder` returns the order and the `inherited` set together, from one walk,
 * because a release gate and a strict runtime that answered "is this the locale's own translation"
 * separately would eventually disagree about the same project.
 */

function catalogFor(
  locale: string,
  messageIds: readonly string[],
): CompiledCatalog {
  const resources = {
    irNodes: 1,
    depth: 1,
    selectors: 0,
    variants: 0,
    inputs: 0,
    slots: 0,
    outputParts: 8,
  };
  return {
    profile: 'atlas-compiled-ir/1',
    generatedAbi: 'atlas-generated/1',
    standardsProfile: 'atlas-1',
    key: { providerId: 'home', scopeId: 'shell', catalogLocale: locale },
    applicationContractFingerprint: 'test',
    semanticRegistryFingerprint: 'test',
    requiredExtensions: Object.freeze([]),
    messages: Object.freeze(
      messageIds.map((messageId) => ({
        messageId,
        kind: 'message' as const,
        resultKind: 'plain' as const,
        sourceFingerprint: 'test',
        inputs: Object.freeze([]),
        slots: Object.freeze([]),
        body: {
          kind: 'pattern',
          declarations: [],
          pattern: [{ kind: 'literal', value: `${messageId} in ${locale}` }],
        },
      })),
    ),
    resources: { ...resources, maximumMessage: resources },
  } as unknown as CompiledCatalog;
}

function handleFor(messageId: string): MessageHandle {
  return {
    generatedAbi: 'atlas-generated/1',
    providerId: 'home',
    scopeId: 'shell',
    messageId,
    identity: `home:shell:${messageId}`,
    resultKind: 'plain',
    inputNames: Object.freeze([]),
    slotNames: Object.freeze([]),
  } as MessageHandle;
}

/**
 * One project, described the way a configuration describes one, resolved the way a build resolves
 * it: the locales it ships, the source, which of them have a catalog in this scope, and which
 * messages each one carries.
 */
function project(options: {
  readonly sourceLocale: string;
  readonly catalogs: Readonly<Record<string, readonly string[]>>;
  readonly locales?: readonly string[];
  readonly parentLocales?: Readonly<Record<string, string>>;
}) {
  const shipped = options.locales ?? Object.keys(options.catalogs);
  const byLocale = new Map(
    Object.entries(options.catalogs).map(([locale, messageIds]) => [
      locale,
      catalogFor(locale, messageIds),
    ]),
  );
  return (targetLocale: string) => {
    const order = catalogConsultationOrder(
      targetLocale,
      atlasShippedFallbackChain(targetLocale, shipped, options.parentLocales),
      options.sourceLocale,
      (locale) => byLocale.has(locale),
    );
    const catalogs = order.locales.flatMap((locale) => {
      const catalog = byLocale.get(locale);
      return catalog === undefined ? [] : [catalog];
    });
    return {
      consulted: order.locales,
      inherited: [...order.inherited],
      resolve: (messageId: string) =>
        findEvaluationCandidate(handleFor(messageId), targetLocale, catalogs),
    };
  };
}

// French is the source, so English is a target like any other and `en-AU` reaching `en` is a claim
// about the chain rather than about source fallback.
const french = project({
  sourceLocale: 'fr-FR',
  catalogs: {
    'fr-FR': ['nav.home', 'nav.help'],
    en: ['nav.home', 'nav.help'],
    'en-AU': ['nav.home'],
  },
});

describe('a regional locale served by its parent', () => {
  it('resolves a message present only in the parent', () => {
    // The case the feature is named for. Before this, `nav.help` came back in French.
    const candidate = french('en-AU').resolve('nav.help');
    expect(candidate.catalog.key.catalogLocale).toBe('en');
    expect(candidate.attemptedLocales).toEqual(['en-AU', 'en']);
  });

  it('still prefers its own catalog for a message it has', () => {
    const candidate = french('en-AU').resolve('nav.home');
    expect(candidate.catalog.key.catalogLocale).toBe('en-AU');
    expect(candidate.attemptedLocales).toEqual(['en-AU']);
  });

  it('consults its own catalog, then its parents, then the source', () => {
    // `en-001` is a real link in `en-AU`'s chain and no application ships one, so it is not in the
    // order at all. The source is last because nothing declares it a parent here.
    expect(french('en-AU').consulted).toEqual(['en-AU', 'en', 'fr-FR']);
    expect(french('en-AU').inherited).toEqual(['en-AU', 'en']);
  });

  it('reaches the source when nothing in the chain carries the message', () => {
    const thin = project({
      sourceLocale: 'fr-FR',
      catalogs: {
        'fr-FR': ['nav.home', 'nav.help'],
        en: ['nav.home'],
        'en-AU': ['nav.home'],
      },
    });
    const candidate = thin('en-AU').resolve('nav.help');
    expect(candidate.catalog.key.catalogLocale).toBe('fr-FR');
    expect(candidate.attemptedLocales).toEqual(['en-AU', 'en', 'fr-FR']);
  });
});

describe('a locale whose parent changes the language', () => {
  const indian = project({
    sourceLocale: 'fr-FR',
    catalogs: {
      'fr-FR': ['nav.home', 'nav.help'],
      hi: ['nav.home'],
      'hi-Latn': ['nav.home'],
      'en-IN': ['nav.home', 'nav.help'],
    },
  });

  it('follows CLDR across the language boundary', () => {
    // `hi-Latn` inherits from `en-IN`. Excluding cross-language parents would be Atlas overriding
    // pinned data on taste, so they are followed and named in the README.
    const candidate = indian('hi-Latn').resolve('nav.help');
    expect(candidate.catalog.key.catalogLocale).toBe('en-IN');
    expect(candidate.attemptedLocales).toEqual(['hi-Latn', 'en-IN']);
  });

  it('goes where a declaration points instead', () => {
    // The same project, disagreeing. `hi` has no `nav.help` either, so the answer becomes the
    // source, which is the point: the declaration moved the chain rather than adding to it.
    const redirected = project({
      sourceLocale: 'fr-FR',
      catalogs: {
        'fr-FR': ['nav.home', 'nav.help'],
        hi: ['nav.home'],
        'hi-Latn': ['nav.home'],
        'en-IN': ['nav.home', 'nav.help'],
      },
      parentLocales: { 'hi-Latn': 'hi' },
    });
    expect(redirected('hi-Latn').consulted).toEqual(['hi-Latn', 'hi', 'fr-FR']);
    expect(
      redirected('hi-Latn').resolve('nav.help').catalog.key.catalogLocale,
    ).toBe('fr-FR');
  });
});

describe('a locale whose script parts it from its language', () => {
  const azerbaijani = project({
    sourceLocale: 'fr-FR',
    catalogs: {
      'fr-FR': ['nav.home', 'nav.help'],
      az: ['nav.home', 'nav.help'],
      'az-Arab': ['nav.home'],
    },
  });

  it('falls to the source and never to the other script', () => {
    // Truncation would send `az-Arab` to `az`, which is written in Latin. Serving that is worse
    // than serving the source language, because it looks like a translation.
    expect(azerbaijani('az-Arab').consulted).toEqual(['az-Arab', 'fr-FR']);
    expect(
      azerbaijani('az-Arab').resolve('nav.help').catalog.key.catalogLocale,
    ).toBe('fr-FR');
  });
});

describe('what is unchanged', () => {
  it('leaves a locale with no parent behaving exactly as before', () => {
    const japanese = project({
      sourceLocale: 'fr-FR',
      catalogs: { 'fr-FR': ['nav.home', 'nav.help'], ja: ['nav.home'] },
    });
    expect(japanese('ja').consulted).toEqual(['ja', 'fr-FR']);
    expect(japanese('ja').resolve('nav.help').attemptedLocales).toEqual([
      'ja',
      'fr-FR',
    ]);
  });

  it('leaves the source locale asking for one catalog', () => {
    expect(french('fr-FR').consulted).toEqual(['fr-FR']);
    expect(french('fr-FR').resolve('nav.home').attemptedLocales).toEqual([
      'fr-FR',
    ]);
  });

  it('refuses a message no catalog in the order carries', () => {
    expect(() => french('en-AU').resolve('nav.missing')).toThrow(
      LocalizationError,
    );
  });
});

describe('a source locale that is also a parent', () => {
  // The ordinary English project: source `en`, regional `en-AU`. The source keeps its place in the
  // chain rather than being appended after it, so it is asked for once.
  const english = project({
    sourceLocale: 'en',
    catalogs: { en: ['nav.home', 'nav.help'], 'en-AU': ['nav.home'] },
  });

  it('is asked for once and counted as inherited', () => {
    expect(english('en-AU').consulted).toEqual(['en-AU', 'en']);
    // `inherited` is what a strict policy accepts and what `degraded` reports on. `en` answering
    // for `en-AU` is `en-AU` behaving as CLDR says it should, so a strict build does not refuse it
    // and the snapshot is not degraded. The release gate counts the same project complete, which
    // is the agreement this set exists to keep.
    expect(english('en-AU').inherited).toEqual(['en-AU', 'en']);
  });

  it('leaves a locale outside the chain uninherited', () => {
    const unrelated = project({
      sourceLocale: 'en',
      catalogs: { en: ['nav.home'], 'de-DE': ['nav.home'] },
    });
    expect(unrelated('de-DE').consulted).toEqual(['de-DE', 'en']);
    expect(unrelated('de-DE').inherited).toEqual(['de-DE']);
  });

  it('reports nothing inherited when the locale has no catalog and no parent with one', () => {
    // Empty is what makes a snapshot degraded and what a strict policy refuses: every string the
    // reader sees is the source language.
    const missing = project({
      sourceLocale: 'en',
      catalogs: { en: ['nav.home'] },
      locales: ['en', 'de-DE'],
    });
    expect(missing('de-DE').consulted).toEqual(['en']);
    expect(missing('de-DE').inherited).toEqual([]);
  });
});
