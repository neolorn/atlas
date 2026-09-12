import {
  MessageDataModelError,
  MessageSyntaxError,
  parseMessage,
  stringifyMessage,
  validate,
  visit,
  type Model,
} from 'messageformat';

import {
  atlasDiagnostic,
  atlasFailure,
  atlasSourceSpan,
  atlasSuccess,
  type AtlasDiagnostic,
  type AtlasDiagnosticCode,
  type AtlasResult,
} from './diagnostics.js';
import {
  ATLAS_MESSAGE_FUNCTION_OPTIONS,
  ATLAS_MESSAGE_OPTION_RULES,
  atlasDateOperandOptions,
  atlasDateTimeFormatOptions,
  atlasExtensionOptionProfile,
  atlasInheritedOptions,
  atlasMessageOptionProblem,
  atlasNumberFormatOptions,
  type AtlasMessageOperandKind,
} from './message-function-options.js';
import { ATLAS_NUMBER_LITERAL } from './message-format-syntax.js';
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';
import { atlasUntrustedText } from './untrusted-text.js';
import { compareCodePoint, frozenRecord } from './sorted-records.js';

export type AtlasStandardMessageFunctionName =
  | 'string'
  | 'number'
  | 'integer'
  | 'offset'
  | 'currency'
  | 'percent'
  | 'unit'
  | 'datetime'
  | 'date'
  | 'time';

export type AtlasMessageFunctionStatus = 'stable' | 'draft';

/**
 * How `.match` selects on a value one built-in produced, which is not the same question as whether.
 *
 * - `none`: the function formats only, and a `.match` over it is a *Bad Selector*.
 * - `literal`: keys are compared to the value as text. `:string` is the only one, and its keys are
 *   whatever the author wrote.
 * - `number`: MessageFormat's Number Selection, where a key is either an exact numeric literal or a
 *   CLDR plural category. Only these have categories a target translation can be missing.
 *
 * Two rules read this: `standardSelectorNames` below asks whether, and target plural coverage asks
 * which. Kept as two hand-written lists they drift, and a second list holding only `:number` and
 * `:integer` ships a `.match` on `:offset` or `:percent` with its plural coverage unmeasured. One
 * statement, from the specification, answers both.
 */
export type AtlasMessageFunctionSelection = 'none' | 'literal' | 'number';

export interface AtlasMessageFunctionProfileEntry {
  readonly name: AtlasStandardMessageFunctionName;
  readonly status: AtlasMessageFunctionStatus;
  /**
   * How `.match` may select on a value this function produced.
   *
   * MessageFormat splits its functions into formatters and selectors, and a `.match` over a
   * formatter is a *Bad Selector*: LDML 48 Part 9 requires the error and requires the selector to
   * match nothing but the catch-all. Half the profile formats only, so this is a property of the
   * function rather than a rule about a handful of exceptions.
   */
  readonly selection: AtlasMessageFunctionSelection;
}

/**
 * The built-in functions, their stability, and which of them `.match` may select on.
 *
 * The third column is transcribed from the pinned LDML 48.2 specification text rather than inferred
 * from the conformance suite or from what the evaluator happens to do. Each function's own section
 * says which it is, in a sentence:
 *
 * | Function | Says | Selects |
 * | --- | --- | --- |
 * | `:string` | "provides string selection and formatting" | as text |
 * | `:number` | "is a selector and formatter for numeric values" | Number Selection |
 * | `:integer` | "is a selector and formatter for matching or formatting numeric ..." | Number Selection |
 * | `:offset` | "is a _selector_ and _formatter_ for matching or formatting ..." | Number Selection |
 * | `:percent` | "is a selector and formatter for percent values" | Number Selection |
 * | `:currency` | "is a _formatter_ for currency values" | no |
 * | `:unit` | "is proposed to be a RECOMMENDED formatter for unitized values" | no |
 * | `:datetime`, `:date`, `:time` | "Selection based on date/time types is not required by this release" | no |
 *
 * The five that select each carry a "Selection with `:x`" subsection; the five that do not carry
 * none. Four of those subsections are one sentence, the function "performs selection as described
 * in Number Selection", and `:string`'s is a literal NFC comparison with no categories in it,
 * which is why the two are different modes rather than one flag. `:percent` adds that its selection
 * "always uses the `plural` selection mode", and its option profile accordingly has no `select`.
 *
 * Reading any of this out of the suite instead would have taken an absence for a fact: the suite
 * writes one `.match` case for `:currency` and none at all for `:unit`, so the absence of a
 * failing case is not evidence that selection is supported.
 */
export const ATLAS_MESSAGE_FUNCTION_PROFILE: readonly AtlasMessageFunctionProfileEntry[] =
  Object.freeze(
    [
      ['string', 'stable', 'literal'],
      ['number', 'stable', 'number'],
      ['integer', 'stable', 'number'],
      ['offset', 'stable', 'number'],
      ['currency', 'stable', 'none'],
      ['percent', 'stable', 'number'],
      ['unit', 'draft', 'none'],
      ['datetime', 'draft', 'none'],
      ['date', 'draft', 'none'],
      ['time', 'draft', 'none'],
    ].map(([name, status, selection]) =>
      Object.freeze({ name, status, selection }),
    ),
  ) as readonly AtlasMessageFunctionProfileEntry[];

const standardFunctionNames = new Set<AtlasStandardMessageFunctionName>(
  ATLAS_MESSAGE_FUNCTION_PROFILE.map(({ name }) => name),
);

const standardSelectorNames = new Set<string>(
  ATLAS_MESSAGE_FUNCTION_PROFILE.filter(
    ({ selection }) => selection !== 'none',
  ).map(({ name }) => name),
);

/**
 * The built-ins whose keys can be CLDR plural categories, which is what a target translation can be
 * missing coverage of. Derived, so it cannot fall behind the profile the way a hand-kept set did.
 */
export const ATLAS_PLURAL_SELECTOR_FUNCTIONS: ReadonlySet<string> =
  Object.freeze(
    new Set(
      ATLAS_MESSAGE_FUNCTION_PROFILE.filter(
        ({ selection }) => selection === 'number',
      ).map(({ name }) => name),
    ),
  ) as ReadonlySet<string>;

