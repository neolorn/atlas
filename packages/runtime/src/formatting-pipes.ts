/**
 * One pipe per canonical value kind, for the eleven kinds a single value answers for.
 *
 * `specs/08-formatting-parsing-and-domain.spec.md` section 3 is the contract each of these stands
 * on: the formatter feature-detects, returns a typed unsupported result rather than approximating,
 * and reads one immutable formatting snapshot so a hydrated page matches what the server wrote.
 * A pipe changes none of that. It is a second spelling of a facade call, for the place a template
 * is what renders the value.
 *
 * Eleven, and not seventeen. Relative time is not here, because `relativeTime` answers with an
 * outcome rather than a string: section 5 makes the out-of-range branch an explicit application
 * decision carrying the elapsed span, and says the format, the zone and the wording of what is
 * shown instead belong to the application. A pipe returning a string cannot express that, and one
 * that quietly rendered an absolute date would be making the decision the spec reserves. Ranges,
 * lists, display names and person names are not here either: none of them is one canonical value
 * with one options bag, so a pipe would have to take two operands or an untyped one.
 *
 * A failure renders nothing and is reported. A formatter reports rather than throws, and a template
 * is the wrong place to catch. Throwing here would take down the view over a value that one locale
 * cannot express, and a stand-in sentence would put Atlas wording on a consumer page. So the output
 * is empty and the diagnostic goes to the observability sink, where
 * `specs/11-diagnostics-and-observability.spec.md` section 8 already collapses equivalent failures
 * inside a window, which matters for a surface that re-runs on every change detection.
 *
 * Impure, and memoized by reference. These read the ambient snapshot, so they cannot be pure, for
 * the same reason `LocalizePipe` cannot. The guard against the cost that buys is the same one: the
 * value, the options and the snapshot identity are compared by reference, so a template binding a
 * value it holds re-formats only when one of the three actually changes. An options object written
 * inline in a template is a new identity on every pass and defeats it; hold it in a field, the way
 * `Intl` options are held anywhere else.
 *
 * Each pipe passes its formatter to the base rather than overriding a method, so what it publishes
 * is the one member a template uses. A protected hook would appear in the declaration file and read
 * as something a consumer is meant to extend, which none of these is.
 */

import { Pipe, inject } from '@angular/core';

import type {
  DecimalValue,
  DurationValue,
  FormattingResult,
  InstantValue,
  MeasurementValue,
  MoneyValue,
  PercentValue,
  PercentagePointsValue,
  PlainDateTimeValue,
  PlainDateValue,
  PlainTimeValue,
  ZonedDateTimeValue,
} from '@neolorn/atlas/core';
import { Localization, emitLocalizationRuntimeEvent } from './localization';
import { RUNTIME_EVENT_CODES } from './observability';

type FormatterCall<Value, Options> = (
  localization: Localization,
  value: Value,
  options: Options | undefined,
) => FormattingResult;

/**
 * The memo and the failure branch, written once.
 *
 * Not a pipe itself, and not exported: eleven copies of this would be eleven places for the
 * reporting to be forgotten in.
 */
abstract class LocalizedValuePipe<Value, Options> {
  private readonly localization = inject(Localization);
  private priorValue: Value | undefined;
  private priorOptions: Options | undefined;
  private priorSnapshotId: number | undefined;
  private priorText = '';

  constructor(private readonly call: FormatterCall<Value, Options>) {}

  transform(value: Value, options?: Options): string {
    const snapshotId = this.localization.snapshot()?.id;
    if (
      value === this.priorValue &&
      options === this.priorOptions &&
      snapshotId === this.priorSnapshotId
    ) {
      return this.priorText;
    }
    this.priorValue = value;
    this.priorOptions = options;
    this.priorSnapshotId = snapshotId;
    const result = this.call(this.localization, value, options);
    if (result.ok) {
      this.priorText = result.value.text;
      return this.priorText;
    }
    emitLocalizationRuntimeEvent(this.localization, {
      code: RUNTIME_EVENT_CODES.formatting,
      phase: 'formatting',
      status: 'failed',
      reason: result.diagnostic.code,
      ...(snapshotId === undefined ? {} : { snapshotId }),
    });
    this.priorText = '';
    return this.priorText;
  }
}

