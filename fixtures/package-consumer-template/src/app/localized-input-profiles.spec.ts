import { describe, expect, it } from 'vitest';

import { Component, InjectionToken, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import {
  Localization,
  decimal,
  duration,
  instant,
  measurement,
  money,
  percent,
  percentagePoints,
  plainDate,
  plainDateTime,
  plainTime,
  provideLocalizationSetup,
  timeZone,
  type LocalizedInputProfile,
} from '@neolorn/atlas';
import { LocalizedInput } from '@neolorn/atlas/forms';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * Every `LocalizedInputProfile` kind, driven through the published `/forms` directive.
 *
 * `/forms` was recorded as never exercised by a consumer. That was
 * wrong, this application's own percent field has used it since it was written, but the
 * narrower fact was true, and worse for being specific: **one of eleven profile kinds had any
 * consumer-level evidence.** `LocalizedInput` is one of the places Atlas is ahead of the field, and
 * ten of its eleven kinds shipped on unit tests alone.
 *
 * What is asserted is a round trip, not a per-locale expected string. Pinning "١٬٢٣٤٫٥" for
 * ar-EG would pin one ICU version's output and turn every ICU bump into a failure nobody can tell
 * from a regression: the same mistake as checking plural categories against the host `Intl`.
 * What must hold in every ICU version is that **whatever the field renders parses back to the
 * value it rendered**, and that re-rendering that parse in the original locale returns the original
 * text exactly.
 *
 * `formatLocalizedInput` already verifies its own round trip internally and refuses to format when
 * it fails, so the claim being added here is not "the formatter round-trips". It is the consumer
 * one: that the *directive* wires format and parse together correctly, in a real reactive form,
 * against the built package, across a real locale change. No unit test makes that claim, and a
 * formatter that refused to format would show up here as an empty field.
 *
 * ar-EG is not decoration. It is where a renderer and a parser most easily disagree: Arabic-Indic
 * digits, a different decimal separator, a different group separator, and RTL. A field that renders
 * localized and parses en-US-only passes every en-US test and fails the second half of every test
 * below.
 *
 * The rejected-input step is what keeps the rest from passing vacuously. A directive that never
 * parsed would leave the control holding its original value and report no errors, which is exactly
 * what a successful round trip looks like from the outside.
 */

interface ProfileCase {
  readonly name: string;
  readonly profile: LocalizedInputProfile;
  readonly value: unknown;
}

const PROFILE_CASE = new InjectionToken<ProfileCase>('atlas.test.profile-case');

/**
 * The profile and the value arrive through the injector rather than through inputs set after
 * construction, because `localizedInput` is a required input: anything set after the first
 * change detection is set after the directive has already rendered once.
 */
@Component({
  imports: [LocalizedInput, ReactiveFormsModule],
  template: `<input
    data-profile-input
    [formControl]="control"
    [localizedInput]="profile"
  />`,
})
class ProfileHost {
  private readonly profileCase = inject(PROFILE_CASE);
  protected readonly profile = this.profileCase.profile;
  readonly control = new FormControl<unknown>(this.profileCase.value, {
    nonNullable: true,
  });
}

/** Nanoseconds since the epoch, as `instant` takes them, rather than a magic literal. */
const epochNanoseconds = (utcMilliseconds: number): string =>
  `${BigInt(utcMilliseconds) * 1_000_000n}`;

/**
 * Text that no profile can accept: not a number in any numbering system, not a label in the
 * time-zone profile's option list, not a date, a time, a duration or an RFC 3339 instant.
 */
const REJECTED = 'zzz zzz';

const cases: readonly ProfileCase[] = [
  {
    name: 'decimal',
    profile: { kind: 'decimal', maximumFractionDigits: 2 },
    value: decimal('1234.5'),
  },
  {
    // `requireCurrency` so the currency has to survive the trip too. Intl separates the code from
    // the amount with U+00A0, which is one of the characters a hand-written parser drops.
    name: 'money',
    profile: { kind: 'money', currency: 'EGP', requireCurrency: true },
    value: money(decimal('1234.5'), 'EGP'),
  },
  {
    name: 'measurement',
    profile: { kind: 'measurement', unit: 'kilometer', requireUnit: true },
    value: measurement(decimal('12.5'), 'kilometer'),
  },
  {
    // The one kind that already had consumer evidence, kept so the eleven are read as one set.
    name: 'percent',
    profile: {
      kind: 'percent',
      scale: 'fractional',
      requirePercentSign: true,
      maximumFractionDigits: 2,
    },
    value: percent(decimal('0.25')),
  },
  {
    name: 'percentage-points',
    profile: { kind: 'percentage-points', maximumFractionDigits: 2 },
    value: percentagePoints(decimal('1.5')),
  },
  {
    name: 'plain-date',
    profile: { kind: 'plain-date', order: 'year-month-day', separator: '-' },
    value: plainDate(2026, 8, 26),
  },
  {
    name: 'plain-time',
    profile: {
      kind: 'plain-time',
      hourCycle: 'h23',
      precision: 'minute',
      separator: ':',
    },
    value: plainTime(14, 30),
  },
  {
    name: 'plain-date-time',
    profile: {
      kind: 'plain-date-time',
      date: { order: 'year-month-day', separator: '-' },
      time: { hourCycle: 'h23', precision: 'minute', separator: ':' },
      separator: ' ',
    },
    value: plainDateTime(plainDate(2026, 8, 26), plainTime(14, 30)),
  },
  {
    // Two labels per zone, one per locale, which is how a consumer would offer a zone picker that
    // reads naturally in both. Both must be accepted in both locales: a visitor who switches
    // locale mid-form has whichever label was already in the field.
    name: 'time-zone',
    profile: {
      kind: 'time-zone',
      options: [
        { timeZone: 'Africa/Cairo', labels: ['Cairo', 'القاهرة'] },
        { timeZone: 'Europe/Lisbon', labels: ['Lisbon', 'لشبونة'] },
      ],
    },
    value: timeZone('Africa/Cairo'),
  },
  {
    name: 'duration',
    profile: {
      kind: 'duration',
      pattern: [
        { field: 'hours' },
        ':',
        { field: 'minutes', minimumIntegerDigits: 2 },
      ],
    },
    value: duration({ hours: 2, minutes: 30 }),
  },
  {
    // RFC 3339 is deliberately locale-independent, so its two halves must render identically. That
    // is the assertion worth having: a syntax that is not supposed to localize, proven not to.
    name: 'instant',
    profile: { kind: 'instant', syntax: 'rfc3339' },
    value: instant(epochNanoseconds(Date.UTC(2026, 7, 26, 14, 30))),
  },
];

async function mount(profileCase: ProfileCase) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PROFILE_CASE, useValue: profileCase },
      provideLocalizationSetup({
        configuration,
        catalogSet,
        catalogLoaders,
        recoveryPayload,
        extensions: atlasRuntimeExtensions,
      }),
    ],
  });
  const localization = TestBed.inject(Localization);
  await localization.initialize();

  const fixture = TestBed.createComponent(ProfileHost);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  const input = (fixture.nativeElement as HTMLElement).querySelector(
    '[data-profile-input]',
  ) as HTMLInputElement;
  return {
    fixture,
    input,
    localization,
    control: fixture.componentInstance.control,
  };
}

