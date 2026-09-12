import { describe, expect, it, beforeEach } from 'vitest';

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
import { messages, providerId, scopeId } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * Formatted placeholders, pinned to exact output.
 *
 * Eight Intl-backed formatters reached the gate through a single `text.length > 0` assertion, so
 * nothing pinned what they produced. That is not a hypothetical weakness: it let
 * `formatPlainDate` render "2026  14" for a medium date, month silently missing, in every locale,
 * without any test noticing.
 *
 * A formatted placeholder such as `{$seconds :number}` is ordinary in production catalogs, a
 * retry countdown on an error page is enough to reach it, so this path is not a corner.
 *
 * Every expectation below is an exact string. `toContain` and non-empty checks are what allowed
 * the missing month through, and are deliberately not used.
 */

const shellScope = { providerId, scopeId } as const;
const ZONE = 'Africa/Cairo';

/**
 * An interpolated value as it appears in a right-to-left message: wrapped in RLI…PDI so it cannot
 * reposition the text around it. Written as a helper rather than inline, because two invisible
 * characters in an expectation are unreadable in a diff.
 *
 * RLI rather than FSI because a formatted number, unit or date has a direction that is known: it is
 * the direction of the locale that formatted it. FSI is for a value whose direction nothing knows,
 * and asking the characters is not the same as knowing: a formatted Arabic number that happens to
 * begin with a digit would be sniffed as left-to-right and isolated as the wrong thing.
 */
const ISOLATED = (value: string) => `\u2067${value}\u2069`;

/**
 * Intl separates a currency code from its amount with U+00A0, not a space. Named here
 * because the two are indistinguishable in a diff, and because embedding the raw character
 * in an expectation makes the test unreviewable.
 */
const NBSP = '\u00A0';

/** 2026-03-14T13:45:00Z, which is 15:45 in Africa/Cairo. */
const INSTANT = new Date(Date.UTC(2026, 2, 14, 13, 45));

function setup(): Localization {
  TestBed.configureTestingModule({
    providers: [
      provideLocalizationSetup(
        {
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
        },
        withFormattingContext({ timeZone: ZONE }),
      ),
    ],
  });
  return TestBed.inject(Localization);
}

describe('formatted placeholders', () => {
  let localization: Localization;

  beforeEach(async () => {
    localization = setup();
    await localization.initialize();
  });

  describe('en-US', () => {
    it('formats numeric placeholders exactly', () => {
      expect(localization.text(messages.fmt.number, { v: 1234.5 })).toBe(
        'Count 1,234.5',
      );
      expect(localization.text(messages.fmt.integer, { v: 1234 })).toBe(
        'Items 1,234',
      );
      expect(localization.text(messages.fmt.percent, { v: 0.256 })).toBe(
        'Share 26%',
      );
      // The separator after the currency code is U+00A0, not a space. Written explicitly because
      // the two are indistinguishable in a diff, and because a `toContain` assertion would not
      // have noticed either way.
      expect(localization.text(messages.fmt.currency, { v: 1234.5 })).toBe(
        `Price EGP${NBSP}1,234.50`,
      );
      expect(localization.text(messages.fmt.unit, { v: 12 })).toBe('Size 12 m');
    });

    it('formats a date with its month present', () => {
      // The regression this pins: an iso8601 calendar forwarded to Intl has no localized month
      // names, so this rendered "On 2026  14" until the calendar handling was corrected.
      expect(localization.text(messages.fmt.date, { v: INSTANT })).toBe(
        'On Mar 14, 2026',
      );
      expect(localization.text(messages.fmt.datetime, { v: INSTANT })).toBe(
        'When Mar 14, 2026, 3:45 PM',
      );
    });

    it('formats a time in the configured zone rather than the host zone', () => {
      // 13:45Z is 15:45 in Africa/Cairo. A host-zone leak would show a different hour and is the
      // failure this pins.
      expect(localization.text(messages.fmt.time, { v: INSTANT })).toBe(
        'At 3:45 PM',
      );
    });
  });

  describe('ar-EG', () => {
    beforeEach(async () => {
      await localization.changeLocale('ar-EG');
    });

    it('formats numeric placeholders exactly', () => {
      // Interpolated values in a right-to-left message are isolated, so a number or a Latin run
      // cannot reposition the Arabic around it. ISOLATED marks where that wrapping falls.
      expect(localization.text(messages.fmt.number, { v: 1234.5 })).toBe(
        `العدد ${ISOLATED('١٬٢٣٤٫٥')}`,
      );
      expect(localization.text(messages.fmt.integer, { v: 1234 })).toBe(
        `العناصر ${ISOLATED('١٬٢٣٤')}`,
      );
      expect(localization.text(messages.fmt.unit, { v: 12 })).toBe(
        `المقاس ${ISOLATED('١٢ مترًا')}`,
      );
    });

    it('formats a date with its month present', () => {
      expect(localization.text(messages.fmt.date, { v: INSTANT })).toBe(
        `في ${ISOLATED('١٤ مارس ٢٠٢٦')}`,
      );
    });

    it('renders Arabic-Indic digits when no numbering system is configured', () => {
      // Recorded because it is a decision, not an accident: ar-EG resolves to the `arab`
      // numbering system unless a consumer sets one. A consumer that wants Latin digits in Arabic
      // has to configure `latn` deliberately; one that does not will get these digits.
      const rendered = localization.text(messages.fmt.number, { v: 1234.5 });
      expect(rendered).toContain('١');
      expect(rendered).not.toContain('1');
    });
  });

  it('rejects a temporal input that is not a Date or epoch value', () => {
    // Worth knowing when authoring: `:date` and friends validate against the compiled contract's
    // `date-time` type, which accepts a Date or a finite number. Atlas's own canonical temporal
    // values, plainDate() and instant(), are not accepted as message inputs and are for the direct
    // formatting API instead.
    expect(() =>
      localization.text(messages.fmt.date, {
        v: '2026-03-14' as unknown as Date,
      }),
    ).toThrow();
  });
});
