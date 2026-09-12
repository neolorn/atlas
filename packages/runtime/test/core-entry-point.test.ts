import { describe, expect, it } from 'vitest';

import {
  LocalizationError,
  directionForLocale,
  localeProfile,
  validateRouteProjection,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * The three exports the core split published, exercised rather than waived.
 *
 * `directionForLocale`, `localeProfile` and `validateRouteProjection` were internal to the primary
 * before the Angular-free core became its own entry point. They are published now because the
 * primary imports them across an entry-point boundary, and anything it needs from the core has to
 * be on the core's public surface: that is the cost of the split, and it is three symbols.
 *
 * `verify-export-surface.mjs` refused them for being named by no consumer, gate or test, which is
 * the correct answer: a published export nothing reaches is one nothing has checked. Adding them to
 * the accepted baseline would have silenced the gate without answering it. All three are reasonable
 * API on their own terms (a locale's writing direction, its profile, and validation of a generated
 * projection) so they are reached here instead.
 *
 * **`localeProfile` was the third symbol and it was not here, because the gate could not see that it
 * was missing.** It read as `structural` on an occurrence count taken over declaration text that
 * still had its documentation in it, and the `{@link localeProfile}` in the comment above
 * `directionForLocale` was enough to lift it over the floor. So a published function reached its
 * shipping state with no test anywhere, and the check written to catch exactly that reported it as
 * fine. The count now runs over signatures with the comments stripped, which is what made this
 * visible.
 */

const VALID: RouteRuntimeProjection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: 'sha256-AtlasBuiltLocaleAddressesTestIdentity012345',
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'route:second', path: 'second', parameterNames: [] },
    ],
  },
  localizedPaths: { 'route:second': { 'en-US': 'second', 'ar-EG': 'second' } },
};

describe('a locale writing direction', () => {
  it('answers for locales whose script Atlas knows in either direction', () => {
    expect(directionForLocale('ar-EG')).toBe('rtl');
    expect(directionForLocale('he-IL')).toBe('rtl');
    expect(directionForLocale('en-US')).toBe('ltr');
    expect(directionForLocale('ja-JP')).toBe('ltr');
  });

  it('falls back to ltr rather than throwing on a tag it cannot profile', () => {
    // The caller is laying out a page. There is no useful way to fail here, so it does not.
    expect(directionForLocale('not a locale')).toBe('ltr');
  });
});

