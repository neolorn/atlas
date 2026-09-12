import { describe, expect, it } from 'vitest';

import { TestBed } from '@angular/core/testing';
import {
  Localization,
  provideLocalizationSetup,
  withFormattingContext,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { messages } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * Is a locale written the way that locale declares?
 *
 * How a language is written is a fact about that language. One application-wide context could not
 * say that `ar-EG` is written in `arab` while `fa-IR` is written in `arabext`, so an application
 * that wanted Western digits on its Arabic pages had to want them everywhere, and the decision that
 * says otherwise had nowhere to be made. Resolution is three layers now: the application-wide
 * context, then the locale's own entry in the generated configuration, then, for whatever neither
 * sets, CLDR's answer for that locale.
 *
 * **The table is built here rather than declared in `atlas.config.json`, and that is deliberate.**
 * Nine specs in this lab assert digits in `en-US` or `ar-EG`; a declaration in the shared
 * configuration would have made every one of them pass or fail for a reason it was not written for,
 * including the two that pin `ar-EG` precisely: one with no context at all, one with the
 * application's own. What that split leaves out is the channel from the file to the generated
 * module, and that is asserted where it lives:
 * `packages/toolkit/test/locale-formatting-declaration.test.ts` writes the key, generates, and
 * reads the emitted `configuration`. The gate's own consumer declares one too, for a pseudo-locale,
 * because a locale that exists in one build and not the other is the case that has to hold.
 *
 * The table still goes through the runtime's admission check exactly as a generated one does: a key
 * naming a locale this application does not serve is refused there, not here.
 */

const ARABIC_INDIC = /[٠-٩]/u;
const LATIN_DIGIT = /[0-9]/u;

interface Declaration {
  readonly applicationWide?: { readonly numberingSystem: string };
  readonly perLocale?: Readonly<
    Record<string, { readonly numberingSystem: string }>
  >;
}

async function rendered(
  locale: string,
  declaration: Declaration,
): Promise<string> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideLocalizationSetup(
        {
          configuration:
            declaration.perLocale === undefined
              ? configuration
              : { ...configuration, formatting: declaration.perLocale },
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
        },
        ...(declaration.applicationWide === undefined
          ? []
          : [withFormattingContext(declaration.applicationWide)]),
      ),
    ],
  });
  const localization = TestBed.inject(Localization);
  await localization.initialize();
  if (locale !== configuration.defaultLocale) {
    await localization.changeLocale(locale);
  }
  return localization.text(messages.fmt.number, { v: 1234.5 });
}

describe('a locale is written the way that locale declares', () => {
  it('gives each locale its own system, crossed so neither can pass by accident', async () => {
    // English in Arabic-Indic digits and Arabic in Western ones: each locale in the digits the
    // other one defaults to, with no application-wide context at all. A runtime that ignored the
    // table would render the exact opposite pair; one that applied a single entry to everything
    // would render both alike.
    const declaration = {
      perLocale: {
        'en-US': { numberingSystem: 'arab' },
        'ar-EG': { numberingSystem: 'latn' },
      },
    } as const;
    const english = await rendered('en-US', declaration);
    expect(english).toMatch(ARABIC_INDIC);
    expect(english).not.toMatch(LATIN_DIGIT);

    const arabic = await rendered('ar-EG', declaration);
    expect(arabic).toMatch(LATIN_DIGIT);
    expect(arabic).not.toMatch(ARABIC_INDIC);
    // And the locale itself did not move with the digits: a runtime that answered in English would
    // satisfy the assertion above and be wrong.
    expect(arabic).toMatch(/\p{Script=Arabic}/u);
  });

  it("overrides the application's default for the locale that declared it", async () => {
    const declaration = {
      applicationWide: { numberingSystem: 'latn' },
      perLocale: { 'ar-EG': { numberingSystem: 'arab' } },
    } as const;
    // Non-vacuous in both directions: `latn` is not what `ar-EG` would take from the
    // application-wide context, and `arab` is not what `en-US` would take from CLDR.
    expect(await rendered('ar-EG', declaration)).toMatch(ARABIC_INDIC);
    expect(await rendered('en-US', declaration)).not.toMatch(ARABIC_INDIC);
  });

  it('leaves a locale that declares nothing on the application default', async () => {
    // The control this needs: it is the single-context behaviour, and it holds whether
    // or not the per-locale layer exists.
    const declaration = {
      applicationWide: { numberingSystem: 'latn' },
    } as const;
    const arabic = await rendered('ar-EG', declaration);
    expect(arabic).toMatch(LATIN_DIGIT);
    expect(arabic).not.toMatch(ARABIC_INDIC);
  });

  it('is asserting against locales whose own defaults are the opposite', () => {
    // Read from the platform rather than stated. If CLDR ever made `arab` the default for `en-US`
    // or `latn` the default for `ar-EG`, the cases above would still pass while proving nothing,
    // and this is what notices.
    expect(
      new Intl.NumberFormat('en-US').resolvedOptions().numberingSystem,
    ).toBe('latn');
    expect(
      new Intl.NumberFormat('ar-EG').resolvedOptions().numberingSystem,
    ).toBe('arab');
  });
});
