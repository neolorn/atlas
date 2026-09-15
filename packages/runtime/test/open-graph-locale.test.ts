import { describe, expect, it } from 'vitest';

import { openGraphLocale } from '@neolorn/atlas/core';

/**
 * The failure mode, pinned.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 13 is the rule: the format's own
 * underscore spelling, the territory from the maximized profile, no script subtag, and no value
 * at all where no territory can be determined, because a reader of the markup cannot tell a
 * malformed value from a territory it does not recognize.
 *
 * The way this gets written wrong is emitting the runtime locale unchanged, so an Arabic
 * Egyptian page says `ar-EG`. That is valid BCP 47, it is what every other locale-shaped field
 * in the document holds, and it is not what ogp.me specifies: "Of the format
 * `language_TERRITORY`". A test that only checked `ar_EG` would pass for an implementation that
 * replaced hyphens with underscores and nothing else, so the script and no-territory cases are here
 * too; those are the ones a `replace('-', '_')` gets wrong.
 */
describe('a locale in Open Graph spelling', () => {
  it('uses the underscore form rather than the BCP 47 tag', () => {
    expect(openGraphLocale('ar-EG')).toBe('ar_EG');
    expect(openGraphLocale('en-US')).toBe('en_US');
    // The thing that must not happen.
    expect(openGraphLocale('ar-EG')).not.toBe('ar-EG');
  });

  it('supplies the territory when the tag omits one', () => {
    // `ar` names one locale; CLDR's likely-subtags says which. Refusing to answer would drop a
    // correct tag for pedantry.
    expect(openGraphLocale('ar')).toBe('ar_EG');
    expect(openGraphLocale('ja')).toBe('ja_JP');
  });

  it('drops the script, because the field has nowhere to put it', () => {
    // A hyphen-to-underscore replacement answers `zh_Hans_CN` here, which is not the specified
    // two-part form.
    expect(openGraphLocale('zh-Hans-CN')).toBe('zh_CN');
    expect(openGraphLocale('sr-Cyrl-RS')).toBe('sr_RS');
  });

  it('answers nothing rather than something malformed', () => {
    // A value the profile cannot resolve at all. `zh` alone maximizes to a territory, so the case
    // that matters here is the tag Atlas cannot profile.
    expect(openGraphLocale('not a locale')).toBeUndefined();
    expect(openGraphLocale('')).toBeUndefined();
  });

  it('agrees with the locales the rest of Atlas uses', () => {
    // Checked against tags the routing tests use, not against tags chosen to make it pass: a case
    // drawn from its own subject agrees with it whatever the subject does.
    for (const locale of ['en-US', 'ar-EG']) {
      const spelled = openGraphLocale(locale);
      expect(spelled).toMatch(/^[a-z]{2,3}_[A-Z]{2}$/u);
      expect(spelled).toBe(locale.replace('-', '_'));
    }
  });
});
