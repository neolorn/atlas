// Type-only, and therefore erased: `routing.ts` imports values from this module, so a value import
// back would be a cycle. The route projection's shape belongs beside the routing code that reads
// it, and `LocalizationSetup` only needs to name it.
import type { GeneratedRouteProjection } from './routing';

/**
 * The version stamp on the interface between generated code and the runtime.
 *
 * Both halves carry it and the runtime checks them against each other, so generated output from one
 * version of Atlas and a runtime from another refuse each other rather than half working.
 */
export const GENERATED_ABI = 'atlas-generated/1' as const;
/** The version stamp on a compiled catalog, checked before one is read. */
export const COMPILED_IR_PROFILE = 'atlas-compiled-ir/1' as const;
/** The version stamp on the descriptor listing a build's compiled catalogs. */
export const CATALOG_SET_PROFILE = 'atlas-catalog-set/1' as const;
/** The version stamp on one extension declaration. */
export const EXTENSION_DESCRIPTOR_PROFILE =
  'atlas-extension-descriptor/1' as const;
/** The version stamp on the resource counts carried beside a compiled catalog. */
export const RESOURCE_SUMMARY_PROFILE = 'atlas-resource-summary/1' as const;

/**
 * Which way a language is written: left to right, or right to left.
 *
 * A determined answer. Content whose language is unknown takes `ContentDirection` instead, which
 * can also say it does not know.
 */
export type LocaleDirection = 'ltr' | 'rtl';

/**
 * A direction that may be left undetermined.
 *
 * `auto` is not a third writing direction. It says Atlas does not know, and defers to the
 * renderer's first-strong rule (UAX #9 P2/P3), which is what `dir="auto"` and `<bdi>` already
 * do in a browser. Deferring leaves the question open, which is what
 * `specs/03-locale-identity-and-resolution.spec.md` section 10 requires: Atlas never determines
 * the authoritative language of consumer content.
 */
export type ContentDirection = LocaleDirection | 'auto';

/**
 * Whether a locale change holds the page until everything is ready, or swaps as each part arrives.
 *
 * `coordinated` is the default and the one that never shows two languages at once: nothing changes
 * until every catalog and every participant is ready, and a failure leaves the old locale standing.
 * `progressive` renders what has arrived, which suits a page whose sections are independent.
 */
export type LocaleChangeMode = 'coordinated' | 'progressive';
/**
 * Which stage localization is at.
 *
 * `uninitialized` before anything starts, `initializing` while the first catalogs load, `ready`
 * once there is a snapshot to render from, `transitioning` during a locale change, and `failed`
 * when there is nothing to render and recovery is what is on screen.
 */
export type LocalizationLifecycle =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'transitioning'
  | 'failed';

/**
 * What a consumer holds in place of a message key: which message, and what it needs.
 *
 * Generated per message, so a caller never writes a string identifier and a typo is a compile
 * error rather than a missing translation in one locale. The runtime reads the fields; the
 * application passes the handle along and reads nothing.
 */
export interface MessageHandle {
  /** The generated interface version, checked against the runtime's own before anything is read. */
  readonly generatedAbi: typeof GENERATED_ABI;
  /** The package that owns the message. */
  readonly providerId: string;
  /** The scope within that package, which is the unit its catalog is loaded in. */
  readonly scopeId: string;
  /** The message's key within that scope. */
  readonly messageId: string;
  /** The stable identity the compiled catalog is indexed by. */
  readonly identity: string;
  /** Whether evaluating it gives a string or parts a template places. */
  readonly resultKind: 'plain' | 'structured';
  /** The values it takes, by name, for the runtime to check what it was passed. */
  readonly inputNames: readonly string[];
  /** The named regions it places, for the runtime to check what was bound. */
  readonly slotNames: readonly string[];
  /**
   * The typed contract, which exists only at compile time and is never present at runtime.
   *
   * What makes a message needing a name refuse an object without one. Read through
   * `MessageInputs` and `MessageSlots` rather than directly.
   */
  readonly __atlasContract?: {
    readonly inputs: unknown;
    readonly slots: string;
    readonly resultKind: 'plain' | 'structured';
  };
}

/**
 * The values a particular message declares, as the object a caller must pass.
 *
 * For a component or a helper that takes a handle and has to name what goes with it. A message
 * declaring none gives an object with no keys, which is what makes the argument optional.
 */
export type MessageInputs<Handle> = Handle extends {
  readonly __atlasContract?: { readonly inputs: infer Inputs };
}
  ? Inputs
  : never;

/**
 * The names of the regions a particular message places, as a union of string literals.
 *
 * What types a bindings object, so a slot the message does not have is a compile error and one it
 * does have cannot be left out.
 */
export type MessageSlots<Handle> = Handle extends {
  readonly __atlasContract?: { readonly slots: infer Slots };
}
  ? Extract<Slots, string>
  : never;

/**
 * Any plain-result handle, whatever inputs it declares.
 *
 * Written as its own interface rather than as `MessageHandle & { resultKind: 'plain' }`, because
 * the two things it has to do pull the declared inputs in opposite directions.
 *
 * It has to be *callable with no inputs*: `localization.text(handle)` is the whole point of a
 * plain handle, and `MessageInputArguments` makes the argument optional only when
 * `keyof MessageInputs<Handle>` is `never`. Instantiating `Inputs` as
 * `Readonly<Record<string, unknown>>` gave `keyof` of `string`, so `text(handle)` failed with
 * `TS2554: Expected 2 arguments, but got 1`. That reproduced on tsc 6.0.3, and two
 * consumers independently wrote the same replacement type to get around it.
 *
 * It also has to be *assignable from a handle that declares inputs*, because that is what
 * `IssueMessageBinding.message`, `IssueMessageSource.unknown`, `presentExternalValue`'s bindings
 * and `issueMessage`'s return all are. Narrowing `Inputs` to fix the first breaks the second:
 * `inputNames` is `readonly (keyof Inputs & string)[]`, so a target with no nameable inputs has
 * `readonly never[]` there, and `readonly 'name'[]` does not assign to it.
 *
 * Separating them settles both. `inputNames` widens to `readonly string[]`, which any handle
 * satisfies, while the type-only contract carries an inputs type with no keys, which is what makes
 * the argument optional. `Record<never, never>` is `{}`, and every object assigns to `{}`, so a
 * handle declaring `{ name: string }` still assigns here, and reading inputs *off* this type still
 * yields nothing nameable, which is the honest answer for a handle whose inputs are not known.
 */
export interface PlainMessageHandle extends MessageHandle {
  readonly resultKind: 'plain';
  readonly __atlasContract?: {
    readonly inputs: Readonly<Record<never, never>>;
    readonly slots: never;
    readonly resultKind: 'plain';
  };
}

/**
 * The argument list that follows a handle, which is the message's inputs, or nothing.
 *
 * Spread into a signature, so one function accepts `text(greeting)` for a message taking nothing
 * and requires `text(welcome, { name })` for one that does. Neither call has an optional argument
 * that is really required.
 */
export type MessageInputArguments<Handle> =
  keyof MessageInputs<Handle> extends never
    ? readonly [inputs?: MessageInputs<Handle>]
    : readonly [inputs: MessageInputs<Handle>];

/** One scope as the generated configuration lists it: what it is, and what loading it requires. */
export interface GeneratedScope {
  /** The package that owns it. */
  readonly providerId: string;
  /** Its own identity within that package. */
  readonly scopeId: string;
  /**
   * Whether the first render uses this scope.
   *
   * Absent means yes, so a configuration that does not carry the field loads everything. Atlas
   * derives it from the route tree rather than asking an application to declare it: a scope used
   * only behind a lazy route boundary is loaded when that route activates.
   */
  readonly startup?: boolean;
  /** The message-contract digest a catalog for this scope must match. */
  readonly applicationContractFingerprint: string;
  /** The extension-registry digest it must match. */
  readonly semanticRegistryFingerprint: string;
  /** The extensions that must be registered before this scope's messages can be evaluated. */
  readonly requiredExtensions: readonly RuntimeExtensionDescriptor[];
}

/**
 * Everything the build decided about an application's localization, in one object.
 *
 * Generated, and passed to `provideLocalization` by the generated code rather than written by
 * hand. The runtime reads it and asks no further questions: which locales exist, what they call
 * themselves, how they fall back, and which scopes the first render needs are all settled here.
 */
export interface GeneratedConfiguration {
  /** The generated interface version, checked against the runtime's own. */
  readonly generatedAbi: typeof GENERATED_ABI;
  /** The locale the messages were authored in. */
  readonly sourceLocale: string;
  /** The locale used when nothing else selects one. */
  readonly defaultLocale: string;
  /** Every locale this build ships, canonically spelled. */
  readonly locales: readonly string[];
  /** Spellings that resolve to one of those locales, so a renamed or narrower tag still lands. */
  readonly aliases: Readonly<Record<string, string>>;
  /**
   * What each locale this owner ships calls itself, from the toolkit's pinned CLDR release.
   *
   * A switcher's label is the one thing about a locale the visitor reads in the locale's own
   * language, and `Intl.DisplayNames` answers it from whatever CLDR snapshot the visitor's engine
   * happens to carry. Measured across the four engines Atlas gates on, three of sixteen locales
   * disagreed, and Atlas server-renders the switcher on Node, so the label could change under a
   * visitor on hydration, from a value Atlas itself had published, with nothing wrong anywhere.
   *
   * The build decides it instead, once, and sends one string per configured locale. A locale
   * absent from the table is one the toolkit's CLDR has no name for; the runtime asks the engine
   * for that one rather than showing a tag.
   */
  readonly localeNames?: Readonly<Record<string, string>>;
  /**
   * How each locale this owner ships is written, where it disagrees with CLDR about that locale.
   *
   * Absent, or a locale absent from it, means CLDR's answer for that locale stands, which is the
   * standard's choice and not an absence of one. Generated only when the configuration declared
   * something, so an application that agrees with CLDR everywhere carries no table at all.
   */
  readonly formatting?: Readonly<Record<string, LocaleFormattingOverride>>;
  /**
   * The locales each locale inherits from, nearest first, before the source locale is reached.
   *
   * CLDR inheritance rather than truncation, resolved at build time from the toolkit's pinned
   * parent data and this owner's own declarations, and filtered here to the locales this owner
   * ships. A member with no catalog would cost a lookup and answer nothing, so it is not sent.
   *
   * Absent, or a locale absent from it, means that locale inherits from nothing and falls to the
   * source locale directly, which is what every locale did before this existed.
   *
   * The runtime carries no parent table of its own and must not: the toolkit's is 199 entries
   * about every locale CLDR knows, and an application shipping three locales needs three short
   * lists. Chains also depend on which locales this owner ships, which only the build knows.
   */
  readonly localeFallbacks?: Readonly<Record<string, readonly string[]>>;
  /** A digest of every message contract in the application, which a catalog is matched against. */
  readonly applicationContractFingerprint: string;
  /** A digest of the extension registry the messages were compiled against. */
  readonly semanticRegistryFingerprint: string;
  /** Every extension the application's messages reference. */
  readonly extensionDescriptors?: readonly RuntimeExtensionDescriptor[];
  /** Every scope, with what each needs and whether the first render uses it. */
  readonly scopes: readonly GeneratedScope[];
}

/** What identifies one catalog: whose it is, which scope, and which locale. */
export interface CatalogKey {
  /** The package that owns the messages. */
  readonly providerId: string;
  /** The scope within it, which is the unit the runtime loads. */
  readonly scopeId: string;
  /** The locale this catalog holds. */
  readonly catalogLocale: string;
}

/**
 * What the single most expensive message in a catalog costs, by each measure separately.
 *
 * Each number may come from a different message: the point is the worst case per dimension, which
 * is what the per-message ceilings are checked against before anything is evaluated.
 */
export interface MessageResourceSummary {
  /** Nodes in the compiled body. */
  readonly irNodes: number;
  /** How deeply that body nests. */
  readonly depth: number;
  /** How many values it selects on. */
  readonly selectors: number;
  /** How many branches it has. */
  readonly variants: number;
  /** How many values it takes. */
  readonly inputs: number;
  /** How many named regions it places. */
  readonly slots: number;
  /** How many pieces its output can come apart into. */
  readonly outputParts: number;
}