describe('a locale profile', () => {
  it('fills in the script and region CLDR considers likely, and keeps the tag it was asked about', () => {
    // `he` carries neither a script nor a region, and both come back. `locale` does not: it is the
    // tag the caller passed, canonicalized and no more. A profile that answered `he-Hebr-IL` there
    // would be telling the caller they asked something they did not, and the two fields together
    // are what let a caller render `he` and still lay it out right-to-left.
    expect(localeProfile('he')).toEqual({
      locale: 'he',
      language: 'he',
      script: 'Hebr',
      region: 'IL',
      direction: 'rtl',
    });
  });

  it('takes an explicit script over the likely one', () => {
    // Serbian is the case where this is not academic: written in Latin it is the same language,
    // the same region and a different script, and only the tag says which. A profile that
    // maximized unconditionally would answer `Cyrl` for both.
    expect(localeProfile('sr-Latn-RS').script).toBe('Latn');
    expect(localeProfile('sr-RS').script).toBe('Cyrl');
  });

  it('reads direction from the script rather than from the language or the region', () => {
    // Urdu is Arabic-script in Pakistan, which is the pair that catches a direction table keyed by
    // language or by region rather than by script.
    expect(localeProfile('ur').script).toBe('Arab');
    expect(localeProfile('ur').direction).toBe('rtl');
    expect(localeProfile('ar-EG').direction).toBe('rtl');
    expect(localeProfile('ja').direction).toBe('ltr');
  });

  it('throws where directionForLocale answers, and the difference is the point', () => {
    // These two sit beside each other in one file and disagree on the same input by design: a
    // caller laying out a page cannot use an exception, and a caller asking for a profile cannot
    // use a guess. Asserted together, because the pair is what a consumer gets wrong.
    expect(() => localeProfile('not a locale')).toThrow(RangeError);
    expect(directionForLocale('not a locale')).toBe('ltr');
    // A well-formed tag CLDR has no likely script for. It reaches Atlas's own error rather than
    // Intl's, and it is the one place this function throws something it wrote itself.
    expect(() => localeProfile('xx')).toThrow('has no likely script');
    expect(directionForLocale('xx')).toBe('ltr');
  });

  it('gives `und` the language subtag both standards say it has', () => {
    // `undefined` here, in a field typed `string` and not optional, is not answered by widening
    // the type. Two sources, and neither leaves room for an absence:
    //
    // - the pinned IANA registry, `language-subtag-registry-2026-06-14.txt`: "Type: language,
    //   Subtag: und, Description: Undetermined, Added: 2005-10-16, Scope: special". It is a
    //   registered language subtag, and UTS 35 48.2's `unicode_language_subtag = alpha{2,3} |
    //   alpha{5,8}` matches it;
    // - ECMA-402, `get Intl.Locale.prototype.language`: "Return GetLocaleLanguage(loc.[[Locale]])",
    //   which is "Let baseName be GetLocaleBaseName(locale) ... Return the first subtag of
    //   baseName", after asserting that subtag matches `unicode_language_subtag`.
    //
    // So the engine is the side that is wrong, and it says so itself below.
    const undetermined = localeProfile('und');
    expect(undetermined.language).toBe('und');
    expect(undetermined.script).toBe('Latn');
    expect(undetermined.direction).toBe('ltr');

    // The engine's own two answers, which cannot both be right: `language` is specified as the
    // first subtag of this exact `baseName`. Pinned deliberately: the day an engine in the
    // supported matrix returns 'und' here, this goes red and the derivation above can go with it.
    expect(new Intl.Locale('und').baseName).toBe('und');
    expect(new Intl.Locale('und').language).toBeUndefined();

    // Not one tag. Every tag built on `und` was affected, and this is the one where the wrong
    // answer was visible: an undetermined language written in Arabic script, reading right to left.
    const arabicScript = localeProfile('und-Arab-EG');
    expect(arabicScript.language).toBe('und');
    expect(arabicScript.script).toBe('Arab');
    expect(arabicScript.direction).toBe('rtl');
  });
});

describe('validating a generated route projection', () => {
  it('returns the projection it was given when the projection is sound', () => {
    expect(validateRouteProjection(VALID)).toBe(VALID);
  });

  it('refuses a projection whose identity is not a sha256 digest', () => {
    expect(() =>
      validateRouteProjection({
        ...VALID,
        generated: { ...VALID.generated, identity: 'sha256-short' },
      }),
    ).toThrow(LocalizationError);
  });

  it('refuses two routes claiming the same address', () => {
    expect(() =>
      validateRouteProjection({
        ...VALID,
        generated: {
          ...VALID.generated,
          routes: [
            { id: 'route:a', path: 'same', parameterNames: [] },
            { id: 'route:b', path: 'same', parameterNames: [] },
          ],
        },
      }),
    ).toThrow(LocalizationError);
  });
});

/**
 * And the property the whole split exists for, asserted where a unit test can see it: the error the
 * core throws is the error the rest of Atlas tests against. Two copies of `contracts.ts` would make
 * this pass in isolation and fail in a consumer, so `verify-package-structure.mjs` checks the built
 * bundles too: this is the cheap half of that pair, not a replacement for it.
 */
describe('the identity of the error the core throws', () => {
  it('is the same class the primary compares against', () => {
    try {
      validateRouteProjection({
        ...VALID,
        generated: { ...VALID.generated, identity: 'not-a-digest' },
      });
      expect.unreachable('validateRouteProjection should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LocalizationError);
      expect((error as LocalizationError).diagnostic.message).toContain(
        'projection',
      );
    }
  });
});
