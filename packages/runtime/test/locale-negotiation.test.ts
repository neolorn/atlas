import { describe, expect, it } from 'vitest';

import { ATLAS_ENCOMPASSED_LANGUAGE_PROFILE } from '../src/encompassed-languages.generated.js';
import {
  negotiateLocale,
  parseAcceptLanguage,
} from '../src/locale-negotiation.js';

/**
 * Negotiating a locale from a request header.
 *
 * `locale-negotiation.ts` imports one generated table and nothing else, which is why it can be
 * asserted here at all: it decides which language an application answers in, from a header a
 * client controls, and every claim in it is a pure function of two strings and pinned data.
 */

/** What the runtime actually passes in: canonicalization, with a tag it rejects meaning no match. */
const canonicalize = (value: string): string | undefined => {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
};

/**
 * RFC 9110 12.4.2 introduces the parameter as *"q" (case-insensitive)* and says the weight
 * *"is normalized to a real number in the range 0 through 1"*. Atlas matched `q` in lower case only
 * and read any value the pattern happened to admit.
 */
describe('Accept-Language weights', () => {
  it('reads a weight spelled in upper case', () => {
    // The defect, at its plainest: a client asks for English first and is answered in German,
    // because `Q` was read as an unknown parameter and German kept the default weight of 1.
    expect(parseAcceptLanguage('de;Q=0.1, en')).toEqual(['en', 'de']);
    expect(parseAcceptLanguage('de;q=0.1, en')).toEqual(['en', 'de']);
  });

  it('does not let a weight above 1 outrank one at 1', () => {
    // 1 is the most preferred value the header can express, so nothing may sort above it. Without
    // normalization `q=1.9` reads as 1.9 and displaces a client's properly weighted first choice;
    // normalized, the two tie and header order decides, the only other information there.
    expect(parseAcceptLanguage('en;q=1, de;q=1.9')).toEqual(['en', 'de']);
  });

  it('reads a weight with more precision than a sender may generate', () => {
    // The three-digit limit binds a sender, "A sender of qvalue MUST NOT generate more than three
    // digits after the decimal point", and nothing binds a recipient. Read to three digits,
    // `q=0.0001` is no match at all, so German keeps the default of 1 and wins a preference it
    // disclaimed.
    expect(parseAcceptLanguage('de;q=0.0001, en')).toEqual(['en', 'de']);
    expect(parseAcceptLanguage('en;q=1.0000, de;q=0.5')).toEqual(['en', 'de']);
  });

  it('still excludes a range at q=0', () => {
    // "a value of 0 means 'not acceptable'", and normalization must not turn that into a weight.
    expect(parseAcceptLanguage('de;q=0, en')).toEqual(['en']);
    expect(parseAcceptLanguage('de;Q=0.000, en')).toEqual(['en']);
  });

  it('leaves the default of 1 when a parameter is not a weight', () => {
    // "If no 'q' parameter is present, the default weight is 1." A parameter that is not one at all
    // is the same case, and dropping the range instead would lose a language over a typo.
    expect(parseAcceptLanguage('de;charset=utf-8, en')).toEqual(['de', 'en']);
    expect(parseAcceptLanguage('de;q=high, en')).toEqual(['de', 'en']);
  });
});

/**
 * 3.7d. RFC 4647 3.4: *"Single letter or digit subtags (including both the letter 'x', which
 * introduces private-use sequences, and the subtags that introduce extensions) are removed at the
 * same time as their closest trailing subtag."*
 *
 * These assert the candidates rather than the answer, because every sequence below ends at the
 * language subtag and produces the same answer either way. The extra candidate the old loop asked
 * about matched nothing only because canonicalization rejects it, and that is an invariant of a
 * different file.
 */
