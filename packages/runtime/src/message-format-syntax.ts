/**
 * The MessageFormat 2 lexical productions Atlas needs on both sides of its package boundary, and
 * the one rule for reading a typed value out of a literal.
 *
 * `packages/runtime` cannot import from `packages/toolkit`: the toolkit is a build-time tool with
 * `ajv`, `yaml` and `messageformat` behind it and none of that belongs in a browser bundle. So this
 * file is duplicated, as `message-function-options.ts` is, and
 * `packages/runtime/test/message-function-options.test.ts` compares every twin in the repository
 * byte for byte. Duplication without a check is drift with a delay on it.
 *
 * Everything here is transcribed from the pinned LDML 48.2 `message.abnf` and the function
 * definitions beside it, not summarized from them.
 */

/**
 * The declared type of an extension operand or option value.
 *
 * Declared here rather than imported, because this file is byte-identical in two packages that
 * cannot import from each other, and each already publishes its own copy of this union on its own
 * public contract. Three spellings of one five-member union would be two too many if anything could
 * drift; nothing can, because every call site that hands one package's union to this file is
 * typechecked against it and a mismatch is a compile error rather than a behaviour.
 */
export type ExtensionValueType =
  | 'boolean'
  | 'date-time'
  | 'integer'
  | 'number'
  | 'string';

/* ------------------------------------------------------------------ *
 * `name`                                                              *
 * ------------------------------------------------------------------ */

/**
 * ```abnf
 * name       = [bidi] name-start *name-char [bidi]
 * bidi       = %x061C / %x200E / %x200F / %x2066-2069
 * name-start = ALPHA / %x2B / %x5F / %xA1-61B / %x61D-167F / %x1681-1FFF / %x200B-200D
 *            / %x2010-2027 / %x2030-205E / %x2060-2065 / %x206A-2FFF / %x3001-D7FF
 *            / %xE000-FDCF / %xFDF0-FFFD / %x10000-1FFFD / %x20000-2FFFD / ... / %x100000-10FFFD
 * name-char  = name-start / DIGIT / "-" / "."
 * ```
 *
 * Atlas constrained a message-function option name to `^[a-z][a-z0-9-]{0,63}$`, which is narrower
 * than the standard in the direction that costs: it rejects `decimalPlaces`, which the standard's
 * own test suite uses, and it rejects every option name Atlas's built-in functions already
 * have, among them `signDisplay`, `roundingMode`, `trailingZeroDisplay`, `currencySign`,
 * `fractionDigits`,
 * `minimumIntegerDigits`, `roundingIncrement`. An extension could not spell an option a built-in
 * had. That is not a bounded profile; it is a typo-shaped rule that survived because nothing had
 * tried to write a real function against it.
 *
 * **The optional `[bidi]` wrapper is deliberately outside this production, and that is measured
 * rather than assumed.** The parser strips it: a message writing `{42 :ns:f <LRM>places<LRM>=1}`
 * hands Atlas the option name `places`. A descriptor able to declare the wrapped form would be
 * declaring a second spelling of one option: one no message could ever match, and one that
 * collides with the first under any comparison that normalizes. What a descriptor names is the
 * name, not its presentation.
 *
 * This governs a *message-function* option name only. A rich-slot option name is Atlas's own
 * vocabulary rather than MessageFormat's and keeps Atlas's lower-kebab identifier convention.
 *
 * Written as one string rather than assembled from parts, because a transcription that has been
 * rearranged can no longer be checked against its source by reading.
 */
const NAME_START =
  'A-Za-z' +
  '\\u002B' +
  '\\u005F' +
  '\\u00A1-\\u061B' +
  '\\u061D-\\u167F' +
  '\\u1681-\\u1FFF' +
  '\\u200B-\\u200D' +
  '\\u2010-\\u2027' +
  '\\u2030-\\u205E' +
  '\\u2060-\\u2065' +
  '\\u206A-\\u2FFF' +
  '\\u3001-\\uD7FF' +
  '\\uE000-\\uFDCF' +
  '\\uFDF0-\\uFFFD' +
  '\\u{10000}-\\u{1FFFD}' +
  '\\u{20000}-\\u{2FFFD}' +
  '\\u{30000}-\\u{3FFFD}' +
  '\\u{40000}-\\u{4FFFD}' +
  '\\u{50000}-\\u{5FFFD}' +
  '\\u{60000}-\\u{6FFFD}' +
  '\\u{70000}-\\u{7FFFD}' +
  '\\u{80000}-\\u{8FFFD}' +
  '\\u{90000}-\\u{9FFFD}' +
  '\\u{A0000}-\\u{AFFFD}' +
  '\\u{B0000}-\\u{BFFFD}' +
  '\\u{C0000}-\\u{CFFFD}' +
  '\\u{D0000}-\\u{DFFFD}' +
  '\\u{E0000}-\\u{EFFFD}' +
  '\\u{F0000}-\\u{FFFFD}' +
  '\\u{100000}-\\u{10FFFD}';