/**
 * Which date option `Intl.DateTimeFormat` refused, said in one line.
 *
 * The construction is one call and answers about the whole set, so a message writing a good
 * `calendar` and a misspelt `timeZone` would otherwise be told its options "cannot be used
 * together": true of the pair and useless to the person who has to fix one of them. The two
 * options whose values are data rather than a rule are re-tried one at a time, and the first that
 * fails alone is the one named. Nothing else can fail: every other date option is an enumerated
 * value the table has already judged.
 */
function dateOptionProblem(
  functionName: string,
  resolved: Readonly<Record<string, string>>,
): string {
  for (const [name, rule] of Object.entries(ATLAS_MESSAGE_OPTION_RULES)) {
    if (rule.kind !== 'constructed') continue;
    const value = resolved[name];
    if (value === undefined) continue;
    try {
      new Intl.DateTimeFormat('en', {
        timeZone: 'UTC',
        ...atlasDateTimeFormatOptions(functionName, { [name]: value }),
      });
    } catch {
      return `MessageFormat option ${name}=${JSON.stringify(value)} on :${functionName} is not ${rule.describes}.`;
    }
  }
  return (
    `MessageFormat options on :${functionName} cannot be used together: ` +
    `${Object.entries(resolved)
      .map(([name, value]) => `${name}=${value}`)
      .sort()
      .join(' ')}.`
  );
}
/**
 * The functions whose operand MessageFormat calls a Number Operand, and the grammar that decides.
 *
 * LDML 48 Part 9: such an operand is a numeric value or "a string matching the `number-literal`
 * production". A literal is the half of that a compiler can settle on its own, the text is right
 * there in the source, and settling it here is the point of compiling at all. Before this,
 * `{foo :number}` parsed, compiled, shipped and threw in front of a reader, which is the one class
 * of defect a localization library cannot put in a release.
 *
 * A variable operand is not checked here and cannot be: what a consumer passes is known at the call
 * site, and the generated input contract is what checks it.
 *
 * The production is transcribed from the specification rather than approximated with `Number()`:
 * `Number('')`, `Number(' 1 ')`, `Number('0x1')` and `Number('Infinity')` are all numbers to
 * JavaScript and none of them is a number to MessageFormat. `packages/runtime/src/evaluator.ts`
 * carries the same regular expression for the same reason, and the two are the same rule read from
 * the same sentence: the runtime still has to answer for a variable operand and for IR it did not
 * compile, so this narrows what reaches it rather than replacing it.
 *
 * Which functions those are is read from `ATLAS_MESSAGE_FUNCTION_OPTIONS` at the one place that
 * asks, rather than from a second set kept beside it.
 */
const NUMBER_LITERAL = ATLAS_NUMBER_LITERAL;

/**
 * The `u:` namespace, which MessageFormat 2 reserves for the message syntax itself.
 *
 * Atlas parsed these, folded them in with every other option and dropped them at runtime, so
 * `{$name :string u:dir=rtl}` produced no diagnostic and no isolation: the worst of the three
 * available behaviours, because the author had no way to find out.
 *
 * `u:dir` and `u:id` are implemented and validated here. Everything else in the namespace is
 * refused rather than ignored: `u:locale` is a real option in the spec that Atlas does not
 * implement, and accepting it quietly would mean a message that formats in the wrong locale with
 * nothing to say so.
 */
const UNICODE_OPTION_PREFIX = 'u:';
const UNICODE_DIRECTION_VALUES = new Set(['ltr', 'rtl', 'auto', 'inherit']);
const IMPLEMENTED_UNICODE_OPTIONS = new Set(['u:dir', 'u:id']);

/**
 * A registered extension function, as the message parser needs to see it.
 *
 * The parser asks two questions about a function name and both have to be answered from one place:
 * whether the profile knows it at all, and whether `.match` may select on what it produces. Passing
 * the names alone answered the first and left the second unanswerable, so a `.match` over a
 * `selector: 'none'` extension compiled. Two lists would have been two registers that can disagree.
 */
/**
 * What the parser is told about one registered function, which is its descriptor's profile.
 *
 * A name and a selector flag was not enough and the gap was not cosmetic. Anything the parser
 * cannot build a profile for is a function whose resolved value it cannot reason about, so an
 * extension declaration carried nothing into the rest of the message while the runtime carried its
 * whole option mapping, which compiled a message that throws at render, and refused a message
 * that renders. Both were measured. The descriptor already declares every field here; nothing new
 * is being asked of an author.
 */
export interface AtlasMessageCustomFunction {
  /** The registered function id, without the leading colon. */
  readonly name: string;
  /** Whether the descriptor declares `selector: 'exact'` rather than `selector: 'none'`. */
  readonly selects: boolean;
  /** The operand type the descriptor declares. */
  readonly operandType: AtlasMessageOperandKind;
  /** The value type the descriptor declares this function produces. */
  readonly resultType: AtlasMessageOperandKind;
  /** The option names the descriptor declares, which is what may be written on it. */
  readonly options: readonly string[];
}

export interface AtlasMessageParseOptions {
  readonly sourcePath?: string;
  readonly path?: readonly (string | number)[];
  /**
   * The message functions the application has registered, beyond the built-in profile.
   *
   * Omitting these is not a lenient parse, it is a stricter one: an unregistered function name is
   * refused, so a caller that has a registry and does not pass it rejects messages its own catalogs
   * accept. Every path that parses an authored message passes it, including the pseudo-locale
   * transform, which re-parses what it derived.
   */
  readonly customFunctions?: readonly AtlasMessageCustomFunction[];
}

/** Text written directly in the message, rather than a value passed into it. */
export interface AtlasMessageLiteral {
  readonly kind: 'literal';
  /** The text itself, with the message syntax's own escapes already resolved. */
  readonly value: string;
}

/** A value the message names and the caller supplies. */
export interface AtlasMessageVariableReference {
  readonly kind: 'variable';
  /** What the message calls it, without the leading marker the syntax uses. */
  readonly name: string;
}

/**
 * Anything that stands in for a value: text written in the message, or a name it takes from
 * outside.
 *
 * Check `kind` to tell them apart. Both an operand and an option value are one of these.
 */
export type AtlasMessageValueReference =
  | AtlasMessageLiteral
  | AtlasMessageVariableReference;

/**
 * The options written on a function or a markup element, by name.
 *
 * An option's value may itself be a variable, so a message can ask for two fraction digits or for
 * however many the caller says.
 */