/**
 * The same memo for the two kinds whose options the facade requires.
 *
 * An instant and a zoned date-time are points on a timeline and say nothing about what to show of
 * them, so there is no default here that is not a guess about the page.
 */
abstract class LocalizedValueWithOptionsPipe<
  Value,
  Options,
> extends LocalizedValuePipe<Value, Options> {
  override transform(value: Value, options: Options): string {
    return super.transform(value, options);
  }
}

/** An exact decimal, in the digits and grouping the committed locale writes. */
@Pipe({ name: 'localizedDecimal', standalone: true, pure: false })
export class LocalizedDecimalPipe extends LocalizedValuePipe<
  DecimalValue,
  Intl.NumberFormatOptions
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatNumber(value, options),
    );
  }
}

/** An amount with its currency, which the value carries rather than the options. */
@Pipe({ name: 'localizedMoney', standalone: true, pure: false })
export class LocalizedMoneyPipe extends LocalizedValuePipe<
  MoneyValue,
  Omit<Intl.NumberFormatOptions, 'currency' | 'style'>
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatMoney(value, options),
    );
  }
}

/** An amount with its unit, which the value carries rather than the options. */
@Pipe({ name: 'localizedMeasurement', standalone: true, pure: false })
export class LocalizedMeasurementPipe extends LocalizedValuePipe<
  MeasurementValue,
  Omit<Intl.NumberFormatOptions, 'style' | 'unit'>
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatMeasurement(value, options),
    );
  }
}

/** A proportion, which the value states the scale of, so nothing has to infer it. */
@Pipe({ name: 'localizedPercent', standalone: true, pure: false })
export class LocalizedPercentPipe extends LocalizedValuePipe<
  PercentValue,
  Omit<Intl.NumberFormatOptions, 'style'>
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatPercent(value, options),
    );
  }
}

/** A difference between two percentages, which is a number and not a percentage. */
@Pipe({ name: 'localizedPercentagePoints', standalone: true, pure: false })
export class LocalizedPercentagePointsPipe extends LocalizedValuePipe<
  PercentagePointsValue,
  Intl.NumberFormatOptions
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatPercentagePoints(value, options),
    );
  }
}

/** A point on the UTC timeline, shown in the time zone the formatting context names. */
@Pipe({ name: 'localizedInstant', standalone: true, pure: false })
export class LocalizedInstantPipe extends LocalizedValueWithOptionsPipe<
  InstantValue,
  Intl.DateTimeFormatOptions
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatInstant(value, options ?? {}),
    );
  }
}

/** A calendar date with no time and no zone. */
@Pipe({ name: 'localizedPlainDate', standalone: true, pure: false })
export class LocalizedPlainDatePipe extends LocalizedValuePipe<
  PlainDateValue,
  Intl.DateTimeFormatOptions
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatPlainDate(value, options),
    );
  }
}

/** A time of day with no date and no zone. */
@Pipe({ name: 'localizedPlainTime', standalone: true, pure: false })
export class LocalizedPlainTimePipe extends LocalizedValuePipe<
  PlainTimeValue,
  Intl.DateTimeFormatOptions
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatPlainTime(value, options),
    );
  }
}

/** A civil date and time, which names no zone and so describes no single moment. */
@Pipe({ name: 'localizedPlainDateTime', standalone: true, pure: false })
export class LocalizedPlainDateTimePipe extends LocalizedValuePipe<
  PlainDateTimeValue,
  Intl.DateTimeFormatOptions
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatPlainDateTime(value, options),
    );
  }
}

/** A moment in a named zone, which is what a departure time or an appointment is. */
@Pipe({ name: 'localizedZonedDateTime', standalone: true, pure: false })
export class LocalizedZonedDateTimePipe extends LocalizedValueWithOptionsPipe<
  ZonedDateTimeValue,
  Intl.DateTimeFormatOptions
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatZonedDateTime(value, options ?? {}),
    );
  }
}

/** A length of time, which carries its own fields rather than a count of milliseconds. */
@Pipe({ name: 'localizedDuration', standalone: true, pure: false })
export class LocalizedDurationPipe extends LocalizedValuePipe<
  DurationValue,
  Readonly<Record<string, unknown>>
> {
  constructor() {
    super((localization, value, options) =>
      localization.formatDuration(value, options),
    );
  }
}
