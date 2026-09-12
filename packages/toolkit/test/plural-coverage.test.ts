import { describe, expect, it } from 'vitest';

import { parseAtlasCatalog, type AtlasCatalog } from '../src/index.js';
import {
  ATLAS_MESSAGE_FUNCTION_PROFILE,
  ATLAS_PLURAL_SELECTOR_FUNCTIONS,
} from '../src/message-format.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';
import { testProjectConfiguration } from './fixtures.js';
import {
  ATLAS_CARDINAL_PLURAL_CATEGORIES,
  ATLAS_ORDINAL_PLURAL_CATEGORIES,
  ATLAS_PLURAL_DATA_PROFILE,
} from '../src/plural-categories.generated.js';
import { pluralCategoriesForLocale } from '../src/semantic-model.js';

/**
 * A target locale that omits a plural category its grammar requires.
 *
 * Arabic needs six cardinal categories. A translator can supply one variant and a catch-all, and
 * every count then renders the same string: it parses, compiles, ships, and reads as a finished
 * translation. Nothing reported it.
 *
 * The categories come from the CLDR release Atlas pins, not from the host `Intl`, so the answer
 * does not change with whichever Node version a build happens to run on.
 *
 * `specs/12-verification.spec.md` section 5 asks for locales that differ in the ways the
 * mechanisms depend on, and names plural categories beyond one and other as one of those ways.
 * Arabic is the case where a translation can look finished and be wrong for five counts.
 */

const configuration = testProjectConfiguration(['en-US', 'ar-EG']);

function message(variants: readonly string[], select?: string): string {
  const declaration =
    select === undefined
      ? '.input {$count :number}'
      : `.input {$count :number select=${select}}`;
  const body = [declaration, '.match $count', ...variants];
  return `messages:\n  cart.items: |-\n${body
    .map((line) => `    ${line}`)
    .join('\n')}\n`;
}

function catalog(
  role: 'source' | 'target',
  locale: string,
  body: string,
): AtlasCatalog {
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
  message(['one {{1 item}}', '* {{# items}}']),
);

function analyze(
  targetVariants: readonly string[],
  requireComplete = false,
  locale = 'ar-EG',
) {
  return analyzeAtlasCatalogSet({
    configuration,
    catalogs: [source, catalog('target', locale, message(targetVariants))],
    ...(requireComplete ? { requireCompleteTargets: true } : {}),
  });
}

/** The same fixture pair, with a `select` kind and a chosen target locale. */
function analyzeSelect(
  select: string,
  targetLocale: string,
  targetVariants: readonly string[],
  sourceVariants: readonly string[] = ['one {{1st item}}', '* {{#th item}}'],
) {
  return analyzeAtlasCatalogSet({
    configuration: testProjectConfiguration(['en-US', targetLocale]),
    catalogs: [
      catalog('source', 'en-US', message(sourceVariants, select)),
      catalog('target', targetLocale, message(targetVariants, select)),
    ],
  });
}

const ALL_SIX = [
  'zero {{لا عناصر}}',
  'one {{عنصر واحد}}',
  'two {{عنصران}}',
  'few {{عناصر}}',
  'many {{عنصرًا}}',
  '* {{عنصر}}',
];

const coverage = (graph: ReturnType<typeof analyze>) =>
  graph.diagnostics.filter((d) => d.code === 'ATL1308');