export type AtlasMessageOptionMap = Readonly<
  Record<string, AtlasMessageValueReference>
>;

/**
 * What an attribute carries: a literal, or `true` for one written with no value at all.
 *
 * Never a variable. An attribute is a note to the tools rather than something the message renders,
 * so it cannot depend on what a caller passed.
 */
export type AtlasMessageAttributeValue = true | AtlasMessageLiteral;
/**
 * The attributes on an expression or a markup element, by name.
 *
 * Attributes annotate a place in the message for whoever is processing it, a translation tool
 * above all, and nothing in them reaches the rendered output.
 */
export type AtlasMessageAttributeMap = Readonly<
  Record<string, AtlasMessageAttributeValue>
>;

/** The function an expression applies to its operand, with whatever options it was written with. */
export interface AtlasMessageFunctionReference {
  /** The name without its leading colon: a built-in, or one a registered extension declares. */
  readonly name: string;
  /** The options written on it. Empty rather than absent when none were. */
  readonly options: AtlasMessageOptionMap;
}

/**
 * One placeholder in a message: the value it shows, how it is formatted, and its annotations.
 *
 * At least one of the operand and the function is present. An expression with neither would name
 * nothing and format nothing, and the parser refuses it.
 */
export interface AtlasMessageExpression {
  readonly kind: 'expression';
  /** What is being shown or selected on. Absent for a function called with nothing. */
  readonly operand?: AtlasMessageValueReference;
  /** How to format or select on it. Absent when the value is shown as it arrives. */
  readonly function?: AtlasMessageFunctionReference;
  /** Annotations for whoever processes the message. Empty rather than absent when none. */
  readonly attributes: AtlasMessageAttributeMap;
}

/**
 * A named region inside a message: what becomes a link, a bold run, or a projected slot.
 *
 * A catalog places it and names it; what it renders as is decided in application code. That is the
 * whole of what a translator controls here, which is where the emphasis and the link sit in the
 * sentence.
 */
export interface AtlasMessageMarkup {
  readonly kind: 'markup';
  /** Whether this opens a region, closes one, or stands alone with nothing inside it. */
  readonly markupKind: 'open' | 'standalone' | 'close';
  /** What the region is called, which is the name application code binds against. */
  readonly name: string;
  /** The options written on it. Empty rather than absent when none were. */
  readonly options: AtlasMessageOptionMap;
  /** Annotations for whoever processes the message. Empty rather than absent when none. */
  readonly attributes: AtlasMessageAttributeMap;
}

/**
 * One piece of a message: a run of text, a placeholder, or a markup boundary.
 *
 * A plain string is the text case, so a message with nothing in it but words is an array of one
 * string.
 */
export type AtlasMessagePatternPart =
  | string
  | AtlasMessageExpression
  | AtlasMessageMarkup;
/** A whole message body, in order, as the pieces it is made of. */
export type AtlasMessagePattern = readonly AtlasMessagePatternPart[];

/**
 * A name the message binds before its body runs.
 *
 * Either a statement about a value the caller passes, or a value computed once inside the message
 * and used more than once.
 */
export interface AtlasMessageDeclaration {
  /** `input` for something the caller supplies, `local` for something the message works out. */
  readonly kind: 'input' | 'local';
  /** The name being bound, without the syntax's leading marker. */
  readonly name: string;
  /** What it is bound to, which for an input is how that input is to be read. */
  readonly value: AtlasMessageExpression;
}

/** A variant key that matches one exact value: a plural category, a number, an enum member. */
export interface AtlasMessageLiteralVariantKey {
  readonly kind: 'literal';
  /** What the selector's value is compared against. */
  readonly value: string;
}

/**
 * A variant key that matches anything the other keys did not.
 *
 * Every selection needs one on every position, so a message has an answer for a value nobody
 * listed.
 */
export interface AtlasMessageCatchallVariantKey {
  readonly kind: 'catchall';
  /** The name it was written under, kept for round-tripping the source rather than for matching. */
  readonly value?: string;
}

/** One position of one variant's key list: an exact value to match, or the catch-all. */
export type AtlasMessageVariantKey =
  | AtlasMessageLiteralVariantKey
  | AtlasMessageCatchallVariantKey;

/** One branch of a selecting message: what it matches, and what it says when it does. */
export interface AtlasMessageVariant {
  /** One key per selector, in the selectors' own order. */
  readonly keys: readonly AtlasMessageVariantKey[];
  /** The message body used when every key matches. */
  readonly pattern: AtlasMessagePattern;
}

interface AtlasMessageSemanticBase {
  readonly source: string;
  readonly canonicalSource: string;
  readonly declarations: readonly AtlasMessageDeclaration[];
  readonly externalInputs: readonly string[];
  readonly functions: readonly string[];
  readonly resultKind: 'plain' | 'structured';
  readonly comment?: string;
}

/** A message that says one thing, with no branching in it. */
export interface AtlasPatternMessageSemanticModel extends AtlasMessageSemanticBase {
  readonly kind: 'pattern';
  /** The body. */
  readonly pattern: AtlasMessagePattern;
}

/**
 * A message that says different things depending on its values, usually a plural or a gender.
 *
 * The variants are what a translation has to cover: a language with six plural categories needs
 * six branches where English needs two, which is why coverage is checked per target rather than
 * against the source.
 */
export interface AtlasSelectMessageSemanticModel extends AtlasMessageSemanticBase {
  readonly kind: 'select';
  /** The names selected on, in the order a variant's keys are written in. */
  readonly selectors: readonly string[];
  /** The branches, each with one key per selector. */
  readonly variants: readonly AtlasMessageVariant[];
}

/**
 * One authored message, parsed and normalized: what it says, what it needs, and what it produces.
 *
 * What `parseAtlasMessage` returns and what everything downstream reads. Both arms carry the
 * original source, a canonical spelling of it that two equivalent writings share, the names the
 * message declares, the inputs it takes from outside, the functions it calls, whether it renders
 * as plain text or as parts, and the author's comment.
 *
 * Check `kind` to tell a plain message from a selecting one.
 */
export type AtlasMessageSemanticModel =
  | AtlasPatternMessageSemanticModel
  | AtlasSelectMessageSemanticModel;

function normalizeValue(
  value: Model.Literal | Model.VariableRef,
): AtlasMessageValueReference {
  return value.type === 'literal'
    ? Object.freeze({ kind: 'literal', value: value.value })
    : Object.freeze({ kind: 'variable', name: value.name });
}