/**
 * What a catalog costs, counted at build time and checked by the runtime before it is accepted.
 *
 * Counted once by the compiler rather than measured on load, so admitting a catalog is a handful of
 * comparisons. A catalog past any ceiling is refused, which is how something too large to evaluate
 * safely is stopped before a page is rendering.
 */
export interface CatalogResourceSummary {
  /** The summary-shape version stamp. */
  readonly profile: typeof RESOURCE_SUMMARY_PROFILE;
  /** How large the catalog is once decoded. */
  readonly decodedBytes: number;
  /** How many messages are in it. */
  readonly messages: number;
  /** How many distinct names its messages use. */
  readonly identifiers: number;
  /** How many literal values they contain. */
  readonly literals: number;
  /** Nodes across every compiled body. */
  readonly irNodes: number;
  /** The deepest nesting any one body reaches. */
  readonly depth: number;
  /** How many selections the catalog makes in total. */
  readonly selectors: number;
  /** How many branches across all of them. */
  readonly variants: number;
  /** How many values its messages take in total. */
  readonly inputs: number;
  /** How many named regions they place in total. */
  readonly slots: number;
  /** How many references its bodies resolve. */
  readonly references: number;
  /** How many function calls they make. */
  readonly functions: number;
  /** How many output pieces they can produce in total. */
  readonly outputParts: number;
  /** The worst case per measure, for the per-message ceilings. */
  readonly maximumMessage: MessageResourceSummary;
}

/**
 * Everything about a compiled catalog the runtime can check before fetching it.
 *
 * Every field is a condition. A catalog whose stamps, digests or required extensions do not match
 * what this application is is refused without being loaded, which is what keeps output from one
 * build out of a page running another.
 */
export interface ArtifactAddress {
  /** Whose catalog, which scope, which locale. */
  readonly key: CatalogKey;
  /** The compiled-shape version stamp the artifact carries. */
  readonly compiledIrProfile: typeof COMPILED_IR_PROFILE;
  /** The schema of the file itself. */
  readonly schema: 'atlas-compiled-catalog/1';
  /** Runtime capabilities it needs, which a host without them refuses on. */
  readonly requiredFeatures: readonly string[];
  /** The standards profile its messages were compiled under. */
  readonly standardsProfile: 'atlas-1';
  /** The generated interface version it matches. */
  readonly generatedAbi: typeof GENERATED_ABI;
  /** The message-contract digest it was built against. */
  readonly applicationContractFingerprint: string;
  /** The extension-registry digest it was built against. */
  readonly semanticRegistryFingerprint: string;
  /** The extensions that must be registered before it can be evaluated. */
  readonly requiredExtensions: readonly RuntimeExtensionDescriptor[];
  /** A digest of its content, for cache keys and for telling two builds apart. */
  readonly contentDigest: string;
}

/** One catalog as the descriptor lists it: what it is, where it is, and what it costs. */
export interface CatalogSetArtifact {
  /** Everything checkable about it before it is fetched. */
  readonly address: ArtifactAddress;
  /** Where the module sits, as the path the loader imports. */
  readonly modulePath: string;
  /** What loading it costs, listed here so the decision is made before the fetch. */
  readonly resources: CatalogResourceSummary;
}

/** One package's catalogs, grouped under the set they were built as. */
export interface ProviderCatalogSet {
  /** The package these belong to. */
  readonly providerId: string;
  /** Which set within that package, which distinguishes two builds of one package. */
  readonly catalogSetId: string;
  /** The catalogs, one per scope and locale. */
  readonly artifacts: readonly CatalogSetArtifact[];
}

/**
 * The index of what catalogs exist, which the runtime reads before loading any of them.
 *
 * An application composing several packages gets one descriptor listing all of them, so which
 * catalog answers for a scope and a locale is one lookup rather than a search per package.
 */
export interface CatalogSetDescriptor {
  /** The descriptor-shape version stamp. */
  readonly profile: typeof CATALOG_SET_PROFILE;
  /** The generated interface version every catalog in it matches. */
  readonly generatedAbi: typeof GENERATED_ABI;
  /** The message-contract digest they were all built against. */
  readonly applicationContractFingerprint: string;
  /** The extension-registry digest they were all built against. */
  readonly semanticRegistryFingerprint: string;
  /** The packages, each with its own catalogs. */
  readonly providers: readonly ProviderCatalogSet[];
}

/**
 * How one catalog is fetched, which is a function returning whatever the module exported.
 *
 * Generated as a dynamic import, so a catalog is a separate chunk and a locale nobody selects is
 * never downloaded. What it returns is validated before anything in it is evaluated, so a loader
 * may return anything and a wrong answer is reported rather than trusted.
 */
export type CatalogLoader = () => unknown | Promise<unknown>;
/** Every catalog a build can load, keyed by the scope and locale each one answers for. */
export type CatalogLoaders = Readonly<Record<string, CatalogLoader>>;

/**
 * The five value types an extension may declare, matching what a message input can be.
 *
 * The same five the compiler uses, so a function an extension adds takes the kinds of value a
 * built-in takes and nothing more exotic.
 */
export type ExtensionValueType =
  | 'boolean'
  | 'date-time'
  | 'integer'
  | 'number'
  | 'string';

interface AtlasRuntimeExtensionDescriptorBase {
  readonly profile: typeof EXTENSION_DESCRIPTOR_PROFILE;
  readonly id: string;
  readonly fingerprint: string;
}

/**
 * The declaration half of a function messages may call, as the runtime receives it.
 *
 * Inert. It says what the function accepts and produces; the code that does the work arrives
 * separately as a binding, and the runtime checks each call against this before running it.
 */
export interface RuntimeMessageFunctionDescriptor extends AtlasRuntimeExtensionDescriptorBase {
  readonly kind: 'message-function';
  /** What kind of value it may be applied to. */
  readonly operandType: ExtensionValueType;
  /**
   * The options it accepts, keyed by name, each with its type and whether it must be given.
   *
   * Declared so the compiler can refuse a misspelled option where it is written rather than
   * ignoring it at render time. Listing `values` closes the option to those literals.
   */
  readonly options?: Readonly<
    Record<
      string,
      Readonly<{
        readonly type: ExtensionValueType;
        readonly required?: boolean;
        readonly values?: readonly (string | number | boolean)[];
      }>
    >
  >;
  /** What it produces. */
  readonly resultType: 'string' | 'number' | 'date-time';
  /**
   * Whether a selection may branch on its result.
   *
   * `none` means it formats only. `exact` means it reports which variant keys its value matches.
   */
  readonly selector: 'none' | 'exact';
  /** How long its output may be, which bounds what one call can cost. */
  readonly maximumOutputLength: number;
}

/**
 * The declaration half of a value type a message family may vary over, beyond Atlas's own.
 *
 * Says what a segment value may look like; the code that normalizes one arrives as a binding.
 */
export interface RuntimeIdentifierSegmentDescriptor extends AtlasRuntimeExtensionDescriptorBase {
  readonly kind: 'identifier-segment';
  /** Which spelling a value must follow. */
  readonly syntax: 'lower-kebab' | 'ascii-token' | 'unicode-token';
  /** The longest a value may be. */
  readonly maximumLength: number;
}

/**
 * The declaration half of a named region messages may place, beyond the ones Atlas ships.
 *
 * The catalog places it and names it; what it renders as is decided in application code, which is
 * what keeps a catalog from naming a component.
 */
export interface RuntimeRichSlotKindDescriptor extends AtlasRuntimeExtensionDescriptorBase {
  readonly kind: 'rich-slot-kind';
  /** Whether it wraps text or marks a point. */
  readonly shape: 'paired' | 'standalone';
  /** Whether a reader can act on it, which is what holds it to being reachable and labelled. */
  readonly interactive: boolean;
  /**
   * Where the words inside it come from.
   *
   * `children` means the message supplies them. `binding-required` means the application does.
   */
  readonly textProjection: 'children' | 'binding-required';
  /** The options it accepts, by name, each with the values allowed for it. */
  readonly options?: Readonly<Record<string, readonly string[]>>;
}

/**
 * The declaration half of a way of writing a value type Atlas does not know.
 *
 * A domain's own quantity, code or identifier. The code that writes it arrives as a binding.
 */
export interface RuntimeFormattingAdapterDescriptor extends AtlasRuntimeExtensionDescriptorBase {
  readonly kind: 'formatting-adapter';
  /** The value type it writes, named by the application. */
  readonly inputType: string;
  /** Whether it produces a string or parts a template places. */
  readonly result: 'text' | 'parts';
  /** How long its output may be. */
  readonly maximumOutputLength: number;
}

/**
 * The declaration half of a way of reading a value type Atlas does not know out of typed text.
 *
 * The other half of a formatting adapter, for a field that has to round-trip.
 */
export interface RuntimeParsingAdapterDescriptor extends AtlasRuntimeExtensionDescriptorBase {
  readonly kind: 'parsing-adapter';
  /** The value type it produces, named by the application. */
  readonly outputType: string;
  /** How much text it will be handed, which bounds what a pasted field can cost. */
  readonly maximumInputLength: number;
}

/**
 * Any of the five things an extension declares, as the runtime receives them.
 *
 * Check `kind` to tell them apart. All five carry an identity and a fingerprint, so a catalog can
 * say exactly which version of an extension it needs and the runtime can refuse one that has
 * changed since.
 */
export type RuntimeExtensionDescriptor =
  | RuntimeMessageFunctionDescriptor
  | RuntimeIdentifierSegmentDescriptor
  | RuntimeRichSlotKindDescriptor
  | RuntimeFormattingAdapterDescriptor
  | RuntimeParsingAdapterDescriptor;

/** One call to an extension's message function: what it was given, and where. */
export interface MessageFunctionInvocation {
  /**
   * The value being formatted or selected on.
   *
   * `unknown`, because what it is depends on the descriptor's declared operand type. Narrow it
   * rather than casting: a message can be written to pass anything, and the runtime does not check
   * the operand against the declaration on the caller's behalf.
   */
  readonly operand: unknown;
  /**
   * The options this call resolved with: those written on the expression, over those the operand
   * carried, narrowed to the names this function's descriptor declares.
   *
   * MessageFormat resolves an operand that is itself an annotated expression to a value that can
   * carry options, "with options on the expression taking priority over any options of the
   * operand". Atlas did that for its own numeric functions and not for extensions, so
   * `.input {$x :ns:f a=1}` followed by `.local $y = {$x :ns:f}` reached the second call with
   * nothing: the same message, two answers, depending on which function it named. The narrowing
   * is Atlas's: a descriptor says which options a function accepts, and inheritance must not be a
   * way for a name it never declared to arrive anyway.
   */
  readonly options: Readonly<Record<string, unknown>>;
  /** The locale being rendered in. */
  readonly locale: string;
  /** The zone, calendar, numbering system and hour cycle in force, for a function that formats. */
  readonly formatting: FormattingContext;
}

/** What an extension's message function gives back: what to show, and what to select on. */
export interface MessageFunctionResult {
  /** The text to place in the message. */
  readonly text: string;
  /** The underlying value, for a caller that needs it beside the text. */
  readonly value?: string | number;
  /**
   * The variant keys this value matches, best first. Omitted by a `selector: 'none'` function and
   * required, possibly empty, of a `selector: 'exact'` one.
   *
   * Both of MessageFormat's selection operations are defined on this one list, which is why it is a
   * list and why it is ordered. The specification: *"Match(`rv`, `k`) returns true for any key `k`
   * that matches `rv`"* (any, so a value may match several) and *"BetterThan(`rv`, `k1`, `k2`)
   * returns true for any keys `k1` and `k2` for which Match(`rv`, `k1`) is true, Match(`rv`, `k2`)
   * is true, and `k1` is a better match than `k2`"*. A function that can say which keys it matches,
   * in the order it prefers them, has stated both: Match is membership, BetterThan is position.
   *
   * This was a single `selectKey`, which could express neither. A function could not match `1.0`
   * and `1` at once, and could not say that `1.0` was the better of the two, so the ranking channel
   * Atlas's own `:number` uses had no counterpart an extension could reach. An empty list is a
   * value that supports selection and matches nothing, which is different from a function that does
   * not select at all: the first reaches the catch-all, the second is refused at compile time.
   */
  readonly selectKeys?: readonly string[];
}

