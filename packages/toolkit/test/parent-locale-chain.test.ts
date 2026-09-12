import { describe, expect, it } from 'vitest';

import {
  parseAtlasCatalog,
  parseAtlasConfiguration,
  type AtlasSemanticGraph,
} from '../src/index.js';
import { generateAtlasContracts } from '../src/generated-contracts.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';
import { atlasLocaleFallbackChain } from '../src/locales.js';
import { ATLAS_PARENT_LOCALES } from '../src/parent-locales.generated.js';
import { testProjectConfiguration } from './fixtures.js';

/**
 * A locale falls back to its parent before it falls back to the source.
 *
 * Until this existed a target catalog that omitted a message was answered by the source locale and
 * by nothing in between, so an application shipping `en`, `en-AU` and `en-GB` either wrote every
 * string three times or served the source language for the ones it did not. CLDR has said which
 * locale each locale inherits from for as long as there has been a CLDR, and Atlas was not reading
 * it.
 *
 * ## What the chain is
 *
 * `specs/03-locale-identity-and-resolution.spec.md` section 4 takes each parent from the pinned
 * release rather than from a consumer's statement, and walks the chain to its end.
 *
 * Inheritance as UTS 35 section 4.1.3 describes it, which is not truncation, walked to its end
 * rather than stopped at one hop. `en-AU` gives `en-001` and then `en`; stopping after `en-001`
 * would serve the source language for a string `en` has, which is the outcome the feature exists
 * to remove and which is invisible in any project whose source locale is English.
 *
 * `und` in the pinned table is a value rather than an absence. `parentLocales.json` carries
 * `_localeRules` `{"parentLocale":{"nonlikelyScript":"root"}}`, and that rule is what produced its
 * 49 `und` entries: a locale written in a script its language does not usually take inherits from
 * root. Those 49 behave exactly as every locale did before this existed.
 */

const chainOf = (locale: string, overrides?: Record<string, string>) =>
  atlasLocaleFallbackChain(locale, overrides);

describe('the chain CLDR declares', () => {
  it('walks to its end rather than stopping at one hop', () => {
    // The case the feature is named for, and the one a single hop gets wrong: a reader of "falls
    // back to its parent" expects `en` to be consulted, and `en-001` is not where the strings are.
    expect(chainOf('en-AU')).toEqual(['en-001', 'en']);
    expect(chainOf('en-DE')).toEqual(['en-150', 'en-001', 'en']);
  });

  it('truncates only where the table says nothing', () => {
    // The default rule, and the reason the table has to be read: `de-CH` is the shape everyone
    // assumes, and `en-AU` is the shape CLDR actually declares.
    expect(chainOf('de-CH')).toEqual(['de']);
    expect(chainOf('pt-BR')).toEqual(['pt']);
    expect(chainOf('es-MX')).toEqual(['es-419', 'es']);
  });

  it('stops at a locale whose script is not the one its language takes', () => {
    // `az-Arab` truncated is `az`, the Latin-script locale it was separated from. Serving Latin
    // Azerbaijani to a reader who asked for Arabic Azerbaijani is worse than serving the source
    // language, because it looks like a translation.
    expect(chainOf('az-Arab')).toEqual([]);
    expect(chainOf('sr-Latn')).toEqual([]);
    // The same rule two hops in: `zh-Hant-MO` reaches `zh-Hant` and stops, rather than reaching
    // `zh`, which is written in the other script.
    expect(chainOf('zh-Hant-MO')).toEqual(['zh-Hant-HK', 'zh-Hant']);
  });

  it('leaves every locale that inherits from root behaving as it always did', () => {
    const rootParented = Object.entries(ATLAS_PARENT_LOCALES)
      .filter(([, parent]) => parent === 'und')
      .map(([locale]) => locale);
    // The count is asserted so a CLDR release that stopped applying the rule is read here rather
    // than silently turning 49 empty chains into 49 truncations.
    expect(rootParented).toHaveLength(49);
    for (const locale of rootParented) expect(chainOf(locale)).toEqual([]);
  });

  it('follows the four parents that change the language', () => {
    // Leaving these out would be Atlas overriding pinned data on taste. They are named in the
    // README's fallback section so nobody meets them by surprise, and the per-locale declaration
    // is where a project that disagrees says so.
    expect(chainOf('hi-Latn')).toEqual(['en-IN', 'en-001', 'en']);
    expect(chainOf('ht')).toEqual(['fr-HT', 'fr']);
    expect(chainOf('nb')).toEqual(['no']);
    expect(chainOf('nn')).toEqual(['no']);
    const crossLanguage = Object.entries(ATLAS_PARENT_LOCALES)
      .filter(
        ([locale, parent]) =>
          parent !== 'und' && locale.split('-')[0] !== parent.split('-')[0],
      )
      .map(([locale]) => locale)
      .sort();
    expect(crossLanguage).toEqual(['hi-Latn', 'ht', 'nb', 'nn']);
  });
});