function normalizeOptions(
  options: Model.Options | undefined,
): AtlasMessageOptionMap {
  return frozenRecord(
    Object.entries(options ?? {})
      .sort(([left], [right]) => compareCodePoint(left, right))
      .map(([name, value]) => [name, normalizeValue(value)] as const),
  );
}

function normalizeAttributes(
  attributes: Model.Attributes | undefined,
): AtlasMessageAttributeMap {
  return frozenRecord(
    Object.entries(attributes ?? {})
      .sort(([left], [right]) => compareCodePoint(left, right))
      .map(
        ([name, value]) =>
          [
            name,
            value === true
              ? true
              : Object.freeze({ kind: 'literal', value: value.value }),
          ] as const,
      ),
  );
}

function normalizeFunction(
  reference: Model.FunctionRef,
): AtlasMessageFunctionReference {
  return Object.freeze({
    name: reference.name as AtlasStandardMessageFunctionName,
    options: normalizeOptions(reference.options),
  });
}

/**
 * The operand an expression carries, read as whatever the parse produced.
 *
 * The model declares the operand present whenever its key is, which describes the shape the
 * grammar admits rather than the object in hand.
 */
function receivedArg(expression: Model.Expression): unknown {
  return 'arg' in expression ? expression.arg : undefined;
}

function normalizeExpression(
  expression: Model.Expression,
): AtlasMessageExpression {
  return Object.freeze({
    kind: 'expression',
    ...('arg' in expression && receivedArg(expression) !== undefined
      ? { operand: normalizeValue(expression.arg) }
      : {}),
    ...(expression.functionRef === undefined
      ? {}
      : { function: normalizeFunction(expression.functionRef) }),
    attributes: normalizeAttributes(expression.attributes),
  });
}

function normalizeMarkup(markup: Model.Markup): AtlasMessageMarkup {
  return Object.freeze({
    kind: 'markup',
    markupKind: markup.kind,
    name: markup.name,
    options: normalizeOptions(markup.options),
    attributes: normalizeAttributes(markup.attributes),
  });
}

function normalizePattern(pattern: Model.Pattern): AtlasMessagePattern {
  return Object.freeze(
    pattern.map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      return part.type === 'markup'
        ? normalizeMarkup(part)
        : normalizeExpression(part);
    }),
  );
}

function normalizeDeclarations(
  declarations: readonly Model.Declaration[],
): readonly AtlasMessageDeclaration[] {
  return Object.freeze(
    declarations.map((declaration) =>
      Object.freeze({
        kind: declaration.type,
        name: declaration.name,
        value: normalizeExpression(declaration.value),
      }),
    ),
  );
}

function normalizeVariantKey(
  key: Model.Literal | Model.CatchallKey,
): AtlasMessageVariantKey {
  return key.type === 'literal'
    ? Object.freeze({ kind: 'literal', value: key.value })
    : Object.freeze({
        kind: 'catchall',
        ...(key.value === undefined ? {} : { value: key.value }),
      });
}

function normalizeVariants(
  variants: readonly Model.Variant[],
): readonly AtlasMessageVariant[] {
  return Object.freeze(
    variants.map((variant) =>
      Object.freeze({
        keys: Object.freeze(variant.keys.map(normalizeVariantKey)),
        pattern: normalizePattern(variant.value),
      }),
    ),
  );
}

/**
 * What the parser and the validator found, in Atlas's words rather than theirs.
 *
 * `MessageSyntaxError.message` is the type slug followed by the offset, `parse-error at 6`, and
 * `MessageDataModelError` adds nothing to it, so carrying the text whole read
 * `MessageFormat missing-selector-annotation: missing-selector-annotation`: the slug twice over,
 * beside a position the diagnostic already states as a span. The type vocabulary is closed and
 * declared, so the reduction is a table over it rather than surgery on a sentence, and a type added
 * or renamed in a later `messageformat` fails to typecheck here instead of falling through.
 *
 * The five the standard names as Data Model Errors are worded from its own definitions; the rest are
 * worded from what the parser rejected at the position it threw.
 */
const MESSAGE_FORMAT_SENTENCES: Readonly<
  Record<MessageSyntaxError['type'], string>
> = Object.freeze({
  'bad-escape': 'MessageFormat escape must be one of \\\\, \\{, \\| or \\}.',
  'bad-input-expression':
    'MessageFormat .input declares a variable, so its expression must be a $variable.',
  'duplicate-attribute':
    'MessageFormat expression writes the same @attribute twice.',
  'duplicate-declaration':
    'MessageFormat declares the same variable twice; using a variable already declares it, so a later .input for it is a redeclaration.',
  'duplicate-option-name':
    'MessageFormat expression writes the same option name twice.',
  'duplicate-variant':
    'MessageFormat .match has two variants with the same keys.',
  'empty-token':
    'MessageFormat expected a name, a variable or a value here and found none.',
  'extra-content':
    'MessageFormat found text after the pattern ended; a quoted pattern is the last thing in a message.',
  'key-mismatch':
    'MessageFormat variant has a different number of keys than .match has selectors.',
  'missing-fallback':
    'MessageFormat .match has no catch-all variant; one variant must be * for every selector.',
  'missing-selector-annotation':
    'MessageFormat .match selector must reach a declaration that names a function, directly or through another declaration.',
  'missing-syntax':
    'MessageFormat expected more syntax here than the message has.',
  'parse-error':
    'MessageFormat found a character here that does not start anything the syntax allows.',
});

/**
 * `missing-syntax` is the one type whose message carries something the span does not: the token the
 * parser wanted. Six are reachable, and each is a token of the syntax rather than prose.
 */
const MISSING_SYNTAX_SENTENCES: ReadonlyMap<string, string> = new Map([
  ['{{', 'MessageFormat expected a quoted pattern here, which opens with {{.'],
  ['}}', 'MessageFormat expected the quoted pattern to close with }} here.'],
  ['{', 'MessageFormat expected an expression in braces here.'],
  ['|', 'MessageFormat expected the quoted literal to close with | here.'],
  [
    '=',
    'MessageFormat expected = here, because an option is written name=value.',
  ],
  ["' '", 'MessageFormat expected a space here.'],
]);

const MISSING_SYNTAX_MESSAGE = /^Missing (.+) at \d+$/u;