/** One call to a formatting adapter: the value, and the locale and conventions to write it in. */
export interface FormattingAdapterInvocation<Value = unknown> {
  /** The value to write, typed by the binding rather than by the call site. */
  readonly value: Value;
  /** The locale to write it in. */
  readonly locale: string;
  /** The zone, calendar, numbering system and hour cycle in force. */
  readonly formatting: FormattingContext;
}

/** What a formatting adapter gives back. */
export interface FormattingAdapterOutput {
  /** The finished text. */
  readonly text: string;
  /**
   * The same output broken into its parts, for an adapter that declared it produces parts.
   *
   * What lets a caller style a piece of the result, the way a currency symbol can be styled apart
   * from its number.
   */
  readonly parts?: readonly LocalizedFormatPart[];
}

/** One call to a parsing adapter: the text somebody typed, and how to read it. */
export interface ParsingAdapterInvocation {
  /** What was typed. Never longer than the adapter's declared bound. */
  readonly text: string;
  /** The locale to read it in. */
  readonly locale: string;
  /** The zone, calendar, numbering system and hour cycle in force. */
  readonly formatting: FormattingContext;
}

/** An installed message function: the declaration it answers for, and the code that runs. */
export interface RuntimeMessageFunctionBinding {
  /** The declaration this implements. Must be the one the catalog was compiled against. */
  readonly descriptor: RuntimeMessageFunctionDescriptor;
  /**
   * Runs the function for one call.
   *
   * Called while a message is being evaluated, so it must be synchronous and must not throw: a
   * message that cannot be rendered is reported through the evaluation, not through an exception
   * out of the middle of it.
   */
  evaluate(invocation: MessageFunctionInvocation): MessageFunctionResult;
}

/** An installed segment type: the declaration it answers for, and the code that normalizes it. */
export interface RuntimeIdentifierSegmentBinding {
  /** The declaration this implements. */
  readonly descriptor: RuntimeIdentifierSegmentDescriptor;
  /**
   * Puts a segment value into its canonical spelling, or returns `undefined` for one it refuses.
   *
   * Refusing is how an unknown member is kept from reaching a lookup, so return `undefined` rather
   * than guessing.
   */
  canonicalize(value: string): string | undefined;
}

/** An installed slot kind: the declaration it answers for, and how its words read as plain text. */
export interface RuntimeRichSlotKindBinding {
  /** The declaration this implements. */
  readonly descriptor: RuntimeRichSlotKindDescriptor;
  /**
   * Gives the plain-text reading of a slot, for somewhere the rendered form cannot go.
   *
   * A title attribute, an announcement, a log line. What comes back is text and never markup.
   */
  projectText(part: LocalizedSlotPart): string;
}

/**
 * An installed formatting adapter, and the type of value it formats.
 *
 * The value type lives on the binding because the binding is what knows it. With the type nowhere,
 * `formatWithAdapter(extensionId: string, value: Value)` takes an unchecked identifier and a value
 * unrelated to the adapter, so a mistyped identifier and a value the adapter cannot format both
 * compile.
 */
export interface RuntimeFormattingAdapterBinding<Value = unknown> {
  /** The declaration this implements. */
  readonly descriptor: RuntimeFormattingAdapterDescriptor;
  /** Writes one value. Synchronous, and must not throw. */
  format(
    invocation: FormattingAdapterInvocation<Value>,
  ): FormattingAdapterOutput;
}

/**
 * An installed parsing adapter, and the type of value it produces.
 *
 * `parseWithAdapter<Value>(extensionId, text)` let the *caller* declare the result type, which is
 * an assertion rather than a contract: nothing checked it against what the adapter actually
 * returns, so the two could disagree silently and forever.
 */
export interface RuntimeParsingAdapterBinding<Value = unknown> {
  /** The declaration this implements. */
  readonly descriptor: RuntimeParsingAdapterDescriptor;
  /**
   * Reads one piece of text.
   *
   * Returns a result rather than throwing, because text that does not parse is the ordinary case in
   * a form rather than a defect.
   */
  parse(invocation: ParsingAdapterInvocation): LocalizedInputResult<Value>;
}

/**
 * Any of the five installed extensions: a declaration paired with the code that implements it.
 *
 * What an application registers. Each binding must carry the same declaration the catalogs were
 * compiled against, or the catalog is refused rather than run against something else.
 */
export type RuntimeExtensionBinding =
  | RuntimeMessageFunctionBinding
  | RuntimeIdentifierSegmentBinding
  | RuntimeRichSlotKindBinding
  | RuntimeFormattingAdapterBinding
  | RuntimeParsingAdapterBinding;

/**
 * A recovery message compiled apart from the catalogs, so it can be read when none of them loaded.
 *
 * The failure path cannot depend on the thing that failed. These arrive with the generated
 * configuration rather than through a loader, one per locale, and are the only messages available
 * when localization did not start.
 */
export interface RecoveryRepresentation {
  /** Which message this is, by the identity its handle carries. */
  readonly identity: string;
  /** The locale it is written in. */
  readonly locale: string;
  /** A digest of the source it was compiled from. */
  readonly sourceFingerprint: string;
  /** The compiled body. Validated before it is evaluated, like any other. */
  readonly body: unknown;
}

/**
 * One locale's person-name profile, as Atlas generates it: the pattern cube plus the scalars.
 *
 * Positional rather than named. Named fields would outweigh the data several times over in a
 * generated artifact, and nothing reads a row by hand: `formatPersonName` is the only reader.
 * Every number except the last two entries indexes the accompanying pattern pool, or is -1 for a
 * cell the locale does not fill.
 */
export type PersonNameRow = readonly [
  tag: string,
  cells: readonly number[],
  initial: number,
  initialSequence: number,
  foreignSpace: number,
  nativeSpace: number,
  defaultLength: number,
  defaultFormality: number,
  givenFirstLocales: readonly string[],
  surnameFirstLocales: readonly string[],
];

/**
 * The person-name data an application generated for its own locales.
 *
 * Declared structurally rather than imported from the toolkit: the runtime does not depend on the
 * toolkit, and this crosses between them as generated data the same way a catalog set does.
 *
 * `profile` identifies the derivation, not the CLDR release. A runtime handed a set whose profile
 * it does not know refuses it rather than reading the wrong offsets out of rows that happen to be
 * the right length.
 */
/**
 * The person-name rules for every locale an application generates them for.
 *
 * Passed to `formatPersonName` rather than carried on a formatting context, because a context is
 * serialized into every server-rendered response and this table would ride along in each one, on
 * top of the copy already in the bundle.
 *
 * A set a caller supplies must carry the same profile version the runtime expects; one that does
 * not is refused rather than read as though it matched.
 */
export interface PersonNameProfileSet {
  /** The version of the profile shape, which is what a supplied set is checked against. */
  readonly profile: string;
  /** The distinct patterns, referenced by index from the rows so each is stored once. */
  readonly patterns: readonly string[];
  /** One row per locale, each naming the patterns it uses and the scalars that go with them. */
  readonly rows: readonly PersonNameRow[];
}

/*
 * Why this is not a member of `FormattingContext`, which is where locale data would naturally sit:
 * a formatting context is part of the snapshot Atlas serializes into the SSR transfer payload, so
 * a table on it would be sent to the browser inside every rendered response, on top of the copy
 * already in the bundle. It reaches `formatPersonName` as an argument instead.
 */

/**
 * Which catalog to load, named as the package and the scope within it.
 *
 * The unit everything about loading is expressed in: what a route requires, what a snapshot has,
 * what is still arriving.
 */
export interface LocalizationScope {
  /** The package that owns the messages. */
  readonly providerId: string;
  /** The scope within that package. */
  readonly scopeId: string;
}

/**
 * Everything the build hands the runtime: the configuration, the index, and the loaders.
 *
 * Produced by generation and passed by the generated `provideLocalization`, so an application
 * does not assemble one. It is the whole of what the runtime knows before the first catalog
 * arrives.
 */
export interface LocalizationSetup {
  /** What the build decided: the locales, their names, their fallbacks, and the scopes. */
  readonly configuration: GeneratedConfiguration;
  /** The index of which catalog answers for which scope and locale. */
  readonly catalogSet: CatalogSetDescriptor;
  /** How to fetch each of them, one function per scope and locale. */
  readonly catalogLoaders: CatalogLoaders;
  /** The messages readable when no catalog could be loaded. Absent when none were selected. */
  readonly recoveryPayload?: readonly RecoveryRepresentation[];
  /**
   * Person-name patterns for the configured locales, supplied by the generated
   * `provideLocalization()`.
   *
   * Absent means the application generated none, and `formatPersonName` falls back to the CLDR
   * root profile compiled into the runtime: published data covering every field and modifier,
   * rather than the hand-written field order Atlas carried before this existed.
   */
  readonly personNames?: PersonNameProfileSet;
  /** The installed extensions, each pairing a declaration with the code that implements it. */
  readonly extensions?: readonly RuntimeExtensionBinding[];
  /**
   * The route table Atlas derived from this owner's sources.
   *
   * Supplied by the generated `provideLocalization()`, never by the application: it is the half of
   * a route projection Atlas already knows. `withRouting()` carries the other half (the URL
   * policy, and the localized paths, parameter codecs, and historical outcomes an application
   * owns) so no application declares the same route table twice, which is how two copies of it
   * drift apart.
   */
  readonly routeProjection?: GeneratedRouteProjection;
  /**
   * Defaults to the finite generated artifact count. A lower value enables
   * deterministic LRU eviction while active snapshots remain pinned.
   */
  readonly maximumCachedCatalogs?: number;
  /**
   * Source fallback is friendly by default; strict mode rejects its use.
   *
   * Friendly does not mean quiet. `specs/11-diagnostics-and-observability.spec.md` section 1
   * keeps fallback and recovery diagnosable, so rendering the source locale where a
   * translation is missing is reported as what it is. A run that renders the source locale
   * everywhere and reports nothing looks exactly like a run that had every translation.
   */
  readonly fallbackPolicy?: 'source' | 'strict';
}

/**
 * What failed, as a closed set of codes.
 *
 * Names the operation rather than the underlying cause: `catalog-load-failed` says a catalog did
 * not arrive, and `LocalizationFailureReason` says whether that was a network, an integrity or a
 * resource problem. Codes never change and are never reused, so a handler can branch on one.
 */
export type LocalizationFailureCode =
  | 'invalid-configuration'
  | 'unsupported-locale'
  | 'scope-unavailable'
  | 'catalog-load-failed'
  | 'catalog-admission-failed'
  | 'message-unavailable'
  | 'invalid-message-input'
  | 'invalid-rich-message'
  | 'unsupported-formatting-capability'
  | 'invalid-localized-input'
  | 'unsupported-input-capability'
  | 'unsafe-route'
  | 'route-unavailable'
  | 'participant-contract-rejected'
  | 'participant-failed'
  | 'participant-timeout'
  | 'participant-unavailable'
  | 'unknown-presentation-code'
  | 'effect-failed'
  | 'cancelled'
  | 'superseded'
  | 'disposed'
  | 'internal-invariant';

/**
 * A closed set naming what kind of thing failed underneath a diagnostic, orthogonal to `code`,
 * which names the operation that failed.
 *
 * Deliberately an enum rather than free text. `LocalizationDiagnostic` must be structurally
 * incapable of carrying user content, credentials or absolute paths, and a caught error's message
 * routinely contains all three: a failed dynamic import names a filesystem path, and a consumer
 * adapter can throw anything at all. A closed set cannot leak, whatever was caught.
 *
 * `specs/11-diagnostics-and-observability.spec.md` section 5 asks for that exclusion to be
 * structural rather than a rule applied at each site, and a closed set is what makes it so:
 * there is no field here for a caught message to be copied into, so no site has to remember
 * not to copy it.
 *
 * The underlying error is attached to `LocalizationError.cause` instead, where developers, stack
 * traces and debuggers reach it and no diagnostic contract applies.
 */
export type LocalizationFailureReason =
  | 'native-capability-rejected'
  | 'module-load-failed'
  | 'integrity-mismatch'
  | 'resource-limit'
  | 'consumer-code-threw'
  | 'malformed-input';

/**
 * Whether something went wrong, or nothing was wrong and there was simply nothing to show.
 *
 * `operational-failure` is a defect. `localized-representation-unavailable` is a correct answer:
 * nothing exists in that locale. `consumer-domain-outcome` is the application's own business
 * result reported through the same channel. Handling all three as errors makes an ordinary miss
 * read as a fault.
 */
