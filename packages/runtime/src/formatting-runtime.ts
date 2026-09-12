/**
 * Every formatting entry point the localization facade offers, and nothing else.
 *
 * *Why these are a module.* All twenty-four reach runtime state through one accessor, the active
 * snapshot's `FormattingContext`, and through nothing else: the only `this` any of them touches is
 * `formattingSnapshot()`, three values out of the setup, and the extension registry. A group whose
 * entire coupling to a two-thousand-line class is one function call is not part of it.
 *
 * *What it deliberately does not take.* Not the options bag, but the three values these methods read
 * out of it. A dependency stated as what it uses cannot quietly grow into a dependency on everything
 * the bag happens to carry, and the next reader can see the whole of it in the interface below.
 *
 * *The accessor stays behind.* `formattingSnapshot()` asserts the context is alive and reads the
 * snapshot signal, both of which are the core's business. It is passed in, so this module holds no
 * state at all: it does not know when the locale changes and does not need to, because it reads the
 * current context on every call exactly as these methods always did.
 *
 * *The adapter helpers came too.* Every one of them was reached only from the two adapter methods
 * here, which is why they are below rather than shared.
 *
 * *What the rules require of them.* `specs/08-formatting-parsing-and-domain.spec.md` section 3
 * requires one immutable formatting snapshot across a server render, hydration and the browser,
 * which is why every entry point here reads the committed context through the accessor and none
 * of them reads a clock or an ambient host setting.
 *
 * Section 4 of `specs/08-formatting-parsing-and-domain.spec.md` resolves that context in three
 * layers and keeps the time zone application-wide, because a page is read in one zone whichever
 * language it is in.
 */

import {
  type DecimalValue,
  directionForLocale,
  type DurationValue,
  type FormattingContext,
  type FormattingResult,
  type InstantValue,
  type LocaleCapabilityResult,
  type LocaleMetadata,
  type LocalizationClock,
  type LocalizationSetup,
  type LocalizedFormatPart,
  type LocalizedFormattedValue,
  type LocalizedInputResult,
  type LocalizedInputStatus,
  type LocalizedSegment,
  type MeasurementValue,
  type MoneyValue,
  type PercentagePointsValue,
  type PercentValue,
  type PersonNameFormatOptions,
  type PersonNameValue,
  type PlainDateTimeValue,
  type PlainDateValue,
  type PlainTimeValue,
  type RuntimeFormattingAdapterBinding,
  type RuntimeParsingAdapterBinding,
  type ZonedDateTimeValue,
} from '@neolorn/atlas/core';
import { languageForLocale } from './evaluator';
import { RuntimeExtensions } from './extensions';
import {
  compareLocalized as compareLocalizedValue,
  formatDisplayName as formatDisplayNameValue,
  formatDuration as formatDurationValue,
  formatInstant as formatInstantValue,
  formatInstantRange as formatInstantRangeValue,
  formatList as formatListValue,
  formatMeasurement as formatMeasurementValue,
  formatMoney as formatMoneyValue,
  formatNumber as formatNumberValue,
  formatNumberRange as formatNumberRangeValue,
  formatPercent as formatPercentValue,
  formatPercentagePoints as formatPercentagePointsValue,
  formatPersonName as formatPersonNameValue,
  formatPlainDate as formatPlainDateValue,
  formatPlainDateTime as formatPlainDateTimeValue,
  formatPlainTime as formatPlainTimeValue,
  formatRelativeTime as formatRelativeTimeValue,
  formatZonedDateTime as formatZonedDateTimeValue,
  localeMetadata as localeMetadataValue,
  segmentText as segmentTextValue,
  selectPlural as selectPluralValue,
  systemClock,
} from './formatting';
import {
  type RelativeTimeOutcome,
  type RelativeTimePolicy,
  resolveRelativeTime,
} from './relative-time-policy';
import {
  codePointLengthAtMost,
  operationalDiagnostic,
  RUNTIME_LIMITS,
  safeDiagnosticIdentifier,
} from './runtime-safety';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The extension identifier an adapter binding claims, read as whatever it holds.
 *
 * An adapter is handed in by the caller of `formatWithAdapter` or `parseWithAdapter`. The binding
 * type says a descriptor is there and that its identifier is a string, which is a description of
 * a binding this runtime produced and a claim about one it did not.
 */
function claimedExtensionId(
  adapter: { readonly descriptor?: { readonly id?: unknown } } | undefined,
): unknown {
  return adapter?.descriptor?.id;
}

function isPromiseLike(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  try {
    return typeof value['then'] === 'function';
  } catch {
    return true;
  }
}