// Exported for the wording suite alone, and not from the package index. Every token-carrying shape
// is reachable from a real message; the general sentence is reachable only when the shape does not
// hold, which is a path no message can take while it does.
export function syntaxErrorSentence(error: MessageSyntaxError): string {
  const general = MESSAGE_FORMAT_SENTENCES[error.type];
  if (error.type !== 'missing-syntax') return general;
  const token = MISSING_SYNTAX_MESSAGE.exec(error.message)?.[1];
  // The capture is confirmed against the span the same error reports, because the parser sets the
  // span from the token's own length. A message shaped differently falls through to the general
  // sentence rather than quoting whatever it now says.
  if (token === undefined || token.length !== error.end - error.start) {
    return general;
  }
  return (
    MISSING_SYNTAX_SENTENCES.get(token) ??
    `MessageFormat expected ${token} here.`
  );
}

/**
 * Which refusals are Data Model Errors, by the standard's division rather than the parser's stages.
 *
 * `ATL1201` is a message the syntax refuses and `ATL1202` is a message the data model refuses, and
 * until this table existed the two were told apart by *where* the refusal came from: anything thrown
 * out of `parseMessage` was syntax, anything reported by `validate` was the data model. That is the
 * implementation's division, and for one type it disagrees with the specification's. LDML 48.2 lists
 * Duplicate Option Name among its Data Model Errors, the working group's own suite files it in
 * `data-model-errors.json`, while `messageformat` throws it while parsing, because a repeated
 * option is visible to the parser. Measured over that suite before this changed: five of its six
 * error types arrived as `ATL1202`, and `duplicate-option-name` alone arrived as `ATL1201`.
 *
 * Which stage notices something is an implementation detail of the parser Atlas embeds; which class
 * of error it is belongs to the message. So the class decides the code, one rule for all six, and a
 * type raised from either stage lands in the same place.
 *
 * A `Record` over the library's own union rather than a list: a type it adds to
 * `MessageDataModelError` fails to compile here rather than falling silently into the syntax half.
 * `duplicate-option-name` is written in beside that union because the library does not put it there
 * and the specification does.
 */
const MESSAGE_FORMAT_DATA_MODEL_ERRORS: Readonly<
  Record<MessageDataModelError['type'] | 'duplicate-option-name', true>
> = Object.freeze({
  'duplicate-declaration': true,
  'duplicate-option-name': true,
  'duplicate-variant': true,
  'key-mismatch': true,
  'missing-fallback': true,
  'missing-selector-annotation': true,
});

function messageFormatErrorCode(
  error: MessageSyntaxError,
): 'ATL1201' | 'ATL1202' {
  return Object.hasOwn(MESSAGE_FORMAT_DATA_MODEL_ERRORS, error.type)
    ? 'ATL1202'
    : 'ATL1201';
}

function errorDiagnostic(
  source: string,
  error: MessageSyntaxError,
  options: AtlasMessageParseOptions,
  code: 'ATL1201' | 'ATL1202',
): AtlasDiagnostic {
  const start = Math.max(0, Math.min(error.start, source.length));
  const end = Math.max(start, Math.min(error.end, source.length));
  return atlasDiagnostic(code, syntaxErrorSentence(error), {
    ...(options.path === undefined ? {} : { path: options.path }),
    span: atlasSourceSpan(
      source,
      start,
      Math.max(1, end - start),
      options.sourcePath,
    ),
  });
}