describe('plural category coverage', () => {
  it('pins the category table to the CLDR release Atlas declares', () => {
    expect(ATLAS_PLURAL_DATA_PROFILE).toBe('cldr-48.2/atlas-plurals-2');
    expect(ATLAS_CARDINAL_PLURAL_CATEGORIES['ar']).toEqual([
      'zero',
      'one',
      'two',
      'few',
      'many',
      'other',
    ]);
    expect(ATLAS_CARDINAL_PLURAL_CATEGORIES['en']).toEqual(['one', 'other']);
    expect(ATLAS_ORDINAL_PLURAL_CATEGORIES['ar']).toEqual(['other']);
    expect(ATLAS_ORDINAL_PLURAL_CATEGORIES['en']).toEqual([
      'one',
      'two',
      'few',
      'other',
    ]);
  });

  it('says nothing when the target supplies every category', () => {
    expect(coverage(analyze(ALL_SIX))).toHaveLength(0);
  });

  it('names a single missing category', () => {
    const missingFew = ALL_SIX.filter((variant) => !variant.startsWith('few '));
    const [diagnostic] = coverage(analyze(missingFew));

    expect(diagnostic?.summary).toContain('"few"');
    expect(diagnostic?.summary).toContain('cart.items');
    expect(diagnostic?.severity).toBe('warning');
  });

  it('names every missing category at once', () => {
    const missingTwoAndFew = ALL_SIX.filter(
      (variant) => !variant.startsWith('two ') && !variant.startsWith('few '),
    );
    const [diagnostic] = coverage(analyze(missingTwoAndFew));

    expect(diagnostic?.summary).toContain('"two"');
    expect(diagnostic?.summary).toContain('"few"');
  });

  it('catches the catch-all-only translation, which is the worst case', () => {
    // Every count renders the same string, and nothing about the file looks unfinished.
    const [diagnostic] = coverage(analyze(['* {{عنصر}}']));

    for (const category of ['zero', 'one', 'two', 'few', 'many']) {
      expect(diagnostic?.summary).toContain(`"${category}"`);
    }
    expect(diagnostic?.summary).toContain('catch-all');
  });

  it('blocks under the release gate and warns otherwise', () => {
    const missingFew = ALL_SIX.filter((variant) => !variant.startsWith('few '));

    expect(analyze(missingFew).ok).toBe(true);
    expect(coverage(analyze(missingFew))[0]?.severity).toBe('warning');

    const gated = analyze(missingFew, true);
    // The severity is the gate; the graph is kept either way, so the rest of the run can
    // still be reported.
    expect(gated.ok).toBe(true);
    expect(coverage(gated)[0]?.severity).toBe('error');
  });

  it('does not invent requirements for a two-category locale', () => {
    // en needs only one and other. A target that supplies them is complete, and must not be
    // reported for lacking categories its grammar does not have.
    const graph = analyzeAtlasCatalogSet({
      configuration: testProjectConfiguration(['en-US', 'en-GB']),
      catalogs: [
        source,
        catalog(
          'target',
          'en-GB',
          message(['one {{1 item}}', '* {{# items}}']),
        ),
      ],
    });

    expect(coverage(graph)).toHaveLength(0);
  });

  it('ignores a select that is not over a number', () => {
    // A select over an enum has no plural categories to be missing. Reporting one would be noise
    // on every non-count selector in a catalog.
    const enumSource = catalog(
      'source',
      'en-US',
      'messages:\n  order.state: |-\n    .input {$state :string}\n    .match $state\n    shipped {{Shipped}}\n    * {{Pending}}\n',
    );
    const enumTarget = catalog(
      'target',
      'ar-EG',
      'messages:\n  order.state: |-\n    .input {$state :string}\n    .match $state\n    shipped {{تم الشحن}}\n    * {{قيد الانتظار}}\n',
    );

    const graph = analyzeAtlasCatalogSet({
      configuration,
      catalogs: [enumSource, enumTarget],
    });

    expect(coverage(graph)).toHaveLength(0);
  });
});

/**
 * The gate read the cardinal table for every selector, whatever MF2's `select`
 * option said, so it was wrong in both directions at once: it demanded of an Arabic ordinal
 * translation five categories Arabic has no ordinal forms for, and it passed an English ordinal
 * translation that was missing `two` and `few`.
 *
 * The two tables are not variants of one another, which is why one cannot stand in for the other.
 */
