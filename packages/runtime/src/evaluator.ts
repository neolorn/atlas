/**
 * One handle, one catalog chain, one result that says where it came from.
 *
 * `specs/06-runtime-and-angular.spec.md` section 2 requires evaluation to be synchronous once
 * the scope is ready and to start no work of its own, so everything here reads state that is
 * already in memory. The metadata on every result is the other half of that section: the locale
 * asked for, the locales attempted, the locale that supplied the answer, and its language and
 * direction, because a result from a fallback locale is still a correct result and has to say so.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 2 is why the result is parts rather than
 * anything a renderer would run: a catalog is data, so nothing on this path compiles a template,
 * builds a handler, or reaches a global.
 */

import {
  directionForLocale,
  localeProfile,
  LocalizationError,
  RTL_STRONG_CHARACTERS,
  type ContentDirection,
  type ExtensionValueType,
  type FormattingContext,
  type LocaleDirection,
  type LocalizationDiagnostic,
  type LocalizedMetadata,
  type LocalizedPart,
  type LocalizedParts,
  type LocalizedSlotPart,
  type LocalizedText,
  type LocalizedTextPart,
  type LocalizedValuePart,
  type MessageHandle,
  type RuntimeMessageFunctionDescriptor,
} from '@neolorn/atlas/core';
import type {
  CompiledCatalog,
  CompiledInputContract,
  CompiledMessage,
  CompiledSlotContract,
} from './catalog-runtime';
import { RuntimeExtensions } from './extensions';
import {
  ATLAS_MESSAGE_FUNCTION_OPTIONS,
  atlasDateOperandOptions,
  atlasDateTimeFormatOptions,
  atlasExtensionOptionProfile,
  atlasInheritedOptions,
  atlasMessageOptionProblem,
  atlasNumberFormatOptions,
  type AtlasMessageOperandKind,
} from './message-function-options';
import {
  ATLAS_NUMBER_LITERAL,
  atlasExtensionOptionValue,
  atlasExtensionOptionValueAllowed,
} from './message-format-syntax';
import {
  type AsReceived,
  RUNTIME_LIMITS,
  codePointLengthAtMost,
  safeDiagnosticIdentifier,
  isRecord,
} from './runtime-safety';

type IrRecord = Readonly<Record<string, unknown>>;

interface EvaluationCandidate {
  readonly catalog: CompiledCatalog;
  readonly message: CompiledMessage;
  readonly targetLocale: string;
  readonly attemptedLocales: readonly string[];
}

interface ResolvedValue {
  readonly raw: unknown;
  readonly text: string;
  readonly functionName?: string;
  readonly locale: string;
  readonly direction: LocaleDirection;
  /**
   * MF2's directionality of a resolved value, which is not the direction of its locale.
   *
   * Text Atlas formatted itself runs the way its locale runs. Text that arrived from a consumer
   * does not, and Atlas will not claim to know which language it is in, so it answers `auto` and
   * lets the first-strong rule decide.
   */
  readonly contentDirection: ContentDirection;
  /** MF2's `isolate`: `u:dir` was written with a value other than `inherit`. */
  readonly isolate: boolean;
  /** MF2's `u:id`. */
  readonly id?: string;
  /**
   * The options this value was resolved with, for a later expression that annotates it again.
   *
   * LDML 48 Part 9 puts this on the function rather than on the language: "a function handler MAY
   * include resolved options in its resolved value", and the number functions do, "when the
   * operand of the expression is an implementation-defined type, such as the resolved value of an
   * expression with a `:number` or `:integer` annotation, it can include option values", with
   * "options on the expression taking priority over any options of the operand".
   *
   * The date functions set it for the same reason and by the same sentence: their operand may be
   * *"an implementation-defined date/time type"* that *"can include other option values"*, of which
   * only the three date/time override options are read. Without it `timeZone=input` had nothing to
   * name and `.local $t = {$when :datetime timeZone=|Europe/Paris|}` lost the zone at the next
   * annotation.
   *
   * It holds MessageFormat option names, not `Intl` ones: inheritance happens in the message's
   * vocabulary and is translated afterwards, once, by the function that receives it.
   */
  readonly options?: Readonly<Record<string, unknown>>;
  /**
   * Whether `.match` may select on this value at all.
   *
   * MessageFormat divides its functions into formatters and selectors, and a `.match` over a
   * formatter is a *Bad Selector*: the specification requires the error and requires the selector
   * to match nothing but the catch-all. `match` returning `false` for every key produces the
   * second half of that on its own and swallows the first, which is how `:currency` and `:unit`
   * came to select as plain numbers here: they never got a `match` of their own, so they
   * inherited the numeric one and picked a keyed variant nobody could see was wrong.
   *
   * So it is stated rather than implied. The toolkit refuses such a message at compile time and
   * this is what stands behind that for a compiled message that did not come from this toolkit.
   */
  readonly selects: boolean;
  /**
   * MF2 `Match(rv, k)`: does this value match one already-normalized variant key?
   *
   * One key at a time, rather than the whole candidate set with the value returning its own
   * preference. The caller has a one-element set to offer, so a preference would have nothing to
   * choose between and the ranking below would never run.
   */
  match(key: string): boolean;
  /**
   * MF2 `BetterThan(rv, k1, k2)`: is `left` a stronger match than `right`?
   *
   * Only called on keys that both match. The spec's ranking is per selector, which is why it lives
   * on the resolved value rather than in the variant loop: only `:number` has a ranking to express,
   * and only it knows that an exact numeric key beats a plural category.
   */
  betterThan(left: string, right: string): boolean;
}

interface EvaluationEnvironment {
  readonly values: Map<string, ResolvedValue>;
  readonly supplyingLocale: string;
  readonly supplyingDirection: LocaleDirection;
  readonly formatting: FormattingContext;
  readonly formatterCache: FormatterCache;
  readonly extensions: RuntimeExtensions;
  readonly maximumParts: number;
  parts: number;
  steps: number;
  references: number;
  functions: number;
  literals: number;
  outputCodePoints: number;
}

export function languageForLocale(locale: string): string {
  try {
    return localeProfile(locale).language;
  } catch {
    return locale.split('-')[0]?.toLowerCase() ?? 'und';
  }
}

function invalidMessage(
  message: string,
  reason?: LocalizationDiagnostic['reason'],
  cause?: unknown,
): never {
  throw new LocalizationError(
    Object.freeze({
      code: 'invalid-rich-message',
      outcome: 'operational-failure',
      message,
      ...(reason === undefined ? {} : { reason }),
    }),
    ...(cause === undefined ? [] : [{ cause }]),
  );
}

function invalidInput(
  message: string,
  reason?: LocalizationDiagnostic['reason'],
  cause?: unknown,
): never {
  throw new LocalizationError(
    Object.freeze({
      code: 'invalid-message-input',
      outcome: 'operational-failure',
      message,
      ...(reason === undefined ? {} : { reason }),
    }),
    ...(cause === undefined ? [] : [{ cause }]),
  );
}

/**
 * The numbering systems this runtime has data for.
 *
 * Read once. `Intl.supportedValuesOf` walks ICU's tables to answer, and every formatter Atlas
 * builds consults this.
 */
let cachedNumberingSystems: ReadonlySet<string> | undefined;

function supportedNumberingSystems(): ReadonlySet<string> {
  cachedNumberingSystems ??= new Set(Intl.supportedValuesOf('numberingSystem'));
  return cachedNumberingSystems;
}

/**
 * The tag to build a formatter from, carrying the numbering system as a `-u-nu-` extension.
 *
 * Not the `numberingSystem` option. Three surfaces accept it and ignore it:
 * `NumberFormat.formatRange`, `NumberFormat.formatRangeToParts` and `DurationFormat.format` render
 * the locale's own digits while `resolvedOptions().numberingSystem` reports the one that was asked
 * for, so the request is dropped and the report says it was honoured. Measured on ICU 78.3 across
 * ar-EG, fa-IR, bn-BD, my-MM, ne-NP and mr-IN.
 *
 * Applied to every formatter rather than to those three. Every other surface produces identical
 * output from either form, measured on the same release, so uniformity costs nothing and a list of
 * "the ones that need it" would be a hand-maintained copy of ICU's behaviour: wrong the moment ICU
 * moves, and wrong without saying so.
 *
 * Built through `Intl.Locale` and never by concatenation. `${locale}-u-nu-${system}` throws on any
 * locale that already carries a `-u-` extension, because RFC 5646 §2.2.6 forbids a repeated
 * singleton, and Atlas canonicalizes through `Intl.getCanonicalLocales`, which preserves them.
 * `Intl.Locale` merges into the extension already there: `ar-EG-u-ca-islamic` becomes
 * `ar-EG-u-ca-islamic-nu-latn`.
 *
 * This tag is for constructing formatters and is never the locale Atlas reports as active. Nothing
 * reads `resolvedOptions().locale`, which would report `ar-EG-u-nu-latn` here.
 */
export function formattingLocale(
  context: FormattingContext,
): string | undefined {
  const { locale, numberingSystem } = context;
  if (numberingSystem === undefined) return locale;
  if (!supportedNumberingSystems().has(numberingSystem)) return undefined;
  try {
    return new Intl.Locale(locale, { numberingSystem }).toString();
  } catch {
    return undefined;
  }
}

function unsupportedFormatting(
  message: string,
  reason?: LocalizationDiagnostic['reason'],
  cause?: unknown,
): never {
  throw new LocalizationError(
    Object.freeze({
      code: 'unsupported-formatting-capability',
      outcome: 'operational-failure',
      message,
      ...(reason === undefined ? {} : { reason }),
    }),
    ...(cause === undefined ? [] : [{ cause }]),
  );
}