export function parseAtlasMessage(
  sourceValue: unknown,
  options: AtlasMessageParseOptions = {},
): AtlasResult<AtlasMessageSemanticModel> {
  const sourceText = atlasUntrustedText(
    sourceValue,
    'ATL1201',
    'MessageFormat source',
    ATLAS_RESOURCE_LIMITS.messageBytes,
  );
  if (!sourceText.ok) return sourceText;
  const source = sourceText.value;
  if (Buffer.byteLength(source, 'utf8') > ATLAS_RESOURCE_LIMITS.messageBytes) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1201',
        `MessageFormat source exceeds the ${ATLAS_RESOURCE_LIMITS.messageBytes}-byte implementation ceiling.`,
        {
          ...(options.path === undefined ? {} : { path: options.path }),
          span: atlasSourceSpan(source, 0, source.length, options.sourcePath),
        },
      ),
    ]);
  }
  let message: Model.Message;
  try {
    message = parseMessage(source);
  } catch (error) {
    if (error instanceof MessageSyntaxError) {
      return atlasFailure([
        errorDiagnostic(source, error, options, messageFormatErrorCode(error)),
      ]);
    }
    throw error;
  }

  const dataModelDiagnostics: AtlasDiagnostic[] = [];
  const validation = validate(message, (type, node) => {
    // Through the same table as the thrown half, rather than passing `ATL1202` because everything
    // reported here happens to be one. Two places deciding the same thing is how they come apart.
    const error = new MessageDataModelError(type, node);
    dataModelDiagnostics.push(
      errorDiagnostic(source, error, options, messageFormatErrorCode(error)),
    );
  });
  if (dataModelDiagnostics.length > 0) {
    return atlasFailure(dataModelDiagnostics);
  }

  const customFunctions = options.customFunctions ?? [];
  const customFunctionNames = new Set(customFunctions.map(({ name }) => name));
  const customProfiles = new Map(
    customFunctions.map((custom) => [
      custom.name,
      atlasExtensionOptionProfile(custom.operandType, custom.options),
    ]),
  );
  const selectorNames = new Set<string>([
    ...standardSelectorNames,
    ...customFunctions.filter(({ selects }) => selects).map(({ name }) => name),
  ]);
  const unsupportedFunctions = [...validation.functions]
    .filter(
      (name): name is string =>
        !standardFunctionNames.has(name as AtlasStandardMessageFunctionName) &&
        !customFunctionNames.has(name),
    )
    .sort(compareCodePoint);
  if (unsupportedFunctions.length > 0) {
    return atlasFailure(
      unsupportedFunctions.map((name) =>
        atlasDiagnostic(
          'ATL1203',
          `MessageFormat function :${name} is not part of the Atlas 1 profile.`,
          {
            ...(options.path === undefined ? {} : { path: options.path }),
            span: atlasSourceSpan(source, 0, source.length, options.sourcePath),
          },
        ),
      ),
    );
  }

  const optionDiagnostics: AtlasDiagnostic[] = [];
  const report = (code: AtlasDiagnosticCode, summary: string): void => {
    optionDiagnostics.push(
      atlasDiagnostic(code, summary, {
        ...(options.path === undefined ? {} : { path: options.path }),
        span: atlasSourceSpan(source, 0, source.length, options.sourcePath),
      }),
    );
  };
  const optionDiagnostic = (summary: string): void =>
    report('ATL1204', summary);
  // Its own code rather than ATL1204's: an option written wrongly and an operand that is not a
  // number are different mistakes with different fixes, and a consumer filtering on a code is
  // entitled to tell them apart.
  const operandDiagnostic = (summary: string): void =>
    report('ATL1205', summary);
  /**
   * @param where  What the option was written on, for the diagnostic.
   * @param allowDirection  `u:dir` is a Bad Option error on markup: markup resolves to no value, so
   *   there is nothing for a direction to be a property of.
   */
  const checkUnicodeOptions = (
    declared: Model.Options | undefined,
    where: string,
    allowDirection: boolean,
  ): void => {
    for (const [name, value] of Object.entries(declared ?? {})) {
      if (!name.startsWith(UNICODE_OPTION_PREFIX)) continue;
      if (!IMPLEMENTED_UNICODE_OPTIONS.has(name)) {
        optionDiagnostic(
          `MessageFormat option ${name} on ${where} is outside the Atlas 1 profile; the profile implements ${[...IMPLEMENTED_UNICODE_OPTIONS].join(' and ')}.`,
        );
        continue;
      }
      if (value.type !== 'literal') {
        optionDiagnostic(
          `MessageFormat option ${name} on ${where} must be a literal, not a variable reference.`,
        );
        continue;
      }
      if (name === 'u:dir') {
        if (!allowDirection) {
          optionDiagnostic(
            `MessageFormat option u:dir is not allowed on ${where}.`,
          );
          continue;
        }
        if (!UNICODE_DIRECTION_VALUES.has(value.value)) {
          optionDiagnostic(
            `MessageFormat option u:dir=${JSON.stringify(value.value)} on ${where} is not one of ${[...UNICODE_DIRECTION_VALUES].map((allowed) => JSON.stringify(allowed)).join(', ')}.`,
          );
        }
      }
    }
  };
  /**
   * The options every declared variable carries, so a later expression can be checked against what
   * it will actually be formatted with rather than against what is written on it.
   *
   * LDML 48 Part 9 makes a number function's resolved value carry its options forward: an operand
   * that is an implementation-defined type *"can include option values"*, which are resolved
   * *"with options on the expression taking priority over any options of the operand"*. So
   * `{$n :number roundingIncrement=5}` is valid or invalid depending on a `minimumFractionDigits`
   * written three lines above it, and a compiler that reads only the expression in front of it will
   * refuse a conforming message or pass one that throws.
   *
   * `complete` is false when some part of the map could not be known here: an option written as
   * `maximumFractionDigits=$digits`, or an operand whose own map was incomplete. An incomplete map
   * still validates every literal on it; what it cannot do is the whole-formatter check below,
   * which needs every option to be present to mean anything. The evaluator answers for those.
   *
   * A variable with no declaration is an external input, which the runtime binds as a plain value
   * with no options at all, so its absence from this map is the correct answer rather than a gap.
   *
   * Computed in its own pass because a declaration can be referred to from anywhere below it, and a
   * pattern expression re-annotates exactly as a later declaration does.
   */
  interface CarriedOptions {
    readonly options: Readonly<Record<string, string>>;
    readonly complete: boolean;
  }
  const literalOptions = (
    declared: Model.Options | undefined,
  ): CarriedOptions => {
    const options: Record<string, string> = {};
    let complete = true;
    for (const [name, value] of Object.entries(declared ?? {})) {
      if (name.startsWith(UNICODE_OPTION_PREFIX)) continue;
      if (value.type === 'literal') options[name] = value.value;
      else complete = false;
    }
    return { options, complete };
  };
  const carried = new Map<string, CarriedOptions>();
  /**
   * @param forResolvedValue  True when the answer becomes a declaration's own resolved value, which
   *   drops the options `:offset` does not carry. False when it is the option set an expression is
   *   about to be formatted with, where `add` is exactly what is being checked.
   */
  const resolveCarried = (
    expression: {
      readonly arg?: Model.Literal | Model.VariableRef | undefined;
      readonly functionRef?: Model.FunctionRef | undefined;
    },
    forResolvedValue: boolean,
  ): CarriedOptions | undefined => {
    const operand = expression.arg;
    const from =
      operand?.type === 'variable' ? carried.get(operand.name) : undefined;
    const functionRef = expression.functionRef;
    if (functionRef === undefined) {
      // `.local $b = {$a}` re-binds the resolved value untouched, options and all.
      return from;
    }
    // A built-in first, then a registered extension, because both are message functions and both
    // carry a profile. A name in neither is not a function this message may use and is refused
    // elsewhere.
    const standard = ATLAS_MESSAGE_FUNCTION_OPTIONS[functionRef.name];
    const profile = standard ?? customProfiles.get(functionRef.name);
    if (profile === undefined) return undefined;
    const written = literalOptions(functionRef.options);
    const dropped = forResolvedValue ? profile.excludedFromResolved : [];
    // The merge itself is in the shared table module, called from here and from the evaluator. The
    // two families inherit by different rules (a numeric function takes everything except what it
    // discards, a date function takes only the three override options) and both rules living in
    // one function is what keeps the compiler refusing exactly what the evaluator could not honour.
    //
    // The date branch is asked of `standard` rather than of `profile` because `timeZone=input` is
    // defined for the three built-in date functions and for nothing else: *"The value `input`
    // corresponds to the time zone of the operand"* is written in their sections. An extension that
    // happens to declare an option spelled `timeZone` is not those functions, and the runtime hands
    // it the text it was written with. Resolving `input` here for an extension would carry a zone
    // the runtime does not, which is the same defect this whole change is closing, in reverse.
    const inherited =
      standard?.operand === 'date-time'
        ? atlasDateOperandOptions(from?.options, written.options, standard)
        : atlasInheritedOptions(from?.options, written.options, profile);
    return {
      options: Object.fromEntries(
        Object.entries(inherited).filter(([name]) => !dropped.includes(name)),
      ),
      complete: (from?.complete ?? true) && written.complete,
    };
  };
  for (const declaration of message.declarations) {
    const resolved = resolveCarried(declaration.value, true);
    if (resolved !== undefined) carried.set(declaration.name, resolved);
  }

  let structured = false;
  // Raised inside the visit below, which is an assignment the compiler cannot order against a
  // plain read of the variable.
  const isStructured = (): boolean => structured;
  visit(message, {
    markup: (markup) => {
      structured = true;
      checkUnicodeOptions(markup.options, `markup {#${markup.name}}`, false);
    },
    functionRef: (functionRef, _context, argument) => {
      checkUnicodeOptions(functionRef.options, `:${functionRef.name}`, true);
      const profile = ATLAS_MESSAGE_FUNCTION_OPTIONS[functionRef.name];
      // Not a built-in. An extension's own descriptor is the authority on what it accepts, and
      // `validExtensionOptions` is where that is enforced.
      if (profile === undefined) return;
      if (argument === undefined) {
        operandDiagnostic(
          `MessageFormat function :${functionRef.name} needs an operand and was written without one.`,
        );
      } else if (
        profile.operand === 'number' &&
        argument.type === 'literal' &&
        !NUMBER_LITERAL.test(argument.value)
      ) {
        operandDiagnostic(
          `MessageFormat operand ${JSON.stringify(argument.value)} on :${functionRef.name} is not a number. ` +
            'A literal operand of a number function must match the MessageFormat number-literal production.',
        );
      }
      let optionsSound = true;
      for (const [name, value] of Object.entries(functionRef.options ?? {})) {
        if (name.startsWith(UNICODE_OPTION_PREFIX)) continue;
        if (value.type !== 'literal') {
          // MessageFormat allows a variable option value in general and forbids it for some:
          // *"if the value is not a literal, a Bad Option error is emitted."* Which ones is a
          // property of the function and the table says it. `select` is singled out for Atlas's
          // reason for checking here at all: it decides which CLDR table a target catalog's
          // plural coverage is measured against, and a value that arrives at render time cannot be
          // measured against anything. The date family singles out everything except its three
          // override options, and for the specification's own reason: they describe the message
          // rather than the environment it renders in.
          if (profile.literalOnly.includes(name)) {
            optionsSound = false;
            optionDiagnostic(
              `MessageFormat option ${name} on :${functionRef.name} must be a literal, not a variable reference.`,
            );
          }
          continue;
        }
        const problem = atlasMessageOptionProblem(
          functionRef.name,
          name,
          value.value,
        );
        if (problem !== undefined) {
          optionsSound = false;
          optionDiagnostic(
            `MessageFormat option ${name}=${JSON.stringify(value.value)} on :${functionRef.name} ${problem}.`,
          );
        }
      }
      if (
        profile.accepts.includes('select') &&
        argument?.type === 'variable' &&
        carried.get(argument.name)?.options['select'] !== undefined &&
        functionRef.options?.['select'] === undefined
      ) {
        optionsSound = false;
        optionDiagnostic(
          `MessageFormat option select on :${functionRef.name} would be inherited from $${argument.name} rather than written here. ` +
            'The option that decides how a number selects must be a literal on the expression that selects, so a translator can see it.',
        );
      }
      const resolved = resolveCarried({ arg: argument, functionRef }, false);
      if (!optionsSound || resolved?.complete !== true) return;
      if (functionRef.name === 'offset') {
        // *"The options on `:offset` are exclusive with each other, and exactly one option is
        // always required."* Decidable here whenever both values are literals, which is the only
        // case this branch is reached in.
        const count = ['add', 'subtract'].filter(
          (name) => resolved.options[name] !== undefined,
        ).length;
        if (count !== 1) {
          optionDiagnostic(
            `MessageFormat function :offset takes exactly one of add or subtract and was written with ${count === 0 ? 'neither' : 'both'}.`,
          );
        }
        return;
      }
      if (profile.operand === 'string') return;
      if (profile.operand === 'date-time') {
        /**
         * `input` is a time zone the operand carries, and an Atlas date input is a `Date`. So the
         * only operand that can answer is one whose own declaration wrote a zone, which is exactly
         * what the carried map holds, and `atlasDateOperandOptions` has already substituted it if
         * there was one. An `input` still standing here means nothing in the message provides it.
         *
         * The specification's answer is a Bad Operand error at format time beside a rendered
         * fallback. Section 8 declines that: the fallback renders a date in whatever zone the
         * consumer's context happens to hold, which is a plausible string on a screen and a
         * different day either side of midnight.
         */
        if (resolved.options['timeZone'] === 'input') {
          optionDiagnostic(
            `MessageFormat option timeZone=input on :${functionRef.name} names the time zone of its operand, and nothing in this message gives the operand one. ` +
              'Write the zone on this expression, or annotate the operand with a declaration that writes one.',
          );
          return;
        }
        try {
          new Intl.DateTimeFormat('en', {
            // A zone is supplied because Atlas refuses to format a date without one, and what is
            // being decided here is whether the message's own options can be honoured. A message
            // that writes no zone takes the consumer's, which is not this file's business.
            timeZone: 'UTC',
            ...atlasDateTimeFormatOptions(functionRef.name, resolved.options),
          });
        } catch {
          optionDiagnostic(
            dateOptionProblem(functionRef.name, resolved.options),
          );
        }
        return;
      }
      /**
       * The last check, and the one that cannot be a table.
       *
       * `roundingIncrement` is a legal MessageFormat option whose validity is not a property of its
       * value: ECMA-402 accepts it only alongside an explicit `minimumFractionDigits` equal to
       * `maximumFractionDigits`, and refuses it outright next to a significant-digit option or a
       * `roundingPriority` other than `auto`. So `{42 :number roundingIncrement=5}` conforms to the
       * message specification and throws when it is formatted.
       *
       * Transcribing that rule would put a second copy of ECMA-402 in this file for nothing to keep
       * current. Building the formatter asks the authority that actually decides, with the same
       * options the evaluator will build it with, and option validation is locale-independent, so
       * a fixed locale here answers for every locale the message ships to.
       *
       * A newer runtime could accept something this compiler's `Intl` refuses, or the reverse. The
       * first direction costs a message an author can rewrite; the second is caught again at render
       * and reported as a diagnostic rather than thrown, which is where a version difference
       * between a build machine and a browser belongs.
       */
      try {
        new Intl.NumberFormat(
          'en',
          atlasNumberFormatOptions(functionRef.name, resolved.options),
        );
      } catch {
        optionDiagnostic(
          `MessageFormat options on :${functionRef.name} cannot be used together: ${Object.entries(
            resolved.options,
          )
            .map(([name, value]) => `${name}=${value}`)
            .sort()
            .join(' ')}.`,
        );
      }
    },
  });
  /**
   * Which function a name's value came from, following a re-binding chain.
   *
   * `.local $b = {$a}` re-binds `$a`'s resolved value untouched, so the function that decides
   * whether `$b` can be selected on is the one that annotated `$a`. A name nothing declares is an
   * external input with no annotation: there is no function to read, and what the consumer passes
   * decides, so it is left alone here.
   *
   * The `seen` set is not defensive about a specification the parser already enforces: it is
   * defensive about this function being handed a model from somewhere else later.
   */
  const declarationsByName = new Map(
    message.declarations.map((declaration) => [declaration.name, declaration]),
  );
  const annotatingFunction = (name: string): string | undefined => {
    const seen = new Set<string>();
    let current: string | undefined = name;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const declaration = declarationsByName.get(current);
      if (declaration === undefined) return undefined;
      const { functionRef, arg } = declaration.value;
      if (functionRef !== undefined) return functionRef.name;
      current = arg?.type === 'variable' ? arg.name : undefined;
    }
    return undefined;
  };

  if (message.type === 'select') {
    const selecting = [...selectorNames].sort(compareCodePoint);
    for (const selector of message.selectors) {
      const name = annotatingFunction(selector.name);
      if (name === undefined || selectorNames.has(name)) continue;
      // MessageFormat splits its functions into formatters and selectors, and
      // `formatting.md` is explicit about what happens when a `.match` names a formatter: the
      // selector matches nothing but the catch-all and a *Bad Selector* error is emitted. Atlas
      // knew which functions select before anything ran, the built-in profile is closed and an
      // extension descriptor declares it, and compiled the message anyway.
      //
      // Reported here rather than at render, on
      // `specs/04-message-authoring-and-catalogs.spec.md` section 6: the standard permits
      // reporting the error and continuing with a fallback, and Atlas does not take that
      // permission. The output of the fallback is the trap. Every keyed variant the author wrote is
      // dead and the catch-all renders, so the string is plausible and nobody is told that four of
      // the five variants in the message can never be chosen.
      report(
        'ATL1206',
        `MessageFormat function :${name} formats but does not select, so .match cannot select on $${selector.name}. ` +
          `A selecting function is one of ${selecting.map((each) => `:${each}`).join(', ')}, or an extension whose descriptor declares selector "exact".`,
      );
    }
  }

  if (optionDiagnostics.length > 0) return atlasFailure(optionDiagnostics);

  const base = {
    source,
    canonicalSource: stringifyMessage(message),
    declarations: normalizeDeclarations(message.declarations),
    externalInputs: Object.freeze(
      [...validation.variables].sort(compareCodePoint),
    ),
    functions: Object.freeze([...validation.functions].sort(compareCodePoint)),
    resultKind: isStructured() ? ('structured' as const) : ('plain' as const),
    ...(message.comment === undefined ? {} : { comment: message.comment }),
  };

  return atlasSuccess(
    message.type === 'message'
      ? Object.freeze({
          kind: 'pattern',
          ...base,
          pattern: normalizePattern(message.pattern),
        })
      : Object.freeze({
          kind: 'select',
          ...base,
          selectors: Object.freeze(
            message.selectors.map((selector) => selector.name),
          ),
          variants: normalizeVariants(message.variants),
        }),
  );
}