describe('RFC 4647 lookup truncation', () => {
  const candidates = (range: string): readonly string[] => {
    const asked: string[] = [];
    negotiateLocale([range], [], (value) => {
      asked.push(value);
      return canonicalize(value);
    });
    return asked;
  };

  it('removes a singleton with the subtag that follows it', () => {
    // The RFC's own worked example, verbatim. `zh-Hant-CN-x` is not in it, and is not a language
    // tag: `Intl.getCanonicalLocales('zh-Hant-CN-x')` throws.
    expect(candidates('zh-Hant-CN-x-private1-private2')).toEqual([
      'zh-Hant-CN-x-private1-private2',
      'zh-Hant-CN-x-private1',
      'zh-Hant-CN',
      'zh-Hant',
      'zh',
    ]);
  });

  it('removes an extension singleton with its keyword', () => {
    // `arab` is removed on its own, because `nu` is two characters. Removing `nu` then takes `u`
    // with it, so `ar-SA-u` is never asked about.
    expect(candidates('ar-SA-u-nu-arab')).toEqual([
      'ar-SA-u-nu-arab',
      'ar-SA-u-nu',
      'ar-SA',
      'ar',
    ]);
  });

  it('leaves an ordinary tag alone', () => {
    expect(candidates('ar-SA')).toEqual(['ar-SA', 'ar']);
    expect(candidates('en')).toEqual(['en']);
  });
});

/**
 * 3.7b. Step 3 of `negotiateLocale` is Atlas's addition to RFC 4647 lookup, and it is a good one:
 * without it `ar-SA` goes unmatched against a supported `ar-EG` and an Arabic speaker is answered in
 * English. It compared the language subtag alone, so it also answered `zh-Hans-CN` to `zh-Hant`.
 */
describe('same-language fallback compares script', () => {
  it('does not answer Simplified to a request for Traditional', () => {
    expect(
      negotiateLocale(['zh-Hant'], ['zh-Hans-CN'], canonicalize),
    ).toBeUndefined();
  });

  it('finds the same-script locale whatever order they are declared in', () => {
    expect(
      negotiateLocale(['zh-Hant'], ['zh-Hans-CN', 'zh-Hant-HK'], canonicalize),
    ).toBe('zh-Hant-HK');
    expect(
      negotiateLocale(['zh-Hant'], ['zh-Hant-HK', 'zh-Hans-CN'], canonicalize),
    ).toBe('zh-Hant-HK');
  });

  it('compares the script a tag is written in, not the one it names', () => {
    // Serbian is the case Chinese hides: the range names no script at all. `sr` maximizes to
    // `sr-Cyrl-RS` and `sr-Latn-RS` to itself, so a comparison of written scripts would find
    // nothing to compare and let Cyrillic answer a Latin request, or the reverse.
    expect(
      negotiateLocale(['sr'], ['sr-Latn-RS'], canonicalize),
    ).toBeUndefined();
    expect(negotiateLocale(['sr'], ['sr-RS'], canonicalize)).toBe('sr-RS');
    expect(negotiateLocale(['sr-Latn'], ['sr-Latn-RS'], canonicalize)).toBe(
      'sr-Latn-RS',
    );
  });

  it('still matches across regions, which is what step 3 exists for', () => {
    // The regression this fix must not cause. `ar-SA` and `ar-EG` are the same language in the same
    // script, and answering English to an Arabic speaker because the region differs is the wrong
    // answer by a wide margin.
    expect(negotiateLocale(['ar-SA'], ['ar-EG'], canonicalize)).toBe('ar-EG');
    expect(negotiateLocale(['en-AU'], ['en-GB'], canonicalize)).toBe('en-GB');
  });

  it('resolves each range fully before considering the next', () => {
    // Unchanged by this fix and asserted alongside it, because the script comparison happens inside
    // the per-range loop and a mistake there would show up as English winning.
    expect(
      negotiateLocale(['zh-Hant', 'en'], ['en-GB', 'zh-Hant-HK'], canonicalize),
    ).toBe('zh-Hant-HK');
  });
});