function stableOptions(options: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(options).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
}

type CachedFormatter =
  | Intl.NumberFormat
  | Intl.DateTimeFormat
  | Intl.PluralRules
  | Intl.ListFormat
  | Intl.RelativeTimeFormat
  | Intl.DisplayNames
  | Intl.Collator
  | Intl.Segmenter;

export class FormatterCache {
  private readonly values = new Map<string, CachedFormatter>();

  constructor(private readonly maximumEntries: number) {
    if (
      !Number.isSafeInteger(maximumEntries) ||
      maximumEntries < 1 ||
      maximumEntries > RUNTIME_LIMITS.formatterCacheEntries
    ) {
      throw new LocalizationError(
        Object.freeze({
          code: 'invalid-configuration',
          outcome: 'operational-failure',
          message:
            'Formatter cache capacity exceeds the fixed runtime ceiling.',
        }),
      );
    }
  }

  private remember<T extends CachedFormatter>(key: string, value: T): T {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.maximumEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    return value;
  }

  number(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
    const key = `number\u0000${locale}\u0000${stableOptions(options as Readonly<Record<string, unknown>>)}`;
    const cached = this.values.get(key);
    if (cached instanceof Intl.NumberFormat) {
      this.remember(key, cached);
      return cached;
    }
    return this.remember(key, new Intl.NumberFormat(locale, options));
  }

  dateTime(
    locale: string,
    options: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormat {
    const key = `date-time\u0000${locale}\u0000${stableOptions(options as Readonly<Record<string, unknown>>)}`;
    const cached = this.values.get(key);
    if (cached instanceof Intl.DateTimeFormat) {
      this.remember(key, cached);
      return cached;
    }
    return this.remember(key, new Intl.DateTimeFormat(locale, options));
  }

  plural(locale: string, options: Intl.PluralRulesOptions): Intl.PluralRules {
    const key = `plural\u0000${locale}\u0000${stableOptions(options as Readonly<Record<string, unknown>>)}`;
    const cached = this.values.get(key);
    if (cached instanceof Intl.PluralRules) {
      this.remember(key, cached);
      return cached;
    }
    return this.remember(key, new Intl.PluralRules(locale, options));
  }

  list(locale: string, options: Intl.ListFormatOptions): Intl.ListFormat {
    const key = `list\u0000${locale}\u0000${stableOptions(options as Readonly<Record<string, unknown>>)}`;
    const cached = this.values.get(key);
    if (cached instanceof Intl.ListFormat) {
      this.remember(key, cached);
      return cached;
    }
    return this.remember(key, new Intl.ListFormat(locale, options));
  }

  relativeTime(
    locale: string,
    options: Intl.RelativeTimeFormatOptions,
  ): Intl.RelativeTimeFormat {
    const key = `relative-time\u0000${locale}\u0000${stableOptions(options as Readonly<Record<string, unknown>>)}`;
    const cached = this.values.get(key);
    if (cached instanceof Intl.RelativeTimeFormat) {
      this.remember(key, cached);
      return cached;
    }
    return this.remember(key, new Intl.RelativeTimeFormat(locale, options));
  }

  displayNames(
    locale: string,
    options: Intl.DisplayNamesOptions,
  ): Intl.DisplayNames {
    const key = `display-names\u0000${locale}\u0000${stableOptions(options as unknown as Readonly<Record<string, unknown>>)}`;
    const cached = this.values.get(key);
    if (cached instanceof Intl.DisplayNames) {
      this.remember(key, cached);
      return cached;
    }
    return this.remember(key, new Intl.DisplayNames(locale, options));
  }

  collator(locale: string, options: Intl.CollatorOptions): Intl.Collator {
    const key = `collator\u0000${locale}\u0000${stableOptions(options as Readonly<Record<string, unknown>>)}`;
    const cached = this.values.get(key);
    if (cached instanceof Intl.Collator) {
      this.remember(key, cached);
      return cached;
    }
    return this.remember(key, new Intl.Collator(locale, options));
  }

  segmenter(locale: string, options: Intl.SegmenterOptions): Intl.Segmenter {
    const key = `segmenter\u0000${locale}\u0000${stableOptions(options as Readonly<Record<string, unknown>>)}`;
    const cached = this.values.get(key);
    if (cached instanceof Intl.Segmenter) {
      this.remember(key, cached);
      return cached;
    }
    return this.remember(key, new Intl.Segmenter(locale, options));
  }
}

function isValidInput(
  value: unknown,
  contract: CompiledInputContract,
): boolean {
  if (value === null) return contract.nullable;
  if (value === undefined) return contract.optional;
  if (contract.enum !== undefined) {
    return typeof value === 'string' && contract.enum.includes(value);
  }
  switch (contract.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'date-time':
      return (
        (value instanceof Date && Number.isFinite(value.getTime())) ||
        (typeof value === 'number' && Number.isFinite(value))
      );
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return (
        typeof value === 'string' &&
        codePointLengthAtMost(value, RUNTIME_LIMITS.outputCodePoints) !==
          undefined
      );
  }
}

function matchesExtensionType(
  value: unknown,
  type: ExtensionValueType,
): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'date-time':
      return (
        (value instanceof Date && Number.isFinite(value.getTime())) ||
        (typeof value === 'number' && Number.isFinite(value))
      );
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return (
        typeof value === 'string' &&
        codePointLengthAtMost(value, RUNTIME_LIMITS.outputCodePoints) !==
          undefined
      );
  }
}