describe('plural category coverage follows MF2 select', () => {
  it('accepts an Arabic ordinal target that supplies only the catch-all', () => {
    // CLDR 48.2 gives Arabic ordinals exactly ["other"]. Under the cardinal table this fixture was
    // required to supply zero/one/two/few/many, which is a demand no translator could satisfy.
    expect(
      coverage(analyzeSelect('ordinal', 'ar-EG', ['* {{عنصر}}'])),
    ).toHaveLength(0);

    // Control: the identical fixture selecting cardinally is still reported, so the pass above is
    // the table being chosen correctly and not category checking having stopped working.
    expect(coverage(analyze(['* {{عنصر}}']))).not.toHaveLength(0);
  });

  it('reports an English ordinal target missing two and few', () => {
    // English ordinals need one/two/few/other. Checked against cardinal ["one","other"] this
    // translation passed, and shipped "2th" and "3th".
    const [diagnostic] = coverage(
      analyzeSelect('ordinal', 'en-GB', ['one {{1st item}}', '* {{#th item}}']),
    );

    expect(diagnostic?.summary).toContain('"two"');
    expect(diagnostic?.summary).toContain('"few"');
    expect(diagnostic?.summary).toContain('ordinal');
    expect(diagnostic?.summary).toContain('cart.items');

    // Control: cardinally, the same two variants are complete for English.
    expect(
      coverage(
        analyzeSelect('plural', 'en-GB', ['one {{1 item}}', '* {{# items}}']),
      ),
    ).toHaveLength(0);
  });

  it('requires nothing of a select=exact message', () => {
    // `exact` selects on the number itself, so there are no categories to be missing. Requiring
    // them would make a legitimate MF2 message unsatisfiable.
    expect(
      coverage(
        analyzeSelect(
          'exact',
          'ar-EG',
          ['1 {{عنصر واحد}}', '* {{عناصر}}'],
          ['1 {{1 item}}', '* {{# items}}'],
        ),
      ),
    ).toHaveLength(0);
  });

  it('rejects a select value the spec does not define, at parse time', () => {
    // UTS #35 Part 2: the value must be a literal and one of plural, ordinal, exact, otherwise a
    // Bad Option error. Accepting anything else means falling through to the cardinal table, which
    // is the defect this section fixes reappearing by a different route.
    const rejected = (select: string) => {
      const result = parseAtlasCatalog(message(['* {{x}}'], select), {
        role: 'source',
        providerId: 'home',
        scopeId: 'shell',
        locale: 'en-US',
        sourcePath: 'i18n/shell/en-US.yaml',
      });
      return result.ok
        ? []
        : result.diagnostics.filter((d) => d.code === 'ATL1204');
    };

    expect(rejected('bogus')).toHaveLength(1);
    // `cardinal` is what Intl.PluralRules and messageformat@4 call it. The spec says `plural`, and
    // one portable spelling is the point of a portable catalog format.
    expect(rejected('cardinal')).toHaveLength(1);
    // Not a literal: the value cannot be known at build time, so no table can be chosen.
    expect(rejected('$kind')).toHaveLength(1);

    for (const value of ['plural', 'ordinal', 'exact']) {
      expect(rejected(value)).toHaveLength(0);
    }

    // Rejecting is only cheap if the error says what to write instead. Counting the diagnostics
    // never reads them, so the permitted-value list could be dropped from the message and every
    // assertion above would stay green. These read it.
    for (const value of ['bogus', 'cardinal']) {
      const [diagnostic] = rejected(value);
      for (const permitted of ['plural', 'ordinal', 'exact']) {
        expect(diagnostic?.summary).toContain(permitted);
      }
    }
  });
});

/**
 * Both generated tables carry rows keyed by more than one subtag (`pt-PT` and
 * `kok-Latn` cardinal, `kok-Latn` ordinal) and the lookup split the locale on `-` and kept the
 * first subtag, so none of those rows could ever be selected.
 *
 * In CLDR 48.2 each of them is identical to its base language, which is why nothing failed, and
 * why asserting on the categories proves nothing. These assert *which row answered*.
 */
