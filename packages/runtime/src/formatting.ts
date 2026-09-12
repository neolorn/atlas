// The invariant forms a domain value is held in, and the factories that admit one.
//
// `specs/08-formatting-parsing-and-domain.spec.md` section 1 keeps localized text out of
// anything authoritative, so money, a quantity, an instant and a duration are stored, compared,
// cached and transported in the forms below, and localized only where they are shown.
//
// Section 2 of `specs/08-formatting-parsing-and-domain.spec.md` is why each of them is
// normalized here rather than accepted as written. A decimal is a base-ten string with no
// exponent, no grouping and no negative zero, an instant is epoch nanoseconds, and money and a
// measurement carry their currency and their unit, so a value cannot reach a formatter having
// lost the scale, the unit or the precision it was created with.

import {
  directionForLocale,
  localeProfile,
  LocalizationError,
  type DecimalValue,
  type DurationValue,
  type FormattingContext,
  type FormattingResult,
  type InstantValue,
  type LocaleCapabilityResult,
  type LocaleMetadata,
  type LocalizationClock,
  type LocalizationDiagnostic,
  type LocalizedFormatPart,
  type LocalizedFormattedValue,
  type LocalizedSegment,
  type MeasurementValue,
  type MoneyValue,
  type PercentagePointsValue,
  type PercentScale,
  type PercentValue,
  type PersonNameField,
  type PersonNameFieldKey,
  type PersonNameFieldVariant,
  type PersonNameFormatOptions,
  type PersonNameProfileSet,
  type PersonNameRow,
  type PersonNameValue,
  type PlainDateTimeValue,
  type PlainDateValue,
  type PlainTimeValue,
  type TimeZoneValue,
  type ZonedDateTimeValue,
} from '@neolorn/atlas/core';
import { FormatterCache, formattingLocale } from './evaluator';
import {
  ATLAS_PERSON_NAME_FORMALITIES,
  ATLAS_PERSON_NAME_LENGTHS,
  ATLAS_PERSON_NAME_ORDERS,
  ATLAS_PERSON_NAME_ROOT,
  ATLAS_PERSON_NAME_USAGES,
} from './person-names-root.generated';
import { RUNTIME_LIMITS, codePointLengthAtMost } from './runtime-safety';

/**
 * One store of `Intl` formatters for every standalone formatting call in this process.
 *
 * **The parameter this replaces delivered nothing.** `FormatterCache` is absent from the package's
 * type exports and from its runtime exports, so there was no expression a consumer could write that
 * produced one to pass, and the default was `new FormatterCache(1)`: a fresh one-entry cache,
 * constructed per call. Counted against the built package, 100 identical `formatNumber` calls
 * constructed 100 `Intl.NumberFormat`s. The seam looked like a caching option and was a way of
 * writing "no cache" twenty times.
 *
 * **Module scope, because these functions have no owner.** They are pure, so there is no object
 * whose lifetime is the right one. A per-instance cache is an owner whose lifetime is *available*
 * rather than right: an `Intl.NumberFormat` for `ar-EG` is identical whoever asked for it, so
 * per-owner stores hold duplicate copies of the same formatter and lose them when the owner dies.
 * Under SSR, where a `Localization` is per request, that is the difference between building a
 * formatter once and building it once a request.
 *
 * *The precedent, named rather than asserted.* FormatJS memoizes the `Intl` constructors themselves
 * (`memoize((...args) => new Intl.NumberFormat(...args), ...)`, keyed on the constructor arguments)
 * and hoists that cache above the object that formats. `IntlMessageFormat` defaults to a
 * per-instance store and accepts an injected one; `@formatjs/intl`'s `createFormatters` is what
 * injects it, so one store serves every message an `IntlShape` formats
 * (`packages/intl-messageformat/core.ts`, `packages/intl/utils.ts`). Its own note on that argument
 * is "explicit cache to prevent leaking memory", because the FormatJS store is an unbounded
 * `Record<string, V>` and hoisting an unbounded cache is how it leaks.
 *
 * **Atlas's is bounded, which is why hoisting it is safe here.** `FormatterCache` is an LRU with a
 * fixed ceiling, so this changes who owns the bound and not whether there is one. Sized at
 * `RUNTIME_LIMITS.formatterCacheEntries` because the store is process-wide: there is no catalog
 * count or instance to scale it from, which is exactly what `Localization` scales its own cache by,
 * and any smaller number here would be arbitrary.
 *
 * LRU rather than clear-on-full because an application's working set is small and stable, a
 * handful of locales times a handful of option shapes, so eviction should almost never run, and
 * when it does it should keep what is in use. The risk it exists for is content-driven: a route
 * parameter or a user-supplied value reaching a formatting option would turn an unbounded store
 * into a leak driven by request content. `verify:cost-budget` is the check that holds that line,
 * and it drives distinct option shapes past the ceiling rather than trusting the bound.
 */
const sharedFormatters = new FormatterCache(
  RUNTIME_LIMITS.formatterCacheEntries,
);

function invalidCanonicalValue(
  message: string,
  reason?: LocalizationDiagnostic['reason'],
  cause?: unknown,
): never {
  throw new LocalizationError(
    {
      code: 'invalid-message-input',
      outcome: 'operational-failure',
      message,
      ...(reason === undefined ? {} : { reason }),
    },
    ...(cause === undefined ? [] : [{ cause }]),
  );
}

function normalizeInteger(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > RUNTIME_LIMITS.canonicalNumberCodeUnits ||
    !/^-?(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    return invalidCanonicalValue(
      `${label} must be a signed base-10 integer string.`,
    );
  }
  return value === '-0' ? '0' : value;
}

/**
 * Strip trailing zeros in one pass.
 *
 * `replace(/0+$/u, '')` is quadratic: the engine restarts the match at every position, so a
 * fraction of 65,000 zeros, which `canonicalNumberCodeUnits` permits, cost about a second,
 * against a tenth of a millisecond for the anchored sibling one line above it. The always-reachable
 * path is a direct `decimal()` call, which is how money is formatted.
 */
function withoutTrailingZeros(fraction: string): string {
  let end = fraction.length;
  while (end > 0 && fraction.charCodeAt(end - 1) === 0x30) end -= 1;
  return end === fraction.length ? fraction : fraction.slice(0, end);
}

function normalizeDecimal(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > RUNTIME_LIMITS.canonicalNumberCodeUnits ||
    !/^-?[0-9]+(?:\.[0-9]+)?$/u.test(value)
  ) {
    return invalidCanonicalValue(
      'A decimal must use base-10 digits without exponent, grouping, or a plus sign.',
    );
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerSource = '0', fractionSource = ''] = unsigned.split('.');
  const integer = integerSource.replace(/^0+(?=[0-9])/u, '');
  const fraction = withoutTrailingZeros(fractionSource);
  const normalized = fraction.length === 0 ? integer : `${integer}.${fraction}`;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}

/**
 * An exact decimal, from its digits.
 *
 * Takes base-ten digits with an optional sign and an optional fraction, and nothing else: no
 * exponent, no grouping separators, no plus sign. Leading and trailing zeros are dropped, so two
 * spellings of one number compare equal. A number literal is not accepted, because the conversion
 * is where precision is lost and doing it here would hide that.
 *
 * Throws for anything else, including a string too long to be a number anyone meant.
 */
export function decimal(value: string): DecimalValue {
  return Object.freeze({ kind: 'decimal', value: normalizeDecimal(value) });
}

/**
 * A moment on the timeline, as nanoseconds since the epoch.
 *
 * Takes the count as digits rather than a number, because a nanosecond count outruns what a
 * JavaScript number holds exactly. Milliseconds from `Date.now()` become this by multiplying by a
 * million.
 *
 * Throws for anything that is not a whole number in digits.
 */
export function instant(epochNanoseconds: string): InstantValue {
  return Object.freeze({
    kind: 'instant',
    epochNanoseconds: normalizeInteger(epochNanoseconds, 'An instant'),
  });
}

/**
 * A calendar date with no time and no zone: a birthday, an invoice date, a holiday.
 *
 * Month counts from one, so March is 3. The calendar defaults to `iso8601`; naming another one
 * means the three numbers are read in that calendar's terms.
 *
 * Throws for a date that does not exist. An ISO date is checked against the calendar, so the
 * thirtieth of February is refused here rather than becoming the first of March somewhere later.
 */
export function plainDate(
  year: number,
  month: number,
  day: number,
  calendar = 'iso8601',
): PlainDateValue {
  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    !/^[A-Za-z0-9-]{1,64}$/u.test(calendar)
  ) {
    return invalidCanonicalValue('A plain date contains invalid civil fields.');
  }
  if (calendar === 'iso8601') {
    const probe = new Date(0);
    probe.setUTCHours(0, 0, 0, 0);
    probe.setUTCFullYear(year, month - 1, day);
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      return invalidCanonicalValue('An ISO plain date does not exist.');
    }
  }
  return Object.freeze({ kind: 'plain-date', year, month, day, calendar });
}