describe('every LocalizedInputProfile kind round-trips through the published directive', () => {
  for (const profileCase of cases) {
    it(`renders, re-parses and re-renders a ${profileCase.name} value across a locale change`, async () => {
      const { fixture, input, localization, control } =
        await mount(profileCase);

      // An empty field is how a refused format presents itself: the directive clears the element
      // and reports policy-rejected. Without this the round trip would pass on empty in, empty out.
      const englishText = input.value;
      expect(englishText).not.toBe('');
      expect(control.errors).toBeNull();

      const retype = (text: string) => {
        input.value = text;
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
      };

      // The field's own rendering, fed back as if a person had typed it.
      retype(englishText);
      expect(control.errors).toBeNull();
      expect(control.value).toEqual(profileCase.value);

      // Without this the two round-trip assertions above would also hold for a directive that
      // never parsed anything at all.
      retype(REJECTED);
      expect(control.errors?.['localizedInput']).toMatchObject({
        code: expect.stringMatching(/^atlas\.input\./u),
      });
      expect(control.value).toEqual(profileCase.value);
      retype(englishText);
      expect(control.errors).toBeNull();

      await localization.changeLocale('ar-EG');
      await fixture.whenStable();
      fixture.detectChanges();

      // What the field now says is the locale's business, not this test's. What is asserted is
      // that it says something, and that it parses back, which is what breaks when a renderer is
      // localized and its parser is not.
      const arabicText = input.value;
      expect(arabicText).not.toBe('');
      retype(arabicText);
      expect(control.errors).toBeNull();
      expect(control.value).toEqual(profileCase.value);

      await localization.changeLocale('en-US');
      await fixture.whenStable();
      fixture.detectChanges();

      // The fixed point: rendering the value parsed out of Arabic text returns the original English
      // text character for character. Any information lost anywhere in the loop shows up here.
      expect(input.value).toBe(englishText);
    });
  }

  it('renders an instant identically in both locales, because RFC 3339 does not localize', async () => {
    const rfc3339 = cases.find(
      (entry) => entry.name === 'instant',
    ) as ProfileCase;
    const { fixture, input, localization } = await mount(rfc3339);
    const englishText = input.value;

    await localization.changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(input.value).toBe(englishText);
    expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });

  it('localizes the digits of a decimal field, so the round trip above is not a no-op', async () => {
    // The guard on the ar-EG half of every test: if ar-EG rendered Latin digits, that half would
    // re-assert the en-US half and prove nothing. This does not pin the rendering: only that the
    // two differ, which is the property the round trip depends on.
    const decimalCase = cases.find(
      (entry) => entry.name === 'decimal',
    ) as ProfileCase;
    const { fixture, input, localization } = await mount(decimalCase);
    const englishText = input.value;

    await localization.changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(input.value).not.toBe(englishText);
  });
});