function normalizeAdapterParts(
  value: unknown,
  text: string,
  maximumOutputLength: number,
): readonly LocalizedFormatPart[] | undefined {
  if (value === undefined) {
    return Object.freeze([
      Object.freeze({ kind: 'semantic-unit' as const, value: text }),
    ]);
  }
  if (!Array.isArray(value) || value.length > maximumOutputLength + 1)
    return undefined;
  const parts: LocalizedFormatPart[] = [];
  let projected = '';
  for (const item of value) {
    if (
      !isPlainRecord(item) ||
      typeof item['kind'] !== 'string' ||
      item['kind'].length === 0 ||
      item['kind'].length > 64 ||
      typeof item['value'] !== 'string' ||
      (item['language'] !== undefined &&
        (typeof item['language'] !== 'string' ||
          item['language'].length > 64)) ||
      (item['direction'] !== undefined &&
        item['direction'] !== 'ltr' &&
        item['direction'] !== 'rtl')
    ) {
      return undefined;
    }
    if (
      codePointLengthAtMost(item['value'], maximumOutputLength) === undefined ||
      projected.length + item['value'].length > maximumOutputLength * 2
    ) {
      return undefined;
    }
    projected += item['value'];
    if (codePointLengthAtMost(projected, maximumOutputLength) === undefined) {
      return undefined;
    }
    parts.push(
      Object.freeze({
        kind: item['kind'] as LocalizedFormatPart['kind'],
        value: item['value'],
        ...(item['language'] === undefined
          ? {}
          : { language: item['language'] as string }),
        ...(item['direction'] === undefined
          ? {}
          : { direction: item['direction'] as 'ltr' | 'rtl' }),
      }),
    );
  }
  return projected === text ? Object.freeze(parts) : undefined;
}

function adapterInputFailure<Value = never>(
  status: Exclude<LocalizedInputStatus, 'valid'>,
  text: string,
  message: string,
  locale: string,
): LocalizedInputResult<Value> {
  return Object.freeze({
    status,
    text,
    diagnostic: operationalDiagnostic(
      status === 'unsupported-capability'
        ? 'unsupported-input-capability'
        : 'invalid-localized-input',
      message,
      { targetLocale: locale },
    ),
  });
}

const adapterInputStatuses = new Set<LocalizedInputStatus>([
  'valid',
  'incomplete',
  'invalid',
  'ambiguous',
  'out-of-range',
  'unsupported-capability',
  'policy-rejected',
]);

function normalizeAdapterInputResult<Value>(
  value: unknown,
  input: string,
  locale: string,
  extensionId: string,
): LocalizedInputResult<Value> | undefined {
  if (
    !isPlainRecord(value) ||
    isPromiseLike(value) ||
    typeof value['status'] !== 'string' ||
    !adapterInputStatuses.has(value['status'] as LocalizedInputStatus) ||
    typeof value['text'] !== 'string' ||
    value['text'].length > input.length + 1_024
  ) {
    return undefined;
  }
  const status = value['status'] as LocalizedInputStatus;
  if (status === 'valid') {
    if (!Object.hasOwn(value, 'value')) return undefined;
    return Object.freeze({
      status: 'valid',
      text: value['text'],
      value: value['value'] as Value,
    });
  }
  const diagnostic = value['diagnostic'];
  if (
    !isPlainRecord(diagnostic) ||
    typeof diagnostic['message'] !== 'string' ||
    diagnostic['message'].length > 1_024
  ) {
    return undefined;
  }
  return adapterInputFailure(
    status,
    value['text'],
    diagnostic['message'] || `Parsing adapter ${extensionId} rejected input.`,
    locale,
  );
}

/**
 * What formatting needs from the runtime around it: three values out of the setup, the extension
 * registry, and one accessor for the live formatting context.
 */
export interface FormattingSurfaceContext {
  readonly snapshot: () => FormattingContext;
  readonly clock: LocalizationClock | undefined;
  readonly relativeTimePolicy: RelativeTimePolicy | undefined;
  readonly personNames: LocalizationSetup['personNames'];
  readonly extensions: RuntimeExtensions;
}

export class FormattingSurface {
  constructor(private readonly context: FormattingSurfaceContext) {}

  formatNumber(
    value: DecimalValue,
    options: Intl.NumberFormatOptions = {},
  ): FormattingResult {
    return formatNumberValue(value, this.context.snapshot(), options);
  }

  formatMoney(
    value: MoneyValue,
    options: Omit<Intl.NumberFormatOptions, 'currency' | 'style'> = {},
  ): FormattingResult {
    return formatMoneyValue(value, this.context.snapshot(), options);
  }

  formatMeasurement(
    value: MeasurementValue,
    options: Omit<Intl.NumberFormatOptions, 'style' | 'unit'> = {},
  ): FormattingResult {
    return formatMeasurementValue(value, this.context.snapshot(), options);
  }