/**
 * A time of day with no date and no zone: an opening hour, a daily reminder.
 *
 * Twenty-four hour clock. Seconds and nanoseconds default to zero.
 *
 * Throws for a field outside its range. There is no leap second: sixty is refused, because a
 * formatter has nowhere to put it.
 */
export function plainTime(
  hour: number,
  minute: number,
  second = 0,
  nanosecond = 0,
): PlainTimeValue {
  if (
    !Number.isSafeInteger(hour) ||
    !Number.isSafeInteger(minute) ||
    !Number.isSafeInteger(second) ||
    !Number.isSafeInteger(nanosecond) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    nanosecond < 0 ||
    nanosecond > 999_999_999
  ) {
    return invalidCanonicalValue('A plain time contains invalid civil fields.');
  }
  return Object.freeze({
    kind: 'plain-time',
    hour,
    minute,
    second,
    nanosecond,
  });
}

/**
 * A date and a time with no zone, which is what a wall clock in an unnamed place reads.
 *
 * Two of these an hour apart are not necessarily an hour apart in the world, because no zone means
 * no answer about a daylight-saving shift. Use a zoned date-time when that matters.
 */
export function plainDateTime(
  date: PlainDateValue,
  time: PlainTimeValue,
): PlainDateTimeValue {
  return Object.freeze({ kind: 'plain-date-time', date, time });
}

/**
 * A time zone, from its IANA identity.
 *
 * Takes a name such as `Europe/Berlin` or `UTC` and returns the platform's canonical spelling of
 * it, so a deprecated alias and its replacement come back as the same zone.
 *
 * Throws for a name this platform does not know, which is the honest answer: a zone the host
 * cannot resolve has no offsets to format with.
 */
export function timeZone(id: string): TimeZoneValue {
  if (id.length === 0 || id.length > 255 || id !== id.normalize('NFC')) {
    return invalidCanonicalValue(
      'A time zone requires a bounded canonical IANA identity.',
    );
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-US', {
      timeZone: id,
    }).resolvedOptions().timeZone;
    return Object.freeze({ kind: 'time-zone', id: canonical });
  } catch (cause) {
    return invalidCanonicalValue(
      'A time zone requires a supported IANA time-zone identity.',
      'malformed-input',
      cause,
    );
  }
}

/**
 * A moment together with the zone it is to be read in, and the calendar it is to be counted in.
 *
 * This is the form to store when the zone is part of what happened: a flight departure, a meeting
 * in an office somewhere. The instant fixes the moment and the zone fixes the wall clock, so the
 * pair survives a daylight-saving change that a wall clock alone would not.
 *
 * Throws for a zone or a calendar this platform does not support.
 */
export function zonedDateTime(
  instantValue: InstantValue,
  timeZoneId: string,
  calendar = 'iso8601',
): ZonedDateTimeValue {
  const canonicalTimeZone = timeZone(timeZoneId).id;
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: canonicalTimeZone,
      calendar,
    }).format(0);
  } catch (cause) {
    return invalidCanonicalValue(
      'A zoned date-time requires a supported IANA time-zone identity and calendar.',
      'malformed-input',
      cause,
    );
  }
  return Object.freeze({
    kind: 'zoned-date-time',
    instant: instantValue,
    timeZone: canonicalTimeZone,
    calendar,
  });
}

/**
 * A length of time, as calendar and clock fields with the direction held separately.
 *
 * Every field is optional and every one given must be zero or more; `sign` says whether the
 * duration runs forward or back. The direction is separate because the fields are a count of
 * units rather than a number: minus one hour and thirty minutes is one duration, and writing it as
 * a negative hour plus a positive half hour would be another.
 *
 * Seconds take a decimal so a fraction of a second keeps its precision. The sign must be zero when
 * every field is zero and non-zero otherwise; anything else throws, as does a negative field.
 */
export function duration(
  fields: Partial<
    Readonly<{
      years: number;
      months: number;
      weeks: number;
      days: number;
      hours: number;
      minutes: number;
      seconds: DecimalValue;
    }>
  >,
  sign: -1 | 0 | 1 = 1,
): DurationValue {
  const integer = (value: number | undefined): number => {
    const resolved = value ?? 0;
    if (!Number.isSafeInteger(resolved) || resolved < 0) {
      return invalidCanonicalValue(
        'Duration calendar and clock fields must be nonnegative integers.',
      );
    }
    return resolved;
  };
  if (![-1, 0, 1].includes(sign)) {
    return invalidCanonicalValue('Duration sign is invalid.');
  }
  const value = Object.freeze({
    kind: 'duration' as const,
    sign,
    years: integer(fields.years),
    months: integer(fields.months),
    weeks: integer(fields.weeks),
    days: integer(fields.days),
    hours: integer(fields.hours),
    minutes: integer(fields.minutes),
    seconds: fields.seconds ?? decimal('0'),
  });
  if (value.seconds.value.startsWith('-')) {
    return invalidCanonicalValue(
      'Duration clock fields must be nonnegative; the duration sign is separate.',
    );
  }
  const nonzero =
    value.years !== 0 ||
    value.months !== 0 ||
    value.weeks !== 0 ||
    value.days !== 0 ||
    value.hours !== 0 ||
    value.minutes !== 0 ||
    value.seconds.value !== '0';
  if ((sign === 0) === nonzero) {
    return invalidCanonicalValue(
      'Duration sign must agree with whether its fields are zero.',
    );
  }
  return value;
}

/**
 * An amount in a currency, kept together so neither can be formatted without the other.
 *
 * Takes the amount as an exact decimal and the currency as an ISO 4217 code in capitals. How many
 * decimal places the currency shows is the formatter's business, not the value's, so the amount is
 * stored as given.
 *
 * Throws for anything that is not three capital letters.
 */
export function money(amount: DecimalValue, currency: string): MoneyValue {
  if (!/^[A-Z]{3}$/u.test(currency)) {
    return invalidCanonicalValue(
      'Money requires an uppercase ISO 4217 currency code.',
    );
  }
  return Object.freeze({ kind: 'money', amount, currency });
}

/**
 * A quantity in a unit: a distance, a weight, a temperature, a file size.
 *
 * The unit is a CLDR sanctioned unit identifier such as `kilometer` or `megabyte`, which is what
 * the platform's formatter accepts. A unit the host does not know is not caught here; it comes
 * back as a reported failure when the value is formatted.
 *
 * Throws for a unit whose spelling could not be an identifier at all.
 */
export function measurement(
  amount: DecimalValue,
  unit: string,
): MeasurementValue {
  if (!/^[a-z0-9-]{1,64}$/u.test(unit)) {
    return invalidCanonicalValue('A measurement unit identifier is invalid.');
  }
  return Object.freeze({ kind: 'measurement', amount, unit });
}

/**
 * A proportion, with the scale it is written on stated rather than assumed.
 *
 * `fractional`, the default, means a half is `0.5`. `percentage` means a half is `50`. The two
 * differ by a factor of a hundred and look identical in a database column, so the value carries
 * which one it is and the formatter does the conversion once.
 */
export function percent(
  amount: DecimalValue,
  scale: PercentScale = 'fractional',
): PercentValue {
  return Object.freeze({ kind: 'percent', amount, scale });
}

/**
 * A difference between two proportions, which is a count rather than a proportion.
 *
 * Separate from a percentage because it is formatted differently: a rate that moved from 4 percent
 * to 6 percent rose by two percentage points, and calling that two percent says something else.
 * Locales that mark the two apart get it right only if they are told which is which.
 */
export function percentagePoints(amount: DecimalValue): PercentagePointsValue {
  return Object.freeze({ kind: 'percentage-points', amount });
}

const personNameFields: readonly PersonNameField[] = Object.freeze([
  'title',
  'given',
  'given2',
  'surname',
  'surname2',
  'generation',
  'credentials',
]);

const personNameFieldVariants: readonly PersonNameFieldVariant[] =
  Object.freeze(['informal', 'prefix', 'core', 'vocative', 'genitive']);

/**
 * Every key a name may carry: the seven fields, and each of them in each variant CLDR asks for.
 *
 * Derived rather than written out so that adding a variant to the contract cannot leave the
 * constructor silently discarding it, which is how a caller would find out, by seeing their
 * value never appear.
 */
const personNameFieldKeys: readonly PersonNameFieldKey[] = Object.freeze([
  ...personNameFields,
  ...personNameFields.flatMap((field) =>
    personNameFieldVariants.map(
      (variant) => `${field}-${variant}` as PersonNameFieldKey,
    ),
  ),
]);

/**
 * A person's name, held as the parts it is made of, in the language it belongs to.
 *
 * Takes the language the name is a name in, which is not the reader's locale: how a name is
 * ordered and shortened follows the name, so a Hungarian name keeps its order when read by an
 * English speaker. Takes the parts by role, each optionally in one of the variants a locale may
 * ask for, and at least one part must be given.
 *
 * Every part is trimmed and normalized. Throws for a language tag that is not canonical, for a
 * part longer than a name, and for text carrying control or direction-override characters, which
 * are the ones that make a rendered name read as something other than what it says.
 */