describe('plural table lookup', () => {
  const cardinal = ATLAS_CARDINAL_PLURAL_CATEGORIES;
  const ordinal = ATLAS_ORDINAL_PLURAL_CATEGORIES;

  it('selects a row keyed by more than one subtag, not its base language', () => {
    // `toBe`, not `toEqual`: `pt-PT` and `pt` are deep-equal in this release, so only the identity
    // of the array says which one answered. Under the first-subtag lookup these are the base rows.
    expect(pluralCategoriesForLocale(cardinal, 'pt-PT')).toBe(
      cardinal['pt-PT'],
    );
    expect(pluralCategoriesForLocale(cardinal, 'kok-Latn')).toBe(
      cardinal['kok-Latn'],
    );
    expect(pluralCategoriesForLocale(ordinal, 'kok-Latn')).toBe(
      ordinal['kok-Latn'],
    );
  });

  it('matches ICU: the longest key that prefixes the locale, then the base', () => {
    // Measured on ICU 78.3 / CLDR 48, which is what this repository's Node resolves with:
    // `new Intl.PluralRules('kok-Latn-IN').resolvedOptions().locale` is `kok-Latn`, and `('pt-BR')`
    // is `pt`. A build-time gate that stopped at the language could not agree with the selection it
    // exists to gate, which is why the unreachable rows are matched rather than dropped.
    expect(pluralCategoriesForLocale(cardinal, 'kok-Latn-IN')).toBe(
      cardinal['kok-Latn'],
    );
    expect(pluralCategoriesForLocale(cardinal, 'pt-BR')).toBe(cardinal['pt']);
    // On a subtag boundary, not a string prefix: `pt-PT` must not answer for `pt-PTX`.
    expect(pluralCategoriesForLocale(cardinal, 'pt-PTX')).toBe(cardinal['pt']);
  });

  it('folds case, because CLDR writes its keys in one and a catalog may not', () => {
    // `new Intl.PluralRules('PT-pt').resolvedOptions().locale` is `pt-PT`.
    expect(pluralCategoriesForLocale(cardinal, 'PT-pt')).toBe(
      cardinal['pt-PT'],
    );
  });

  it('answers nothing for a language the release does not list', () => {
    // CLDR expresses "only other" by omitting the language; the caller supplies that meaning, so
    // the lookup does not invent a default it would then be impossible to tell from a real row.
    expect(pluralCategoriesForLocale(cardinal, 'zxx')).toBeUndefined();
  });

  it('reads a diverged multi-subtag row, which is the mutation that is silent today', () => {
    // The failure this guards against: change a hyphenated row so it differs from its base and
    // nothing notices. It cannot be written against the real tables while every such row equals its
    // base, so it is written against a table shaped like them. This is the release that has not
    // happened yet, and the check that will be there when it does.
    const diverged = Object.freeze({
      pt: ['one', 'many', 'other'],
      'pt-PT': ['one', 'other'],
    });

    expect(pluralCategoriesForLocale(diverged, 'pt-PT')).toEqual([
      'one',
      'other',
    ]);
    expect(pluralCategoriesForLocale(diverged, 'pt-BR')).toEqual([
      'one',
      'many',
      'other',
    ]);
  });

  it('does not answer with an inherited object property', () => {
    // A locale reaches here from configuration, and an indexed read of a plain object answers
    // `constructor` with a function. The lookup goes through a `Map`, which has no such keys.
    expect(pluralCategoriesForLocale(cardinal, 'constructor')).toBeUndefined();
    expect(pluralCategoriesForLocale(cardinal, '__proto__')).toBeUndefined();
  });
});

/**
 * `requireCompleteTargets` turns ATL1307 and ATL1308 from warnings into errors.
 * Three checks above turn the gate on, or use a complete target: none did both, so nothing said
 * that a translator who has actually finished can turn the gate on and have the build pass.
 *
 * That is the failure a completeness gate has, and it is not letting an incomplete catalog through:
 * it is refusing one that is complete, at the moment the build is strictest. It cost exactly that
 * for Arabic ordinals until 3.6.
 *
 * The categories are written out rather than read back from the generated table. A fixture built
 * from the same table the gate reads agrees with the gate however wrong both are, and the mutation
 * that matters here, reading the cardinal table for an ordinal selector, would go green.
 */