describe('a project that declares a parent of its own', () => {
  it('replaces one hop and lets CLDR carry the rest', () => {
    // The declaration is a correction rather than a chain: `hi-Latn` now inherits from `hi`, and
    // what `hi` inherits from is still CLDR's answer.
    expect(chainOf('hi-Latn', { 'hi-Latn': 'hi' })).toEqual(['hi']);
    expect(chainOf('en-AU', { 'en-AU': 'en-GB' })).toEqual([
      'en-GB',
      'en-001',
      'en',
    ]);
  });

  it('is read at every hop, so one line moves a family', () => {
    // `en-001` is not a locale anyone ships, and every regional English inherits through it.
    expect(chainOf('en-AU', { 'en-001': 'und' })).toEqual(['en-001']);
    expect(chainOf('en-DE', { 'en-150': 'en' })).toEqual(['en-150', 'en']);
  });

  it('says a locale has no parent with the identity the standard uses', () => {
    expect(chainOf('en-AU', { 'en-AU': 'und' })).toEqual([]);
  });
});

const configuration = (extra: Readonly<Record<string, unknown>>) =>
  parseAtlasConfiguration(
    JSON.stringify({
      schemaVersion: 1,
      sourceLocale: 'en-US',
      defaultLocale: 'en-US',
      locales: ['en-US', 'en-AU'],
      ...extra,
    }),
  );

const codesOf = (result: ReturnType<typeof configuration>) =>
  result.diagnostics.map(({ code }) => code);

describe('the declarations a configuration is refused for', () => {
  it('accepts a declaration a configured locale inherits through', () => {
    // The key is not a locale this project ships, and that is deliberate: a chain runs through
    // locales nobody serves, and redirecting one of those is what the key is for.
    const parsed = configuration({ parentLocales: { 'en-001': 'und' } });
    if (!parsed.ok) throw new Error('the configuration was refused');
    expect(parsed.value.parentLocales).toEqual({ 'en-001': 'und' });
  });

  it('refuses a locale that declares itself', () => {
    // A cycle of length one. The message says what to write instead, because somebody who types
    // this means "no parent" and there is a spelling for that.
    expect(
      codesOf(configuration({ parentLocales: { 'en-AU': 'en-AU' } })),
    ).toContain('ATL1007');
  });

  it('refuses a chain that comes back on itself', () => {
    // Only a declaration can make one: the pinned table has no cycle and truncation always
    // shortens. Undetected it is not a hang, because the walk stops at the first repeat; it is a
    // chain that quietly ends somewhere nobody chose.
    const parsed = configuration({
      parentLocales: { 'en-US': 'en-AU', 'en-AU': 'en-US' },
    });
    // One finding per locale caught in it, and each one prints the walk that came back, because a
    // reader looking at two entries in a file cannot see the loop and a reader given the path can.
    const cycles = parsed.diagnostics.filter(({ code }) => code === 'ATL1007');
    expect(cycles.map(({ summary }) => summary).join('\n')).toContain(
      'en-AU to en-US to en-AU',
    );
    expect(cycles.map(({ summary }) => summary).join('\n')).toContain(
      'en-US to en-AU to en-US',
    );
  });

  it('refuses a declaration nothing inherits through', () => {
    // `fr-CA` is not shipped and no shipped locale reaches it, so the entry states a decision that
    // has no effect, which is a typo far more often than it is a plan.
    expect(
      codesOf(configuration({ parentLocales: { 'fr-CA': 'fr' } })),
    ).toContain('ATL1004');
  });

  it('refuses a malformed locale on either side', () => {
    expect(
      codesOf(configuration({ parentLocales: { 'not a locale': 'en' } })),
    ).toContain('ATL1003');
    expect(
      codesOf(configuration({ parentLocales: { 'en-AU': 'not a locale' } })),
    ).toContain('ATL1003');
  });
});

function catalog(role: 'source' | 'target', locale: string, body: string) {
  const parsed = parseAtlasCatalog(body, {
    role,
    providerId: 'home',
    scopeId: 'shell',
    locale,
    sourcePath: `i18n/shell/${locale}.yaml`,
  });
  if (!parsed.ok) throw new Error(`fixture ${locale} failed to parse`);
  return parsed.value;
}

// French is the source, so English is a target like any other and `en-AU` inheriting from `en` is
// a claim about the chain rather than about source fallback. With English as the source every case
// below would pass whether or not any of this existed.
const french = catalog(
  'source',
  'fr-FR',
  'messages:\n  nav.home: Accueil\n  nav.help: Aide\n',
);
const english = catalog(
  'target',
  'en',
  'messages:\n  nav.home: Home\n  nav.help: Help\n',
);
const australian = catalog('target', 'en-AU', 'messages:\n  nav.home: Home\n');

const analyze = (
  locales: readonly string[],
  catalogs: readonly ReturnType<typeof catalog>[],
  extra: Readonly<Record<string, unknown>> = {},
) =>
  analyzeAtlasCatalogSet({
    configuration: testProjectConfiguration(locales, extra),
    catalogs,
    requireCompleteTargets: true,
  });