function validExtensionOptions(
  options: Readonly<Record<string, unknown>>,
  descriptor: RuntimeMessageFunctionDescriptor,
): boolean {
  const contracts = descriptor.options ?? {};
  for (const name of Object.keys(options)) {
    if (!Object.hasOwn(contracts, name)) return false;
  }
  for (const [name, contract] of Object.entries(contracts)) {
    const value = options[name];
    if (value === undefined) {
      if (contract.required) return false;
      continue;
    }
    // Not `matchesExtensionType`, which is for an operand and a result: those are real values, and
    // an option is whatever the message spelled. A literal reaches here as text even when the
    // descriptor declared `integer`.
    const interpreted = atlasExtensionOptionValue(value, contract.type);
    if (
      interpreted === undefined ||
      !atlasExtensionOptionValueAllowed(interpreted, contract.values)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * MF2's `number-literal` production, verbatim:
 * `["-"] (%x30 / (%x31-39 *DIGIT)) ["." 1*DIGIT] [%i"e" ["-" / "+"] 1*DIGIT]`.
 *
 * A numeric selector needs it because the spec separates the two kinds of key rather than trying
 * one after the other: a key that looks like a number is compared only against the value's exact
 * serialization, and a key that is a plural keyword only against the rule-selected category.
 */
const NUMBER_LITERAL = ATLAS_NUMBER_LITERAL;

/** The six CLDR plural categories, which are the only non-numeric keys a numeric selector takes. */
const PLURAL_KEYWORDS: ReadonlySet<string> = Object.freeze(
  new Set(['zero', 'one', 'two', 'few', 'many', 'other']),
);

/**
 * MessageFormat's Number Operand, which is not the same thing as a JavaScript number.
 *
 * LDML 48 Part 9: the operand of a number function is "an implementation-defined numeric type, or a
 * string matching the `number-literal` production". A literal written into the message reaches the
 * evaluator as its source text, because source text is what a literal *is*, so a function that
 * asked `typeof raw === 'number'` refused `{42 :number}`, the most ordinary message the syntax can
 * express, while accepting the variable form of exactly the same thing. Sixty-eight conformance
 * cases; nothing here ever wrote a literal operand, so nothing here ever saw it.
 *
 * The rule lives out here rather than inside the numeric functions because the custom-function
 * boundary needs the identical one. A descriptor declaring `operandType: 'number'` is declaring what
 * the specification calls a Number Operand, and an extension that could not be handed
 * `{1 :feature:thing}` would carry this defect one layer out, in code nobody had looked at yet. Two
 * call sites and one rule, or they drift apart the first time either is touched.
 *
 * `NUMBER_LITERAL` and not `Number()`: `Number('')`, `Number(' 1 ')`, `Number('0x1')` and
 * `Number('Infinity')` are all numbers to JavaScript and none of them is a number to MessageFormat,
 * so the grammar decides and the parse only converts what it admitted.
 */
function numberOperand(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string' || !NUMBER_LITERAL.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function plainResolved(
  raw: unknown,
  locale: string,
  direction: LocaleDirection,
): ResolvedValue {
  const text = raw === undefined || raw === null ? '' : String(raw);
  // MF2 "Selection with :string": the comparison is between the key, already normalized by
  // NormalizeKey, and the value in NFC. Normalizing once here rather than per key.
  const compare = text.normalize('NFC');
  return Object.freeze({
    raw,
    text,
    locale,
    direction,
    // Nothing here was formatted by Atlas: this is whatever the consumer passed in. Giving it the
    // message locale's direction is the assumption that produced the defect this replaces: a
    // customer name typed in Arabic inside an English message is not left-to-right because the
    // message is. `auto` where the content could reorder, so the renderer's first-strong rule
    // answers it, and the locale's direction where it cannot, so a wholly English application
    // carries no invisible characters it has no use for.
    contentDirection: mayReorder(text) ? ('auto' as const) : direction,
    isolate: false,
    // ":string" "provides string selection and formatting", and an unannotated selector is
    // resolved through this same path. The suite writes no Bad Selector case for either.
    selects: true,
    match: (key: string) => key === compare,
    // ":string" ranks nothing: every key that matches is the same key.
    betterThan: () => false,
  });
}

function tick(environment: EvaluationEnvironment, amount = 1): void {
  environment.steps += amount;
  if (environment.steps > RUNTIME_LIMITS.evaluationSteps) {
    invalidMessage('Message evaluation exceeded the fixed step ceiling.');
  }
}

function countOutput(environment: EvaluationEnvironment, value: string): void {
  const remaining =
    RUNTIME_LIMITS.outputCodePoints - environment.outputCodePoints;
  const length = codePointLengthAtMost(value, remaining);
  if (length === undefined) {
    invalidMessage('Message evaluation exceeded the fixed output ceiling.');
  }
  environment.outputCodePoints += length;
}

/**
 * What a reference names: a literal's text, or the resolved value a declaration bound.
 *
 * The resolved value rather than `value.raw`, which would throw away everything the declaration
 * produced. LDML 48 Part 9, Variable Resolution: *"If a declaration exists for the variable, its
 * resolved value is used."* The formatted text, the function that produced it, its options and its
 * `u:dir` are all part of that value, and a caller that wants only the operand can still say so.
 */
type ReferencedValue =
  | { readonly kind: 'literal'; readonly raw: string }
  | { readonly kind: 'variable'; readonly value: ResolvedValue };

function readReference(
  reference: unknown,
  environment: EvaluationEnvironment,
): ReferencedValue {
  tick(environment);
  if (!isRecord(reference))
    invalidMessage('A message value reference is invalid.');
  if (
    reference['kind'] === 'literal' &&
    typeof reference['value'] === 'string'
  ) {
    environment.literals += 1;
    if (environment.literals > RUNTIME_LIMITS.evaluationLiterals) {
      invalidMessage('Message evaluation exceeded the fixed literal ceiling.');
    }
    return { kind: 'literal', raw: reference['value'] };
  }
  if (
    reference['kind'] === 'variable' &&
    typeof reference['name'] === 'string'
  ) {
    environment.references += 1;
    if (environment.references > RUNTIME_LIMITS.evaluationReferences) {
      invalidMessage(
        'Message evaluation exceeded the fixed reference ceiling.',
      );
    }
    const value = environment.values.get(reference['name']);
    if (value === undefined) {
      invalidInput(`Message input ${reference['name']} is unavailable.`);
    }
    return { kind: 'variable', value };
  }
  return invalidMessage('A message value reference is invalid.');
}

const referencedOperand = (referenced: ReferencedValue): unknown =>
  referenced.kind === 'literal' ? referenced.raw : referenced.value.raw;

function readOptions(
  options: unknown,
  environment: EvaluationEnvironment,
): Readonly<Record<string, unknown>> {
  if (!isRecord(options)) return Object.freeze({});
  return Object.freeze(
    Object.fromEntries(
      Object.entries(options).map(([name, reference]) => [
        name,
        // An option value is an operand, not a resolved value: MF2 resolves it and hands the
        // function the value, and a function's own options are its contract rather than the
        // message's. Only the expression's operand carries a resolved value forward.
        referencedOperand(readReference(reference, environment)),
      ]),
    ),
  );
}

/** MF2's four `u:dir` values. `inherit` is the default and the only one that asks for no isolation. */
const UNICODE_DIRECTIONS = Object.freeze(
  new Set(['ltr', 'rtl', 'auto', 'inherit']),
) as ReadonlySet<string>;

interface UnicodeOptions {
  readonly direction?: 'ltr' | 'rtl' | 'auto' | 'inherit';
  readonly id?: string;
}

/**
 * Read the `u:` namespace out of an option mapping.
 *
 * MessageFormat 2 reserves `u:` for options that belong to the message syntax rather than to any
 * function. Atlas parsed them, folded them in with everything else and then dropped them, which is
 * the worst of the three available behaviours: an author who wrote `u:dir=rtl` got no diagnostic
 * and no isolation.
 *
 * Anything outside `u:dir` and `u:id` is refused rather than ignored. `u:locale` is a real option
 * in the spec that Atlas does not implement, and quietly accepting it would mean a message that
 * formats in the wrong locale with nothing to show for it. The toolkit rejects all of this at parse
 * time; this is the same rule applied to a compiled artifact that did not come through it.
 */
function unicodeOptions(
  options: Readonly<Record<string, unknown>>,
  context: string,
  allowDirection: boolean,
): UnicodeOptions {
  let direction: UnicodeOptions['direction'];
  let id: string | undefined;
  for (const [name, value] of Object.entries(options)) {
    if (!name.startsWith('u:')) continue;
    if (name === 'u:dir') {
      // MF2 makes `u:dir` a Bad Option error on markup: markup resolves to no value, so there is
      // nothing for a direction to be a property of.
      if (!allowDirection) {
        invalidMessage(
          `MessageFormat option u:dir is not allowed on ${context}.`,
        );
      }
      if (typeof value !== 'string' || !UNICODE_DIRECTIONS.has(value)) {
        invalidMessage(
          `MessageFormat option u:dir on ${context} must be one of ltr, rtl, auto or inherit.`,
        );
      }
      direction = value as UnicodeOptions['direction'];
      continue;
    }
    if (name === 'u:id') {
      if (typeof value !== 'string') {
        invalidMessage(
          `MessageFormat option u:id on ${context} must be a string.`,
        );
      }
      id = value;
      continue;
    }
    invalidMessage(
      `MessageFormat option ${name} on ${context} is outside the Atlas 1 profile.`,
    );
  }
  return Object.freeze({
    ...(direction === undefined ? {} : { direction }),
    ...(id === undefined ? {} : { id }),
  });
}

function withoutUnicodeOptions(
  options: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const entries = Object.entries(options).filter(
    ([name]) => !name.startsWith('u:'),
  );
  return entries.length === Object.keys(options).length
    ? options
    : Object.freeze(Object.fromEntries(entries));
}

/**
 * Apply `u:dir` and `u:id` to a resolved value.
 *
 * `inherit` is not the same as writing nothing. Written explicitly it says the value is ordinary
 * text of the message's own locale, which turns off the content check `plainResolved` applies by
 * default: the one escape hatch an author has when Atlas isolates something it need not.
 */
function applyUnicodeOptions(
  value: ResolvedValue,
  unicode: UnicodeOptions,
): ResolvedValue {
  if (unicode.direction === undefined && unicode.id === undefined) return value;
  return Object.freeze({
    ...value,
    ...(unicode.direction === undefined
      ? {}
      : unicode.direction === 'inherit'
        ? { contentDirection: value.direction, isolate: false }
        : { contentDirection: unicode.direction, isolate: true }),
    ...(unicode.id === undefined ? {} : { id: unicode.id }),
  });
}

/**
 * Every option, as the string the specification says an option value is.
 *
 * An option can reach here as a literal from the message, as whatever a consumer passed for
 * `maximumFractionDigits=$digits`, or carried on an operand's resolved value. `String` is applied
 * once, here, so `atlasMessageOptionProblem` sees the same shape in all three cases and there is
 * one answer to what a valid option is rather than one per arrival route.
 */
function optionText(
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const text: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    text[name] = typeof value === 'string' ? value : String(value);
  }
  return text;
}

/**
 * Refuse an option this runtime cannot honour, rather than dropping it and formatting anyway.
 *
 * The compiler refuses every option it can see written as a literal, so most of these never get
 * here. What does get here is a value that arrived through a variable, `roundingMode=$mode` with
 * a consumer passing `"nearest"`, and a compiled artifact this runtime did not compile.
 */
function checkFunctionOptions(
  functionName: string,
  options: Readonly<Record<string, string>>,
  written: boolean,
): void {
  const profile = ATLAS_MESSAGE_FUNCTION_OPTIONS[functionName];
  if (profile === undefined) return;
  for (const [name, value] of Object.entries(options)) {
    // An option the function does not define is carried, not applied: the specification puts an
    // operand's options into the resolved options whether or not this function uses them. Written
    // on the expression the same name is a mistake, because nothing will ever read it.
    if (!profile.accepts.includes(name)) {
      if (!written) continue;
      invalidInput(
        profile.accepts.length === 0
          ? `MessageFormat option ${name} is not an option of :${functionName}, which the specification gives none.`
          : `MessageFormat option ${name} is not an option of :${functionName}; ` +
              `it takes ${[...profile.accepts].sort().join(', ')}.`,
      );
    }
    const problem = atlasMessageOptionProblem(functionName, name, value);
    if (problem !== undefined) {
      invalidInput(
        `MessageFormat option ${name}=${JSON.stringify(value)} on :${functionName} ${problem}.`,
      );
    }
  }
}

/**
 * The options a number function is called with, once the operand has had its say.
 *
 * LDML 48 Part 9 lets a numeric operand be "an implementation-defined type, such as the resolved
 * value of an expression with a `:number` or `:integer` annotation", which "can include option
 * values", and resolves the two sets "with options on the expression taking priority over any
 * options of the operand".
 *
 * **`select` is the exception the specification names.** *"If the `select` option is set by an
 * implementation-defined type used as an operand, a Bad Option Error is emitted."* Atlas refuses
 * rather than reports, for the reason it refuses everywhere else: `select` decides which CLDR table
 * a target catalog's plural coverage is checked against, so a message whose selection behaviour
 * arrives by inheritance is one whose translations were checked against the wrong table.
 *
 * The refusal here is the second of two. `packages/toolkit/src/message-format.ts` refuses the same
 * shape when it can see it, which is whenever the declaration chain is written in the message; this
 * one answers for a compiled artifact that did not come through that check.
 *
 * **And the refusal is only for the two functions that have a `select` option.** `:number` and
 * `:integer` define one; `:currency`, `:offset`, `:percent` and `:unit` do not, and `:percent`'s
 * own table says `select` is *discarded* when it arrives from an operand. So
 * `.local $n = {1 :number select=exact}` followed by `{$n :percent}` is a conforming message and
 * is not refused: the option is dropped rather than reported, because a function without a `select`
 * option has no selection behaviour for an inherited one to have decided. The discard lists in
 * `./message-function-options` say which options each function throws away, and they are not
 * the same list.
 *
 * **`:integer`'s three are what keep the message renderable.** `:integer` sets
 * `maximumFractionDigits` to 0, so a `minimumFractionDigits` of 2 arriving from the operand asks
 * `Intl.NumberFormat` for a range with its minimum above its maximum, and it throws. Written on the
 * expression itself they are the author's own contradiction to own; arriving by inheritance they
 * are nobody's, which is why the specification discards exactly these and only from the operand.
 */
/**
 * What one extension call resolves its options to: the operand's, then the expression's over them,
 * narrowed to what the descriptor declares.
 *
 * The narrowing is the part that is Atlas's rather than MessageFormat's. A descriptor is a closed
 * statement of the options a function accepts and `validExtensionOptions` enforces it on the way
 * in, so inheritance must not be a second door an undeclared name walks through. The unnarrowed
 * mapping is still what the resolved value carries forward, because the next annotation in the
 * chain may be a function that does declare the name: narrowing at the call, not at the carry.
 */
function extensionOperandOptions(
  referenced: ReferencedValue | undefined,
  declared: Readonly<Record<string, unknown>>,
  descriptor: RuntimeMessageFunctionDescriptor,
): Readonly<Record<string, unknown>> {
  return atlasInheritedOptions(
    referenced?.kind === 'variable' ? referenced.value.options : undefined,
    declared,
    // The same profile the compiler builds from the same descriptor. Written as one call rather
    // than as a spread that happens to agree with one, because the compiler refusing exactly what
    // this could not honour is the property, and two merges that agree today are two merges.
    atlasExtensionOptionProfile(
      descriptor.operandType as AtlasMessageOperandKind,
      Object.keys(descriptor.options ?? {}),
    ),
  );
}

function declaredOptionsOnly(
  options: Readonly<Record<string, unknown>>,
  descriptor: RuntimeMessageFunctionDescriptor,
): Readonly<Record<string, unknown>> {
  const accepted = descriptor.options ?? {};
  return Object.freeze(
    Object.fromEntries(
      Object.entries(options).filter(([name]) => accepted[name] !== undefined),
    ),
  );
}

function numericOperandOptions(
  referenced: ReferencedValue | undefined,
  declared: Readonly<Record<string, unknown>>,
  functionName: string,
): Readonly<Record<string, unknown>> {
  // Checked here rather than after the merge, because this is the last point at which an option
  // written on the expression can still be told apart from one that arrived on the operand, and
  // only one of the two is the author's mistake.
  checkFunctionOptions(functionName, optionText(declared), true);
  const carried =
    referenced?.kind === 'variable' ? referenced.value.options : undefined;
  if (carried === undefined) return declared;
  const profile = ATLAS_MESSAGE_FUNCTION_OPTIONS[functionName];
  if (
    profile?.accepts.includes('select') === true &&
    carried['select'] !== undefined &&
    declared['select'] === undefined
  ) {
    invalidInput(
      `:${functionName} received a select option from its operand rather than from a literal. ` +
        'MessageFormat does not inherit select, because a message whose selection is decided ' +
        'elsewhere cannot be translated against a known plural table.',
    );
  }
  return atlasInheritedOptions(carried, declared, profile);
}

/**
 * The options a date function is called with, once the operand has had its say.
 *
 * The same shape as the numeric one above and a different inheritance rule, which is the
 * specification's rather than a choice: *"Any operand options not matching the date/time override
 * options are ignored."* `timeZone=input` is answered here too, by the shared function the compiler
 * refuses on, so what renders and what compiles are decided by one piece of code.
 */
function dateOperandOptions(
  referenced: ReferencedValue | undefined,
  declared: Readonly<Record<string, unknown>>,
  functionName: string,
): Readonly<Record<string, string>> {
  const written = optionText(declared);
  checkFunctionOptions(functionName, written, true);
  const carried =
    referenced?.kind === 'variable' ? referenced.value.options : undefined;
  return atlasDateOperandOptions(
    carried === undefined ? undefined : optionText(carried),
    written,
    ATLAS_MESSAGE_FUNCTION_OPTIONS[functionName],
  );
}

/**
 * What a number function's resolved value carries forward, and the one thing it must not.
 *
 * LDML 48 Part 9 on `:offset`: its options are *"not included in the resolved option values"*. They
 * are not display options: they say what was done to the number, and the number they were done to
 * is already the resolved value. Carrying `add` forward would let `.local $a = {41 :offset add=1}`
 * followed by a bare re-annotation add again, which is arithmetic nobody wrote.
 *
 * Everything else is carried, including options this function does not define and `select`, because
 * the specification's rule is inheritance and `:offset` is the only exception it names.
 */
function resolvedNumberOptions(
  functionName: string,
  declared: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const excluded =
    ATLAS_MESSAGE_FUNCTION_OPTIONS[functionName]?.excludedFromResolved ?? [];
  if (excluded.length === 0) return Object.freeze({ ...declared });
  return Object.freeze(
    Object.fromEntries(
      Object.entries(declared).filter(([name]) => !excluded.includes(name)),
    ),
  );
}

/**
 * Which of the numeric functions `.match` may select on, from their own sections in LDML 48 Part 9.
 *
 * `:number` "is a selector and formatter for numeric values", `:integer` and `:offset` say the same
 * of themselves, and `:percent` "is a selector and formatter for percent values". `:currency` "is a
 * _formatter_ for currency values" and `:unit` "is proposed to be a RECOMMENDED formatter for
 * unitized values": formatter, both times, and neither carries the "Selection with" subsection
 * the other four do. One factory serves all six, so the split has to be named here or it is lost.
 */
const NUMERIC_SELECTOR_FUNCTIONS: ReadonlySet<string> = Object.freeze(
  new Set(['number', 'integer', 'offset', 'percent']),
) as ReadonlySet<string>;

function numericResolved(
  raw: unknown,
  functionName: string,
  sourceOptions: Readonly<Record<string, unknown>>,
  environment: EvaluationEnvironment,
): ResolvedValue {
  const operand = numberOperand(raw);
  if (operand === undefined) {
    invalidInput(`:${functionName} requires a number operand.`);
  }
  const declared = optionText(sourceOptions);
  checkFunctionOptions(functionName, declared, false);
  let value = operand;
  const options = atlasNumberFormatOptions(functionName, declared) as Record<
    string,
    unknown
  >;
  switch (functionName) {
    case 'integer':
      value = Math.round(operand);
      break;
    case 'offset': {
      // The specification's own words: the two options "are exclusive with each other, and exactly
      // one option is always required". Their values are digit size options, so the range check is
      // the table's; what is left here is the arithmetic and the count.
      const add = declared['add'];
      const subtract = declared['subtract'];
      if ((add === undefined) === (subtract === undefined)) {
        invalidInput(':offset requires exactly one add or subtract option.');
      }
      value += add === undefined ? -Number(subtract) : Number(add);
      break;
    }
    case 'currency':
      // No default exists for this one, and there is no sensible currency to guess.
      if (declared['currency'] === undefined) {
        invalidInput(':currency requires a currency code.');
      }
      break;
    case 'unit':
      if (declared['unit'] === undefined) {
        invalidInput(':unit requires a unit identifier.');
      }
      break;
    default:
      break;
  }
  // The same tag the direct formatting API builds, and for the same reason. Passing
  // `environment.formatting.locale` bare would ignore `numberingSystem`, so an application that
  // declared one through `withFormattingContext()` would have it honoured by `formatNumber()` and
  // dropped by every `:number`, `:integer`, `:currency`, `:percent` and `:unit` placeholder in
  // every message, which is where almost all of an application's numbers are rendered.
  const formattingTag = formattingLocale(environment.formatting);
  if (formattingTag === undefined) {
    unsupportedFormatting(
      `:${functionName} was asked for the numbering system "${String(
        environment.formatting.numberingSystem,
      )}", which this runtime has no data for.`,
      'native-capability-rejected',
    );
  }
  let formatter: Intl.NumberFormat;
  try {
    formatter = environment.formatterCache.number(
      formattingTag,
      options as Intl.NumberFormatOptions,
    );
  } catch (cause) {
    invalidInput(
      `:${functionName} received unsupported formatting options.`,
      'native-capability-rejected',
      cause,
    );
  }
  const text = formatter.format(value);
  const selectionValue = functionName === 'percent' ? value * 100 : value;
  return Object.freeze({
    raw: value,
    text,
    functionName,
    options: resolvedNumberOptions(functionName, declared),
    locale: environment.formatting.locale,
    direction: directionForLocale(environment.formatting.locale),
    // Atlas formatted this text, in this locale, so it runs the way the locale runs. No sniff.
    contentDirection: directionForLocale(environment.formatting.locale),
    isolate: false,
    selects: NUMERIC_SELECTOR_FUNCTIONS.has(functionName),
    match: (key: string) => {
      if (NUMBER_LITERAL.test(key)) {
        // "Exact Literal Match Serialization": for an integer with no fraction or significant-digit
        // options the serialization is the decimal form, which is what `String` produces. Outside
        // that the spec leaves it implementation-defined and tells authors not to rely on it.
        return key === String(selectionValue);
      }
      if (!PLURAL_KEYWORDS.has(key)) return false;
      // "Rule Selection": `select=exact` disables keyword selection entirely, so no category key
      // matches rather than the cardinal table being consulted as a fallback.
      if (sourceOptions['select'] === 'exact') return false;
      const pluralType =
        sourceOptions['select'] === 'ordinal' ? 'ordinal' : 'cardinal';
      return (
        key ===
        environment.formatterCache
          .plural(environment.formatting.locale, { type: pluralType })
          .select(selectionValue)
      );
    },
    // The one ranking in the default function set: an exact numeric key beats a plural category.
    // `1 {{…}}` wins over `one {{…}}` for n=1 wherever both match, whichever is written first.
    betterThan: (left: string, right: string) =>
      NUMBER_LITERAL.test(left) && !NUMBER_LITERAL.test(right),
  });
}

function dateResolved(
  raw: unknown,
  functionName: 'date' | 'datetime' | 'time',
  resolved: Readonly<Record<string, string>>,
  environment: EvaluationEnvironment,
): ResolvedValue {
  const date = raw instanceof Date ? raw : new Date(raw as number);
  if (!Number.isFinite(date.getTime())) {
    invalidInput(`:${functionName} requires a valid date-time value.`);
  }
  // Still `input` after the merge means nothing in the chain gave the operand a zone. The compiler
  // refuses that where it is written; this answers for a compiled artifact that did not come
  // through it.
  if (resolved['timeZone'] === 'input') {
    invalidInput(
      `:${functionName} was written with timeZone=input and its operand carries no time zone.`,
    );
  }
  const options: Intl.DateTimeFormatOptions = {
    ...(environment.formatting.timeZone === undefined
      ? {}
      : { timeZone: environment.formatting.timeZone }),
    ...(environment.formatting.calendar === undefined
      ? {}
      : { calendar: environment.formatting.calendar }),
    // `hour12` and `hourCycle` describe the same thing and ECMA-402 lets the first win. Dropping
    // the context's cycle when the message writes `hour12` says so, rather than sending both and
    // relying on the precedence rule staying where it is.
    ...(environment.formatting.hourCycle === undefined ||
    (functionName !== 'date' && resolved['hour12'] !== undefined)
      ? {}
      : { hourCycle: environment.formatting.hourCycle }),
    // The message's own options, mapped by the function the compiler calls with the same input.
    // The components, the month length and the precision are all that mapping, and a second copy
    // of it here is how `fields`, `timeZoneStyle` and four other options come to be accepted and
    // never read.
    ...atlasDateTimeFormatOptions(functionName, resolved),
  };
  if (options.timeZone === undefined) {
    unsupportedFormatting(
      `:${functionName} requires an explicit deterministic time zone.`,
    );
  }
  // Same tag as the numeric path above. `DateTimeFormat` does honour the `numberingSystem` option,
  // so this is not a fix: it is the same construction everywhere, so that no future surface can
  // be the one nobody remembered to update.
  const formattingTag = formattingLocale(environment.formatting);
  if (formattingTag === undefined) {
    unsupportedFormatting(
      `:${functionName} was asked for the numbering system "${String(
        environment.formatting.numberingSystem,
      )}", which this runtime has no data for.`,
      'native-capability-rejected',
    );
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = environment.formatterCache.dateTime(formattingTag, options);
  } catch (cause) {
    invalidInput(
      `:${functionName} received unsupported formatting options.`,
      'native-capability-rejected',
      cause,
    );
  }
  return Object.freeze({
    raw: date,
    text: formatter.format(date),
    functionName,
    locale: environment.formatting.locale,
    direction: directionForLocale(environment.formatting.locale),
    // Atlas formatted this text, in this locale, so it runs the way the locale runs. No sniff.
    contentDirection: directionForLocale(environment.formatting.locale),
    isolate: false,
    // Carried so a later annotation can read the three date/time override options off it, which is
    // what `timeZone=input` names and what a `:datetime` feeding a `:time` would otherwise lose.
    options: resolved,
    // Date and time values do not support selection: MF2 gives them no Match, so a `.match` on one
    // is a Bad Selector and only the catch-all can be chosen.
    selects: false,
    match: () => false,
    betterThan: () => false,
  });
}

function resolveExpression(
  expression: unknown,
  environment: EvaluationEnvironment,
): ResolvedValue {
  tick(environment);
  if (!isRecord(expression) || expression['kind'] !== 'expression') {
    return invalidMessage('A compiled message expression is invalid.');
  }
  const referenced =
    expression['operand'] === undefined
      ? undefined
      : readReference(expression['operand'], environment);
  const raw =
    referenced === undefined ? undefined : referencedOperand(referenced);
  if (expression['function'] === undefined) {
    // A bare `{$foo}` is the declaration's resolved value, not a fresh reading of its operand.
    // `.local $n = {$v :number minimumFractionDigits=2}` followed by `{{bar {$n}}}` printed `4.2`
    // where the declaration had already produced `4.20`, and `.local $w = {world :string u:dir=ltr}`
    // lost the isolation the author had asked for by name. Selection read the resolved value and
    // formatting did not, so a message could choose the right variant and print the wrong number in
    // it.
    if (referenced?.kind === 'variable') return referenced.value;
    return plainResolved(
      raw,
      environment.formatting.locale,
      directionForLocale(environment.formatting.locale),
    );
  }
  if (!isRecord(expression['function'])) {
    return invalidMessage('A compiled message function is invalid.');
  }
  environment.functions += 1;
  if (environment.functions > RUNTIME_LIMITS.evaluationFunctions) {
    return invalidMessage(
      'Message evaluation exceeded the fixed function ceiling.',
    );
  }
  const name = expression['function']['name'];
  if (typeof name !== 'string') {
    return invalidMessage('A compiled message function name is invalid.');
  }
  const declared = readOptions(expression['function']['options'], environment);
  // MF2: `u:` options "MUST be removed from the resolved mapping of options" before the function
  // handler is called. Not a tidiness measure: a custom function's descriptor declares the
  // options it accepts, and leaving `u:dir` in the mapping would fail that contract for using a
  // feature of the message syntax rather than of the function.
  const unicode = unicodeOptions(declared, `:${name}`, true);
  const options = withoutUnicodeOptions(declared);
  switch (name) {
    case 'string':
      // *"The function `:string` has no options."* Checked rather than ignored: an option written
      // here can never be read by anything, and accepting it renders the message as though the
      // author had not written it.
      checkFunctionOptions('string', optionText(options), true);
      return applyUnicodeOptions(
        plainResolved(
          raw,
          environment.formatting.locale,
          directionForLocale(environment.formatting.locale),
        ),
        unicode,
      );
    case 'currency':
    case 'integer':
    case 'number':
    case 'offset':
    case 'percent':
    case 'unit':
      return applyUnicodeOptions(
        numericResolved(
          raw,
          name,
          numericOperandOptions(referenced, options, name),
          environment,
        ),
        unicode,
      );
    case 'date':
    case 'datetime':
    case 'time':
      return applyUnicodeOptions(
        dateResolved(
          raw,
          name,
          dateOperandOptions(referenced, options, name),
          environment,
        ),
        unicode,
      );
    default: {
      const binding = environment.extensions.messageFunction(name);
      if (binding === undefined) {
        return invalidMessage(
          `Compiled message function :${name} is unsupported.`,
        );
      }
      // A descriptor asking for a numeric operand is asking for MessageFormat's Number Operand, so a
      // literal written in the message resolves the same way it does for `:number`. Without this an
      // extension could be handed `{$count :feature:thing}` and never `{42 :feature:thing}`, which
      // is the defect `numberOperand` exists to close, sitting one layer out in code the conformance
      // suite reaches only through a custom function.
      const operand =
        binding.descriptor.operandType === 'number' ||
        binding.descriptor.operandType === 'integer'
          ? (numberOperand(raw) ?? raw)
          : raw;
      if (
        !matchesExtensionType(operand, binding.descriptor.operandType) ||
        !validExtensionOptions(options, binding.descriptor)
      ) {
        return invalidMessage(
          `Custom message function :${name} received an operand or options outside its descriptor contract.`,
        );
      }
      // Everything the chain carries, for the resolved value; only what this descriptor declares,
      // for the call. `validExtensionOptions` above already judged the expression's own options.
      const resolvedOptions = extensionOperandOptions(
        referenced,
        options,
        binding.descriptor,
      );
      const invocation = Object.freeze({
        operand,
        options: declaredOptionsOnly(resolvedOptions, binding.descriptor),
        locale: environment.formatting.locale,
        formatting: environment.formatting,
      });
      let result: unknown;
      try {
        result = binding.evaluate(invocation);
      } catch (cause) {
        return invalidMessage(
          `Custom message function :${name} failed during deterministic evaluation.`,
          'consumer-code-threw',
          cause,
        );
      }
      if (!isRecord(result)) {
        return invalidMessage(
          `Custom message function :${name} returned an invalid or unbounded result.`,
        );
      }
      const selectKeys = result['selectKeys'];
      const selectsExactly = binding.descriptor.selector === 'exact';
      if (
        typeof result['text'] !== 'string' ||
        codePointLengthAtMost(
          result['text'],
          binding.descriptor.maximumOutputLength,
        ) === undefined ||
        (selectKeys !== undefined &&
          (!Array.isArray(selectKeys) ||
            selectKeys.length > RUNTIME_LIMITS.extensionSelectKeys ||
            selectKeys.some((key) => typeof key !== 'string') ||
            new Set(selectKeys).size !== selectKeys.length)) ||
        (selectsExactly
          ? !Array.isArray(selectKeys)
          : selectKeys !== undefined) ||
        typeof (result as { readonly then?: unknown }).then === 'function'
      ) {
        return invalidMessage(
          `Custom message function :${name} returned an invalid or unbounded result.`,
        );
      }
      // Narrowed to `string[]` by the guard above; read once so `match` and `betterThan` are
      // answering from the same list rather than re-reading an object the extension still holds.
      const matching: readonly string[] = selectsExactly
        ? Object.freeze([...(selectKeys as readonly string[])])
        : Object.freeze([]);
      const resultValue = result['value'] ?? operand;
      if (!matchesExtensionType(resultValue, binding.descriptor.resultType)) {
        return invalidMessage(
          `Custom message function :${name} returned a value outside its descriptor contract.`,
        );
      }
      return applyUnicodeOptions(
        Object.freeze({
          raw: resultValue,
          text: result['text'],
          functionName: name,
          locale: environment.formatting.locale,
          direction: directionForLocale(environment.formatting.locale),
          // A custom function is handed the formatting context and formats in that locale, the
          // same as a built-in one. `u:dir` overrides this where the extension knows better.
          contentDirection: directionForLocale(environment.formatting.locale),
          isolate: false,
          selects: selectsExactly,
          options: resolvedOptions,
          match: (key: string) => matching.includes(key),
          // MF2 BetterThan, read off the order the function gave: it is only asked about two keys
          // that both match, so the earlier of the two is the one the function preferred.
          betterThan: (left: string, right: string) =>
            matching.indexOf(left) < matching.indexOf(right),
        }),
        unicode,
      );
    }
  }
}

function initializeEnvironment(
  message: CompiledMessage,
  inputs: unknown,
  candidate: EvaluationCandidate,
  formatting: FormattingContext,
  formatterCache: FormatterCache,
  extensions: RuntimeExtensions,
): EvaluationEnvironment {
  const record = inputs === undefined ? {} : inputs;
  if (!isRecord(record)) invalidInput('Message inputs must be an object.');
  const contracts = new Map(message.inputs.map((input) => [input.name, input]));
  for (const name of Object.keys(record)) {
    if (!contracts.has(name)) invalidInput(`Unknown message input ${name}.`);
  }
  const values = new Map<string, ResolvedValue>();
  for (const contract of message.inputs) {
    const value = record[contract.name];
    if (!isValidInput(value, contract)) {
      invalidInput(
        `Message input ${contract.name} does not satisfy its generated contract.`,
      );
    }
    values.set(
      contract.name,
      plainResolved(
        value,
        formatting.locale,
        directionForLocale(formatting.locale),
      ),
    );
  }
  return {
    values,
    supplyingLocale: candidate.catalog.key.catalogLocale,
    supplyingDirection: directionForLocale(candidate.catalog.key.catalogLocale),
    formatting,
    formatterCache,
    extensions,
    maximumParts: Math.max(
      1,
      Math.min(
        RUNTIME_LIMITS.outputParts,
        candidate.catalog.resources.maximumMessage.outputParts,
      ),
    ),
    parts: 0,
    steps: 0,
    references: 0,
    functions: 0,
    literals: 0,
    outputCodePoints: 0,
  };
}

function applyDeclarations(
  declarations: unknown,
  environment: EvaluationEnvironment,
): void {
  if (!Array.isArray(declarations))
    invalidMessage('Message declarations are invalid.');
  for (const declaration of declarations) {
    tick(environment);
    if (
      !isRecord(declaration) ||
      !['input', 'local'].includes(String(declaration['kind'])) ||
      typeof declaration['name'] !== 'string'
    ) {
      invalidMessage('A message declaration is invalid.');
    }
    environment.values.set(
      declaration['name'],
      resolveExpression(declaration['value'], environment),
    );
  }
}

/**
 * LDML 48 Part 9, Formatting > Pattern Selection > `NormalizeKey`: *"Let `k1` be the result of
 * applying Unicode Normalization Form C [UAX#15] to `k`."*
 *
 * The citation is the point of this function existing. `NormalizeKey` is a step the standard gives
 * to whatever performs selection, and selection is performed here, so this is Atlas implementing
 * a rule it is required to implement, not Atlas repeating work a dependency happens to have done.
 * The two read the same from the outside and are not the same thing: one is a guarantee, the other
 * is a coincidence that holds until someone changes a version.
 *
 * It belongs on the key, which is where the spec puts it. Atlas applied it to the *value* instead,
 * so a key authored in NFD never matched a value equal to it and fell through to the catch-all.
 *
 * **Where this can fail, since no catalog compiled here will ever reach it.** `messageformat`'s
 * parser normalizes a variant key while parsing, so a key authored in NFD is already NFC by the
 * time it is compiled, which makes every conformance case that looks like it certifies this line
 * pass without executing anything it does. That is not a reason to remove the line: the runtime is
 * a separately published package whose input is a compiled artifact, and a runtime that assumes
 * every artifact came from this toolkit, at this version, is trusting something it has no way to
 * check. It is a reason to say where the guarantee is actually tested, which is
 * `packages/runtime/test/pattern-selection.test.ts`: an artifact assembled by hand with an NFD
 * key, because the compiler cannot emit one. Removing this line fails that case and no other. The
 * parser's own behaviour is pinned separately in
 * `packages/toolkit/test/message-format.test.ts`, so a version that stops normalizing is a failing
 * test rather than a silent change of which layer the conformance cases were testing.
 */
function normalizeKey(key: string): string {
  return key.normalize('NFC');
}

/**
 * One variant's keys, with the catch-all `*` carried as `undefined`.
 *
 * `undefined` rather than the literal `'*'` because the catch-all is not a key that happens to be
 * spelled that way: it matches everything and loses every comparison, and a real key could be the
 * string `'*'`.
 */
type VariantKeys = readonly (string | undefined)[];

function variantKeys(
  keys: readonly unknown[],
  arity: number,
  environment: EvaluationEnvironment,
): VariantKeys {
  if (keys.length !== arity) {
    invalidMessage('A message variant has the wrong selector arity.');
  }
  return keys.map((key) => {
    tick(environment);
    if (!isRecord(key)) invalidMessage('A message variant key is invalid.');
    if (key['kind'] === 'catchall') return undefined;
    if (key['kind'] !== 'literal' || typeof key['value'] !== 'string') {
      invalidMessage('A message variant key is invalid.');
    }
    return normalizeKey(key['value']);
  });
}

/** MF2 `SelectorsMatch`: every key that is not the catch-all matches its own selector. */
function selectorsMatch(
  selectors: readonly ResolvedValue[],
  keys: VariantKeys,
  environment: EvaluationEnvironment,
): boolean {
  for (const [index, key] of keys.entries()) {
    tick(environment);
    if (key === undefined) continue;
    if (!(selectors[index] as ResolvedValue).match(key)) return false;
  }
  return true;
}

/**
 * MF2 `SelectorsCompare`: is `keys` a stronger match than `against`?
 *
 * Both are known to match. The walk is left to right and stops at the first position where the two
 * differ, so an earlier selector outranks a later one.
 */
function selectorsCompare(
  selectors: readonly ResolvedValue[],
  keys: VariantKeys,
  against: VariantKeys,
  environment: EvaluationEnvironment,
): boolean {
  for (const [index, key] of keys.entries()) {
    tick(environment);
    const other = against[index];
    if (key === undefined) {
      // Catch-all against catch-all is a tie at this position; against a real key it loses.
      if (other === undefined) continue;
      return false;
    }
    if (other === undefined) return true;
    if (key === other) continue;
    return (selectors[index] as ResolvedValue).betterThan(key, other);
  }
  return false;
}

/**
 * MF2 "Resolve Selectors" followed by "Compare Variants".
 *
 * Every variant is walked and a provisional best is kept, rather than returning the first variant
 * whose keys all match. Returning the first lets source order decide the result, so `* {{…}}`
 * written above `one {{…}}` wins for n=1, and so does `one {{…}}` written above `1 {{…}}`, the
 * second because the ranking that says an exact key beats a category is then asked to choose
 * between a set of one key.
 *
 * Ties keep the earlier variant, because a later variant is only taken when it compares strictly
 * better.
 */
function selectPattern(
  body: IrRecord,
  environment: EvaluationEnvironment,
): readonly unknown[] {
  if (!Array.isArray(body['selectors']) || !Array.isArray(body['variants'])) {
    return invalidMessage('A select message is invalid.');
  }
  const selectors = body['selectors'].map((name) => {
    tick(environment);
    if (typeof name !== 'string') invalidMessage('A selector name is invalid.');
    const value = environment.values.get(name);
    if (value === undefined) invalidMessage(`Selector ${name} is unavailable.`);
    if (!value.selects) {
      invalidMessage(
        value.functionName === undefined
          ? `Selector ${name} resolved to a value that does not support selection.`
          : `Selector ${name} was annotated with :${value.functionName}, which formats but does not select.`,
      );
    }
    return value;
  });
  let bestPattern: readonly unknown[] | undefined;
  let bestKeys: VariantKeys | undefined;
  for (const variant of body['variants']) {
    tick(environment);
    if (!isRecord(variant) || !Array.isArray(variant['keys'])) {
      invalidMessage('A message variant is invalid.');
    }
    const keys = variantKeys(variant['keys'], selectors.length, environment);
    if (!selectorsMatch(selectors, keys, environment)) continue;
    if (
      bestKeys !== undefined &&
      !selectorsCompare(selectors, keys, bestKeys, environment)
    ) {
      continue;
    }
    if (!Array.isArray(variant['pattern'])) {
      invalidMessage('A message variant pattern is invalid.');
    }
    bestPattern = variant['pattern'];
    bestKeys = keys;
  }
  if (bestPattern === undefined) {
    return invalidMessage(
      'A select message has no matching catch-all variant.',
    );
  }
  return bestPattern;
}

function incrementParts(environment: EvaluationEnvironment): void {
  tick(environment);
  environment.parts += 1;
  if (environment.parts > environment.maximumParts) {
    invalidMessage(
      'Message evaluation exceeded its generated output-part bound.',
    );
  }
}

function textPart(
  value: string,
  environment: EvaluationEnvironment,
): LocalizedTextPart {
  incrementParts(environment);
  countOutput(environment, value);
  return Object.freeze({
    kind: 'text',
    value,
    language: languageForLocale(environment.supplyingLocale),
    direction: environment.supplyingDirection,
    supplyingLocale: environment.supplyingLocale,
  });
}

function valuePart(
  value: ResolvedValue,
  environment: EvaluationEnvironment,
): LocalizedValuePart {
  incrementParts(environment);
  countOutput(environment, value.text);
  return Object.freeze({
    kind: 'value',
    value: value.text,
    ...(value.functionName === undefined
      ? {}
      : { functionName: value.functionName }),
    language: languageForLocale(value.locale),
    direction: value.direction,
    contentDirection: value.contentDirection,
    isolate: value.isolate,
    ...(value.id === undefined ? {} : { id: value.id }),
    supplyingLocale: value.locale,
  });
}

/**
 * The presentation a markup slot carries: its declared options, and its `u:id` if it has one.
 *
 * `u:id` is lifted out of the option mapping rather than left in it. A slot's options are the
 * contract between the message and the consumer's binding, and `u:id` is neither: it belongs to
 * the message syntax, and a binding that read it as an option would be reading a name it never
 * declared.
 */
interface SlotPresentation {
  readonly options: Readonly<Record<string, string>>;
  readonly id?: string;
}

function slotOptions(
  value: unknown,
  environment: EvaluationEnvironment,
): SlotPresentation {
  const declared = readOptions(value, environment);
  const unicode = unicodeOptions(declared, 'markup', false);
  return Object.freeze({
    options: Object.freeze(
      Object.fromEntries(
        Object.entries(withoutUnicodeOptions(declared)).map(
          ([name, option]) => [name, String(option)],
        ),
      ),
    ),
    ...(unicode.id === undefined ? {} : { id: unicode.id }),
  });
}

interface MutableSlotFrame {
  readonly contract: CompiledSlotContract;
  readonly options: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly children: LocalizedPart[];
}

function freezeSlot(
  frame: MutableSlotFrame,
  environment: EvaluationEnvironment,
): LocalizedSlotPart {
  incrementParts(environment);
  return Object.freeze({
    kind: 'slot',
    name: frame.contract.name,
    slotKind: frame.contract.kind,
    shape: frame.contract.shape,
    children: Object.freeze(frame.children),
    options: frame.options,
    ...(frame.id === undefined ? {} : { id: frame.id }),
    language: languageForLocale(environment.supplyingLocale),
    direction: environment.supplyingDirection,
    supplyingLocale: environment.supplyingLocale,
  });
}

function evaluatePattern(
  pattern: readonly unknown[],
  slots: readonly CompiledSlotContract[],
  resultKind: 'plain' | 'structured',
  environment: EvaluationEnvironment,
): readonly LocalizedPart[] {
  const contracts = new Map(slots.map((slot) => [slot.name, slot]));
  const root: LocalizedPart[] = [];
  const stack: MutableSlotFrame[] = [];
  const destination = () => stack.at(-1)?.children ?? root;
  for (const part of pattern) {
    tick(environment);
    if (typeof part === 'string') {
      destination().push(textPart(part, environment));
      continue;
    }
    if (!isRecord(part)) invalidMessage('A message pattern part is invalid.');
    if (part['kind'] === 'expression') {
      destination().push(
        valuePart(resolveExpression(part, environment), environment),
      );
      continue;
    }
    if (
      part['kind'] !== 'markup' ||
      typeof part['name'] !== 'string' ||
      typeof part['markupKind'] !== 'string'
    ) {
      invalidMessage('A structured message part is invalid.');
    }
    if (resultKind !== 'structured') {
      invalidMessage('A plain message cannot contain semantic slots.');
    }
    const contract = contracts.get(part['name']);
    if (contract === undefined)
      invalidMessage('A message uses an undeclared slot.');
    switch (part['markupKind']) {
      case 'open':
        if (contract.shape !== 'paired') invalidMessage('Slot shape mismatch.');
        stack.push({
          contract,
          ...slotOptions(part['options'], environment),
          children: [],
        });
        break;
      case 'standalone':
        if (contract.shape !== 'standalone')
          invalidMessage('Slot shape mismatch.');
        destination().push(
          freezeSlot(
            {
              contract,
              ...slotOptions(part['options'], environment),
              children: [],
            },
            environment,
          ),
        );
        break;
      case 'close': {
        const frame = stack.pop();
        if (frame === undefined || frame.contract.name !== contract.name) {
          invalidMessage('Structured message slots are not correctly nested.');
        }
        destination().push(freezeSlot(frame, environment));
        break;
      }
      default:
        invalidMessage('A structured message markup kind is invalid.');
    }
  }
  if (stack.length > 0)
    invalidMessage('A structured message slot is unclosed.');
  return Object.freeze(root);
}

export function projectLocalizedParts(
  parts: readonly LocalizedPart[],
  extensions?: RuntimeExtensions,
  messageDirection: LocaleDirection = 'ltr',
): string {
  const projected: string[] = [];
  let count = 0;
  let visited = 0;
  const append = (value: string): void => {
    const length = codePointLengthAtMost(
      value,
      RUNTIME_LIMITS.outputCodePoints - count,
    );
    if (length === undefined) {
      invalidMessage(
        'Localized text projection exceeded the fixed output ceiling.',
      );
    }
    count += length;
    projected.push(value);
  };
  const visit = (values: readonly LocalizedPart[], depth: number): void => {
    if (depth > RUNTIME_LIMITS.jsonDepth) {
      invalidMessage(
        'Localized text projection exceeded the fixed depth ceiling.',
      );
    }
    for (const part of values) {
      visited += 1;
      if (visited > RUNTIME_LIMITS.outputParts) {
        invalidMessage(
          'Localized text projection exceeded the fixed part ceiling.',
        );
      }
      switch (part.kind) {
        case 'text':
          append(part.value);
          break;
        case 'value':
          append(isolatedValueText(part, messageDirection));
          break;
        case 'slot': {
          const extensionProjection = extensions?.projectSlot(part);
          if (extensionProjection === undefined) {
            visit(part.children, depth + 1);
          } else {
            append(extensionProjection);
          }
          break;
        }
      }
    }
  };
  visit(parts, 1);
  return projected.join('');
}

/** The three directional isolates, and the terminator all three share. */
const LRI = '\u2066';
const RLI = '\u2067';
const FSI = '\u2068';
const PDI = '\u2069';

/**
 * Bidi formatting controls: the isolates above, plus the embeddings and overrides.
 *
 * `\p{Bidi_Control}` rather than a written range, and the difference is not stylistic. The written
 * one covered U+202A..U+202E and U+2066..U+2069 and missed U+061C ARABIC LETTER MARK, U+200E LEFT-TO-
 * RIGHT MARK and U+200F RIGHT-TO-LEFT MARK, and U+200F was named in this defect's own evidence as
 * one of the code points the isolation rules failed to see. The property is the definition; a range
 * list is a copy of it.
 */
const BIDI_CONTROL = /\p{Bidi_Control}/u;

/**
 * Characters that carry an inherent right-to-left direction.
 *
 * Generated from `RTL_SCRIPTS`, the same table `locale-profile.ts` trusts to decide whether a
 * *locale* runs right to left, so one table decides whether a *locale* and whether a *value* run
 * that way. A written list of Unicode blocks is a copy of that table maintained by hand, and a copy
 * omits U+0860..U+086A and U+0870..U+088F, added in Unicode 10 and 14, with nothing comparing the
 * two.
 */
const STRONG_RTL = new RegExp(RTL_STRONG_CHARACTERS, 'u');

/**
 * Whether a value's own content can reposition the text around it.
 *
 * Only consulted for values Atlas did not format: a consumer's string, where Atlas has no locale
 * to take a direction from and will not claim to know the language. MessageFormat 2 says
 * directionality "SHOULD NOT be determined by introspecting the character sequence", and the
 * alternative it offers is the operand's locale, which Atlas does not have: an interpolated value
 * inherits the message's locale, so consulting it answers "the message's direction" every time and
 * isolates nothing. `u:dir` is the author's way to say what this cannot know, and writing
 * `u:dir=inherit` turns this off.
 *
 * Exported for the check that enumerates every letter in Unicode against `RTL_SCRIPTS`. That check
 * has to reach the sniff the runtime performs: rebuilding the class from the generated constant
 * would show the generated data is current and show nothing about whether this file still reads it.
 * `evaluator.ts` is internal, so nothing here reaches the package surface.
 */
export function mayReorder(text: string): boolean {
  return STRONG_RTL.test(text) || BIDI_CONTROL.test(text);
}

/**
 * MessageFormat 2's Default Bidi Strategy, applied to one value part.
 *
 * The structured component wraps every value in `<bdi>`, which stops an order reference or a
 * customer name from reordering the sentence it sits in. The pipe returns a string and has no
 * element to carry that, so the same value was left bare on that path. An isolate is the
 * string-level equivalent of `<bdi>`, and applying it in the formatter means Atlas owns
 * isolation rather than every call site remembering it.
 *
 * The strategy, verbatim in shape:
 *
 * - a right-to-left value is always isolated, because it repositions the neutrals around it
 *   whichever way the message runs;
 * - a value of unknown direction is always isolated, and with FSI, so the renderer's first-strong
 *   rule decides;
 * - a left-to-right value is isolated only in a right-to-left message, or where the author asked
 *   for it with `u:dir`.
 *
 * That last line is the one that keeps a wholly English application free of invisible characters,
 * and it is a real trade rather than a convenience. `<bdi>` is free in the DOM because
 * `textContent` does not show it, while these characters are visible to every string comparison a
 * consumer writes. Isolating where isolation means nothing buys no safety and costs every
 * assertion.
 *
 * What this no longer does is decide isolation from the message's direction. "Every value in a
 * right-to-left message" and "any value with a right-to-left character" were two different rules
 * standing in for one missing fact, the direction of the value itself, and both are now that
 * fact, carried on the part.
 */
function isolatedValueText(
  part: LocalizedValuePart,
  messageDirection: LocaleDirection,
): string {
  // An empty value has no content to run in either direction, and two invisible characters around
  // nothing is not isolation.
  if (part.value.length === 0) return part.value;
  if (part.contentDirection === 'auto') return `${FSI}${part.value}${PDI}`;
  if (part.contentDirection === 'rtl') return `${RLI}${part.value}${PDI}`;
  return messageDirection === 'ltr' && !part.isolate
    ? part.value
    : `${LRI}${part.value}${PDI}`;
}

function metadata(candidate: EvaluationCandidate): LocalizedMetadata {
  const supplyingLocale = candidate.catalog.key.catalogLocale;
  const fallback = supplyingLocale !== candidate.targetLocale;
  const diagnostics: readonly LocalizationDiagnostic[] = fallback
    ? Object.freeze([
        Object.freeze({
          code: 'message-unavailable' as const,
          outcome: 'localized-representation-unavailable' as const,
          message:
            'The target translation is unavailable; the compatible source message supplied the result.',
          targetLocale: safeDiagnosticIdentifier(candidate.targetLocale),
          supplyingLocale: safeDiagnosticIdentifier(supplyingLocale),
          providerId: safeDiagnosticIdentifier(
            candidate.catalog.key.providerId,
          ),
          scopeId: safeDiagnosticIdentifier(candidate.catalog.key.scopeId),
        }),
      ])
    : Object.freeze([]);
  return {
    targetLocale: candidate.targetLocale,
    supplyingLocale,
    language: languageForLocale(supplyingLocale),
    direction: directionForLocale(supplyingLocale),
    attemptedLocales: Object.freeze([...candidate.attemptedLocales]),
    fallback,
    diagnostics,
  };
}

/**
 * Which catalogs a scope consults for one target locale, and in what order.
 *
 * The locale's own first, then each locale it inherits from that this scope ships a catalog for,
 * then the source. `available` answers whether a catalog exists, because which artifacts a scope
 * has is a fact about the store rather than about the locales.
 *
 * `inherited` is the part of that order the target locale genuinely inherits from, itself
 * included. A strict policy accepts a message from any of those and refuses one from anywhere
 * else, and a scope whose `inherited` is empty is being served entirely by the source language,
 * which is what `degraded` reports. Keeping the two together is the point of returning both: the
 * order and the question "was this the locale's own answer" have to be decided from the same walk,
 * or a release gate and a strict runtime can disagree about the same project.
 *
 * The source is appended rather than inserted, unless the chain already reached it: a source
 * locale that is genuinely a parent keeps its place, and one that is not is consulted last.
 */
export interface CatalogConsultationOrder {
  readonly locales: readonly string[];
  readonly inherited: ReadonlySet<string>;
}

export function catalogConsultationOrder(
  targetLocale: string,
  inheritsFrom: readonly string[],
  sourceLocale: string,
  available: (locale: string) => boolean,
): CatalogConsultationOrder {
  const inherited = [targetLocale, ...inheritsFrom].filter(
    (locale, index, all) => all.indexOf(locale) === index && available(locale),
  );
  return Object.freeze({
    locales: Object.freeze(
      inherited.includes(sourceLocale)
        ? [...inherited]
        : [...inherited, sourceLocale],
    ),
    inherited: new Set(inherited),
  });
}

/**
 * The first catalog in the consulting order that carries this message.
 *
 * The order is the scope's, decided when the locale was activated: the locale's own catalog, then
 * each parent locale that ships one, then the source. Walking it here rather than trying a target
 * and then a source is what makes `en-AU` render a string `en` has in English rather than in the
 * source language, which is what CLDR inheritance means and what a reader of "falls back to its
 * parent" expects.
 *
 * `attemptedLocales` records every locale consulted up to the one that answered, starting with the
 * target locale even when no catalog for it exists, because a reader of the metadata is asking
 * what was tried rather than what was loaded.
 */
export function findEvaluationCandidate(
  handle: MessageHandle,
  targetLocale: string,
  catalogs: readonly CompiledCatalog[],
): EvaluationCandidate {
  const attempted: string[] = [targetLocale];
  for (const catalog of catalogs) {
    const locale = catalog.key.catalogLocale;
    if (locale !== targetLocale) attempted.push(locale);
    const message = catalog.messages.find(
      ({ messageId }) => messageId === handle.messageId,
    );
    if (message !== undefined) {
      return {
        catalog,
        message,
        targetLocale,
        attemptedLocales: Object.freeze([...attempted]),
      };
    }
  }
  throw new LocalizationError(
    Object.freeze({
      code: 'message-unavailable',
      outcome: 'localized-representation-unavailable',
      message: 'No compatible generated message representation is available.',
      targetLocale: safeDiagnosticIdentifier(targetLocale),
      providerId: safeDiagnosticIdentifier(handle.providerId),
      scopeId: safeDiagnosticIdentifier(handle.scopeId),
    }),
  );
}

export function evaluateCandidate(
  handle: MessageHandle,
  candidate: EvaluationCandidate,
  inputs: unknown,
  formatting: FormattingContext,
  formatterCache: FormatterCache,
  extensions: RuntimeExtensions,
): LocalizedText | LocalizedParts {
  try {
    return evaluateCandidateInternal(
      handle,
      candidate,
      inputs,
      formatting,
      formatterCache,
      extensions,
    );
  } catch (error) {
    // The evaluator's failure helpers are called from dozens of places that do not hold the
    // handle. Naming the message once here is what makes an evaluator diagnostic actionable,
    // and it is the only place the identity is reliably in scope.
    if (
      error instanceof LocalizationError &&
      error.diagnostic.messageIdentity === undefined
    ) {
      throw new LocalizationError(
        Object.freeze({
          ...error.diagnostic,
          messageIdentity: safeDiagnosticIdentifier(handle.identity),
          providerId:
            error.diagnostic.providerId ??
            safeDiagnosticIdentifier(handle.providerId),
          scopeId:
            error.diagnostic.scopeId ??
            safeDiagnosticIdentifier(handle.scopeId),
        }),
        { cause: error.cause ?? error },
      );
    }
    throw error;
  }
}

function evaluateCandidateInternal(
  handle: AsReceived<MessageHandle, 'generatedAbi'>,
  candidate: EvaluationCandidate,
  inputs: unknown,
  formatting: FormattingContext,
  formatterCache: FormatterCache,
  extensions: RuntimeExtensions,
): LocalizedText | LocalizedParts {
  const { message } = candidate;
  if (
    handle.generatedAbi !== candidate.catalog.generatedAbi ||
    handle.providerId !== candidate.catalog.key.providerId ||
    handle.scopeId !== candidate.catalog.key.scopeId ||
    handle.resultKind !== message.resultKind
  ) {
    return invalidMessage(
      'The generated handle is incompatible with its active catalog.',
    );
  }
  const environment = initializeEnvironment(
    message,
    inputs,
    candidate,
    formatting,
    formatterCache,
    extensions,
  );
  if (message.kind === 'empty') {
    const common = metadata(candidate);
    return Object.freeze(
      message.resultKind === 'plain'
        ? { ...common, kind: 'text', value: '' }
        : { ...common, kind: 'parts', value: Object.freeze([]), text: '' },
    );
  }
  if (!isRecord(message.body))
    invalidMessage('Compiled message body is invalid.');
  applyDeclarations(message.body['declarations'], environment);
  const pattern =
    message.body['kind'] === 'pattern'
      ? message.body['pattern']
      : message.body['kind'] === 'select'
        ? selectPattern(message.body, environment)
        : invalidMessage('Compiled message body kind is invalid.');
  if (!Array.isArray(pattern))
    invalidMessage('Compiled message pattern is invalid.');
  const parts = evaluatePattern(
    pattern,
    message.slots,
    message.resultKind,
    environment,
  );
  const common = metadata(candidate);
  const text = projectLocalizedParts(
    parts,
    extensions,
    directionForLocale(environment.formatting.locale),
  );
  return Object.freeze(
    message.resultKind === 'plain'
      ? { ...common, kind: 'text', value: text }
      : { ...common, kind: 'parts', value: parts, text },
  );
}
