import { describe, expect, it } from 'vitest';

import {
  LOCALE_DATA_PROFILE,
  languagePresentation,
  localeMetadata,
  resolveTypography,
} from '@neolorn/atlas';

describe('pinned locale-direction profile', () => {
  it('binds runtime direction metadata to CLDR and Unicode script semantics', () => {
    // The profile names both sources because the direction data now comes from both: locale
    // direction from CLDR's script metadata, and the strong right-to-left character class from the
    // Unicode character database's Bidi_Class rather than from a script membership test.
    expect(LOCALE_DATA_PROFILE).toBe('cldr-48.2+unicode-17.0/atlas-rtl-bidi-1');

    for (const [locale, direction] of [
      ['ar-EG', 'rtl'],
      ['az-Arab', 'rtl'],
      ['az-Latn', 'ltr'],
      ['ff-Adlm', 'rtl'],
      ['ff-Latn', 'ltr'],
      ['pa-Arab', 'rtl'],
      ['pa-Guru', 'ltr'],
      ['und-Hebr', 'rtl'],
      ['und-Latn', 'ltr'],
    ] as const) {
      expect(languagePresentation(locale)).toMatchObject({ direction });
      expect(localeMetadata(locale)).toMatchObject({
        ok: true,
        value: { direction },
      });
    }
  });

  it('uses the same maximized script for typography and exposed metadata', () => {
    const registry = Object.freeze({
      default: Object.freeze({ id: 'default' }),
      scripts: Object.freeze({
        Adlm: Object.freeze({ id: 'adlam' }),
        Arab: Object.freeze({ id: 'arabic' }),
        Latn: Object.freeze({ id: 'latin' }),
      }),
    });

    expect(resolveTypography('ff-Adlm', registry)).toEqual({ id: 'adlam' });
    expect(resolveTypography('az-Arab', registry)).toEqual({ id: 'arabic' });
    expect(resolveTypography('az-Latn', registry)).toEqual({ id: 'latin' });
    expect(localeMetadata('ff-Adlm')).toMatchObject({
      ok: true,
      value: { language: 'ff', script: 'Adlm', direction: 'rtl' },
    });
  });
});