/** `name-char = name-start / DIGIT / "-" / "."`, with `-` last so the class needs no escape. */
const NAME_CHAR = `${NAME_START}0-9.\\-`;

/**
 * The production as a JSON Schema `pattern`.
 *
 * Ajv compiles a `pattern` with the `u` flag, so the astral ranges above mean code points here and
 * a lone surrogate is refused rather than matched half a character at a time.
 */
export const ATLAS_MESSAGE_NAME_PATTERN = `^[${NAME_START}][${NAME_CHAR}]*$`;

/** The length bound, in code points. A name is an identifier, not a payload. */
export const ATLAS_MESSAGE_NAME_CHARACTERS = 64;

const messageName = new RegExp(ATLAS_MESSAGE_NAME_PATTERN, 'u');

/** Whether `value` is a MessageFormat `name` an Atlas descriptor may declare. */
export function atlasIsMessageName(value: string): boolean {
  return (
    [...value].length <= ATLAS_MESSAGE_NAME_CHARACTERS &&
    messageName.test(value)
  );
}

/* ------------------------------------------------------------------ *
 * `number-literal`                                                    *
 * ------------------------------------------------------------------ */

/**
 * ```abnf
 * number-literal = ["-"] (%x30 / (%x31-39 *DIGIT)) ["." 1*DIGIT] [%i"e" ["-" / "+"] 1*DIGIT]
 * ```
 *
 * Both packages had their own copy of this. They agreed, which is the only reason nothing had gone
 * wrong yet; two transcriptions of one production is one more than there is a source for.
 */
export const ATLAS_NUMBER_LITERAL =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/u;

/* ------------------------------------------------------------------ *
 * Typed option values                                                 *
 * ------------------------------------------------------------------ */

/**
 * The value a message-function option carries, read according to the type its descriptor declares.
 *
 * An option value written in a message is always text, MessageFormat's syntax has literals and
 * variables and no numeric option token, so a check asking "is this a JavaScript number" of a
 * literal answers no for every literal ever written. Atlas asked exactly that on both sides, which
 * made `integer`, `number` and `boolean` unreachable option types: a descriptor could declare one
 * and no message could satisfy it. The standard is explicit that the two spellings are the same
 * value, requiring of a digit size option that its value "resolves to a numerical integer value 0
 * or 1 or their corresponding string representations `'0'` or `'1'`".
 *
 * So the text is read as the declared type and the interpreted value is what gets compared: to
 * the type, and to a closed `values` set, which was unsatisfiable for the same reason. A value that
 * already arrived as its native type, from a variable rather than a literal, is accepted as itself.
 *
 * `undefined` means the value does not spell one of `type`. `date-time` accepts a `Date` or the
 * epoch-millisecond number that stands for one, and never a string: Atlas does not guess a date
 * format, which is the one place a lenient reading would silently pick a calendar.
 */
export function atlasExtensionOptionValue(
  value: unknown,
  type: ExtensionValueType,
): string | number | boolean | Date | undefined {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : undefined;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    case 'integer':
    case 'number': {
      const numeric =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && ATLAS_NUMBER_LITERAL.test(value)
            ? Number(value)
            : undefined;
      if (numeric === undefined || !Number.isFinite(numeric)) return undefined;
      return type === 'integer' && !Number.isSafeInteger(numeric)
        ? undefined
        : numeric;
    }
    case 'date-time':
      if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value : undefined;
      }
      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
  }
}

/**
 * Whether an interpreted option value is one of a descriptor's closed set.
 *
 * The set is authored data and holds `string | number | boolean`, so a `Date` is never a member and
 * a descriptor that declares `values` on a `date-time` option has declared an empty gate. Compared
 * after interpretation, so `decimalPlaces=1` written in a message meets `values: [0, 1]` written in
 * a descriptor.
 */
export function atlasExtensionOptionValueAllowed(
  value: string | number | boolean | Date,
  values: readonly (string | number | boolean)[] | undefined,
): boolean {
  if (values === undefined) return true;
  return !(value instanceof Date) && values.includes(value);
}