/**
 * The encompassed-language step. `no` is what a Norwegian browser actually sends, and until this
 * step existed a site shipping `nb-NO` answered it with nothing, so the only repair a consumer had
 * was writing `"no": "nb-NO"` into `aliases` by hand, for a relation two standards already publish.
 *
 * The table under it is `packages/runtime/src/encompassed-languages.generated.ts`: membership from
 * the vendored IANA registry's `Macrolanguage` field, ordering from CLDR's language matching data,
 * both pinned and both regenerated under `verify:locale-profile`. The last two cases here are the
 * ones that must not move, and the two after them are the narrowness: this is not CLDR matching in
 * full, and the pairs it leaves out are left out on purpose.
 */
describe('a language written under another subtag', () => {
  it('answers a request for the macrolanguage', () => {
    expect(negotiateLocale(['no'], ['nb-NO'], canonicalize)).toBe('nb-NO');
    expect(negotiateLocale(['no'], ['en-US', 'nb-NO'], canonicalize)).toBe(
      'nb-NO',
    );
  });

  it('prefers the nearer language when a site ships both', () => {
    // CLDR rates `nb`/`no` at 1 and `nn`/`no` at 20, so declaration order does not decide this one:
    // Bokmal wins from either end of the list.
    expect(negotiateLocale(['no'], ['nn-NO', 'nb-NO'], canonicalize)).toBe(
      'nb-NO',
    );
    expect(negotiateLocale(['no'], ['nb-NO', 'nn-NO'], canonicalize)).toBe(
      'nb-NO',
    );
    // And Nynorsk is still Norwegian when it is the only Norwegian on offer.
    expect(negotiateLocale(['no'], ['nn-NO'], canonicalize)).toBe('nn-NO');
  });

  it('reads the relation in both directions', () => {
    expect(negotiateLocale(['nb'], ['no-NO'], canonicalize)).toBe('no-NO');
  });

  it('leaves a tie to the consumer, because CLDR leaves it too', () => {
    // `bs`, `hr` and `sr` are all 4 from `sh`. Nothing in the data separates Bosnian from Croatian
    // here, so the first locale the consumer declared is the one that answers.
    expect(negotiateLocale(['sh'], ['hr-HR', 'bs-BA'], canonicalize)).toBe(
      'hr-HR',
    );
    expect(negotiateLocale(['sh'], ['bs-BA', 'hr-HR'], canonicalize)).toBe(
      'bs-BA',
    );
  });

  it('still refuses Simplified for a request for Traditional', () => {
    // Unchanged, and the reason the table stops at the language dimension: under the whole CLDR
    // distance model the script dimension alone contributes exactly the default threshold for this
    // pair, so the refusal would rest on where that threshold sits. Step 3 decides it outright.
    expect(
      negotiateLocale(['zh-Hant'], ['zh-Hans-CN'], canonicalize),
    ).toBeUndefined();
  });

  it('still matches Traditional across regions', () => {
    expect(negotiateLocale(['zh-Hant'], ['zh-TW'], canonicalize)).toBe('zh-TW');
  });

  it('names the two snapshots it is derived from', () => {
    // The string moves when either source moves, so a regeneration that changes what negotiation
    // answers cannot land as a silent data update.
    expect(ATLAS_ENCOMPASSED_LANGUAGE_PROFILE).toBe(
      'cldr-48.2+iana-2026-06-14/atlas-encompassed-1',
    );
  });

  it('does not serve one language in place of another', () => {
    // Both pairs are in CLDR's language-dimension data, inside its default threshold, and neither is
    // in the table: `da`/`no` is 8 and `af`/`en` is 20, and they say what a reader will accept, not
    // what their language is. Danish is not Norwegian and Afrikaans is not English.
    expect(negotiateLocale(['da'], ['nb-NO'], canonicalize)).toBeUndefined();
    expect(negotiateLocale(['af'], ['en-GB'], canonicalize)).toBeUndefined();
  });
});
