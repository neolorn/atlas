import { describe, expect, it, beforeEach } from 'vitest';

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Localization,
  LocalizedDecimalPipe,
  LocalizedDurationPipe,
  LocalizedInstantPipe,
  LocalizedMeasurementPipe,
  LocalizedMoneyPipe,
  LocalizedPercentPipe,
  LocalizedPercentagePointsPipe,
  LocalizedPlainDatePipe,
  LocalizedPlainDateTimePipe,
  LocalizedPlainTimePipe,
  LocalizedZonedDateTimePipe,
  RUNTIME_EVENT_CODES,
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
  withFormattingContext,
  withObservability,
  zonedDateTime,
  type LocalizationObservabilityEvent,
  type LocalizationObservabilitySink,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * One pipe per canonical value kind, in both locales, and what a failure puts on the page.
 *
 * A pipe is a second spelling of a facade call, so the two things the spelling can get wrong are
 * what this asserts: whether the output follows the locale the runtime has committed rather than
 * the one the pipe first saw, and what a reader is shown when the formatter reports instead of
 * succeeding.
 *
 * No numbering system is declared here, so each locale takes its own: `en-US` resolves to `latn`
 * and `ar-EG` to `arab`. That is what makes the Arabic pass non-vacuous. A pipe that kept the first
 * snapshot would still be rendering Western digits after the locale moved.
 *
 * The failure is deliberate and deterministic rather than stubbed. A decimal carrying more
 * significant digits than a double holds cannot reach the native formatter without losing
 * precision, and `specs/08-formatting-parsing-and-domain.spec.md` section 3 forbids approximating
 * it, so the formatter reports an unsupported capability. A template is the wrong place to catch,
 * so the pipe renders nothing and the diagnostic goes to the observability sink.
 */

const DATE = Object.freeze({ dateStyle: 'medium' } as const);
const TIME = Object.freeze({ timeStyle: 'short' } as const);
const DATE_TIME = Object.freeze({
  dateStyle: 'medium',
  timeStyle: 'short',
} as const);

/** 2026-03-14T09:30:00Z, so every date and time kind describes the same moment. */
const EPOCH_NANOSECONDS = '1773480600000000000';

const ARABIC_INDIC = /[٠-٩]/u;
const LATIN_DIGIT = /[0-9]/u;

@Component({
  selector: 'formatting-host',
  imports: [
    LocalizedDecimalPipe,
    LocalizedDurationPipe,
    LocalizedInstantPipe,
    LocalizedMeasurementPipe,
    LocalizedMoneyPipe,
    LocalizedPercentPipe,
    LocalizedPercentagePointsPipe,
    LocalizedPlainDatePipe,
    LocalizedPlainDateTimePipe,
    LocalizedPlainTimePipe,
    LocalizedZonedDateTimePipe,
  ],
  template: `
    <p data-decimal>{{ amount | localizedDecimal }}</p>
    <p data-money>{{ price | localizedMoney }}</p>
    <p data-measurement>{{ distance | localizedMeasurement }}</p>
    <p data-percent>{{ share | localizedPercent }}</p>
    <p data-percentage-points>{{ movement | localizedPercentagePoints }}</p>
    <p data-instant>{{ moment | localizedInstant: dateTimeOptions }}</p>
    <p data-plain-date>{{ day | localizedPlainDate: dateOptions }}</p>
    <p data-plain-time>{{ clock | localizedPlainTime: timeOptions }}</p>
    <p data-plain-date-time>
      {{ stamp | localizedPlainDateTime: dateTimeOptions }}
    </p>
    <p data-zoned-date-time>
      {{ zoned | localizedZonedDateTime: dateTimeOptions }}
    </p>
    <p data-duration>{{ span | localizedDuration }}</p>
    <p data-unformattable>{{ tooPrecise | localizedDecimal }}</p>
  `,
})
class FormattingHost {
  /**
   * Held in fields rather than written inline.
   *
   * An options object written into a binding is a new identity on every change detection and
   * defeats the memo, which is the one thing an impure pipe has to get right.
   */
  protected readonly dateOptions = DATE;
  protected readonly timeOptions = TIME;
  protected readonly dateTimeOptions = DATE_TIME;