export function personName(
  language: string,
  fields: Readonly<Partial<Record<PersonNameFieldKey, string>>>,
): PersonNameValue {
  if (
    typeof language !== 'string' ||
    language.length === 0 ||
    language.length > 128
  ) {
    return invalidCanonicalValue(
      'A person name requires a bounded canonical language tag.',
    );
  }
  let canonicalLanguage: string;
  try {
    canonicalLanguage = Intl.getCanonicalLocales(language)[0] as string;
  } catch (cause) {
    return invalidCanonicalValue(
      'A person name requires a canonical language tag.',
      'malformed-input',
      cause,
    );
  }
  const normalized: Partial<Record<PersonNameFieldKey, string>> = {};
  for (const field of personNameFieldKeys) {
    const value = fields[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 512) {
      return invalidCanonicalValue(
        `Person-name field ${field} contains unsafe or invalid text.`,
      );
    }
    const text = value.normalize('NFC').trim();
    if (
      text.length === 0 ||
      [...text].length > 256 ||
      /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)
    ) {
      return invalidCanonicalValue(
        `Person-name field ${field} contains unsafe or invalid text.`,
      );
    }
    normalized[field] = text;
  }
  if (Object.keys(normalized).length === 0) {
    return invalidCanonicalValue(
      'A person name requires at least one supplied field.',
    );
  }
  return Object.freeze({
    kind: 'person-name',
    language: canonicalLanguage,
    fields: Object.freeze(normalized),
  });
}

/**
 * A clock that always reads the same moment, for a test or a render that must be reproducible.
 *
 * Install it with `withLocalizationClock`. Relative time is the surface it matters to: "two hours
 * ago" is a different sentence a minute later, and a server and a browser computing it from their
 * own clocks disagree at exactly the boundary.
 */
export function fixedClock(value: InstantValue): LocalizationClock {
  return Object.freeze({ now: () => value });
}

/**
 * The host's own clock, which is what is installed when nothing else is.
 *
 * Reads milliseconds and reports nanoseconds, so the precision is the platform's rather than the
 * type's.
 */
export function systemClock(): LocalizationClock {
  return Object.freeze({
    now: () => instant((BigInt(Date.now()) * 1_000_000n).toString()),
  });
}

function unsupported(
  message: string,
  context: FormattingContext,
  reason?: LocalizationDiagnostic['reason'],
): Extract<FormattingResult, { readonly ok: false }> {
  return Object.freeze({
    ok: false,
    diagnostic: Object.freeze({
      code: 'unsupported-formatting-capability',
      outcome: 'operational-failure',
      message,
      targetLocale: context.locale,
      ...(reason === undefined ? {} : { reason }),
    }),
  });
}

/**
 * Refuse a numbering system this runtime cannot render.
 *
 * Neither form reports one on its own: a well-formed but unsupported value falls back to the
 * locale default and renders, through the option and through the extension alike. Without this the
 * caller asks for digits that do not exist, is told nothing, and is shown different ones.
 */
function unsupportedNumberingSystem(
  context: FormattingContext,
): Extract<FormattingResult, { readonly ok: false }> {
  return unsupported(
    `This runtime has no data for the numbering system "${String(
      context.numberingSystem,
    )}".`,
    context,
    'native-capability-rejected',
  );
}

function nativeNumber(
  value: DecimalValue,
  context: FormattingContext,
): number | Extract<FormattingResult, { readonly ok: false }> {
  const number = Number(value.value);
  if (!Number.isFinite(number)) {
    return unsupported(
      'The native formatter cannot represent this exact decimal magnitude.',
      context,
    );
  }
  let normalizedNative: string;
  try {
    normalizedNative = normalizeDecimal(String(number));
  } catch {
    return unsupported(
      'The native formatter cannot represent this exact decimal without exponent notation.',
      context,
      'native-capability-rejected',
    );
  }
  if (normalizedNative !== value.value) {
    return unsupported(
      'The native formatter cannot represent this exact decimal without precision loss.',
      context,
    );
  }
  return number;
}

function success(
  semantic: LocalizedFormattedValue['semantic'],
  text: string,
  parts: readonly LocalizedFormatPart[],
  source: unknown,
  context: FormattingContext,
  language = context.locale,
): FormattingResult {
  if (
    codePointLengthAtMost(text, RUNTIME_LIMITS.outputCodePoints) ===
      undefined ||
    parts.length > RUNTIME_LIMITS.outputParts
  ) {
    return unsupported(
      'The formatted result exceeds the fixed runtime output ceiling.',
      context,
    );
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      kind: 'formatted-value' as const,
      semantic,
      text,
      parts: Object.freeze(parts),
      locale: context.locale,
      language,
      direction: directionForLocale(language),
      source,
    }),
  });
}