/**
 * Variants that would merge if a catch-all key had to be written as `other`.
 *
 * *Why this is a question at all.* Some interchange formats have no catch-all. XLIFF's Plural,
 * Gender and Select module is the one this was written for: it names each case, and a case named
 * `*` is not one of them, so an exporter targeting it has to spell the catch-all as some category,
 * and `other` is the only candidate. That mapping is lossy exactly when the message already has
 * an `other` of its own, because two variants then claim one case.
 *
 * *And the two are genuinely different, which is what makes the loss real rather than cosmetic.*
 * It is tempting to read `other` and `*` as synonyms, and in English they behave alike: every
 * cardinal value is `one` or `other`, so a message carrying both never reaches the catch-all.
 * Arabic has six categories (`zero`, `one`, `two`, `few`, `many`, `other`, from the CLDR release
 * this repository pins) so a message with `one`, `other` and `*` reaches `*` for four of them.
 * Merging the two would take a variant a reader can see and hand it to values it was never written
 * for.
 *
 * *It reports groups rather than a boolean* because an exporter has to name what collided to say
 * anything useful about it, and because with more than one selector the collision is between whole
 * key tuples rather than between two keys.
 *
 * A group is returned only when one of its members carries a catch-all. Two variants with identical
 * literal keys are also a defect, and a different one: they collide in MF2 itself, before any
 * export is involved, and this is not the check that should be reporting them.
 *
 * *No caller yet, deliberately.* Atlas's XLIFF export writes a select message as the whole MF2
 * source in one flat segment, which loses nothing and needs no mapping, so raising this on today's
 * export would be a warning about a format Atlas does not emit. It exists so that the exporter that
 * one day does emit per-case units asks this rather than deriving it again, and so that the
 * reasoning above is recorded where that exporter will look.
 */
export function atlasCatchallOtherCollisions(
  variants: readonly AtlasMessageVariant[],
): readonly (readonly number[])[] {
  const groups = new Map<string, number[]>();
  const catchallSignatures = new Set<string>();
  for (const [index, variant] of variants.entries()) {
    const signature = variant.keys
      .map((key) => (key.kind === 'catchall' ? 'other' : key.value))
      .join(' ');
    const group = groups.get(signature);
    if (group === undefined) groups.set(signature, [index]);
    else group.push(index);
    if (variant.keys.some((key) => key.kind === 'catchall')) {
      catchallSignatures.add(signature);
    }
  }
  return Object.freeze(
    [...groups]
      .filter(
        ([signature, group]) =>
          group.length > 1 && catchallSignatures.has(signature),
      )
      .map(([, group]) => Object.freeze([...group])),
  );
}