  protected readonly amount = decimal('1234.5');
  protected readonly price = money(decimal('19.99'), 'USD');
  protected readonly distance = measurement(decimal('3.5'), 'kilometer');
  protected readonly share = percent(decimal('0.15'));
  protected readonly movement = percentagePoints(decimal('2.5'));
  protected readonly moment = instant(EPOCH_NANOSECONDS);
  protected readonly day = plainDate(2026, 3, 14);
  protected readonly clock = plainTime(9, 30);
  protected readonly stamp = plainDateTime(
    plainDate(2026, 3, 14),
    plainTime(9, 30),
  );
  protected readonly zoned = zonedDateTime(instant(EPOCH_NANOSECONDS), 'UTC');
  protected readonly span = duration({ hours: 2, minutes: 30 });

  /** More significant digits than a double holds, so the formatter reports rather than rounds. */
  protected readonly tooPrecise = decimal('0.12345678901234567890123');
}

const events: LocalizationObservabilityEvent[] = [];

const sink: LocalizationObservabilitySink = Object.freeze({
  emit: (event: LocalizationObservabilityEvent): void => {
    events.push(event);
  },
});

const NUMERIC_MARKERS = [
  'data-decimal',
  'data-money',
  'data-measurement',
  'data-percent',
  'data-percentage-points',
  'data-instant',
  'data-plain-date',
  'data-plain-time',
  'data-plain-date-time',
  'data-zoned-date-time',
  'data-duration',
] as const;

function setup(): Localization {
  events.length = 0;
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
        withFormattingContext({ timeZone: 'UTC' }),
        withObservability(sink),
      ),
    ],
  });
  return TestBed.inject(Localization);
}

function textOf(fixture: { nativeElement: unknown }, marker: string): string {
  const host = fixture.nativeElement as HTMLElement;
  return host.querySelector(`[${marker}]`)?.textContent?.trim() ?? '';
}

describe('a formatting pipe for each canonical value kind', () => {
  let localization: Localization;

  beforeEach(async () => {
    localization = setup();
    await localization.initialize();
  });

  it('writes every kind the way the reader of the default locale writes it', async () => {
    const fixture = TestBed.createComponent(FormattingHost);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(textOf(fixture, 'data-decimal')).toBe('1,234.5');
    expect(textOf(fixture, 'data-money')).toBe('$19.99');
    expect(textOf(fixture, 'data-measurement')).toBe('3.5 km');
    expect(textOf(fixture, 'data-percent')).toBe('15%');
    expect(textOf(fixture, 'data-percentage-points')).toBe('2.5');
    expect(textOf(fixture, 'data-plain-date')).toBe('Mar 14, 2026');
    // The separator between a time and its day period moved to a narrow no-break space in recent
    // platform data, so the assertion is on the digits rather than on that character.
    expect(textOf(fixture, 'data-plain-time')).toContain('9:30');
    expect(textOf(fixture, 'data-plain-date-time')).toContain('Mar 14, 2026');
    expect(textOf(fixture, 'data-plain-date-time')).toContain('9:30');
    expect(textOf(fixture, 'data-instant')).toContain('Mar 14, 2026');
    expect(textOf(fixture, 'data-zoned-date-time')).toContain('Mar 14, 2026');
    expect(textOf(fixture, 'data-duration')).toContain('30');
  });

  it('rewrites every kind when the locale moves under it', async () => {
    const fixture = TestBed.createComponent(FormattingHost);
    await fixture.whenStable();
    fixture.detectChanges();

    await localization.changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();

    for (const marker of NUMERIC_MARKERS) {
      const rendered = textOf(fixture, marker);
      expect(rendered, marker).toMatch(ARABIC_INDIC);
      // Both directions, so a pipe that appended an Arabic form to a Western one cannot pass the
      // line above by having something to match.
      expect(rendered, marker).not.toMatch(LATIN_DIGIT);
    }
  });
});

describe('a value the formatter will not write', () => {
  beforeEach(async () => {
    await setup().initialize();
  });

  it('renders nothing and reports the diagnostic to the sink', async () => {
    const fixture = TestBed.createComponent(FormattingHost);
    await fixture.whenStable();
    fixture.detectChanges();

    // Nothing on the page. Not an apology in Atlas words, and not a thrown error taking a view
    // down over one value.
    expect(textOf(fixture, 'data-unformattable')).toBe('');

    // And not silent either, which is the half a template cannot see.
    const reported = events.filter(
      (event) =>
        event.code === RUNTIME_EVENT_CODES.formatting &&
        event.phase === 'formatting' &&
        event.status === 'failed',
    );
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0]?.reason).toBe('unsupported-formatting-capability');
  });
});