export type LocalizationOutcomeClass =
  | 'operational-failure'
  | 'localized-representation-unavailable'
  | 'consumer-domain-outcome';

/**
 * What the runtime has to say about something that did not work, in a shape safe to log whole.
 *
 * There is no field here for a caught error's text, an absolute path, or anything a reader typed,
 * so nothing of that kind can reach a log through a diagnostic however it was caught. What was
 * caught is attached to the error's `cause`, where a debugger reaches it and no contract applies.
 */
export interface LocalizationDiagnostic {
  /** Which operation failed. */
  readonly code: LocalizationFailureCode;
  /** Whether this is a defect, an honest absence, or the application's own result. */
  readonly outcome: LocalizationOutcomeClass;
  /** A fixed sentence from Atlas's own vocabulary. Never assembled out of what was caught. */
  readonly message: string;
  /** The locale the work was for, which on a change is the one being moved to. */
  readonly targetLocale?: string;
  /** The locale that actually answered, which differs from the target when something fell back. */
  readonly supplyingLocale?: string;
  /** Which package's catalogs this concerns. */
  readonly providerId?: string;
  /** Which scope within that package. */
  readonly scopeId?: string;
  /** Which participant this is about, on a failure raised by one. */
  readonly participantId?: string;
  /** Which locale change this belongs to, so one transaction's diagnostics group together. */
  readonly transitionId?: number;
  /** What kind of thing went wrong underneath, from a closed set. */
  readonly reason?: LocalizationFailureReason;
  /** Which message this is about, on a failure evaluating one. */
  readonly messageIdentity?: string;
}

/**
 * What Atlas throws, carrying the diagnostic rather than only a sentence.
 *
 * Thrown where there is no result to return one in: a misconfiguration, a value that cannot be
 * built. Work with an outcome reports through a result instead.
 *
 * Catch it and read `diagnostic` to branch on what happened. `cause` holds whatever was caught
 * underneath, which is for a person reading a stack trace rather than for a log.
 */
export class LocalizationError extends Error {
  /** Recognizable by a handler without an `instanceof`. */
  override readonly name = 'LocalizationError';

  constructor(
    /** What went wrong, in the shape that is safe to log. */
    readonly diagnostic: LocalizationDiagnostic,
    options?: { readonly cause?: unknown },
  ) {
    super(diagnostic.message, options);
  }
}

/**
 * What is committed right now: the locale, its catalogs, and everything rendered from them.
 *
 * It is replaced whole at a commit rather than changed in pieces, so everything read out of one
 * snapshot belongs to the same locale. A rendering pass that reads it twice reads the same thing
 * both times, which is what keeps two languages from appearing on one screen.
 */
export interface LocalizationSnapshot {
  /** Which commit this is, counting up, so an event can be placed against what was on screen. */
  readonly id: number;
  /** The locale committed. */
  readonly primaryLocale: string;
  /** Which way that locale is written. */
  readonly direction: LocaleDirection;
  /** The scopes this commit was meant to have. */
  readonly requiredScopes: readonly LocalizationScope[];
  /** The scopes it actually has, which is the same list unless something did not arrive. */
  readonly loadedScopes: readonly LocalizationScope[];
  /** Whether something is missing, so a page can say so rather than quietly showing less. */
  readonly degraded: boolean;
  /** The generated interface version the catalogs were built against. */
  readonly generatedAbi: typeof GENERATED_ABI;
  /** The standards profile the messages were compiled under. */
  readonly standardsProfile: 'atlas-1';
  /** Which catalog set answered for each package, which is what distinguishes two builds. */
  readonly catalogSetIds: Readonly<Record<string, string>>;
  /** The zone, calendar, numbering system and hour cycle every formatting call inherits. */
  readonly formatting: FormattingContext;
  /** Where the reader is, when routing is installed and a navigation has settled. */
  readonly route?: LocalizationRouteSnapshot;
}

/** Which page the reader is on, in the terms localization needs to describe it elsewhere. */
export interface LocalizationRouteSnapshot {
  /** Which route, by the stable name the projection gives it. */
  readonly routeId: string;
  /** Which route table this was resolved against, so a stale snapshot can be recognized. */
  readonly projectionIdentity: string;
  /** This page's address in the committed locale, which is what the canonical link carries. */
  readonly canonicalPath: string;
  /**
   * Where this page lives in each other locale, keyed by the configured locale.
   *
   * Only the addresses that select the locale they are keyed by: one that a visitor stating no
   * preference would actually be served that locale at. An entry here becomes a link, and a link is
   * a promise about where following it lands. Under a prefix or host policy that is every locale,
   * because the prefix or the origin decides. Under `locale-neutral` it is the locales whose
   * spelling of this route differs, and on a route every locale spells alike it is the one the
   * address is negotiated to.
   *
   * Absent, rather than empty, where none qualifies, and before a route with a loaded slug has
   * declared its spellings, because until then there is nothing to build from. A control reading
   * this renders a link when there is one and switches without one when there is not; the switch
   * itself never depends on it.
   *
   * Under a `locale-host` policy these are absolute URLs at the origin that serves each locale,
   * because that is where the page is. A switch to one of them is a document navigation rather
   * than a transition, and `changeLocale` reports `redirected` for it.
   */
  readonly addresses?: Readonly<Record<string, string>>;
}

/**
 * Whether a participant holds a locale change up, or catches up after it.
 *
 * `required` means the change waits for it and a failure abandons the change. `progressive` means
 * the page commits without it and takes its answer when it arrives. The choice belongs to what the
 * participant fetches: an article's body is required, a sidebar's recommendations are not.
 */
export type LocalizationParticipantCoordination = 'required' | 'progressive';

/**
 * What a participant fetched, named in the application's own terms.
 *
 * Atlas carries these and never interprets them. They exist so a report can be traced back to the
 * thing it is about without Atlas knowing what that thing is.
 */
export interface LocalizationParticipantIdentity {
  /** What was fetched, by whatever identity the application gives it. */
  readonly resourceId: string;
  /** Which representation of it, for a resource that has more than one. */
  readonly representationId?: string;
  /** Which version, so a stale answer can be recognized as stale. */
  readonly revision?: string;
  /** Ties this to work outside Atlas, when the application supplied something to tie it to. */
  readonly correlationId?: string;
}

/**
 * What language a participant's content actually came back in, and which way it runs.
 *
 * Reported rather than assumed: a request for one locale can be answered in another, and the
 * region holding that content has to be marked with what arrived rather than with what was asked
 * for.
 */
export interface LocalizationParticipantLanguage {
  /** The language tag of what came back. */
  readonly language: string;
  /** Which way that language is written. */
  readonly direction: LocaleDirection;
}

/**
 * What language a participant's content is in, as one of six honest answers.
 *
 * The region holding the content is marked from this, so the answer decides what a screen reader
 * pronounces it as and which way it is laid out. `locale-bound` where the store answered in a
 * particular locale, `language-independent` for content with no language in it, `user-authored`
 * for content somebody typed, `multilingual` where several languages are present at once,
 * `fixed-language` for content that is in one language whatever was asked, and `unknown-language`
 * where the application genuinely does not know, which leaves the direction to the renderer.
 */
export type LocalizationParticipantRepresentation =
  | {
      readonly kind: 'locale-bound';
      readonly supplyingLocale: string;
      readonly direction: LocaleDirection;
    }
  | {
      readonly kind: 'language-independent';
      readonly direction?: LocaleDirection;
    }
  | {
      readonly kind: 'user-authored';
      readonly language?: string;
      readonly direction?: LocaleDirection;
    }
  | {
      readonly kind: 'multilingual';
      readonly languages: readonly LocalizationParticipantLanguage[];
      readonly direction?: LocaleDirection;
    }
  | {
      readonly kind: 'fixed-language';
      readonly language: string;
      readonly direction: LocaleDirection;
    }
  | {
      readonly kind: 'unknown-language';
      readonly direction?: LocaleDirection;
    };

/**
 * Why a participant failed, from a closed set.
 *
 * A closed set rather than a message, for the reason diagnostics are: this reaches a log, and a
 * caught error's text carries paths and user content. Keep the detail in the application's own
 * logging and report the class here.
 */
export type LocalizationParticipantOperationalReason =
  | 'invalid-configuration'
  | 'unsupported-capability'
  | 'compatibility-rejection'
  | 'security-rejection'
  | 'environment-failure'
  | 'internal-failure';

/**
 * What a participant says about one attempt, as one of four outcomes.
 *
 * `ready` with the language its content is in, `unavailable` for content that exists in no locale
 * at all, `domain-outcome` for the application's own result under its own code, and `failed` for
 * something that went wrong. Only `failed` is a defect; the middle two are answers.
 */
export type LocalizationParticipantReport =
  | {
      readonly status: 'ready';
      readonly representation: LocalizationParticipantRepresentation;
      readonly identity?: LocalizationParticipantIdentity;
    }
  /**
   * The content does not exist, not "it does not exist in this language".
   *
   * A required participant reporting this fails the whole transition, which is what it is for. It
   * is not the answer for a locale the store has no copy in; see `LocalizationParticipant`.
   */
  | {
      readonly status: 'unavailable';
      readonly outcome: 'localized-representation-unavailable';
      readonly identity?: LocalizationParticipantIdentity;
    }
  | {
      readonly status: 'domain-outcome';
      readonly outcome: 'consumer-domain-outcome';
      readonly code: string;
      readonly representation?: LocalizationParticipantRepresentation;
      readonly identity?: LocalizationParticipantIdentity;
    }
  | {
      readonly status: 'failed';
      readonly outcome: 'operational-failure';
      readonly reason: LocalizationParticipantOperationalReason;
      readonly identity?: LocalizationParticipantIdentity;
    };

/**
 * A report that a commit can be built on, which is any of them except a failure.
 *
 * Nothing that failed reaches a commit, so the failed arm is excluded here rather than handled
 * again at every place a committed report is read.
 */
export type LocalizationParticipantCommitReport = Exclude<
  LocalizationParticipantReport,
  { readonly status: 'failed' }
>;

/** What a participant is showing now, which is whatever the last successful commit left it with. */
export interface LocalizationParticipantCurrent {
  /** The locale that commit was for. */
  readonly targetLocale: string;
  /** Which locale change it came from. */
  readonly transitionId: number;
  /** What the participant reported then, including the language its content is really in. */
  readonly report: LocalizationParticipantCommitReport;
}

/**
 * Where a participant's most recent attempt got to.
 *
 * `idle` before it has been asked for anything, then through preparing and prepared to one of the
 * four outcomes, or to `cancelled` or `superseded` when the change it belonged to was abandoned or
 * overtaken by a later one.
 */
export type LocalizationParticipantAttemptStatus =
  | 'idle'
  | 'preparing'
  | 'prepared'
  | 'ready'
  | 'unavailable'
  | 'domain-outcome'
  | 'failed'
  | 'cancelled'
  | 'superseded';

/** The most recent attempt at a participant, whether or not it ended in a commit. */
export interface LocalizationParticipantAttempt {
  /** Where it got to. */
  readonly status: LocalizationParticipantAttemptStatus;
  /** The locale it was for. Absent while the participant is still idle. */
  readonly targetLocale?: string;
  /** Which locale change it belonged to. */
  readonly transitionId?: number;
  /** What the participant answered, once it has answered. */
  readonly report?: LocalizationParticipantReport;
  /** Why it did not work, on a failure or a timeout. */
  readonly diagnostic?: LocalizationDiagnostic;
}

/**
 * Everything about one participant: what it is showing, and what it is doing.
 *
 * The two are separate on purpose. A failed attempt does not disturb what is on screen, so a
 * region keeps its content while a retry is in flight and a page can show both facts at once.
 */
export interface LocalizationParticipantState {
  /** What this participant is called, in diagnostics and in this list. */
  readonly participantId: string;
  /** Whether it holds a locale change up or catches up after one. */
  readonly coordination: LocalizationParticipantCoordination;
  /** What it is showing. Absent until its first successful commit. */
  readonly current?: LocalizationParticipantCurrent;
  /** What it is doing, or how its last attempt ended. */
  readonly attempt: LocalizationParticipantAttempt;
}