function numberResult(
  semantic: LocalizedFormattedValue['semantic'],
  source: unknown,
  amount: DecimalValue,
  context: FormattingContext,
  options: Intl.NumberFormatOptions,
  cache: FormatterCache,
): FormattingResult {
  const number = nativeNumber(amount, context);
  if (typeof number !== 'number') return number;
  try {
    const formattingTag = formattingLocale(context);
    if (formattingTag === undefined) {
      return unsupportedNumberingSystem(context);
    }
    const formatter = cache.number(formattingTag, {
      ...options,
    });
    return success(
      semantic,
      formatter.format(number),
      formatter
        .formatToParts(number)
        .map(({ type, value }) => Object.freeze({ kind: type, value })),
      source,
      context,
    );
  } catch {
    return unsupported(
      'The native number-formatting capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

function divideByHundred(value: DecimalValue): DecimalValue {
  const negative = value.value.startsWith('-');
  const digits = negative ? value.value.slice(1) : value.value;
  const [integer = '0', fraction = ''] = digits.split('.');
  const split = integer.length - 2;
  const raw =
    split > 0
      ? `${integer.slice(0, split)}.${integer.slice(split)}${fraction}`
      : `0.${'0'.repeat(-split)}${integer}${fraction}`;
  return decimal(`${negative ? '-' : ''}${raw}`);
}

/**
 * Writes a decimal in the conventions of a locale: its digits, grouping and decimal mark.
 *
 * Takes the value, the context that says which locale and which numbering system, and the
 * platform's number options. Returns the text together with its parts and the locale that supplied
 * it, or a diagnostic.
 *
 * It reports rather than rounds. A decimal too precise for the platform's number type comes back as
 * a failure, because writing an approximation of an exact value is the error that never announces
 * itself.
 */
export function formatNumber(
  value: DecimalValue,
  context: FormattingContext,
  options: Intl.NumberFormatOptions = {},
): FormattingResult {
  return numberResult(
    'number',
    value,
    value,
    context,
    options,
    sharedFormatters,
  );
}

/**
 * Writes an amount with its currency, in the position and spelling the locale uses.
 *
 * The currency and the currency style come from the value, so they cannot be passed and cannot
 * disagree with it. Everything else about the number is open. How many decimals a currency shows
 * is the locale data's answer unless the options override it.
 */
export function formatMoney(
  value: MoneyValue,
  context: FormattingContext,
  options: Omit<Intl.NumberFormatOptions, 'currency' | 'style'> = {},
): FormattingResult {
  return numberResult(
    'money',
    value,
    value.amount,
    context,
    { ...options, style: 'currency', currency: value.currency },
    sharedFormatters,
  );
}

/**
 * Writes a quantity with its unit, in the locale's own measurement wording.
 *
 * The unit and the unit style come from the value. A unit the host does not support is reported
 * rather than written as a bare number with the name appended, which would look right and read
 * wrong in most of the world.
 */
export function formatMeasurement(
  value: MeasurementValue,
  context: FormattingContext,
  options: Omit<Intl.NumberFormatOptions, 'style' | 'unit'> = {},
): FormattingResult {
  return numberResult(
    'measurement',
    value,
    value.amount,
    context,
    { ...options, style: 'unit', unit: value.unit },
    sharedFormatters,
  );
}

/**
 * Writes a proportion as a percentage, converting from whichever scale the value carries.
 *
 * The percent style comes from the value, so a caller cannot ask for it twice or ask for a
 * different one. What is written is the locale's own arrangement of the number and the sign,
 * including the locales that put the sign first.
 */
export function formatPercent(
  value: PercentValue,
  context: FormattingContext,
  options: Omit<Intl.NumberFormatOptions, 'style'> = {},
): FormattingResult {
  const fractional =
    value.scale === 'fractional' ? value.amount : divideByHundred(value.amount);
  return numberResult(
    'percent',
    value,
    fractional,
    context,
    { ...options, style: 'percent' },
    sharedFormatters,
  );
}

/**
 * Writes a difference between proportions, with the unit the locale uses for points.
 *
 * Distinct from a percentage on purpose: the number is the same and the sentence is not. Locales
 * that have no separate wording fall back to what they do have, which is reported as the locale
 * that supplied it rather than silently substituted.
 */
export function formatPercentagePoints(
  value: PercentagePointsValue,
  context: FormattingContext,
  options: Intl.NumberFormatOptions = {},
): FormattingResult {
  const formatted = numberResult(
    'percentage-points',
    value,
    value.amount,
    context,
    options,
    sharedFormatters,
  );
  if (!formatted.ok) return formatted;
  return success(
    'percentage-points',
    formatted.value.text,
    [
      ...formatted.value.parts,
      Object.freeze({
        kind: 'semantic-unit' as const,
        value: 'percentage-points',
      }),
    ],
    value,
    context,
  );
}

/**
 * The millisecond an instant falls in.
 *
 * Any instant whose nanoseconds are not a whole millisecond is accepted rather than refused.
 * Sub-millisecond precision is ordinary in instants that originate outside JavaScript (Go and
 * Rust carry nanoseconds, .NET's `DateTimeOffset` carries 100-nanosecond ticks, and PostgreSQL's
 * `timestamptz` carries microseconds) so an epoch-nanosecond string is a normal thing to be
 * handed, and refusing it declines to format a value that is not in any way malformed.
 *
 * Nothing is lost by accepting them. `Intl.DateTimeFormat` cannot express finer than milliseconds
 * at all, `fractionalSecondDigits` stops at 3, so a caller cannot ask for precision this
 * discards, and refusing was declining to answer a question that had been asked at a precision the
 * value could satisfy. Decision section 10: format to the precision the options request, and
 * refuse only where sub-millisecond output is genuinely requested, which no Intl option can do.
 * Silent truncation was rejected as the guessing Atlas refuses elsewhere.
 *
 * The division floors rather than truncating toward zero. For an instant before 1970 those differ,
 * and truncation would name the millisecond *after* the one the instant falls in: displaying a
 * timestamp as later than it is.
 */
function instantMilliseconds(
  value: InstantValue,
  context: FormattingContext,
): number | FormattingResult {
  const nanoseconds = BigInt(value.epochNanoseconds);
  const remainder = ((nanoseconds % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const milliseconds = Number((nanoseconds - remainder) / 1_000_000n);
  return Number.isSafeInteger(milliseconds)
    ? milliseconds
    : unsupported('The instant is outside the native Date range.', context);
}

/**
 * Writes a moment as a date and time, read in a named zone.
 *
 * The options are required rather than defaulted, because a moment has no natural presentation:
 * whether to show the date, the time, the zone or the seconds is the caller's decision and a
 * default would be a guess made once and then inherited everywhere.
 *
 * A zone is required too, from the context or from the options. Without one there is no wall clock
 * to read the moment against, and that is reported rather than being taken as the host's zone,
 * which is the value that differs between a server and a browser.
 */
export function formatInstant(
  value: InstantValue,
  context: FormattingContext,
  options: Intl.DateTimeFormatOptions,
): FormattingResult {
  if (context.timeZone === undefined && options.timeZone === undefined) {
    return unsupported(
      'Instant formatting requires an explicit deterministic time zone.',
      context,
    );
  }
  const milliseconds = instantMilliseconds(value, context);
  if (typeof milliseconds !== 'number') return milliseconds;
  try {
    const formattingTag = formattingLocale(context);
    if (formattingTag === undefined) {
      return unsupportedNumberingSystem(context);
    }
    const formatter = sharedFormatters.dateTime(formattingTag, {
      ...options,
      ...(context.timeZone === undefined ? {} : { timeZone: context.timeZone }),
      ...displayCalendar(context.calendar),
      ...(context.hourCycle === undefined
        ? {}
        : { hourCycle: context.hourCycle }),
    });
    return success(
      'instant',
      formatter.format(milliseconds),
      formatter
        .formatToParts(milliseconds)
        .map(({ type, value: part }) =>
          Object.freeze({ kind: type, value: part }),
        ),
      value,
      context,
    );
  } catch {
    return unsupported(
      'The native date-time capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

/**
 * A calendar option safe to hand to `Intl.DateTimeFormat`.
 *
 * `iso8601` describes how an Atlas plain value is *expressed*: proleptic Gregorian, ISO rules.
 * It is not a display calendar. CLDR defines no month names for it, so passing it through makes
 * ICU drop the month from any pattern that would spell it out: `dateStyle: 'medium'` renders
 * "2026  14" instead of "Mar 14, 2026", in every locale, with no diagnostic.
 *
 * So ISO values format under the locale's own calendar, and any other calendar, which a consumer
 * selected deliberately, is forwarded unchanged.
 */
function displayCalendar(calendar: string | undefined): {
  readonly calendar?: string;
} {
  return calendar === undefined || calendar === 'iso8601' ? {} : { calendar };
}

function plainDateMilliseconds(
  value: PlainDateValue,
  context: FormattingContext,
): number | FormattingResult {
  if (value.calendar !== 'iso8601') {
    return unsupported(
      'Native Date cannot safely construct non-ISO plain-date fields.',
      context,
    );
  }
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  const milliseconds = date.getTime();
  return Number.isFinite(milliseconds)
    ? milliseconds
    : unsupported('The plain date is outside the native Date range.', context);
}

/**
 * Writes a calendar date in the locale's field order and its calendar's own year.
 *
 * Defaults to a numeric day, month and year when no options are given. No zone is involved: a
 * plain date is the same date wherever it is read, which is why a birthday does not move.
 */
export function formatPlainDate(
  value: PlainDateValue,
  context: FormattingContext,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  },
): FormattingResult {
  const milliseconds = plainDateMilliseconds(value, context);
  if (typeof milliseconds !== 'number') return milliseconds;
  try {
    const formattingTag = formattingLocale(context);
    if (formattingTag === undefined) {
      return unsupportedNumberingSystem(context);
    }
    const formatter = sharedFormatters.dateTime(formattingTag, {
      ...options,
      timeZone: 'UTC',
      ...displayCalendar(value.calendar),
    });
    return success(
      'plain-date',
      formatter.format(milliseconds),
      formatter
        .formatToParts(milliseconds)
        .map(({ type, value: part }) =>
          Object.freeze({ kind: type, value: part }),
        ),
      value,
      context,
    );
  } catch {
    return unsupported(
      'The native date capability rejected this plain-date profile.',
      context,
      'native-capability-rejected',
    );
  }
}

function plainTimeMilliseconds(value: PlainTimeValue): number {
  const date = new Date(0);
  date.setUTCHours(
    value.hour,
    value.minute,
    value.second,
    Math.floor(value.nanosecond / 1_000_000),
  );
  return date.getTime();
}

/**
 * Writes a time of day in the locale's clock: its hour cycle, its separator, its day period.
 *
 * Defaults to hours, minutes and seconds. Whether it comes out as a twelve or twenty-four hour
 * clock follows the locale, or the hour cycle the context names.
 */
export function formatPlainTime(
  value: PlainTimeValue,
  context: FormattingContext,
  options: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  },
): FormattingResult {
  if (value.nanosecond % 1_000_000 !== 0) {
    return unsupported(
      'Native Date formatting cannot preserve sub-millisecond plain-time precision.',
      context,
    );
  }
  if (options.timeZone !== undefined && options.timeZone !== 'UTC') {
    return unsupported(
      'Plain-time formatting cannot apply a time zone.',
      context,
    );
  }
  try {
    const formattingTag = formattingLocale(context);
    if (formattingTag === undefined) {
      return unsupportedNumberingSystem(context);
    }
    const formatter = sharedFormatters.dateTime(formattingTag, {
      ...options,
      timeZone: 'UTC',
      ...(context.hourCycle === undefined
        ? {}
        : { hourCycle: context.hourCycle }),
    });
    const milliseconds = plainTimeMilliseconds(value);
    return success(
      'plain-time',
      formatter.format(milliseconds),
      formatter
        .formatToParts(milliseconds)
        .map(({ type, value: part }) =>
          Object.freeze({ kind: type, value: part }),
        ),
      value,
      context,
    );
  } catch {
    return unsupported(
      'The native date capability rejected this plain-time profile.',
      context,
      'native-capability-rejected',
    );
  }
}

/**
 * Writes a date and a time together, joined the way the locale joins them.
 *
 * Defaults to numeric date fields with hours, minutes and seconds. Still no zone, so this is for a
 * wall-clock time whose place is understood from elsewhere on the page.
 */
export function formatPlainDateTime(
  value: PlainDateTimeValue,
  context: FormattingContext,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  },
): FormattingResult {
  if (value.date.calendar !== 'iso8601') {
    return unsupported(
      'Native Date cannot safely construct non-ISO plain date-time fields.',
      context,
    );
  }
  if (options.timeZone !== undefined && options.timeZone !== 'UTC') {
    return unsupported(
      'Plain date-time formatting cannot apply a time zone.',
      context,
    );
  }
  if (value.time.nanosecond % 1_000_000 !== 0) {
    return unsupported(
      'Native Date formatting cannot preserve sub-millisecond plain date-time precision.',
      context,
    );
  }
  const date = new Date(0);
  date.setUTCHours(
    value.time.hour,
    value.time.minute,
    value.time.second,
    Math.floor(value.time.nanosecond / 1_000_000),
  );
  date.setUTCFullYear(value.date.year, value.date.month - 1, value.date.day);
  try {
    const formattingTag = formattingLocale(context);
    if (formattingTag === undefined) {
      return unsupportedNumberingSystem(context);
    }
    const formatter = sharedFormatters.dateTime(formattingTag, {
      ...options,
      timeZone: 'UTC',
      ...displayCalendar(value.date.calendar),
      ...(context.hourCycle === undefined
        ? {}
        : { hourCycle: context.hourCycle }),
    });
    const milliseconds = date.getTime();
    return success(
      'plain-date-time',
      formatter.format(milliseconds),
      formatter
        .formatToParts(milliseconds)
        .map(({ type, value: part }) =>
          Object.freeze({ kind: type, value: part }),
        ),
      value,
      context,
    );
  } catch {
    return unsupported(
      'The native date capability rejected this plain date-time profile.',
      context,
      'native-capability-rejected',
    );
  }
}

/**
 * Writes a moment in the zone the value itself carries.
 *
 * Like formatting an instant, except that the zone comes from the value rather than from the
 * context, so one page can show several of these in several zones without changing the context
 * between them. Options are required for the same reason.
 */
export function formatZonedDateTime(
  value: ZonedDateTimeValue,
  context: FormattingContext,
  options: Intl.DateTimeFormatOptions,
): FormattingResult {
  const formatted = formatInstant(
    value.instant,
    {
      ...context,
      timeZone: value.timeZone,
      ...displayCalendar(value.calendar),
    },
    options,
  );
  if (!formatted.ok) return formatted;
  return success(
    'zoned-date-time',
    formatted.value.text,
    formatted.value.parts,
    value,
    context,
  );
}

interface NativeRangePart {
  readonly type: string;
  readonly value: string;
}

interface NativeNumberRangeFormatter {
  formatRange(start: number, end: number): string;
  formatRangeToParts(start: number, end: number): readonly NativeRangePart[];
}

/**
 * Writes two decimals as one range, with the locale's own separator and its collapsing rules.
 *
 * Takes the two ends in order. Locales shorten a range where they can, so a run of months in one
 * year may come out naming the year once, and a range whose ends are equal may come out as one
 * number with an approximation sign, which is the locale's answer rather than a fault.
 */
export function formatNumberRange(
  start: DecimalValue,
  end: DecimalValue,
  context: FormattingContext,
  options: Intl.NumberFormatOptions = {},
): FormattingResult {
  const startNumber = nativeNumber(start, context);
  if (typeof startNumber !== 'number') return startNumber;
  const endNumber = nativeNumber(end, context);
  if (typeof endNumber !== 'number') return endNumber;
  try {
    const formattingTag = formattingLocale(context);
    if (formattingTag === undefined) {
      return unsupportedNumberingSystem(context);
    }
    const formatter = sharedFormatters.number(formattingTag, {
      ...options,
    }) as Intl.NumberFormat & Partial<NativeNumberRangeFormatter>;
    if (
      typeof formatter.formatRange !== 'function' ||
      typeof formatter.formatRangeToParts !== 'function'
    ) {
      return unsupported(
        'The native number-range capability is unavailable.',
        context,
      );
    }
    return success(
      'number-range',
      formatter.formatRange(startNumber, endNumber),
      formatter
        .formatRangeToParts(startNumber, endNumber)
        .map(({ type, value }) =>
          Object.freeze({
            kind: type as LocalizedFormatPart['kind'],
            value,
          }),
        ),
      Object.freeze({ start, end }),
      context,
    );
  } catch {
    return unsupported(
      'The native number-range capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

interface NativeDateRangeFormatter {
  formatRange(start: number, end: number): string;
  formatRangeToParts(start: number, end: number): readonly NativeRangePart[];
}

/**
 * Writes two moments as one range, showing only the fields that differ where the locale allows it.
 *
 * Takes the two ends in order and the options that apply to both. A zone is required, from the
 * context or the options, for the reason a single instant needs one.
 */
export function formatInstantRange(
  start: InstantValue,
  end: InstantValue,
  context: FormattingContext,
  options: Intl.DateTimeFormatOptions,
): FormattingResult {
  if (context.timeZone === undefined && options.timeZone === undefined) {
    return unsupported(
      'Instant-range formatting requires an explicit deterministic time zone.',
      context,
    );
  }
  const startMilliseconds = instantMilliseconds(start, context);
  if (typeof startMilliseconds !== 'number') return startMilliseconds;
  const endMilliseconds = instantMilliseconds(end, context);
  if (typeof endMilliseconds !== 'number') return endMilliseconds;
  try {
    const formattingTag = formattingLocale(context);
    if (formattingTag === undefined) {
      return unsupportedNumberingSystem(context);
    }
    const formatter = sharedFormatters.dateTime(formattingTag, {
      ...options,
      ...(context.timeZone === undefined ? {} : { timeZone: context.timeZone }),
      ...displayCalendar(context.calendar),
      ...(context.hourCycle === undefined
        ? {}
        : { hourCycle: context.hourCycle }),
    }) as Intl.DateTimeFormat & Partial<NativeDateRangeFormatter>;
    if (
      typeof formatter.formatRange !== 'function' ||
      typeof formatter.formatRangeToParts !== 'function'
    ) {
      return unsupported(
        'The native date-range capability is unavailable.',
        context,
      );
    }
    return success(
      'date-range',
      formatter.formatRange(startMilliseconds, endMilliseconds),
      formatter
        .formatRangeToParts(startMilliseconds, endMilliseconds)
        .map(({ type, value }) =>
          Object.freeze({
            kind: type as LocalizedFormatPart['kind'],
            value,
          }),
        ),
      Object.freeze({ start, end }),
      context,
    );
  } catch {
    return unsupported(
      'The native date-range capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

interface NativeDurationFormatter {
  format(value: Readonly<Record<string, number>>): string;
  formatToParts(
    value: Readonly<Record<string, number>>,
  ): readonly NativeRangePart[];
}

interface NativeDurationFormatConstructor {
  new (
    locales?: string | readonly string[],
    options?: Readonly<Record<string, unknown>>,
  ): NativeDurationFormatter;
}

/**
 * Writes a length of time in the locale's words for its units.
 *
 * The options are the platform's duration options, typed loosely because the duration formatter is
 * newer than the type definitions Atlas compiles against. A host without it reports rather than
 * assembling a sentence out of separate numbers, which would put the units in an order that is
 * wrong in most locales.
 */
export function formatDuration(
  value: DurationValue,
  context: FormattingContext,
  options: Readonly<Record<string, unknown>> = {},
): FormattingResult {
  const constructor = (
    Intl as unknown as {
      readonly DurationFormat?: NativeDurationFormatConstructor;
    }
  ).DurationFormat;
  if (constructor === undefined) {
    return unsupported(
      'The native duration-format capability is unavailable.',
      context,
    );
  }
  const seconds = nativeNumber(value.seconds, context);
  if (typeof seconds !== 'number') return seconds;
  const signed = (amount: number): number => amount * value.sign;
  const fields = Object.freeze({
    years: signed(value.years),
    months: signed(value.months),
    weeks: signed(value.weeks),
    days: signed(value.days),
    hours: signed(value.hours),
    minutes: signed(value.minutes),
    seconds: signed(seconds),
  });
  try {
    const formattingTag = formattingLocale(context);
    if (formattingTag === undefined) {
      return unsupportedNumberingSystem(context);
    }
    const formatter = new constructor(formattingTag, {
      ...options,
    });
    return success(
      'duration',
      formatter.format(fields),
      formatter.formatToParts(fields).map(({ type, value: part }) =>
        Object.freeze({
          kind: type as LocalizedFormatPart['kind'],
          value: part,
        }),
      ),
      value,
      context,
    );
  } catch {
    return unsupported(
      'The native duration-format capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

/**
 * Joins strings the way the locale joins them, including whether there is a comma before the last.
 *
 * Takes text that is already localized: this arranges items, it does not translate them. The
 * combined length is bounded, and a list past that bound is reported rather than truncated, because
 * a shortened list reads as a complete one.
 */
export function formatList(
  values: readonly string[],
  context: FormattingContext,
  options: Intl.ListFormatOptions = {},
): FormattingResult {
  let aggregateCharacters = 0;
  const bounded =
    Array.isArray(values) &&
    values.length <= 100 &&
    values.every((value) => {
      if (typeof value !== 'string') return false;
      const length = codePointLengthAtMost(
        value,
        Math.min(4_096, RUNTIME_LIMITS.outputCodePoints - aggregateCharacters),
      );
      if (length === undefined) return false;
      aggregateCharacters += length;
      return true;
    });
  if (!bounded) {
    return unsupported(
      'The list exceeds Atlas formatting resource bounds.',
      context,
    );
  }
  try {
    const formatter = sharedFormatters.list(context.locale, options);
    return success(
      'list',
      formatter.format(values),
      formatter
        .formatToParts(values)
        .map(({ type, value }) => Object.freeze({ kind: type, value })),
      Object.freeze([...values]),
      context,
    );
  } catch {
    return unsupported(
      'The native list capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

/**
 * Writes an offset in a unit as words: an hour ago, in three days.
 *
 * Takes the signed amount and the unit it is counted in, so the choice of unit is the caller's.
 * `selectRelativeTime` is what picks one from two moments; this writes whatever it is handed.
 * Locales that have a word for a particular offset use it, so minus one day may come out as
 * yesterday rather than as a count.
 */
export function formatRelativeTime(
  value: DecimalValue,
  unit: Intl.RelativeTimeFormatUnit,
  context: FormattingContext,
  options: Intl.RelativeTimeFormatOptions = {},
): FormattingResult {
  const number = nativeNumber(value, context);
  if (typeof number !== 'number') return number;
  try {
    const formattingTag = formattingLocale(context);
    if (formattingTag === undefined) {
      return unsupportedNumberingSystem(context);
    }
    const formatter = sharedFormatters.relativeTime(formattingTag, {
      ...options,
    });
    return success(
      'relative-time',
      formatter.format(number, unit),
      formatter.formatToParts(number, unit).map(({ type, value }) =>
        Object.freeze({
          kind: type as LocalizedFormatPart['kind'],
          value,
        }),
      ),
      Object.freeze({ value, unit }),
      context,
    );
  } catch {
    return unsupported(
      'The native relative-time capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

/**
 * Writes the name of a language, region, script or currency, in the reading locale's words.
 *
 * Takes the code and the options that say what kind of code it is. This is what a locale switcher
 * shows when it names a language in the reader's own language; `languagePresentation` is what it
 * shows when the name should be in the language's own words.
 */
export function formatDisplayName(
  value: string,
  context: FormattingContext,
  options: Intl.DisplayNamesOptions,
): FormattingResult {
  if (
    typeof value !== 'string' ||
    codePointLengthAtMost(value, 1_024) === undefined
  ) {
    return unsupported('The display-name input exceeds Atlas bounds.', context);
  }
  try {
    const display = sharedFormatters
      .displayNames(context.locale, options)
      .of(value);
    if (display === undefined) {
      return unsupported(
        'The native display-name capability has no representation for this value.',
        context,
      );
    }
    return success(
      'display-name',
      display,
      [Object.freeze({ kind: 'display-name', value: display })],
      value,
      context,
    );
  } catch {
    return unsupported(
      'The native display-name capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

function firstGrapheme(
  value: string,
  language: string,
  cache: FormatterCache,
): string {
  try {
    const first = cache
      .segmenter(language, { granularity: 'grapheme' })
      .segment(value)
      [Symbol.iterator]()
      .next().value as { readonly segment?: unknown } | undefined;
    return typeof first?.segment === 'string'
      ? first.segment
      : ([...value][0] ?? '');
  } catch {
    return [...value][0] ?? '';
  }
}

/**
 * Person names, from CLDR patterns rather than from a field order written by hand.
 *
 * What this replaces was eleven `surnameFirst` languages and four `compact` ones, both invented,
 * joined with a space or nothing. CLDR 48 lists five surname-first languages in root and a
 * different set per locale; the eleven were the union of every list in the release, which is the
 * correct answer for three locales out of 766. Ordering is the visible half. The invisible half
 * is that a name has patterns, not a field order: `sorting` is `{surname}, {given}` and not
 * surname-first, monograms have their own patterns per locale, `hu` addresses formally as
 * `{surname} {given} {title}`, and no arrangement of a field list produces any of it.
 *
 * The data arrives as an argument, defaulted to CLDR root, for the reason recorded on
 * `PersonNameProfileSet`: a formatting context is serialized into the SSR transfer payload.
 */

interface PersonNameProfile {
  readonly tag: string;
  readonly cells: readonly number[];
  readonly patterns: readonly string[];
  readonly initial: string;
  readonly initialSequence: string;
  readonly foreignSpace: string;
  readonly nativeSpace: string;
  readonly defaultLength: number;
  readonly defaultFormality: number;
  readonly givenFirstLocales: readonly string[];
  readonly surnameFirstLocales: readonly string[];
}

const PERSON_NAME_INDEXES = new WeakMap<
  PersonNameProfileSet,
  ReadonlyMap<string, PersonNameRow>
>();

function personNameIndex(
  set: PersonNameProfileSet,
): ReadonlyMap<string, PersonNameRow> {
  const cached = PERSON_NAME_INDEXES.get(set);
  if (cached !== undefined) return cached;
  const index = new Map<string, PersonNameRow>(
    set.rows.map((row) => [row[0].toLowerCase(), row] as const),
  );
  PERSON_NAME_INDEXES.set(set, index);
  return index;
}

/**
 * The row for the longest prefix of `tag` the set carries.
 *
 * An application generates rows for the locales it configured, under the tags those rows carry in
 * CLDR rather than the tags that asked for them. `ar-EG` finds the `ar` row here because `ar-EG`
 * is identical to `ar` in this release; a release that separates them emits both and this finds
 * the more specific one without changing.
 */
function personNameProfile(
  set: PersonNameProfileSet,
  tag: string,
): PersonNameProfile | undefined {
  const index = personNameIndex(set);
  let candidate = tag.toLowerCase();
  for (;;) {
    const row = index.get(candidate);
    if (row !== undefined) {
      const pattern = (at: number): string => set.patterns[at] ?? '';
      return {
        tag: row[0],
        cells: row[1],
        patterns: set.patterns,
        initial: pattern(row[2]),
        initialSequence: pattern(row[3]),
        foreignSpace: pattern(row[4]),
        nativeSpace: pattern(row[5]),
        defaultLength: row[6],
        defaultFormality: row[7],
        givenFirstLocales: row[8],
        surnameFirstLocales: row[9],
      };
    }
    const boundary = candidate.lastIndexOf('-');
    if (boundary <= 0) return undefined;
    candidate = candidate.slice(0, boundary);
  }
}

function personNameCell(
  order: number,
  length: number,
  usage: number,
  formality: number,
): number {
  return (
    ((order * ATLAS_PERSON_NAME_LENGTHS.length + length) *
      ATLAS_PERSON_NAME_USAGES.length +
      usage) *
      ATLAS_PERSON_NAME_FORMALITIES.length +
    formality
  );
}

function maximizedScript(tag: string): string | undefined {
  try {
    return new Intl.Locale(tag).maximize().script;
  } catch {
    return undefined;
  }
}

function baseLanguage(tag: string): string {
  try {
    return new Intl.Locale(tag).language;
  } catch {
    return tag.split('-')[0]?.toLowerCase() ?? tag;
  }
}

/**
 * Which order the formatter's locale wants for a name written in `nameLocale`.
 *
 * The lists belong to the **formatter's** locale and the tag looked up in them is the **name's**,
 * which is the whole point: an English interface renders a Japanese name surname-first because
 * English says so about Japanese names, not because the name says so about itself.
 */
function personNameOrder(
  profile: PersonNameProfile,
  nameLocale: string,
  requested: PersonNameFormatOptions['order'],
): number {
  if (requested === 'sorting')
    return ATLAS_PERSON_NAME_ORDERS.indexOf('sorting');
  if (requested === 'given-first') {
    return ATLAS_PERSON_NAME_ORDERS.indexOf('givenFirst');
  }
  if (requested === 'surname-first') {
    return ATLAS_PERSON_NAME_ORDERS.indexOf('surnameFirst');
  }
  const givenFirst = new Set(
    profile.givenFirstLocales.map((entry) => entry.toLowerCase()),
  );
  const surnameFirst = new Set(
    profile.surnameFirstLocales.map((entry) => entry.toLowerCase()),
  );
  let candidate = nameLocale.toLowerCase();
  for (;;) {
    if (givenFirst.has(candidate)) {
      return ATLAS_PERSON_NAME_ORDERS.indexOf('givenFirst');
    }
    if (surnameFirst.has(candidate)) {
      return ATLAS_PERSON_NAME_ORDERS.indexOf('surnameFirst');
    }
    const boundary = candidate.lastIndexOf('-');
    if (boundary <= 0) break;
    candidate = candidate.slice(0, boundary);
  }
  // The chain ends at root, which every locale lists, and given-first if even that is silent.
  if (surnameFirst.has('und')) {
    return ATLAS_PERSON_NAME_ORDERS.indexOf('surnameFirst');
  }
  return ATLAS_PERSON_NAME_ORDERS.indexOf('givenFirst');
}

/**
 * Variants a name supplies, not ones a formatter derives.
 *
 * All but `prefix` fall back to the plain field: UTS #35 says an informal form "should not be
 * generated", and a `-core` with nothing stored "defaults to the field it modifies". `prefix` is
 * the exception on purpose: falling back would put the whole surname in front of itself, so
 * `{surname-prefix} {surname-core}` against a plain `Poel` has to render `Poel` and not
 * `Poel Poel`.
 */
const PERSON_NAME_PLAIN_FALLBACK: ReadonlySet<string> = new Set([
  'informal',
  'core',
  'vocative',
  'genitive',
]);

function storedPersonNameField(
  value: PersonNameValue,
  field: string,
  variants: readonly string[],
): string | undefined {
  const fields = value.fields as Readonly<Record<string, string | undefined>>;
  for (const variant of variants) {
    const stored = fields[`${field}-${variant}`];
    if (stored !== undefined) return stored;
  }
  if (variants.some((variant) => !PERSON_NAME_PLAIN_FALLBACK.has(variant))) {
    return undefined;
  }
  const plain = fields[field];
  if (plain !== undefined) return plain;
  if (variants.length > 0) return undefined;
  // A name that carries only the split form: "if the surname-prefix is 'von und zu' and the
  // surname-core is 'Stettbach' and there is no surname (plain), then the derived value for the
  // (plain) surname is 'von und zu Stettbach'".
  const prefix = fields[`${field}-prefix`];
  const core = fields[`${field}-core`];
  if (prefix === undefined && core === undefined) return undefined;
  return [prefix, core].filter((part) => part !== undefined).join(' ');
}

function personNameWords(
  text: string,
): readonly { readonly word: string; readonly separator: string }[] {
  return [...text.matchAll(/([^\s\p{Pd}]+)([\s\p{Pd}]*)/gu)].map((match) => ({
    word: match[1] ?? '',
    separator: match[2] ?? '',
  }));
}

function fillPattern(pattern: string, ...values: readonly string[]): string {
  return pattern.replace(/\{(\d)\}/gu, (whole, digit: string) => {
    const at = Number(digit);
    return at < values.length ? (values[at] as string) : whole;
  });
}

/**
 * One initial per word, each through the `initial` pattern, recombined with `initialSequence`.
 *
 * `retain` keeps the separator the name itself used instead: "Anne-Marie" becomes "A.-M." rather
 * than "A. M.", which is the difference the modifier exists for.
 */
function personNameInitials(
  text: string,
  profile: PersonNameProfile,
  language: string,
  cache: FormatterCache,
  retain: boolean,
): string {
  const words = personNameWords(text);
  if (words.length === 0) return '';
  let result = fillPattern(
    profile.initial,
    firstGrapheme(words[0]?.word ?? '', language, cache),
  );
  for (let at = 1; at < words.length; at += 1) {
    const piece = fillPattern(
      profile.initial,
      firstGrapheme(words[at]?.word ?? '', language, cache),
    );
    result = retain
      ? `${result}${words[at - 1]?.separator ?? ''}${piece}`
      : fillPattern(profile.initialSequence, result, piece);
  }
  return result;
}

function personNameFieldText(
  value: PersonNameValue,
  profile: PersonNameProfile,
  placeholder: string,
  cache: FormatterCache,
): { readonly field: PersonNameField; readonly text: string } | undefined {
  const [field, ...modifiers] = placeholder.split('-');
  if (
    field === undefined ||
    !(personNameFields as readonly string[]).includes(field)
  ) {
    return undefined;
  }
  const variants = modifiers.filter((modifier) =>
    (personNameFieldVariants as readonly string[]).includes(modifier),
  );
  const stored = storedPersonNameField(value, field, variants);
  const name = field as PersonNameField;
  if (stored === undefined) return { field: name, text: '' };

  let text = stored;
  if (modifiers.includes('monogram')) {
    text = firstGrapheme(text, value.language, cache);
  } else if (modifiers.includes('initial')) {
    text = personNameInitials(
      text,
      profile,
      value.language,
      cache,
      modifiers.includes('retain'),
    );
  }
  if (modifiers.includes('allCaps')) {
    text = text.toLocaleUpperCase(value.language);
  } else if (modifiers.includes('initialCap')) {
    const head = firstGrapheme(text, value.language, cache);
    text = head.toLocaleUpperCase(value.language) + text.slice(head.length);
  }
  return { field: name, text };
}

type PersonNameToken =
  | { readonly kind: 'literal'; readonly text: string }
  | {
      readonly kind: 'field';
      readonly field: PersonNameField;
      readonly text: string;
    };

function parsePersonNamePattern(
  pattern: string,
  value: PersonNameValue,
  profile: PersonNameProfile,
  cache: FormatterCache,
): readonly PersonNameToken[] {
  const tokens: PersonNameToken[] = [];
  let at = 0;
  for (const match of pattern.matchAll(/\{([^{}]*)\}/gu)) {
    const start = match.index;
    if (start > at) {
      tokens.push({ kind: 'literal', text: pattern.slice(at, start) });
    }
    at = start + match[0].length;
    const resolved = personNameFieldText(value, profile, match[1] ?? '', cache);
    // A placeholder naming no field Atlas knows is literal text, not a silent disappearance.
    if (resolved === undefined)
      tokens.push({ kind: 'literal', text: match[0] });
    else tokens.push({ kind: 'field', ...resolved });
  }
  if (at < pattern.length) {
    tokens.push({ kind: 'literal', text: pattern.slice(at) });
  }
  return tokens;
}

/** Steps 1 and 2: nothing before the first populated field, nothing after the last. */
function trimToPopulated(
  tokens: readonly PersonNameToken[],
): readonly PersonNameToken[] {
  const populated = tokens.map(
    (token) => token.kind === 'field' && token.text.length > 0,
  );
  const first = populated.indexOf(true);
  if (first < 0) return [];
  return tokens.slice(first, populated.lastIndexOf(true) + 1);
}

/**
 * Step 3: a run of empty fields separated only by literals takes the literals with it.
 *
 * A lone empty field is removed and its neighbours are left, which is why this is a run scan
 * rather than a filter: `{given} {given2} {surname}` missing both given names must not leave
 * two spaces in front of the surname, and missing only `given2` must leave exactly one.
 */
function removeEmptyFields(
  tokens: readonly PersonNameToken[],
): readonly PersonNameToken[] {
  const kept: PersonNameToken[] = [];
  let at = 0;
  while (at < tokens.length) {
    const token = tokens[at] as PersonNameToken;
    if (token.kind !== 'field' || token.text.length > 0) {
      kept.push(token);
      at += 1;
      continue;
    }
    let end = at;
    for (let scan = at + 1; scan < tokens.length; scan += 1) {
      const next = tokens[scan] as PersonNameToken;
      if (next.kind === 'literal') continue;
      if (next.text.length > 0) break;
      end = scan;
    }
    at = end + 1;
  }
  return kept;
}

/** Steps 4 and 5: two literals become one, and whitespace runs inside it become one character. */
function coalesceLiterals(
  tokens: readonly PersonNameToken[],
): readonly PersonNameToken[] {
  const kept: PersonNameToken[] = [];
  for (const token of tokens) {
    const previous = kept[kept.length - 1];
    if (token.kind !== 'literal' || previous?.kind !== 'literal') {
      kept.push(token);
      continue;
    }
    kept.pop();
    const merged =
      previous.text.length === 0
        ? token.text
        : token.text.length === 0 || previous.text.endsWith(token.text)
          ? previous.text
          : `${previous.text}${token.text}`.replace(
              /(\s)\s+/gu,
              (_whole, first: string) => first,
            );
    kept.push({ kind: 'literal', text: merged });
  }
  return kept;
}

/**
 * Writes a name in the order, length and formality a locale asks for.
 *
 * Takes the name, the reading context, the options that say which arrangement is wanted, and the
 * profile set the rules come from. The profiles default to the root set Atlas ships; a caller
 * passing its own must pass one of the same profile version, and one that is not is refused.
 *
 * The name's own language decides the arrangement, not the reader's locale, so a name keeps its
 * order when it appears on a page in another language.
 */
export function formatPersonName(
  value: PersonNameValue,
  context: FormattingContext,
  options: PersonNameFormatOptions = {},
  profiles: PersonNameProfileSet = ATLAS_PERSON_NAME_ROOT,
): FormattingResult {
  if (profiles.profile !== ATLAS_PERSON_NAME_ROOT.profile) {
    return unsupported(
      `Person-name data profile ${JSON.stringify(profiles.profile)} is not the one this runtime reads (${JSON.stringify(ATLAS_PERSON_NAME_ROOT.profile)}). Regenerate this application against a matching Atlas.`,
      context,
      'integrity-mismatch',
    );
  }

  // UTS #35: "If the name script doesn't match the formatting script: if the name locale has name
  // formatting data, then set the formatting locale to the name locale." Data an application did
  // not generate is data it does not have, so a name in a script none of its locales use is
  // formatted by the interface's own patterns rather than by root.
  const nameScript = maximizedScript(value.language);
  const formatterScript = maximizedScript(context.locale);
  const switched =
    nameScript !== undefined &&
    formatterScript !== undefined &&
    nameScript !== formatterScript &&
    personNameProfile(profiles, value.language) !== undefined;
  const formattingTag = switched ? value.language : context.locale;
  const profile =
    personNameProfile(profiles, formattingTag) ??
    (personNameProfile(ATLAS_PERSON_NAME_ROOT, 'und') as PersonNameProfile);

  const order = personNameOrder(profile, value.language, options.order);
  const length =
    options.length === undefined
      ? profile.defaultLength
      : ATLAS_PERSON_NAME_LENGTHS.indexOf(options.length);
  const formality =
    options.formality === undefined
      ? profile.defaultFormality
      : ATLAS_PERSON_NAME_FORMALITIES.indexOf(options.formality);
  const usage = ATLAS_PERSON_NAME_USAGES.indexOf(options.usage ?? 'referring');

  // The only empty region in the release is `sorting` crossed with addressing and monogram, in
  // every one of the 379 rows: a sorting form is a referring form, so that is where it falls to.
  const referring = ATLAS_PERSON_NAME_USAGES.indexOf('referring');
  const selected =
    profile.cells[personNameCell(order, length, usage, formality)];
  const index =
    selected !== undefined && selected >= 0
      ? selected
      : profile.cells[personNameCell(order, length, referring, formality)];
  const pattern =
    index !== undefined && index >= 0 ? profile.patterns[index] : undefined;
  if (pattern === undefined) {
    return unsupported(
      `Locale ${JSON.stringify(profile.tag)} carries no person-name pattern for this combination.`,
      context,
      'native-capability-rejected',
    );
  }

  const spaceReplacement =
    baseLanguage(formattingTag) === baseLanguage(value.language)
      ? profile.nativeSpace
      : profile.foreignSpace;

  const tokens = coalesceLiterals(
    removeEmptyFields(
      trimToPopulated(
        parsePersonNamePattern(pattern, value, profile, sharedFormatters),
      ),
    ),
  );

  const literalDirection = directionForLocale(formattingTag);
  const nameDirection = directionForLocale(value.language);
  const parts: LocalizedFormatPart[] = [];
  for (const token of tokens) {
    if (token.kind === 'field') {
      parts.push(
        Object.freeze({
          kind: token.field,
          value: token.text,
          language: value.language,
          direction: nameDirection,
        }),
      );
      continue;
    }
    // The pattern's spaces, not the name's: replacing spaces inside a field would rewrite
    // "Mary Beth" as "MaryBeth" in a locale that joins its fields without one.
    const text =
      spaceReplacement === ' '
        ? token.text
        : token.text.replace(/ /gu, spaceReplacement);
    if (text.length === 0) continue;
    parts.push(
      Object.freeze({
        kind: 'literal',
        value: text,
        language: formattingTag,
        direction: literalDirection,
      }),
    );
  }

  return success(
    'person-name',
    parts.map(({ value: part }) => part).join(''),
    parts,
    value,
    context,
    value.language,
  );
}

function capabilityFailure<Value>(
  message: string,
  context: FormattingContext,
  reason?: LocalizationDiagnostic['reason'],
): LocaleCapabilityResult<Value> {
  return Object.freeze({
    ok: false,
    diagnostic: Object.freeze({
      code: 'unsupported-formatting-capability',
      outcome: 'operational-failure',
      message,
      targetLocale: context.locale,
      ...(reason === undefined ? {} : { reason }),
    }),
  });
}

/**
 * Which plural category a number falls in for a locale: one, few, many, and the rest.
 *
 * For a caller assembling something a message cannot express. Ordinary plural selection belongs in
 * the message, where a translator can see it; reaching for this puts the branching in code, where
 * they cannot.
 */
export function selectPlural(
  value: DecimalValue,
  context: FormattingContext,
  options: Intl.PluralRulesOptions = {},
): LocaleCapabilityResult<Intl.LDMLPluralRule> {
  const number = nativeNumber(value, context);
  if (typeof number !== 'number') {
    return Object.freeze({ ok: false, diagnostic: number.diagnostic });
  }
  try {
    return Object.freeze({
      ok: true,
      value: sharedFormatters.plural(context.locale, options).select(number),
    });
  } catch {
    return capabilityFailure(
      'The native plural capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

/**
 * Orders two strings the way the locale orders them, which is rarely the way code points order.
 *
 * Returns -1, 0 or 1, for sorting. Use it for any list a reader sees: accented letters, digraphs
 * and case all sort differently by locale, and a byte comparison gets a name list wrong in most
 * languages.
 */
export function compareLocalized(
  left: string,
  right: string,
  context: FormattingContext,
  options: Intl.CollatorOptions = {},
): LocaleCapabilityResult<-1 | 0 | 1> {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    codePointLengthAtMost(left, RUNTIME_LIMITS.localizedInputCodePoints) ===
      undefined ||
    codePointLengthAtMost(right, RUNTIME_LIMITS.localizedInputCodePoints) ===
      undefined
  ) {
    return capabilityFailure(
      'The collation input exceeds the fixed runtime ceiling.',
      context,
    );
  }
  try {
    const result = sharedFormatters
      .collator(context.locale, options)
      .compare(left, right);
    return Object.freeze({
      ok: true,
      value: result < 0 ? -1 : result > 0 ? 1 : 0,
    });
  } catch {
    return capabilityFailure(
      'The native collation capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

/**
 * Splits text into graphemes, words or sentences according to the locale.
 *
 * Returns the segments with what each one is, so a word count, a truncation or a highlight lands on
 * a boundary a reader recognizes. Counting code units instead cuts an emoji or a Devanagari
 * cluster in half.
 */
export function segmentText(
  input: string,
  context: FormattingContext,
  options: Intl.SegmenterOptions = {},
): LocaleCapabilityResult<readonly LocalizedSegment[]> {
  if (
    typeof input !== 'string' ||
    codePointLengthAtMost(input, RUNTIME_LIMITS.localizedInputCodePoints) ===
      undefined
  ) {
    return capabilityFailure(
      'The segmentation input exceeds Atlas bounds.',
      context,
    );
  }
  try {
    const segments = [
      ...sharedFormatters.segmenter(context.locale, options).segment(input),
    ].map((part) =>
      Object.freeze({
        segment: part.segment,
        index: part.index,
        input: part.input,
        ...('isWordLike' in part && typeof part.isWordLike === 'boolean'
          ? { wordLike: part.isWordLike }
          : {}),
      }),
    );
    return Object.freeze({ ok: true, value: Object.freeze(segments) });
  } catch {
    return capabilityFailure(
      'The native segmentation capability rejected this profile.',
      context,
      'native-capability-rejected',
    );
  }
}

interface ExtendedLocale {
  readonly language: string;
  readonly script?: string;
  readonly region?: string;
  getCalendars?(): readonly string[];
  getNumberingSystems?(): readonly string[];
  getHourCycles?(): readonly string[];
  getWeekInfo?(): {
    readonly firstDay: number;
    readonly weekend: readonly number[];
    readonly minimalDays: number;
  };
}

/**
 * What a locale tag implies: its direction, its calendar, its numbering system, its week.
 *
 * Takes the tag and returns what the host resolves for it, so this is the platform's answer rather
 * than a table Atlas keeps. A tag the host cannot canonicalize is reported.
 */
export function localeMetadata(
  locale: string,
): LocaleCapabilityResult<LocaleMetadata> {
  const context: FormattingContext = { locale };
  try {
    const canonical = Intl.getCanonicalLocales(locale)[0] as string;
    const native = new Intl.Locale(canonical) as unknown as ExtendedLocale;
    const profile = localeProfile(canonical);
    const calendars = native.getCalendars?.() ?? [];
    const numberingSystems = native.getNumberingSystems?.() ?? [];
    const hourCycles = native.getHourCycles?.() ?? [];
    const week = native.getWeekInfo?.();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        locale: canonical,
        language: profile.language,
        script: profile.script,
        ...(profile.region === undefined ? {} : { region: profile.region }),
        direction: profile.direction,
        calendars: Object.freeze([...calendars]),
        numberingSystems: Object.freeze([...numberingSystems]),
        hourCycles: Object.freeze([...hourCycles]),
        ...(week === undefined
          ? {}
          : {
              week: Object.freeze({
                firstDay: week.firstDay,
                weekend: Object.freeze([...week.weekend]),
                minimalDays: week.minimalDays,
              }),
            }),
      }),
    });
  } catch {
    return capabilityFailure(
      'The native locale-metadata capability rejected this locale.',
      context,
      'native-capability-rejected',
    );
  }
}