function graphOf(result: ReturnType<typeof analyze>): AtlasSemanticGraph {
  if (!result.ok) {
    throw new Error(
      `the fixture did not compile: ${result.diagnostics
        .map(({ code, summary }) => `${code} ${summary}`)
        .join('; ')}`,
    );
  }
  return result.value;
}

function indexModuleOf(graph: AtlasSemanticGraph): string {
  const generated = generateAtlasContracts(graph);
  if (!generated.ok) throw new Error('the fixture generated nothing');
  const index = generated.value.find(({ path }) => path === 'index.ts');
  if (index === undefined) throw new Error('no index module was generated');
  return index.contents;
}

describe('what the build hands the runtime', () => {
  it('carries each chain, filtered to the locales this project ships', () => {
    // `en-001` is a real link in `en-AU`'s chain and no application ships a catalog for it, so it
    // is dropped here: a member with no catalog costs a lookup and answers nothing.
    expect(
      indexModuleOf(
        graphOf(
          analyze(['fr-FR', 'en', 'en-AU'], [french, english, australian]),
        ),
      ),
    ).toContain('localeFallbacks: Object.freeze({"en-AU":["en"]} as const)');
  });

  it('carries nothing when no locale inherits from another it ships', () => {
    expect(
      indexModuleOf(graphOf(analyze(['fr-FR', 'en'], [french, english]))),
    ).not.toContain('localeFallbacks');
  });

  it('sends a redirected locale where the declaration points', () => {
    // `hi-Latn` inherits from `en-IN` in CLDR. A project that would rather it inherited from `hi`
    // says so, and what reaches the runtime changes with it.
    const hindi = catalog('target', 'hi', 'messages:\n  nav.home: होम\n');
    const latin = catalog('target', 'hi-Latn', 'messages:\n  nav.home: Home\n');
    const indian = catalog(
      'target',
      'en-IN',
      'messages:\n  nav.home: Home\n  nav.help: Help\n',
    );
    const locales = ['fr-FR', 'hi', 'hi-Latn', 'en-IN'];
    const catalogs = [french, hindi, latin, indian];
    expect(indexModuleOf(graphOf(analyze(locales, catalogs)))).toContain(
      'localeFallbacks: Object.freeze({"hi-Latn":["en-IN"]}',
    );
    expect(
      indexModuleOf(
        graphOf(
          analyze(locales, catalogs, { parentLocales: { 'hi-Latn': 'hi' } }),
        ),
      ),
    ).toContain('localeFallbacks: Object.freeze({"hi-Latn":["hi"]}');
  });

  it('sends nothing for a locale whose script parts it from its language', () => {
    // `az-Arab` next to `az`: the chain is empty, so the runtime falls to the source and never to
    // `az`. A truncating implementation would send `["az"]` here.
    const arabic = catalog(
      'target',
      'az-Arab',
      'messages:\n  nav.home: Ev\n  nav.help: Kömək\n',
    );
    const latin = catalog(
      'target',
      'az',
      'messages:\n  nav.home: Ev\n  nav.help: Komek\n',
    );
    expect(
      indexModuleOf(
        graphOf(analyze(['fr-FR', 'az', 'az-Arab'], [french, latin, arabic])),
      ),
    ).not.toContain('localeFallbacks');
  });
});

describe('the release completeness gate', () => {
  const codes = (result: ReturnType<typeof analyze>) =>
    result.diagnostics.map(({ code }) => code);

  it('counts a locale complete once its whole chain is counted', () => {
    // `en-AU` omits `nav.help` and `en` has it. That is a regional locale saying it has nothing to
    // add, which is what a parent is for, so there is nothing to report.
    const graph = analyze(
      ['fr-FR', 'en', 'en-AU'],
      [french, english, australian],
    );
    expect(graph.ok).toBe(true);
    expect(codes(graph)).not.toContain('ATL1307');
  });

  it('still reports a message no locale in the chain has', () => {
    // The same omission with the chain unable to answer it. The gate has not been softened; it has
    // been given the second place to look that the runtime already looks in.
    const thin = catalog('target', 'en', 'messages:\n  nav.home: Home\n');
    const graph = analyze(['fr-FR', 'en', 'en-AU'], [french, thin, australian]);
    const reported = graph.diagnostics.filter(({ code }) => code === 'ATL1307');
    // Both locales are short of it and both are told so: `en-AU` inherits from an `en` that does
    // not have it either.
    expect(reported).toHaveLength(2);
    expect(reported.map(({ summary }) => summary).join(' ')).toContain(
      'nav.help',
    );
  });

  it('counts a locale with no catalog complete when it inherits one', () => {
    // The most complete form of incompleteness is a locale with no catalog at all, and it is a
    // legitimate way to ship a regional locale: `en-AU` exists as an address and a way of writing
    // numbers, and every string it shows is `en`.
    const graph = analyze(['fr-FR', 'en', 'en-AU'], [french, english]);
    expect(graph.ok).toBe(true);
    expect(codes(graph)).not.toContain('ATL1306');
  });

  it('still reports a locale with no catalog and nothing to inherit from', () => {
    expect(
      codes(analyze(['fr-FR', 'en', 'de-DE'], [french, english])),
    ).toContain('ATL1306');
  });
});