/** What a participant is told when it is asked to prepare, commit, roll back or discard. */
export interface LocalizationParticipantContext {
  /** The locale being moved to. */
  readonly targetLocale: string;
  /** The zone, calendar, numbering system and hour cycle that will be in force. */
  readonly formatting: FormattingContext;
  /** Which locale change this is, so a slow answer can be recognized as belonging to an old one. */
  readonly transitionId: number;
  /**
   * Aborted when the change is abandoned or overtaken.
   *
   * Pass it to whatever fetching the participant does. A participant that ignores it keeps working
   * for a locale nobody is waiting for.
   */
  readonly signal: AbortSignal;
  /**
   * What this participant was showing in a server-rendered response, during hydration.
   *
   * Present only on the first preparation in a browser taking over a rendered page, so a
   * participant can adopt what is already on screen instead of fetching it again.
   */
  readonly transferred?: LocalizationParticipantCurrent;
}

/**
 * A region of a page whose content belongs to the application rather than to a catalog.
 *
 * Atlas loads catalogs. It never sees an article body, a product description, or a row out of a
 * database, so anything localized outside a catalog changes locale by taking part in the same
 * transaction: `prepare` is asked for the new locale, the transition waits for it, and `commit`
 * swaps the payload the consumer kept in its own store.
 *
 * **What to answer for a locale the store has no content in.** This is the decision that catches
 * people, and it is not the same question as whether the load failed. A store keyed by locale is
 * asked for every locale the build has, including one added last week, and including a
 * pseudo-locale, which can have no application content at all by construction, because nothing can
 * translate a database.
 *
 * Answering `unavailable` there is expensive and the cost is not obvious from the call site. A
 * required participant that reports it fails the transition, so the page does not render; under
 * prerendering that is a build error and no file written at that address, rather than a warning
 * beside a page that came out slightly wrong.
 *
 * Report `ready` instead, with a `locale-bound` representation whose `supplyingLocale` names the
 * locale the content actually came from. "This is the English copy" is a truthful answer that
 * renders, and `supplyingLocale` is what keeps it truthful: it is carried in the participant's
 * state, so the region can declare the language and direction it is really in rather than the one
 * the page around it claims. Reserve `unavailable` for content that exists in no locale at all
 * (a deleted entity, an identifier nothing matches), which is a different fact and deserves the
 * different outcome.
 *
 * On a pseudo-locale page the consequence is the point rather than a compromise: every message
 * that went through Atlas carries the pseudo-locale's transformation and this content does not,
 * which is exactly what an unlocalized string is supposed to look like. Content that never went
 * through Atlas is the largest class of them.
 */
export interface LocalizationParticipant {
  /** What this participant is called. Appears in diagnostics and in the participant state list. */
  readonly id: string;
  /**
   * Fetches the content for the new locale and says what came back. Nothing is shown yet.
   *
   * Keep what was fetched somewhere of the participant's own and report the language it is in.
   * Honor the context's signal, and do not touch what is on screen here: a change that is later
   * abandoned must leave the page as it was.
   */
  readonly prepare: (
    context: LocalizationParticipantContext,
  ) =>
    | LocalizationParticipantReport
    | PromiseLike<LocalizationParticipantReport>;
  /**
   * Swaps in what `prepare` fetched. Called once the whole change has succeeded.
   *
   * Synchronous, because every participant commits in the same pass and the point of the
   * transaction is that the page changes language all at once.
   */
  readonly commit?: (
    context: LocalizationParticipantContext,
    report: LocalizationParticipantCommitReport,
  ) => void;
  /** Puts back what was showing before, when a change is undone after it had committed. */
  readonly rollback?: (
    context: LocalizationParticipantContext,
    report: LocalizationParticipantCommitReport,
  ) => void;
  /**
   * Throws away what `prepare` fetched, for a change that was abandoned before committing.
   *
   * The report is absent when the preparation never finished. What is on screen is untouched,
   * because nothing was swapped in.
   */
  readonly discard?: (
    context: LocalizationParticipantContext,
    report?: LocalizationParticipantReport,
  ) => void;
  /** Releases what the participant holds. Called once, when it or the context goes. */
  readonly dispose?: () => void;
}

/** How a participant takes part: whether the page waits for it, and for how long. */
export interface LocalizationParticipantOptions {
  /** Whether it holds a change up or catches up after one. Defaults to holding it up. */
  readonly coordination?: LocalizationParticipantCoordination;
  /**
   * How long its preparation may take before the attempt is abandoned.
   *
   * A required participant with no deadline can hold a locale change open indefinitely, which on a
   * server-rendered page is a request that never answers.
   */
  readonly deadlineMilliseconds?: number;
}

/** What one locale change is to do beyond changing the locale. */
export interface LocaleChangeOptions {
  /** Whether to hold the old page until everything is ready. Defaults to holding it. */
  readonly mode?: LocaleChangeMode;
  /** Scopes that must be loaded before the change commits, beyond the ones already required. */
  readonly requiredScopes?: readonly LocalizationScope[];
  /** Scopes to load alongside the change rather than ahead of it. */
  readonly progressiveScopes?: readonly LocalizationScope[];
  /**
   * The route the new snapshot is to carry.
   *
   * Supplied by the routing integration, which knows where the reader will be. Pass `null` to
   * clear it, which is what a change that leaves routing behind means.
   */
  readonly route?: LocalizationRouteSnapshot | null;
}

/**
 * How a locale change ended, which is always reported rather than thrown.
 *
 * `committed` with the snapshot that is now in force. Otherwise cancelled, overtaken by a later
 * change, failed, or redirected because the locale is an origin and reaching it is a document
 * navigation. Every arm carries the transition id, so a result can be matched to the events it
 * produced.
 */
export type LocaleChangeResult =
  | {
      readonly status: 'committed';
      readonly transitionId: number;
      readonly mode: LocaleChangeMode;
      readonly targetLocale: string;
      readonly snapshot: LocalizationSnapshot;
    }
  | {
      readonly status: 'cancelled' | 'superseded' | 'failed';
      readonly transitionId: number;
      readonly mode: LocaleChangeMode;
      readonly targetLocale: string;
      readonly diagnostic: LocalizationDiagnostic;
    }
  | {
      /**
       * The locale is not served by this document's origin, so changing to it is a move.
       *
       * Under a `locale-host` policy the locale *is* the origin, and application state does not
       * cross origins, so there is no transition to run: no scope loads, no participants, no
       * snapshot. The answer is an address, and `address` is it: this page's own address at the
       * origin that serves the locale asked for.
       *
       * In a browser Atlas has started moving the document there by the time this resolves, so
       * nothing after the call is guaranteed to run. On the server nothing moved, because there is
       * no document to move; the address is still the honest answer to what was asked.
       *
       * This is not a failure and carries no diagnostic. It is what a correct switch looks like
       * when the locale lives somewhere else.
       */
      readonly status: 'redirected';
      readonly transitionId: number;
      readonly mode: LocaleChangeMode;
      readonly targetLocale: string;
      readonly address: string;
    };

/** Where one scope's catalog stands for a locale: loading, ready, or not arriving. */
export interface ScopeReadiness {
  /** Which scope. */
  readonly scope: LocalizationScope;
  /** The locale it is being loaded for. */
  readonly targetLocale: string;
  /** Whether it has been asked for, is arriving, is here, or did not come. */
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  /**
   * The locales actually answering for it, nearest first.
   *
   * More than the target when something fell back, which is how a scope can be ready and still be
   * showing another locale's words.
   */
  readonly supplyingLocales: readonly string[];
  /** Which locale change this loading belongs to. */
  readonly transitionId?: number;
  /** Why it did not arrive. */
  readonly diagnostic?: LocalizationDiagnostic;
}

/**
 * What every evaluated message carries besides its words: which locale answered, and whether that
 * was the one asked for.
 *
 * Present on the result rather than looked up afterwards, so text that fell back can be marked with
 * the language it is really in instead of inheriting the page's claim.
 */
export interface LocalizedMetadata {
  /** The locale asked for. */
  readonly targetLocale: string;
  /** The locale that answered, which differs from the target when something fell back. */
  readonly supplyingLocale: string;
  /** The language tag to mark this text with, which follows the supplying locale. */
  readonly language: string;
  /** Which way that language runs. */
  readonly direction: LocaleDirection;
  /** The locales tried, in order, so a fallback can be explained without running it again. */
  readonly attemptedLocales: readonly string[];
  /** Whether what came back is a fallback, which is the quick form of comparing the two locales. */
  readonly fallback: boolean;
  /** Anything the runtime had to say while evaluating this, including why it fell back. */
  readonly diagnostics: readonly LocalizationDiagnostic[];
}

/** A message evaluated to a finished string, with the metadata that says where it came from. */
export interface LocalizedText extends LocalizedMetadata {
  readonly kind: 'text';
  /** The words. */
  readonly value: string;
}

/** A run of literal words inside a structured message. */
export interface LocalizedTextPart {
  readonly kind: 'text';
  /** The words. */
  readonly value: string;
  /** The language they are in, which follows whichever locale supplied this message. */
  readonly language: string;
  /** Which way that language runs. */
  readonly direction: LocaleDirection;
  /** The locale that supplied it. */
  readonly supplyingLocale: string;
}

/**
 * An interpolated value inside a structured message, formatted and ready to place.
 *
 * The part that needs care: the words around it are in the message's language and the value itself
 * may not be, which is why it carries two directions rather than one.
 */
export interface LocalizedValuePart {
  readonly kind: 'value';
  /** The formatted text. */
  readonly value: string;
  /** Which function formatted it, when one did. */
  readonly functionName?: string;
  /** The language of the message this sits in. */
  readonly language: string;
  /** The direction of the locale that supplied the value. */
  readonly direction: LocaleDirection;
  /**
   * The direction of the value's own content, which is not the same question as `direction`.
   *
   * `direction` answers "which locale produced this", and for an interpolated value that is always
   * the message's own locale, since Atlas does not ask a consumer to tag every input.
   * `contentDirection` answers "which way does this text run", and it is the one that decides
   * isolation. A customer name typed in Arabic inside an English message has `direction: 'ltr'`
   * and does not run left-to-right.
   *
   * `auto` where Atlas defers rather than decides: the value is consumer content, so the renderer's
   * first-strong rule answers it. MessageFormat 2's `u:dir` overrides all of this.
   */
  readonly contentDirection: ContentDirection;
  /**
   * MessageFormat 2's `isolate`: the author wrote `u:dir` with a value other than `inherit`.
   *
   * Separate from `contentDirection` because the two answer different halves of the Default Bidi
   * Strategy. A left-to-right value in a left-to-right message is left bare unless this is set.
   */
  readonly isolate: boolean;
  /** MessageFormat 2's `u:id`, when the author wrote one. Absent from the string projection. */
  readonly id?: string;
  /** The locale that supplied the message this sits in. */
  readonly supplyingLocale: string;
}

/**
 * A named region inside a structured message, with whatever the message put inside it.
 *
 * The catalog decided where this sits in the sentence and what it is called. What it renders as is
 * decided by the binding the application supplies under that name.
 */
export interface LocalizedSlotPart {
  readonly kind: 'slot';
  /** What the region is called, which is the name a binding is looked up under. */
  readonly name: string;
  /** What kind of region it is: a link, an emphasis, an extension's own kind. */
  readonly slotKind: string;
  /** Whether it wraps words or marks a point. */
  readonly shape: 'paired' | 'standalone';
  /** What the message put inside it, which is empty for a standalone slot. */
  readonly children: readonly LocalizedPart[];
  /** The options the message wrote on it, already resolved to text. */
  readonly options: Readonly<Record<string, string>>;
  /** The language of the message this sits in. */
  readonly language: string;
  /** Which way that language runs. */
  readonly direction: LocaleDirection;
  /** MessageFormat 2's `u:id`, when the author wrote one. Absent from the string projection. */
  readonly id?: string;
  /** The locale that supplied the message this sits in. */
  readonly supplyingLocale: string;
}

/**
 * One piece of a structured message: words, a formatted value, or a named region.
 *
 * Check `kind` to tell them apart. A renderer walks these in order and asks the application what
 * each slot is; anything it cannot render is dropped rather than shown as text.
 */
export type LocalizedPart =
  | LocalizedTextPart
  | LocalizedValuePart
  | LocalizedSlotPart;