describe('requireCompleteTargets accepts a target that is complete', () => {
  /** Categories other than `other`, which the catch-all supplies. CLDR 48.2, written out. */
  const COMPLETE = [
    // Six cardinal categories, the largest set CLDR defines.
    {
      locale: 'ar-EG',
      select: 'plural',
      categories: ['zero', 'one', 'two', 'few', 'many'],
    },
    // Two.
    { locale: 'en-GB', select: 'plural', categories: ['one'] },
    // Six ordinal categories. Welsh is the only language CLDR 48.2 gives six ordinal forms.
    {
      locale: 'cy-GB',
      select: 'ordinal',
      categories: ['zero', 'one', 'two', 'few', 'many'],
    },
    // Two.
    { locale: 'fr-FR', select: 'ordinal', categories: ['one'] },
    // One. Arabic ordinals, which under the cardinal table were required to supply five categories
    // the language has no ordinal forms for: a demand no translator could have satisfied.
    { locale: 'ar-EG', select: 'ordinal', categories: [] },
    // Four. English ordinals, where the cardinal table passed a translation missing two and few.
    { locale: 'en-GB', select: 'ordinal', categories: ['one', 'two', 'few'] },
  ] as const;

  /** English, complete for its own grammar in the same kind, so the source is not itself a gap. */
  const sourceVariants = (select: string) =>
    select === 'ordinal'
      ? ['one {{1st}}', 'two {{2nd}}', 'few {{3rd}}', '* {{#th}}']
      : ['one {{1 item}}', '* {{# items}}'];

  for (const { locale, select, categories } of COMPLETE) {
    it(`${select} in ${locale}, ${categories.length + 1} categories`, () => {
      const graph = analyzeAtlasCatalogSet({
        configuration: testProjectConfiguration(['en-US', locale]),
        catalogs: [
          catalog('source', 'en-US', message(sourceVariants(select), select)),
          catalog(
            'target',
            locale,
            message(
              [
                ...categories.map((category) => `${category} {{${category}}}`),
                '* {{other}}',
              ],
              select,
            ),
          ),
        ],
        requireCompleteTargets: true,
      });

      expect(graph.diagnostics).toEqual([]);
      expect(graph.ok).toBe(true);
    });
  }
});
/**
 * The four functions that select numerically, not the two a hand-kept set remembered.
 *
 * `PLURAL_SELECTOR_FUNCTIONS` was `new Set(['number', 'integer'])` beside a built-in profile that
 * knows the answer, so a `.match` on `:offset` or `:percent` shipped with its target plural
 * coverage unmeasured: the Arabic translation below, one variant and a catch-all where the
 * grammar needs six, reported nothing. The set is derived from the profile now, and these are the
 * two rows that were missing.
 *
 * `:currency` is here as the other half of the check: it selects numerically in no sense at all,
 * 3.17 refuses a `.match` over it outright, and a coverage rule that fired on it would be measuring
 * a message that cannot exist.
 */
describe('which functions have plural categories to be missing', () => {
  const arabicMessage = (annotation: string, variants: readonly string[]) =>
    `messages:\n  cart.items: |-\n${[
      `.input {$count ${annotation}}`,
      '.match $count',
      ...variants,
    ]
      .map((line) => `    ${line}`)
      .join('\n')}\n`;

  const analyzeAnnotated = (annotation: string) =>
    analyzeAtlasCatalogSet({
      configuration,
      catalogs: [
        catalog(
          'source',
          'en-US',
          arabicMessage(annotation, ['one {{1 item}}', '* {{# items}}']),
        ),
        catalog(
          'target',
          'ar-EG',
          arabicMessage(annotation, ['one {{عنصر واحد}}', '* {{عنصر}}']),
        ),
      ],
    });

  it.each([[':number'], [':integer'], [':offset add=1'], [':percent']])(
    'measures target plural coverage for a .match on %s',
    (annotation) => {
      expect(coverage(analyzeAnnotated(annotation))).not.toEqual([]);
    },
  );

  it('is derived from the profile rather than kept beside it', () => {
    expect([...ATLAS_PLURAL_SELECTOR_FUNCTIONS].sort()).toEqual([
      'integer',
      'number',
      'offset',
      'percent',
    ]);
    // Every one of them selects, and every function that selects numerically is one of them.
    for (const { name, selection } of ATLAS_MESSAGE_FUNCTION_PROFILE) {
      expect(ATLAS_PLURAL_SELECTOR_FUNCTIONS.has(name)).toBe(
        selection === 'number',
      );
    }
  });
});