  formatPercent(
    value: PercentValue,
    options: Omit<Intl.NumberFormatOptions, 'style'> = {},
  ): FormattingResult {
    return formatPercentValue(value, this.context.snapshot(), options);
  }

  formatPercentagePoints(
    value: PercentagePointsValue,
    options: Intl.NumberFormatOptions = {},
  ): FormattingResult {
    return formatPercentagePointsValue(value, this.context.snapshot(), options);
  }

  formatInstant(
    value: InstantValue,
    options: Intl.DateTimeFormatOptions,
  ): FormattingResult {
    return formatInstantValue(value, this.context.snapshot(), options);
  }

  formatPlainDate(
    value: PlainDateValue,
    options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    },
  ): FormattingResult {
    return formatPlainDateValue(value, this.context.snapshot(), options);
  }

  formatPlainTime(
    value: PlainTimeValue,
    options: Intl.DateTimeFormatOptions = {
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    },
  ): FormattingResult {
    return formatPlainTimeValue(value, this.context.snapshot(), options);
  }

  formatPlainDateTime(
    value: PlainDateTimeValue,
    options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    },
  ): FormattingResult {
    return formatPlainDateTimeValue(value, this.context.snapshot(), options);
  }

  formatZonedDateTime(
    value: ZonedDateTimeValue,
    options: Intl.DateTimeFormatOptions,
  ): FormattingResult {
    return formatZonedDateTimeValue(value, this.context.snapshot(), options);
  }

  formatNumberRange(
    start: DecimalValue,
    end: DecimalValue,
    options: Intl.NumberFormatOptions = {},
  ): FormattingResult {
    return formatNumberRangeValue(start, end, this.context.snapshot(), options);
  }

  formatInstantRange(
    start: InstantValue,
    end: InstantValue,
    options: Intl.DateTimeFormatOptions,
  ): FormattingResult {
    return formatInstantRangeValue(
      start,
      end,
      this.context.snapshot(),
      options,
    );
  }

  formatDuration(
    value: DurationValue,
    options: Readonly<Record<string, unknown>> = {},
  ): FormattingResult {
    return formatDurationValue(value, this.context.snapshot(), options);
  }

  formatList(
    values: readonly string[],
    options: Intl.ListFormatOptions = {},
  ): FormattingResult {
    return formatListValue(values, this.context.snapshot(), options);
  }

  formatRelativeTime(
    value: DecimalValue,
    unit: Intl.RelativeTimeFormatUnit,
    options: Intl.RelativeTimeFormatOptions = {},
  ): FormattingResult {
    return formatRelativeTimeValue(
      value,
      unit,
      this.context.snapshot(),
      options,
    );
  }

  relativeTime(
    target: InstantValue,
    options: Intl.RelativeTimeFormatOptions = {},
  ): RelativeTimeOutcome {
    return resolveRelativeTime(
      target,
      (this.context.clock ?? systemClock()).now(),
      this.context.relativeTimePolicy ?? {},
      this.context.snapshot(),
      options,
    );
  }

  formatDisplayName(
    value: string,
    options: Intl.DisplayNamesOptions,
  ): FormattingResult {
    return formatDisplayNameValue(value, this.context.snapshot(), options);
  }

  formatPersonName(
    value: PersonNameValue,
    options: PersonNameFormatOptions = {},
  ): FormattingResult {
    return formatPersonNameValue(
      value,
      this.context.snapshot(),
      options,
      // Passed here rather than carried on the formatting context: the context is part of the
      // snapshot Atlas serializes into the SSR transfer payload, and the table is already in the
      // bundle. Absent, the formatter falls back to the CLDR root profile it compiles in.
      ...(this.context.personNames === undefined
        ? []
        : ([this.context.personNames] as const)),
    );
  }

  selectPlural(
    value: DecimalValue,
    options: Intl.PluralRulesOptions = {},
  ): LocaleCapabilityResult<Intl.LDMLPluralRule> {
    return selectPluralValue(value, this.context.snapshot(), options);
  }

  compare(
    left: string,
    right: string,
    options: Intl.CollatorOptions = {},
  ): LocaleCapabilityResult<-1 | 0 | 1> {
    return compareLocalizedValue(left, right, this.context.snapshot(), options);
  }

  segment(
    input: string,
    options: Intl.SegmenterOptions = {},
  ): LocaleCapabilityResult<readonly LocalizedSegment[]> {
    return segmentTextValue(input, this.context.snapshot(), options);
  }

  localeMetadata(): LocaleCapabilityResult<LocaleMetadata> {
    return localeMetadataValue(this.context.snapshot().locale);
  }

  formatWithAdapter<Value>(
    adapter: RuntimeFormattingAdapterBinding<Value>,
    value: Value,
  ): FormattingResult {
    const formatting = this.context.snapshot();
    // The adapter is resolved through this context's own registry rather than trusted as passed,
    // so an adapter from another context, or one never installed here, is still refused.
    const extensionId = claimedExtensionId(adapter);
    const safeExtensionId = safeDiagnosticIdentifier(extensionId);
    const declaredId =
      typeof extensionId === 'string' &&
      /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,63}$/u.test(extensionId)
        ? extensionId
        : undefined;
    const binding =
      declaredId === undefined
        ? undefined
        : this.context.extensions.formattingAdapter(declaredId);
    if (declaredId === undefined || binding === undefined) {
      return Object.freeze({
        ok: false,
        diagnostic: operationalDiagnostic(
          'unsupported-formatting-capability',
          `Formatting adapter ${safeExtensionId} is not registered.`,
          { targetLocale: formatting.locale },
        ),
      });
    }
    let output: unknown;
    try {
      output = binding.format(
        Object.freeze({ value, locale: formatting.locale, formatting }),
      );
    } catch {
      return Object.freeze({
        ok: false,
        diagnostic: operationalDiagnostic(
          'unsupported-formatting-capability',
          `Formatting adapter ${safeExtensionId} failed.`,
          { targetLocale: formatting.locale, reason: 'consumer-code-threw' },
        ),
      });
    }
    if (
      !isPlainRecord(output) ||
      isPromiseLike(output) ||
      typeof output['text'] !== 'string' ||
      codePointLengthAtMost(
        output['text'],
        binding.descriptor.maximumOutputLength,
      ) === undefined ||
      (binding.descriptor.result === 'parts' &&
        !Array.isArray(output['parts'])) ||
      (binding.descriptor.result === 'text' && output['parts'] !== undefined)
    ) {
      return Object.freeze({
        ok: false,
        diagnostic: operationalDiagnostic(
          'unsupported-formatting-capability',
          `Formatting adapter ${safeExtensionId} returned an invalid result.`,
          { targetLocale: formatting.locale },
        ),
      });
    }
    const parts = normalizeAdapterParts(
      output['parts'],
      output['text'],
      binding.descriptor.maximumOutputLength,
    );
    if (parts === undefined) {
      return Object.freeze({
        ok: false,
        diagnostic: operationalDiagnostic(
          'unsupported-formatting-capability',
          `Formatting adapter ${safeExtensionId} returned invalid parts.`,
          { targetLocale: formatting.locale },
        ),
      });
    }
    const formatted: LocalizedFormattedValue = Object.freeze({
      kind: 'formatted-value',
      semantic: 'extension',
      extensionId: declaredId,
      text: output['text'],
      parts,
      locale: formatting.locale,
      language: languageForLocale(formatting.locale),
      direction: directionForLocale(formatting.locale),
      source: value,
    });
    return Object.freeze({
      ok: true,
      value: formatted,
    });
  }

  parseWithAdapter<Value>(
    adapter: RuntimeParsingAdapterBinding<Value>,
    text: string,
  ): LocalizedInputResult<Value> {
    const formatting = this.context.snapshot();
    const extensionId = claimedExtensionId(adapter);
    const safeExtensionId = safeDiagnosticIdentifier(extensionId);
    const binding =
      typeof extensionId === 'string' &&
      /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,63}$/u.test(extensionId)
        ? this.context.extensions.parsingAdapter(extensionId)
        : undefined;
    if (binding === undefined) {
      return adapterInputFailure(
        'unsupported-capability',
        text,
        `Parsing adapter ${safeExtensionId} is not registered.`,
        formatting.locale,
      );
    }
    if (
      typeof text !== 'string' ||
      codePointLengthAtMost(
        text,
        Math.min(
          binding.descriptor.maximumInputLength,
          RUNTIME_LIMITS.localizedInputCodePoints,
        ),
      ) === undefined
    ) {
      return adapterInputFailure(
        'out-of-range',
        text,
        `Parsing adapter ${safeExtensionId} rejected input beyond its declared bound.`,
        formatting.locale,
      );
    }
    let result: unknown;
    try {
      result = binding.parse(
        Object.freeze({ text, locale: formatting.locale, formatting }),
      );
    } catch {
      return adapterInputFailure(
        'invalid',
        text,
        `Parsing adapter ${safeExtensionId} failed.`,
        formatting.locale,
      );
    }
    const normalized = normalizeAdapterInputResult<Value>(
      result,
      text,
      formatting.locale,
      safeExtensionId,
    );
    if (normalized === undefined) {
      return adapterInputFailure(
        'invalid',
        text,
        `Parsing adapter ${safeExtensionId} returned an invalid result.`,
        formatting.locale,
      );
    }
    return normalized;
  }
}