/**
 * A message evaluated to pieces a template places, rather than to one string.
 *
 * What a message with a link or an emphasis in it comes back as.
 */
export interface LocalizedParts extends LocalizedMetadata {
  readonly kind: 'parts';
  /** The pieces, in order. */
  readonly value: readonly LocalizedPart[];
  /**
   * The whole message as plain text, for somewhere the pieces cannot go.
   *
   * A title attribute, an announcement, a log line. Text throughout, never markup.
   */
  readonly text: string;
}

/** What a template projected into a slot is handed, which is the slot itself, twice. */
export interface LocalizedSlotTemplateContext {
  /** The slot, reachable as the template's own implicit variable. */
  readonly $implicit: LocalizedSlotPart;
  /** The same slot under a name, for a template that reads better saying it. */
  readonly part: LocalizedSlotPart;
}

/**
 * Where a link inside a message goes, built in application code and never named by a catalog.
 *
 * Produced by `internalDestination` or `externalDestination`, each of which checks the address
 * before there is a destination at all. An external one carries its own target and the `rel` that
 * goes with opening a new tab, so neither is left to a template to remember.
 */
export type TrustedDestination =
  | {
      readonly kind: 'internal';
      readonly href: string;
    }
  | {
      readonly kind: 'external';
      readonly href: string;
      readonly target: '_blank' | '_self';
      readonly rel: string;
    };

/**
 * The conventions every formatting call is made under: the locale, and four things about how it is
 * read.
 *
 * Taken from the committed snapshot, so a call inherits it rather than assembling one. The four
 * optional fields default to what the locale's own data says; setting one states a deliberate
 * disagreement with that.
 */
export interface FormattingContext {
  /** The locale to format in, which is the committed one. */
  readonly locale: string;
  /**
   * The zone to read moments in.
   *
   * The one worth setting deliberately: without it a server and the browser that rehydrates its
   * output read the same instant off two different clocks, and a date near midnight differs.
   */
  readonly timeZone?: string;
  /** Which calendar dates are counted in. */
  readonly calendar?: string;
  /** Which digits numbers are written with. */
  readonly numberingSystem?: string;
  /** Which clock times are written on. */
  readonly hourCycle?: 'h11' | 'h12' | 'h23' | 'h24';
}

/**
 * The parts of a formatting context that are facts about a locale rather than about a reader.
 *
 * A numbering system, a calendar and an hour cycle say how a language is written: `ar-EG` is
 * written in `arab` digits and `fa-IR` in `arabext`, and an application that wants Western digits
 * on its Arabic pages is saying something about Arabic. A time zone is not in this set and is not
 * missing from it: it belongs to the reader or to the business, and it stays application-wide,
 * where one value covers every language the same page can be read in.
 */
export type LocaleFormattingOverride = Pick<
  FormattingContext,
  'numberingSystem' | 'calendar' | 'hourCycle'
>;

/**
 * An exact decimal, held as digits rather than as a number.
 *
 * A JavaScript number cannot hold every decimal exactly, and a price or a tax rate that is written
 * approximately is wrong in a way nothing announces. Built by `decimal`.
 */
export interface DecimalValue {
  readonly kind: 'decimal';
  /** The digits, normalized so two spellings of one number compare equal. */
  readonly value: string;
}

/**
 * A moment on the timeline, with no zone and no calendar attached to it.
 *
 * The same instant everywhere; what differs is the wall clock it is read against. Built by
 * `instant`.
 */
export interface InstantValue {
  readonly kind: 'instant';
  /** Nanoseconds since the epoch, as digits, because the count outruns an exact number. */
  readonly epochNanoseconds: string;
}

/**
 * A calendar date with no time and no zone: a birthday, an invoice date, a holiday.
 *
 * The same date wherever it is read, which is why a birthday does not move. Built by `plainDate`.
 */
export interface PlainDateValue {
  readonly kind: 'plain-date';
  /** The year, in the calendar named below. */
  readonly year: number;
  /** The month, counting from one. */
  readonly month: number;
  /** The day of the month. */
  readonly day: number;
  /** Which calendar the three numbers are counted in. */
  readonly calendar: string;
}

/**
 * A time of day with no date and no zone: an opening hour, a daily reminder.
 *
 * Built by `plainTime`.
 */
export interface PlainTimeValue {
  readonly kind: 'plain-time';
  /** The hour on a twenty-four hour clock. */
  readonly hour: number;
  /** The minute. */
  readonly minute: number;
  /** The second. Never sixty: no leap second here, because a formatter cannot place one. */
  readonly second: number;
  /** The fraction of a second, in nanoseconds. */
  readonly nanosecond: number;
}

/**
 * A date and a time with no zone, which is what a wall clock in an unnamed place reads.
 *
 * Two of these an hour apart are not necessarily an hour apart in the world, because no zone means
 * no answer about a daylight-saving shift. Built by `plainDateTime`.
 */
export interface PlainDateTimeValue {
  readonly kind: 'plain-date-time';
  /** The date half. */
  readonly date: PlainDateValue;
  /** The time half. */
  readonly time: PlainTimeValue;
}

/**
 * A moment together with the zone it is to be read in.
 *
 * The form to store when the zone is part of what happened: a flight departure, a meeting in an
 * office somewhere. The instant fixes the moment and the zone fixes the wall clock, so the pair
 * survives a daylight-saving change that a wall clock alone would not. Built by `zonedDateTime`.
 */
export interface ZonedDateTimeValue {
  readonly kind: 'zoned-date-time';
  /** The moment itself. */
  readonly instant: InstantValue;
  /** The zone to read it in, as an IANA identity. */
  readonly timeZone: string;
  /** Which calendar to count it in. */
  readonly calendar: string;
}

/** A time zone, as the platform's canonical spelling of its IANA identity. Built by `timeZone`. */
export interface TimeZoneValue {
  readonly kind: 'time-zone';
  /** The identity, such as `Europe/Berlin` or `UTC`. */
  readonly id: string;
}

/**
 * A length of time, as counts of calendar and clock units with the direction held separately.
 *
 * The fields are counts rather than one number, so minus an hour and a half is one duration rather
 * than a negative hour plus a positive half hour. Built by `duration`.
 */
export interface DurationValue {
  readonly kind: 'duration';
  /** Which way it runs. Zero when every field is zero, and non-zero otherwise. */
  readonly sign: -1 | 0 | 1;
  /** Whole years. Never negative; the direction is the sign's business. */
  readonly years: number;
  /** Whole months. */
  readonly months: number;
  /** Whole weeks. */
  readonly weeks: number;
  /** Whole days. */
  readonly days: number;
  /** Whole hours. */
  readonly hours: number;
  /** Whole minutes. */
  readonly minutes: number;
  /** Seconds, as an exact decimal so a fraction of a second keeps its precision. */
  readonly seconds: DecimalValue;
}

/**
 * An amount in a currency, held together so neither can be formatted without the other.
 *
 * Built by `money`. How many decimals the currency shows is the formatter's business, so the amount
 * is stored as it was given.
 */
export interface MoneyValue {
  readonly kind: 'money';
  /** The amount, exactly. */
  readonly amount: DecimalValue;
  /** The currency, as an ISO 4217 code in capitals. */
  readonly currency: string;
}

/** A quantity in a unit: a distance, a weight, a temperature, a size. Built by `measurement`. */
export interface MeasurementValue {
  readonly kind: 'measurement';
  /** The quantity, exactly. */
  readonly amount: DecimalValue;
  /** The unit, as a CLDR unit identifier such as `kilometer` or `megabyte`. */
  readonly unit: string;
}

/**
 * Which scale a proportion is written on.
 *
 * `fractional` means a half is `0.5`; `percent-unit` means a half is `50`. The two differ by a
 * factor of a hundred and look identical in a database column, so the value says which it is.
 */
export type PercentScale = 'fractional' | 'percent-unit';

/** A proportion, with the scale it is written on stated rather than assumed. Built by `percent`. */
export interface PercentValue {
  readonly kind: 'percent';
  /** The proportion, exactly. */
  readonly amount: DecimalValue;
  /** Which scale that number is on. */
  readonly scale: PercentScale;
}

/**
 * A difference between two proportions, which is a count rather than a proportion.
 *
 * A rate that went from 4 percent to 6 percent rose by two percentage points, and calling that two
 * percent says something else. Built by `percentagePoints`.
 */
export interface PercentagePointsValue {
  readonly kind: 'percentage-points';
  /** The difference, exactly. */
  readonly amount: DecimalValue;
}

/**
 * The seven roles a person's name can be made of.
 *
 * Roles rather than positions, because which of them comes first is the locale's decision and the
 * name's own language decides it.
 */
export type PersonNameField =
  | 'title'
  | 'given'
  | 'given2'
  | 'surname'
  | 'surname2'
  | 'generation'
  | 'credentials';

/**
 * Field variants a name carries but a formatter cannot derive.
 *
 * CLDR patterns reference these directly (`{given-informal}`, `{surname-core}`) and UTS #35 is
 * explicit that they come from the name, not from the formatter: an informal form "should not be
 * generated, because they vary too much", and no library can tell that the `van der` in
 * `van der Poel` is a tussenvoegsel while the `Van` in `Van Dyke` is not.
 *
 * Every one of them falls back to the plain field when absent, so a name that supplies only the
 * seven base fields formats correctly everywhere; supplying more makes it better in the locales
 * that ask.
 */
export type PersonNameFieldVariant =
  | 'informal'
  | 'prefix'
  | 'core'
  | 'vocative'
  | 'genitive';

/**
 * How one part of a name is named: a role on its own, or a role with a variant after a hyphen.
 *
 * `given`, `given-informal`, `surname-core`, and so on. Every variant falls back to its plain role
 * when absent, so a name supplying only the seven roles still formats everywhere.
 */
export type PersonNameFieldKey =
  | PersonNameField
  | `${PersonNameField}-${PersonNameFieldVariant}`;

/** A person's name, held as the parts it is made of, in the language it belongs to. */
export interface PersonNameValue {
  readonly kind: 'person-name';
  /**
   * The language the name is a name in, which is not the reader's locale.
   *
   * How a name is ordered and shortened follows the name, so a Hungarian name keeps its order on a
   * page written in English.
   */
  readonly language: string;
  /** The parts, by role, each trimmed and normalized. At least one is present. */
  readonly fields: Readonly<Partial<Record<PersonNameFieldKey, string>>>;
}

/** Which arrangement of a name is wanted, in CLDR's own four dimensions. */
export interface PersonNameFormatOptions {
  /** Whether the name is being spoken to, spoken about, or reduced to initials. */
  readonly usage?: 'addressing' | 'referring' | 'monogram';
  /** How much of the name to include. */
  readonly length?: 'long' | 'medium' | 'short';
  /** Which register, which in several locales changes which parts appear at all. */
  readonly formality?: 'formal' | 'informal';
  /**
   * `sorting` is an order of its own, not surname-first with a comma: CLDR gives it separate
   * patterns, and several locales spell it differently from both other orders.
   */
  readonly order?: 'auto' | 'given-first' | 'surname-first' | 'sorting';
}

/**
 * One piece of a formatted value, for a caller that needs to style or read part of it.
 *
 * The currency symbol apart from its number, the month apart from the year, one field of a name.
 * The kinds come from the platform's own formatters, plus a few Atlas adds for the things it
 * formats itself.
 */
export interface LocalizedFormatPart {
  /** What this piece is. */
  readonly kind:
    | Intl.NumberFormatPartTypes
    | Intl.DateTimeFormatPartTypes
    | PersonNameField
    | 'element'
    | 'display-name'
    | 'segment'
    | 'semantic-unit';
  /** The text of this piece. */
  readonly value: string;
  /** The language it is in, on a piece whose language differs from the rest. */
  readonly language?: string;
  /** Which way that language runs. */
  readonly direction?: LocaleDirection;
}

/**
 * A formatted value: the text, its pieces, and where it came from.
 *
 * What every formatting function returns on success. Carrying the source and the semantic along
 * with the text is what lets a caller re-render the same value in another locale without going back
 * to whatever produced it.
 */
export interface LocalizedFormattedValue {
  readonly kind: 'formatted-value';
  /** What kind of thing was formatted, which is what a caller branches on. */
  readonly semantic:
    | 'number'
    | 'money'
    | 'measurement'
    | 'percent'
    | 'percentage-points'
    | 'instant'
    | 'plain-date'
    | 'plain-time'
    | 'plain-date-time'
    | 'zoned-date-time'
    | 'time-zone'
    | 'number-range'
    | 'date-range'
    | 'duration'
    | 'list'
    | 'display-name'
    | 'relative-time'
    | 'person-name'
    | 'extension';
  /** The finished text. */
  readonly text: string;
  /** The same output in pieces, for styling or reading part of it. */
  readonly parts: readonly LocalizedFormatPart[];
  /** The locale asked for. */
  readonly locale: string;
  /** The language tag to mark the text with, which follows the locale that answered. */
  readonly language: string;
  /** Which way that language runs. */
  readonly direction: LocaleDirection;
  /**
   * The value this was formatted from, kept so it can be formatted again elsewhere.
   *
   * `unknown` because what it is depends on the semantic. Narrow on that rather than casting.
   */
  readonly source: unknown;
  /** Which extension produced it, on a value an adapter formatted. */
  readonly extensionId?: string;
}

/**
 * What a formatting call returns: the value, or a diagnostic saying why there is none.
 *
 * Returned rather than thrown, because a host without the data for a unit or a calendar is an
 * ordinary condition on the web and not a defect in the calling code. Check `ok` before reading
 * `value`.
 */
export type FormattingResult =
  | { readonly ok: true; readonly value: LocalizedFormattedValue }
  | { readonly ok: false; readonly diagnostic: LocalizationDiagnostic };

/**
 * Where "now" comes from, so a reference instant can be supplied rather than read off the host.
 *
 * Relative time is what it matters to: "two hours ago" is a different sentence a minute later, and
 * a server and the browser rehydrating its output computing it from their own clocks disagree at
 * the boundary. Install one with `withLocalizationClock`.
 */
export interface LocalizationClock {
  /** The current moment. Called once per formatting call rather than cached. */
  now(): InstantValue;
}

/** How a locale divides its week, which differs by more than which day it starts on. */
export interface LocaleWeekInformation {
  /** Which day the week begins on, from 1 for Monday to 7 for Sunday. */
  readonly firstDay: number;
  /** Which days are the weekend, in the same numbering. Not always two, and not always adjacent. */
  readonly weekend: readonly number[];
  /** How many days of a week must fall in a year for it to count as that year's first week. */
  readonly minimalDays: number;
}

/**
 * What the host knows about a locale: how it is written, and what it supports.
 *
 * Read from the platform rather than shipped by Atlas, so what comes back is what this engine can
 * actually do rather than what the data says somewhere else.
 */
export interface LocaleMetadata {
  /** The locale asked about, canonically spelled. */
  readonly locale: string;
  /** Its bare language subtag, which is what `lang` on a single element wants. */
  readonly language: string;
  /** Its script, where the tag names or implies one. */
  readonly script?: string;
  /** Its region, where the tag names one. */
  readonly region?: string;
  /** Which way it is written. */
  readonly direction: LocaleDirection;
  /** The calendars this host can count it in, preferred first. */
  readonly calendars: readonly string[];
  /** The numbering systems this host can write it in, preferred first. */
  readonly numberingSystems: readonly string[];
  /** The hour cycles it uses, preferred first. */
  readonly hourCycles: readonly string[];
  /** How it divides its week. Absent on a host that does not expose it. */
  readonly week?: LocaleWeekInformation;
}

/**
 * What asking the host about a locale returns: the answer, or why there is none.
 *
 * A host that does not know a locale, or does not expose what was asked, is an ordinary condition
 * on the web rather than a defect, so it is reported rather than thrown. Check `ok` first.
 */
export type LocaleCapabilityResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly diagnostic: LocalizationDiagnostic };

/**
 * One piece of text the host's own segmenter found: a grapheme, a word, or a sentence.
 *
 * Needed because counting characters is not counting letters in most of the world, and neither is
 * splitting on spaces counting words.
 */
export interface LocalizedSegment {
  /** The piece itself. */
  readonly segment: string;
  /** Where it starts in the input, in code units. */
  readonly index: number;
  /** The whole text it came from. */
  readonly input: string;
  /** Whether it is a word rather than punctuation or space. Present for word segmentation. */
  readonly wordLike?: boolean;
}

/**
 * The outcome of reading typed text.
 *
 * Only `valid` carries a value. `incomplete` is what a half-typed field gives and is not an error
 * to show yet; `ambiguous` is text that reads two ways, such as a date whose field order the locale
 * leaves open; `policy-rejected` is text that parsed and fell outside the bounds the profile
 * declared.
 */
export type LocalizedInputStatus =
  | 'valid'
  | 'incomplete'
  | 'invalid'
  | 'ambiguous'
  | 'out-of-range'
  | 'unsupported-capability'
  | 'policy-rejected';

interface LocalizedInputBase {
  readonly maximumCharacters?: number;
  readonly minimum?: DecimalValue;
  readonly maximum?: DecimalValue;
  readonly maximumFractionDigits?: number;
  readonly allowGrouping?: boolean;
}

/** Reads a plain number in the locale's own digits, grouping and decimal mark. */
export interface LocalizedDecimalInputProfile extends LocalizedInputBase {
  readonly kind: 'decimal';
}

/** Reads an amount of money. The currency is the profile's, never the typist's. */
export interface LocalizedMoneyInputProfile extends LocalizedInputBase {
  readonly kind: 'money';
  /** The currency the field is in, as an ISO 4217 code. */
  readonly currency: string;
  /** Whether the symbol or code must be typed. Off by default, so a bare number is accepted. */
  readonly requireCurrency?: boolean;
}

/** Reads a quantity in a unit. The unit is the profile's. */
export interface LocalizedMeasurementInputProfile extends LocalizedInputBase {
  readonly kind: 'measurement';
  /** The unit the field is in, as a CLDR unit identifier. */
  readonly unit: string;
  /** Whether the unit must be typed. Off by default. */
  readonly requireUnit?: boolean;
}

/** Reads a percentage, onto the scale the profile names. */
export interface LocalizedPercentInputProfile extends LocalizedInputBase {
  readonly kind: 'percent';
  /** Which scale the resulting value is on, which is what `50` becomes. */
  readonly scale: PercentScale;
  /** Whether the percent sign must be typed. Off by default. */
  readonly requirePercentSign?: boolean;
}

/** Reads a difference between proportions, which is a count rather than a proportion. */
export interface LocalizedPercentagePointsInputProfile extends LocalizedInputBase {
  readonly kind: 'percentage-points';
}

/**
 * How a date is written in one locale, which is what makes it readable back.
 *
 * The field order is stated rather than guessed: `03/04` is two different dates on two sides of an
 * ocean, and a parser that picks one is wrong half the time without ever saying so.
 */
export interface LocalizedPlainDateInputPattern {
  /** Which order the three fields are typed in. */
  readonly order: 'day-month-year' | 'month-day-year' | 'year-month-day';
  /** What goes between them. */
  readonly separator: string;
  /** Which calendar the fields are counted in. Defaults to the context's. */
  readonly calendar?: string;
  /** The earliest date accepted. Anything before it parses and is reported out of range. */
  readonly minimum?: PlainDateValue;
  /** The latest date accepted. */
  readonly maximum?: PlainDateValue;
}

/** A date field: the pattern, plus the bound on how much may be typed. */
export interface LocalizedPlainDateInputProfile extends LocalizedPlainDateInputPattern {
  readonly kind: 'plain-date';
  /** The most characters that will be read. Defaults to the runtime's own bound. */
  readonly maximumCharacters?: number;
}

/** How a locale writes the halves of a twelve-hour clock, for a field that accepts one. */
export interface LocalizedDayPeriodInputPattern {
  /** What the morning half is written as. */
  readonly am: string;
  /** What the afternoon half is written as. */
  readonly pm: string;
  /** Whether it comes before the time or after it. */
  readonly position: 'prefix' | 'suffix';
  /** What goes between it and the time. Nothing when absent. */
  readonly separator?: string;
}

/** How a time of day is written in one locale. */
export interface LocalizedPlainTimeInputPattern {
  /** Which clock is typed on. */
  readonly hourCycle: 'h11' | 'h12' | 'h23' | 'h24';
  /** How far the field goes: minutes, seconds, or a fraction of a second. */
  readonly precision: 'minute' | 'second' | 'fraction';
  /** What goes between the fields. */
  readonly separator: string;
  /** How many fractional digits are read, for a field that goes that far. */
  readonly fractionalSecondDigits?: number;
  /** How the morning and afternoon halves are written, for a twelve-hour field. */
  readonly dayPeriod?: LocalizedDayPeriodInputPattern;
  /** The earliest time accepted. */
  readonly minimum?: PlainTimeValue;
  /** The latest time accepted. */
  readonly maximum?: PlainTimeValue;
}

/** A time field: the pattern, plus the bound on how much may be typed. */
export interface LocalizedPlainTimeInputProfile extends LocalizedPlainTimeInputPattern {
  readonly kind: 'plain-time';
  /** The most characters that will be read. */
  readonly maximumCharacters?: number;
}

/** A field holding a date and a time together, with the two patterns and what joins them. */
export interface LocalizedPlainDateTimeInputProfile {
  readonly kind: 'plain-date-time';
  /** How the date half is written. */
  readonly date: LocalizedPlainDateInputPattern;
  /** How the time half is written. */
  readonly time: LocalizedPlainTimeInputPattern;
  /** What goes between them. */
  readonly separator: string;
  /** The earliest moment accepted. */
  readonly minimum?: PlainDateTimeValue;
  /** The latest moment accepted. */
  readonly maximum?: PlainDateTimeValue;
  /** The most characters that will be read. */
  readonly maximumCharacters?: number;
}

/**
 * One zone a field will accept, and the ways a person might write it.
 *
 * Listed rather than matched loosely, because a zone read from a partial or ambiguous name is a
 * meeting at the wrong hour.
 */
export interface LocalizedTimeZoneInputOption {
  /** The zone's IANA identity, which is what a match produces. */
  readonly timeZone: string;
  /** The spellings accepted for it: its city, its abbreviations, its localized names. */
  readonly labels: readonly string[];
}

/** A field holding a time zone, matched against a stated list rather than against everything. */
export interface LocalizedTimeZoneInputProfile {
  readonly kind: 'time-zone';
  /** The zones this field accepts. Text matching none of them is refused. */
  readonly options: readonly LocalizedTimeZoneInputOption[];
  /** The most characters that will be read. */
  readonly maximumCharacters?: number;
}

/** The seven units a duration field can be built out of. */
export type LocalizedDurationFieldName =
  | 'years'
  | 'months'
  | 'weeks'
  | 'days'
  | 'hours'
  | 'minutes'
  | 'seconds';

/** One unit in a duration field, and what a value for it may look like. */
export interface LocalizedDurationInputField {
  /** Which unit this position holds. */
  readonly field: LocalizedDurationFieldName;
  /** How many digits must be typed, which is what makes a fixed-width field. */
  readonly minimumIntegerDigits?: number;
  /** How many may be. */
  readonly maximumIntegerDigits?: number;
  /** How many fractional digits are read, for a field that takes them. */
  readonly maximumFractionDigits?: number;
  /** The smallest value accepted for this unit. */
  readonly minimum?: DecimalValue;
  /** The largest. */
  readonly maximum?: DecimalValue;
}

/**
 * One position in a duration field: literal text, or a unit to read.
 *
 * A plain string is the literal case, so a clock-style field is a field, a colon, a field.
 */
export type LocalizedDurationInputToken = string | LocalizedDurationInputField;

/**
 * A field holding a length of time, described as the sequence a person types.
 *
 * Stated as a pattern rather than assumed, because a duration is written every way there is: as a
 * clock, as counted units, as one number with a unit beside it.
 */
export interface LocalizedDurationInputProfile {
  readonly kind: 'duration';
  /** The positions, in order, mixing literal text with the units to read. */
  readonly pattern: readonly LocalizedDurationInputToken[];
  /** Whether a leading sign may be typed. Defaults to forbidding it. */
  readonly sign?: 'forbidden' | 'optional' | 'required';
  /** The most characters that will be read. */
  readonly maximumCharacters?: number;
}

/**
 * A field holding a moment, typed in a machine syntax rather than in a locale's conventions.
 *
 * For a field fed by a picker or by another system. There is nothing localized about what is
 * accepted, which is why it is stated here rather than implied.
 */
export interface LocalizedInstantInputProfile {
  readonly kind: 'instant';
  /** Which syntax is accepted. */
  readonly syntax: 'rfc3339';
  /** The most characters that will be read. */
  readonly maximumCharacters?: number;
}

/**
 * Any of the eleven kinds of field: what a caller declares once and both reads and writes with.
 *
 * The profile decides the value's type, so a money profile parses to an amount with its currency
 * and a date profile to a calendar date. Check `kind` to tell them apart.
 */
export type LocalizedInputProfile =
  | LocalizedDecimalInputProfile
  | LocalizedMoneyInputProfile
  | LocalizedMeasurementInputProfile
  | LocalizedPercentInputProfile
  | LocalizedPercentagePointsInputProfile
  | LocalizedPlainDateInputProfile
  | LocalizedPlainTimeInputProfile
  | LocalizedPlainDateTimeInputProfile
  | LocalizedTimeZoneInputProfile
  | LocalizedDurationInputProfile
  | LocalizedInstantInputProfile;

/**
 * The value type a particular profile produces.
 *
 * What makes a field typed by its profile rather than by an assertion: a caller holding a money
 * profile gets an amount with its currency, and cannot be handed a bare decimal by mistake.
 */
export type LocalizedInputValue<Profile extends LocalizedInputProfile> =
  Profile extends LocalizedMoneyInputProfile
    ? MoneyValue
    : Profile extends LocalizedMeasurementInputProfile
      ? MeasurementValue
      : Profile extends LocalizedPercentInputProfile
        ? PercentValue
        : Profile extends LocalizedPercentagePointsInputProfile
          ? PercentagePointsValue
          : Profile extends LocalizedPlainDateInputProfile
            ? PlainDateValue
            : Profile extends LocalizedPlainTimeInputProfile
              ? PlainTimeValue
              : Profile extends LocalizedPlainDateTimeInputProfile
                ? PlainDateTimeValue
                : Profile extends LocalizedTimeZoneInputProfile
                  ? TimeZoneValue
                  : Profile extends LocalizedDurationInputProfile
                    ? DurationValue
                    : Profile extends LocalizedInstantInputProfile
                      ? InstantValue
                      : DecimalValue;

/**
 * What reading typed text gives back: the value, or the status and a diagnostic.
 *
 * Both arms carry the text as typed, so a field can keep what the person wrote while the form holds
 * the last value that parsed. Never throws: unreadable input is the ordinary case in a form.
 */
export type LocalizedInputResult<Value> =
  | { readonly status: 'valid'; readonly text: string; readonly value: Value }
  | {
      readonly status: Exclude<LocalizedInputStatus, 'valid'>;
      readonly text: string;
      readonly diagnostic: LocalizationDiagnostic;
    };

/**
 * A failure reported by something outside the application, in its own vocabulary.
 *
 * A validation code from a form library, an error code from a service. Atlas turns it into words;
 * it never decides what the code means.
 */
export interface LocalizedIssue {
  /** The code, as whatever raised it spells it. */
  readonly code: string;
  /** Values that go with it, such as the bound a number exceeded. */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/** One code's message, for a code the naming convention cannot reach. */
export interface IssueMessageBinding {
  /** The message to show. */
  readonly message: PlainMessageHandle;
  /**
   * Turns the issue's own values into the message's inputs.
   *
   * Needed when the names differ, or when something has to be computed. Returning `undefined`
   * means the message takes none.
   */
  readonly parameters?: (
    issue: LocalizedIssue,
  ) => Readonly<Record<string, unknown>> | undefined;
}

/**
 * Where the message for a backend failure code comes from.
 *
 * A code pairs with a message by name, not by a table an application keeps: `INSUFFICIENT_STOCK`
 * finds `insufficient-stock` in `messages`. Nothing is written per code, which is the point:
 * a table with one line per code is a line every new code needs and eventually does not get, and
 * the failure mode is a customer reading a generic apology instead of what actually went wrong.
 *
 * `bindings` remains for what a convention cannot express: a code whose message lives elsewhere,
 * or several codes deliberately collapsing to one. It is consulted first.
 *
 * `unknown` is mandatory. A code no message answers is not a bug to be discovered in production;
 * it is a case every application has and must have an answer for.
 */
export interface IssueMessageSource {
  /**
   * The generated group the convention looks in, such as `messages.issue`.
   *
   * Passing the group rather than each member is also what makes these messages reachable: Atlas
   * sees the group referenced and treats every message in it as used, so none is reported unused
   * or dropped because the code that selects it is a string from a server.
   */
  readonly messages: Readonly<Record<string, unknown>>;
  /** What to show for a code nothing answered for. Must be plain and take no inputs. */
  readonly unknown: PlainMessageHandle;
  /**
   * Messages for particular codes, consulted before the naming convention.
   *
   * For a code whose message lives elsewhere, or several codes that deliberately say one thing.
   */
  readonly bindings?: Readonly<Record<string, IssueMessageBinding>>;
  /** Turns an issue's values into message inputs, for every code the convention resolves. */
  readonly parameters?: (
    issue: LocalizedIssue,
  ) => Readonly<Record<string, unknown>> | undefined;
}

/**
 * What an issue came out as: a message that answered it, or the fallback and why.
 *
 * Both arms carry localized text, so a caller renders the same way either way and reads the status
 * only when it wants to log or count the codes nothing answered.
 */
export type IssuePresentation =
  | {
      readonly status: 'known';
      readonly code: string;
      readonly localized: LocalizedText;
    }
  | {
      readonly status: 'unknown';
      readonly code: string;
      readonly localized: LocalizedText;
      readonly diagnostic: LocalizationDiagnostic;
    };

/**
 * What a code from outside came out as, with the value kept beside the words.
 *
 * A status from an API, an enum from another team's service. The set changes without this
 * application shipping, so an unmapped value is expected rather than a defect.
 */
export interface ExternalValuePresentation<Value extends string = string> {
  /** Whether a message answered for it. */
  readonly status: 'known' | 'unknown';
  /** The code itself, kept so it can be logged or shown beside the words. */
  readonly value: Value;
  /** The words, which on an unknown value are the fallback message. */
  readonly localized: LocalizedText;
  /** Why nothing answered, on an unknown value. */
  readonly diagnostic?: LocalizationDiagnostic;
}

/** Something to tell the reader, before it has been localized. */
export interface NotificationMessage<
  Handle extends MessageHandle = MessageHandle,
> {
  /** What this notification is, so a queue can match it to whatever raised it. */
  readonly id: string;
  /** How it reads. Defaults to information. */
  readonly tone?: 'information' | 'success' | 'warning' | 'error';
  /** The message. Either kind: plain text or structured. */
  readonly message: Handle;
  /** The values it takes. */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** The same notification with its message evaluated, ready for a toast host to render. */
export interface LocalizedNotification {
  /** The identity, carried through untouched. */
  readonly id: string;
  /** How it reads, with the default filled in. */
  readonly tone: 'information' | 'success' | 'warning' | 'error';
  /** The words, as text or as parts depending on which kind of message it was. */
  readonly content: LocalizedText | LocalizedParts;
}

/**
 * How text in one writing system should be set.
 *
 * Declared by the application, because a font stack is a design decision. What Atlas contributes is
 * choosing which of them applies to the committed locale.
 */
export interface TypographyProfile {
  /** What this profile is called, which is what a stylesheet keys on. */
  readonly id: string;
  /** The font stack to set the text in. */
  readonly fontFamily?: string;
  /** The line height, which scripts with tall marks need more of than Latin does. */
  readonly lineHeight?: number;
  /** How lines may break, which is what keeps CJK and long compounds from breaking wrongly. */
  readonly wordBreak?: 'normal' | 'keep-all' | 'break-word';
}

/**
 * An application's typography, declared by script, by language, and as a fallback.
 *
 * Resolution looks at the script first, then the language, then the default, because line height
 * and font stack follow the writing system rather than the tongue.
 */
export interface LocaleTypographyRegistry {
  /** What to use when neither the script nor the language is listed. */
  readonly default?: TypographyProfile;
  /** Profiles by language tag, for a language that needs its own within a shared script. */
  readonly languages?: Readonly<Record<string, TypographyProfile>>;
  /** Profiles by script code, which is where most of these belong. */
  readonly scripts?: Readonly<Record<string, TypographyProfile>>;
}

/**
 * What kind of icon this is, which is what decides whether it flips in a right-to-left locale.
 *
 * `relative` points at something and is mirrored: a back arrow, a next chevron. `neutral` and
 * `physical` are not: a clock, a logo, a checkmark stay as they are, because mirroring those makes
 * them wrong rather than localized.
 */
export type IconDirectionClass = 'neutral' | 'relative' | 'physical';

/**
 * What a nested localization context starts with, for a region of a page in its own locale.
 *
 * A preview of another language, a side-by-side comparison, an embedded document. The child has its
 * own snapshot and its own participants, so a change inside it leaves the page around it alone.
 */
export interface ChildLocalizationOptions {
  /** The locale to start in. Defaults to whatever the parent has committed. */
  readonly initialLocale?: string;
  /** The scopes to load at start-up. Defaults to what the parent required. */
  readonly bootstrapScopes?: readonly LocalizationScope[];
  /** The formatting defaults inside it. The locale is not among them: it is the child's own. */
  readonly formattingContext?: Omit<FormattingContext, 'locale'>;
}

/**
 * What building a localization context outside Angular's injector takes.
 *
 * Only the setup is required; with nothing else given the context starts in the default locale and
 * loads every scope the configuration declares.
 */
export interface LocalizationContextOptions {
  /** What the build produced: the configuration, the catalog index, and the loaders. */
  readonly setup: LocalizationSetup;
  /** The scopes to load at start-up. Defaults to every scope the configuration declares. */
  readonly bootstrapScopes?: readonly LocalizationScope[];
  /** The locale to start in. Defaults to the configured default. */
  readonly initialLocale?: string;
  /**
   * Something of the caller's own to carry through, opaque to Atlas.
   *
   * On a server this is usually the request, so a participant preparing content for one request can
   * reach it without a global.
   */
  readonly requestContext?: unknown;
  /** What to say when localization could not start. Must be plain and take no inputs. */
  readonly recoveryMessage?: MessageHandle & { readonly resultKind: 'plain' };
  /**
   * The retry control's wording, carried in the recovery payload beside the message.
   *
   * A literal string here is an English button on an Arabic page, inside a region that already
   * carries `lang="ar"`, so a screen reader reads English words under Arabic rules. The payload is
   * keyed by identity and locale and has always been able to hold more than one message, so this
   * is the same lookup rather than a second mechanism.
   */
  readonly recoveryRetryLabel?: MessageHandle & {
    readonly resultKind: 'plain';
  };
  /** The formatting defaults every call inherits. The locale is not among them: it is committed. */
  readonly formattingContext?: Omit<FormattingContext, 'locale'>;
  /** Where the reader already is, for a context built to render one page. */
  readonly initialRoute?: LocalizationRouteSnapshot;
}

/**
 * One option in a locale switcher, with everything a correct option needs.
 *
 * Every field here is something the runtime knows and the application cannot derive: the bare
 * language subtag comes from the same locale profile the direction does, and the endonym from the
 * engine's own display names. An application writing these by hand writes them once per locale per
 * template, in a language it may not read, and it is the shape every library in the field leaves to
 * the consumer: next-intl asks for a `select` message in every catalog, Nuxt for a `name` key on
 * every locale object, Transloco for a label beside every id.
 *
 * There is no `disabled`. It was the context's own disposal copied onto every row, which is a
 * property of the switcher and not of a choice; a control that must disable the whole set reads the
 * lifecycle once instead of reading the same answer once per option.
 */
export interface LocaleSelectorChoice {
  /** The locale this option switches to. */
  readonly locale: string;
  /** The bare language subtag, which is what `lang` on a single option wants. */
  readonly language: string;
  /** The locale's own name for itself. */
  readonly selfName: string;
  /** Which way that name is written, which one option may need against the page around it. */
  readonly direction: LocaleDirection;
  /** This is the locale the snapshot is in. */
  readonly current: boolean;
  /** A switch to this locale is in flight. */
  readonly pending: boolean;
}
