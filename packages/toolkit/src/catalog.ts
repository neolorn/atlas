/**
 * Reading an authored catalog, and refusing everything YAML can do that a catalog must not.
 *
 * `specs/04-message-authoring-and-catalogs.spec.md` section 2 is the profile: one document, one
 * mapping, no directive, tag, constructor, anchor, alias or merge key, duplicate keys caught before
 * the mapping is built, and nothing resolved over the network. Why this file is the only door is
 * `specs/04-message-authoring-and-catalogs.spec.md` section 1: a message that could also arrive
 * from template text or a code literal would have two authorities and no way to say which one is
 * current.
 *
 * The restricted features are the ones that change what a key means from elsewhere in the
 * document. An alias graph or a merge key makes a later key's value depend on how a reader
 * resolved an earlier one, so what a reviewer reads is not necessarily what compiles.
 */
import {
  Scalar,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  parseDocument,
  stringify,
  type Document,
  type Node,
  type ParsedNode,
  type Pair,
} from 'yaml';

import {
  atlasDiagnostic,
  atlasFailure,
  atlasSourceSpan,
  atlasSuccess,
  type AtlasDiagnostic,
  type AtlasDiagnosticCode,
  type AtlasResult,
  type AtlasSourceSpan,
} from './diagnostics.js';
import {
  atlasMessageKeyInCatalog,
  atlasMessageKeyInCode,
  parseAtlasMessageId,
  parseAtlasProviderId,
  parseAtlasScopeId,
  type AtlasProviderId,
  type AtlasScopeId,
} from './identities.js';
import { canonicalizeAtlasLocale, type AtlasLocale } from './locales.js';
import {
  parseAtlasMessage,
  type AtlasMessageSemanticModel,
} from './message-format.js';
import {
  atlasSchemaErrorParameter,
  atlasSchemaErrorPath,
  atlasSchemaErrorSummary,
  compileAtlasSchema,
  sortedAtlasSchemaErrors,
} from './schema-validation.js';
import {
  ATLAS_SOURCE_CATALOG_SCHEMA,
  ATLAS_TARGET_CATALOG_SCHEMA,
} from './schemas.js';
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';
import type { ErrorObject } from 'ajv';

import { atlasUntrustedText } from './untrusted-text.js';
import {
  inspectAtlasAuthoredBidi,
  isAtlasSafeAuthoredText,
  isAtlasSafeStructuralText,
  type AtlasBidiViolation,
} from './unicode-safety.js';
import {
  atlasMessageCustomFunctions,
  type AtlasExtensionRegistry,
} from './extensions.js';
import { frozenRecord } from './sorted-records.js';

/**
 * Whether a catalog is the one authored in the original language or a translation of it.
 *
 * The two are checked differently. A source catalog is where a message's shape is declared; a
 * target is measured against the source it translates, which is where a missing plural category or
 * a dropped slot is caught.
 */
export type AtlasCatalogRole = 'source' | 'target';
/** What an enumerated input value may be: a string, a number, or a boolean. */
export type AtlasInputLiteral = string | number | boolean;

/**
 * What a message says about one of the values it takes, beyond the fact that it takes it.
 *
 * Every field is the author's declaration in the source catalog. It becomes the type of that input
 * in the generated code, so a message that says it takes a date is a message a caller cannot hand a
 * string to.
 */
export interface AtlasInputRefinement {
  /** The kind of value expected, as a name the generator maps to a type. */
  readonly type?: string;
  /** The exact values allowed, when the input is one of a closed set. */
  readonly enum?: readonly AtlasInputLiteral[];
  /** Whether a caller may leave it out entirely. */
  readonly optional: boolean;
  /** Whether it may be present and null, which is not the same as being left out. */
  readonly nullable: boolean;
  /** What it means, for a translator and for whoever calls the message. */
  readonly description?: string;
}

/**
 * Whether a slot wraps words or stands alone.
 *
 * A paired slot opens and closes around text, the way a link does. A standalone one marks a single
 * point, the way an icon does.
 */
export type AtlasSlotShape = 'paired' | 'standalone';

/**
 * What a message says about one of the named regions inside it.
 *
 * These become the slot contract the application binds against, so a message declaring a link slot
 * is one whose bindings must include a link.
 */
export interface AtlasSlotRefinement {
  /** What the slot renders as: a link, an emphasis, a projected template. */
  readonly kind?: string;
  /** Whether it wraps text or marks a point. */
  readonly shape?: AtlasSlotShape;
  /** Whether a translation may leave it out. */
  readonly optional: boolean;
  /** Whether a translation may use it more than once. */
  readonly repeatable: boolean;
  /** The slots this one may appear inside, when nesting is constrained. */
  readonly within?: readonly string[];
  /** What it is for, which is what tells a translator where the words around it belong. */
  readonly description?: string;
}

interface AtlasCatalogMessageMetadata {
  readonly description?: string;
  readonly context?: string;
  readonly inputs: Readonly<Record<string, AtlasInputRefinement>>;
  readonly slots: Readonly<Record<string, AtlasSlotRefinement>>;
}

/** A message with text in it, parsed and kept beside its source. */
export interface AtlasTextCatalogMessage extends AtlasCatalogMessageMetadata {
  readonly kind: 'message';
  /** What the author wrote, exactly as written. */
  readonly message: string;
  /** The parsed form: what it needs, what it produces, and how it branches. */
  readonly semantics: AtlasMessageSemanticModel;
}

/**
 * A message declared with no text yet, which is how a target catalog records an untranslated entry.
 *
 * It keeps its description, its context and its declared inputs and slots, so a translator is
 * handed the whole brief rather than an empty key.
 */
export interface AtlasEmptyCatalogMessage extends AtlasCatalogMessageMetadata {
  readonly kind: 'empty';
}

/**
 * One entry in a catalog: text that was written, or a declaration still waiting for it.
 *
 * Check `kind` to tell them apart. Both carry the author's description, context, inputs and slots.
 */
export type AtlasCatalogMessage =
  | AtlasTextCatalogMessage
  | AtlasEmptyCatalogMessage;

/**
 * One catalog file, parsed: which package and scope and locale it belongs to, and what is in it.
 *
 * The unit everything downstream works in. A message is identified by the provider, the scope and
 * its own key, and those three together are what makes two packages able to ship a `title` each.
 */
export interface AtlasCatalog {
  /** Whether this is an authored catalog or a translation. */
  readonly role: AtlasCatalogRole;
  /** Which package owns it, which is what keeps two packages' scopes from colliding. */
  readonly providerId: AtlasProviderId;
  /** Which scope within that package, which is the unit catalogs are loaded in. */
  readonly scopeId: AtlasScopeId;
  /** The locale it holds, canonically spelled. */
  readonly locale: AtlasLocale;
  /** Where it was read from, when it came from a file. Carried into diagnostics. */
  readonly sourcePath?: string;
  /** The messages, by key. */
  readonly messages: Readonly<Record<string, AtlasCatalogMessage>>;
  /** The message families, by name, for messages that vary over a set of segments. */
  readonly families: Readonly<Record<string, AtlasCatalogFamily>>;
}

/**
 * A group of messages generated from one template, one per segment.
 *
 * What a set of related keys is declared as when they differ only in one part: a status per state,
 * a label per field. The template is authored once, so adding a segment adds a message rather than
 * a copy of one.
 */
export interface AtlasCatalogFamily {
  /** The message key the segments are substituted into. */
  readonly template: string;
  /** The segments, by name, each with the value substituted for it. */
  readonly segments: Readonly<Record<string, string>>;
}

/**
 * Everything about a catalog that its own text does not say.
 *
 * A catalog file holds messages and nothing about where it belongs, so the identity comes from
 * where the file was found rather than from something inside it that could disagree with that.
 */
export interface AtlasCatalogParseOptions {
  /** Whether to check it as an authored catalog or as a translation. */
  readonly role: AtlasCatalogRole;
  /** Which package it belongs to. Must be a valid provider identity. */
  readonly providerId: string;
  /** Which scope within that package. Must be a valid scope identity. */
  readonly scopeId: string;
  /** Which locale it holds. Must be canonical. */
  readonly locale: string;
  /** Where it came from, carried into every diagnostic this parse produces. */
  readonly sourcePath?: string;
  /**
   * The extensions whose functions and slot kinds the messages may use.
   *
   * Leaving it out is stricter rather than looser: a message calling an unregistered function is
   * refused, so a caller that has a registry and does not pass it rejects its own catalogs.
   */
  readonly extensions?: AtlasExtensionRegistry;
}

type JsonObject = Readonly<Record<string, unknown>>;

const BIDI_VIOLATION_SUMMARY: Readonly<Record<AtlasBidiViolation, string>> =
  Object.freeze({
    'directional-override':
      'Atlas catalog text contains a directional override or embedding (U+202A-U+202E), which reorders the text around it and cannot be seen while reading the file.',
    'unbalanced-isolate':
      'Atlas catalog text contains an unbalanced directional isolate (U+2066-U+2069); an isolate that is opened and never closed reorders the text that follows it.',
    'byte-order-mark':
      'Atlas catalog text contains U+FEFF, a byte-order mark that has ended up inside the value rather than content anyone typed.',
  });

const validateSourceCatalog = compileAtlasSchema(ATLAS_SOURCE_CATALOG_SCHEMA);
const validateTargetCatalog = compileAtlasSchema(ATLAS_TARGET_CATALOG_SCHEMA);

function yamlRangeSpan(
  source: string,
  range: readonly number[] | null | undefined,
  sourcePath: string | undefined,
): AtlasSourceSpan | undefined {
  if (range == null || range[0] === undefined) {
    return undefined;
  }
  const end = range[2] ?? range[1] ?? range[0];
  return atlasSourceSpan(
    source,
    range[0],
    Math.max(0, end - range[0]),
    sourcePath,
  );
}

function yamlNodeSpan(
  source: string,
  node: Node | null | undefined,
  sourcePath: string | undefined,
): AtlasSourceSpan | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  if ('range' in node) {
    return yamlRangeSpan(source, node.range ?? undefined, sourcePath);
  }
  return undefined;
}

const catalogSourceText = new WeakMap<AtlasCatalog, string>();

/**
 * Resolve an authored path such as `['messages', 'nav.products']` to the span it occupies in the
 * catalog source, so a semantic diagnostic can report a real line and column instead of 1:1.
 *
 * The source is held in a side table rather than on `AtlasCatalog` itself. Putting it on the type
 * was tried and reverted: the catalog feeds deep equality, canonical JSON and output-freshness
 * digests, so an extra field silently changed identity and broke unchanged-output detection.
 *
 * Returns undefined for a catalog that was not produced by `parseAtlasCatalog`, or for a path
 * with no authored node behind it.
 */
export function atlasCatalogPathSpan(
  catalog: AtlasCatalog,
  path: readonly (string | number)[],
): AtlasSourceSpan | undefined {
  return atlasCatalogPathAnchor(catalog, path)?.span;
}

/**
 * Where in the file to point, and how much of the pointer got there.
 *
 * A JSON pointer into a catalog does not always resolve, and the interesting case is the one where
 * it *cannot*: a diagnostic reporting that a message is absent is pointing at the thing that is not
 * there. The answer is the nearest ancestor that does resolve, `messages` for a missing
 * `messages/greeting`, with `resolved` saying how many segments got there, so a caller can tell a
 * reader why the caret is where it is instead of on the thing they were told about.
 *
 * `resolved === path.length` is an exact hit and needs no explaining. `undefined` means there is no
 * honest answer at all (no retained source, an empty pointer, a file that does not parse) and a
 * caller must then report no location rather than inventing one. Every location this returns is a
 * position a reader can put a cursor on.
 */
export function atlasCatalogPathAnchor(
  catalog: AtlasCatalog,
  path: readonly (string | number)[],
): { readonly span: AtlasSourceSpan; readonly resolved: number } | undefined {
  const source = catalogSourceText.get(catalog);
  if (source === undefined || path.length === 0) return undefined;
  let documents: Document.Parsed<ParsedNode>[];
  try {
    documents = parseAllDocuments<ParsedNode>(source, {
      customTags: [],
      merge: false,
      resolveKnownTags: false,
    });
  } catch {
    return undefined;
  }
  const root = documents[0]?.contents;
  if (root === null || root === undefined) return undefined;
  const located = yamlPathNode(root, path);
  const span = yamlNodeSpan(
    source,
    located.node ?? undefined,
    catalog.sourcePath,
  );
  return span === undefined
    ? undefined
    : Object.freeze({ span, resolved: located.resolved });
}

/**
 * Walk as far down the pointer as the document goes, and say where you stopped.
 *
 * Stopping is the ordinary outcome rather than the failure. This already returned the node it had
 * when the next step needed a different kind of collection; what it did not do was stop when a key
 * was simply **absent**: it set `current` to `undefined` and walked on, so a pointer into a
 * missing message came back with nothing at all and the caller had no position to report. Absence
 * is exactly the case the diagnostics that use this are reporting.
 */
function yamlPathNode(
  root: ParsedNode,
  path: readonly (string | number)[],
): {
  readonly node: ParsedNode | null | undefined;
  readonly resolved: number;
} {
  let current: ParsedNode | null | undefined = root;
  let resolved = 0;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!isSeq<ParsedNode>(current)) return { node: current, resolved };
      const element: ParsedNode | undefined = current.items[part];
      if (element === undefined) return { node: current, resolved };
      current = element;
      resolved += 1;
      continue;
    }

    if (!isMap<ParsedNode, ParsedNode | null>(current)) {
      return { node: current, resolved };
    }
    const pair: Pair<ParsedNode, ParsedNode | null> | undefined =
      current.items.find(
        (item) => isScalar<string>(item.key) && item.key.value === part,
      );
    // The key is not in this map. The map is where the reader has to look, and the key is what is
    // not in it, so this node is the answer and `resolved` says the rest of the pointer is
    // what is missing beneath it.
    if (pair === undefined) return { node: current, resolved };
    current = pair.value;
    resolved += 1;
  }
  return { node: current, resolved };
}

function yamlDiagnostic(
  source: string,
  sourcePath: string | undefined,
  code: AtlasDiagnosticCode,
  summary: string,
  options: {
    readonly node?: ParsedNode | null;
    readonly path?: readonly (string | number)[];
    readonly span?: AtlasSourceSpan;
  } = {},
): AtlasDiagnostic {
  const span = options.span ?? yamlNodeSpan(source, options.node, sourcePath);
  return atlasDiagnostic(code, summary, {
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(span === undefined ? {} : { span }),
  });
}

/**
 * One cause, one diagnostic.
 *
 * Ajv reports a rejected property name twice: the keyword that actually rejected it, and
 * the `propertyNames` wrapper around that keyword. The two carry complementary halves and neither
 * is usable alone (the inner one has the rule and no property, the wrapper has the property and
 * no rule) so a reader got
 *
 *     en-US.yaml:2:3:  Atlas catalog must match pattern "^[a-z][a-z0-9]*(?:-[a-z]...".
 *     en-US.yaml:2:17: Atlas catalog property name must be valid.
 *
 * two lines about one key, at two positions, saying between them less than either would alone. The
 * wrapper is kept because it resolves to the offending entry rather than to the map containing it,
 * and `rejectedKeySummary` below puts the rule back into it in words.
 *
 * The inner error is dropped **only when its wrapper is present**. Ajv emitting one without the
 * other would otherwise silently drop the whole report, so the filter is shown keeping what it is
 * not there to remove. An empty report says nothing until the filter is known to pass something.
 */
function reportableSchemaErrors(
  errors: readonly ErrorObject[],
): readonly ErrorObject[] {
  const wrapped = new Set(
    errors
      .filter((error) => error.keyword === 'propertyNames')
      .map((error) => error.instancePath),
  );
  return errors.filter(
    (error) =>
      error.keyword === 'propertyNames' ||
      !error.schemaPath.includes('/propertyNames/') ||
      !wrapped.has(error.instancePath),
  );
}

/**
 * A rejected catalog key, said the way a person would say it.
 *
 * *"Atlas catalog property name must be valid"* names no property and no rule, and the line above
 * it printed the raw regex, which states the rule in a language the reader is not writing in,
 * and never mentions that the file spells keys one way and code spells them another.
 * `sign-in-button` in the file is `messages.signInButton` in code, and that mapping was written
 * down nowhere at all.
 *
 * So this says the rule in words, offers the key's catalog spelling when the obvious repair is one
 * the schema would accept, and names what code will reach it by: taken from the projection the
 * generator itself uses, so the sentence cannot promise a name the generator does not emit.
 */
function rejectedKeySummary(
  error: ErrorObject,
  errors: readonly ErrorObject[],
): string | undefined {
  if (error.keyword !== 'propertyNames') return undefined;
  const key = atlasSchemaErrorParameter(error, 'propertyName');
  if (key === undefined) return undefined;
  const inner = errors.find(
    (candidate) =>
      candidate.instancePath === error.instancePath &&
      candidate.schemaPath.includes('/propertyNames/') &&
      candidate.keyword === 'pattern',
  );
  const pattern =
    inner === undefined
      ? undefined
      : atlasSchemaErrorParameter(inner, 'pattern');
  if (pattern === undefined) return undefined;

  // Only the two maps whose rule this function knows how to state. A third keyed map added to the
  // catalog schema later would otherwise inherit the message-key sentence and be described by a
  // rule that is not its own; falling through to Ajv's wording is worse prose and true, which is
  // the right way round.
  const collection = error.instancePath.split('/').at(-1) ?? '';
  if (collection !== 'messages' && collection !== 'families') return undefined;
  const [subject, rule] =
    collection === 'families'
      ? ['Family name', 'Family names are lower-case words joined by hyphens.']
      : [
          'Message key',
          'Message keys are lower-case words joined by hyphens, and a dot separates groups.',
        ];

  const repaired = atlasMessageKeyInCatalog(key);
  let advice = '';
  try {
    if (repaired !== key && new RegExp(pattern, 'u').test(repaired)) {
      advice =
        collection === 'families'
          ? ` Write it as ${JSON.stringify(repaired)}.`
          : ` Write it as ${JSON.stringify(repaired)}, which code reaches as messages.${atlasMessageKeyInCode(repaired)}.`;
    }
  } catch {
    // A pattern this build cannot compile is not a reason to lose the diagnostic; the rule above
    // still holds and the suggestion is the optional half.
  }
  return `${subject} ${JSON.stringify(key)} is not a valid catalog key. ${rule}${advice}`;
}

/**
 * The parser's complaint as one sentence, because a diagnostic is a line.
 *
 * `YAMLParseError.message` is a code frame: a sentence, then a blank line, then the
 * offending source, then a caret. Interpolated into a one-line diagnostic those newlines survive as
 * the raw bytes they are (on a terminal the reader gets
 * `Missing closing "quote at line 3, column 1:<CR><LF>  greeting: "unterminated<CR><LF>^<CR>`) and
 * the frame is a worse copy of the source Atlas is already pointing at by file, line and column.
 *
 * So: the first line only, with the position stripped off the end of it for the same reason. What is
 * left is the part that says what is wrong.
 */
function yamlErrorSentence(message: string): string {
  const [first = ''] = message.split('\n');
  return first
    .replace(/\s+at line \d+, column \d+:?\s*$/u, '')
    .replace(/:\s*$/u, '');
}

/**
 * Whether the walk has already stopped at a limit.
 *
 * The flag is raised inside the recursive call the two readers below follow, and an assignment a
 * call makes is not one the compiler can order against a plain read of the property.
 */
function limitReached(state: { readonly limited: boolean }): boolean {
  return state.limited;
}

function inspectYamlNode(
  source: string,
  node: ParsedNode | null,
  sourcePath: string | undefined,
  path: readonly (string | number)[],
  diagnostics: AtlasDiagnostic[],
  depth = 0,
  state: { nodes: number; limited: boolean } = { nodes: 0, limited: false },
): void {
  if (node === null) {
    return;
  }
  if (
    state.limited ||
    diagnostics.length >= ATLAS_RESOURCE_LIMITS.diagnostics
  ) {
    return;
  }
  state.nodes += 1;
  if (state.nodes > ATLAS_RESOURCE_LIMITS.yamlNodes) {
    state.limited = true;
    diagnostics.push(
      yamlDiagnostic(
        source,
        sourcePath,
        'ATL1101',
        `Atlas catalog structure exceeds the node ceiling of ${ATLAS_RESOURCE_LIMITS.yamlNodes}.`,
        { node, path },
      ),
    );
    return;
  }

  if (depth > ATLAS_RESOURCE_LIMITS.yamlDepth) {
    diagnostics.push(
      yamlDiagnostic(
        source,
        sourcePath,
        'ATL1101',
        `Atlas catalog structure exceeds the depth ceiling of ${ATLAS_RESOURCE_LIMITS.yamlDepth}.`,
        { node, path },
      ),
    );
    return;
  }

  if (isAlias(node)) {
    diagnostics.push(
      yamlDiagnostic(
        source,
        sourcePath,
        'ATL1101',
        'Atlas catalogs cannot contain YAML aliases.',
        { node, path },
      ),
    );
    return;
  }

  if ('anchor' in node && typeof node.anchor === 'string') {
    diagnostics.push(
      yamlDiagnostic(
        source,
        sourcePath,
        'ATL1101',
        'Atlas catalogs cannot contain YAML anchors.',
        { node, path },
      ),
    );
  }

  if (isMap<ParsedNode, ParsedNode | null>(node)) {
    const seen = new Set<string>();
    for (const pair of node.items) {
      state.nodes += 1;
      if (state.nodes > ATLAS_RESOURCE_LIMITS.yamlNodes) {
        state.limited = true;
        diagnostics.push(
          yamlDiagnostic(
            source,
            sourcePath,
            'ATL1101',
            `Atlas catalog structure exceeds the node ceiling of ${ATLAS_RESOURCE_LIMITS.yamlNodes}.`,
            { node: pair.key, path },
          ),
        );
        return;
      }
      if (!isScalar<string>(pair.key) || typeof pair.key.value !== 'string') {
        diagnostics.push(
          yamlDiagnostic(
            source,
            sourcePath,
            'ATL1101',
            'Atlas catalog mappings require scalar string keys.',
            { node: pair.key, path },
          ),
        );
        inspectYamlNode(
          source,
          pair.value,
          sourcePath,
          path,
          diagnostics,
          depth + 1,
          state,
        );
        continue;
      }

      const key = pair.key.value;
      const childPath = [...path, key];
      if (!isAtlasSafeStructuralText(key)) {
        diagnostics.push(
          yamlDiagnostic(
            source,
            sourcePath,
            'ATL1101',
            'Atlas catalog keys contain malformed Unicode or unauthorized invisible or bidi controls.',
            { node: pair.key, path: childPath },
          ),
        );
      }
      if (key === '<<') {
        diagnostics.push(
          yamlDiagnostic(
            source,
            sourcePath,
            'ATL1101',
            'Atlas catalogs cannot contain YAML merge keys.',
            { node: pair.key, path: childPath },
          ),
        );
      }
      if (seen.has(key)) {
        diagnostics.push(
          yamlDiagnostic(
            source,
            sourcePath,
            'ATL1103',
            `Atlas catalog contains the duplicate key ${JSON.stringify(key)}.`,
            { node: pair.key, path: childPath },
          ),
        );
      } else {
        seen.add(key);
      }

      inspectYamlNode(
        source,
        pair.value,
        sourcePath,
        childPath,
        diagnostics,
        depth + 1,
        state,
      );
      if (
        limitReached(state) ||
        diagnostics.length >= ATLAS_RESOURCE_LIMITS.diagnostics
      ) {
        return;
      }
    }
    return;
  }

  if (isSeq<ParsedNode>(node)) {
    for (const [index, item] of node.items.entries()) {
      inspectYamlNode(
        source,
        item,
        sourcePath,
        [...path, index],
        diagnostics,
        depth + 1,
        state,
      );
      if (
        limitReached(state) ||
        diagnostics.length >= ATLAS_RESOURCE_LIMITS.diagnostics
      ) {
        return;
      }
    }
    return;
  }

  if (isScalar<unknown>(node)) {
    const value = node.value;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      (typeof value !== 'number' || !Number.isFinite(value))
    ) {
      diagnostics.push(
        yamlDiagnostic(
          source,
          sourcePath,
          'ATL1101',
          'Atlas catalogs permit only JSON-compatible Core-schema scalar values.',
          { node, path },
        ),
      );
    } else if (typeof value === 'string' && !isAtlasSafeAuthoredText(value)) {
      diagnostics.push(
        yamlDiagnostic(
          source,
          sourcePath,
          'ATL1101',
          'Atlas catalog text contains malformed Unicode or forbidden control characters.',
          { node, path },
        ),
      );
    } else if (typeof value === 'string') {
      const violation = inspectAtlasAuthoredBidi(value);
      if (violation !== undefined) {
        diagnostics.push(
          yamlDiagnostic(
            source,
            sourcePath,
            'ATL1103',
            BIDI_VIOLATION_SUMMARY[violation],
            { node, path },
          ),
        );
      }
    }
    return;
  }

  diagnostics.push(
    yamlDiagnostic(
      source,
      sourcePath,
      'ATL1101',
      'Atlas catalog contains an unsupported YAML node.',
      { node, path },
    ),
  );
}

function constructYamlValue(node: ParsedNode | null): unknown {
  if (node === null) {
    return null;
  }
  if (isScalar<unknown>(node)) {
    return node.value;
  }
  if (isSeq<ParsedNode>(node)) {
    return Object.freeze(node.items.map(constructYamlValue));
  }
  if (isMap<ParsedNode, ParsedNode | null>(node)) {
    const value = Object.create(null) as Record<string, unknown>;
    for (const pair of node.items) {
      if (isScalar<string>(pair.key) && typeof pair.key.value === 'string') {
        Object.defineProperty(value, pair.key.value, {
          configurable: false,
          enumerable: true,
          value: constructYamlValue(pair.value),
          writable: false,
        });
      }
    }
    return Object.freeze(value);
  }
  throw new TypeError('Cannot construct an unsupported YAML node.');
}

function emptyFrozenRecord<T>(): Readonly<Record<string, T>> {
  return Object.freeze(Object.create(null)) as Readonly<Record<string, T>>;
}

function normalizeInputs(
  value: unknown,
): Readonly<Record<string, AtlasInputRefinement>> {
  if (typeof value !== 'object' || value === null) {
    return emptyFrozenRecord();
  }
  const entries = Object.entries(value as JsonObject)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, refinement]) => {
      if (typeof refinement === 'string') {
        return [
          key,
          Object.freeze({ type: refinement, optional: false, nullable: false }),
        ] as const;
      }
      const record = refinement as JsonObject;
      return [
        key,
        Object.freeze({
          ...(typeof record['type'] === 'string'
            ? { type: record['type'] }
            : {}),
          ...(Array.isArray(record['enum'])
            ? {
                enum: Object.freeze([...record['enum']] as AtlasInputLiteral[]),
              }
            : {}),
          optional: record['optional'] === true,
          nullable: record['nullable'] === true,
          ...(typeof record['description'] === 'string'
            ? { description: record['description'] }
            : {}),
        }),
      ] as const;
    });
  return frozenRecord<AtlasInputRefinement>(
    entries as readonly (readonly [string, AtlasInputRefinement])[],
  );
}

function normalizeSlots(
  value: unknown,
): Readonly<Record<string, AtlasSlotRefinement>> {
  if (typeof value !== 'object' || value === null) {
    return emptyFrozenRecord();
  }
  const entries = Object.entries(value as JsonObject)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, refinement]) => {
      if (typeof refinement === 'string') {
        return [
          key,
          Object.freeze({
            kind: refinement,
            optional: false,
            repeatable: false,
          }),
        ] as const;
      }
      const record = refinement as JsonObject;
      return [
        key,
        Object.freeze({
          ...(typeof record['kind'] === 'string'
            ? { kind: record['kind'] }
            : {}),
          ...(record['shape'] === 'paired' || record['shape'] === 'standalone'
            ? { shape: record['shape'] }
            : {}),
          optional: record['optional'] === true,
          repeatable: record['repeatable'] === true,
          ...(Array.isArray(record['within'])
            ? { within: Object.freeze([...record['within']] as string[]) }
            : {}),
          ...(typeof record['description'] === 'string'
            ? { description: record['description'] }
            : {}),
        }),
      ] as const;
    });
  return frozenRecord<AtlasSlotRefinement>(
    entries as readonly (readonly [string, AtlasSlotRefinement])[],
  );
}

function normalizeMessages(
  value: JsonObject,
  semantics: ReadonlyMap<string, AtlasMessageSemanticModel>,
): Readonly<Record<string, AtlasCatalogMessage>> {
  const messages = value['messages'] as JsonObject;
  return frozenRecord<AtlasCatalogMessage>(
    Object.entries(messages)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([messageId, authored]) => {
        if (typeof authored === 'string') {
          return [
            messageId,
            Object.freeze({
              kind: 'message',
              message: authored,
              semantics: semantics.get(messageId) as AtlasMessageSemanticModel,
              inputs: emptyFrozenRecord<AtlasInputRefinement>(),
              slots: emptyFrozenRecord<AtlasSlotRefinement>(),
            }),
          ] as const;
        }

        const record = authored as JsonObject;
        const metadata = {
          ...(typeof record['description'] === 'string'
            ? { description: record['description'] }
            : {}),
          ...(typeof record['context'] === 'string'
            ? { context: record['context'] }
            : {}),
          inputs: normalizeInputs(record['inputs']),
          slots: normalizeSlots(record['slots']),
        };
        if (record['empty'] === true) {
          return [
            messageId,
            Object.freeze({ kind: 'empty', ...metadata }),
          ] as const;
        }
        return [
          messageId,
          Object.freeze({
            kind: 'message',
            message: record['message'] as string,
            semantics: semantics.get(messageId) as AtlasMessageSemanticModel,
            ...metadata,
          }),
        ] as const;
      }),
  );
}

function contextDiagnostics(options: AtlasCatalogParseOptions): {
  readonly diagnostics: readonly AtlasDiagnostic[];
  readonly providerId?: AtlasProviderId;
  readonly scopeId?: AtlasScopeId;
  readonly locale?: AtlasLocale;
} {
  const providerId = parseAtlasProviderId(options.providerId);
  const scopeId = parseAtlasScopeId(options.scopeId);
  const locale = canonicalizeAtlasLocale(options.locale);
  const diagnostics: AtlasDiagnostic[] = [];
  if (!providerId.ok) {
    diagnostics.push(
      atlasDiagnostic('ATL1104', 'Catalog provider identity is malformed.'),
    );
  }
  if (!scopeId.ok) {
    diagnostics.push(
      atlasDiagnostic('ATL1104', 'Catalog scope identity is malformed.'),
    );
  }
  if (!locale.ok) {
    diagnostics.push(
      atlasDiagnostic('ATL1003', 'Catalog locale is malformed.'),
    );
  }
  return {
    diagnostics,
    ...(providerId.ok ? { providerId: providerId.value } : {}),
    ...(scopeId.ok ? { scopeId: scopeId.value } : {}),
    ...(locale.ok ? { locale: locale.value } : {}),
  };
}

/**
 * Reads one catalog file and returns it parsed, or the reasons it could not be.
 *
 * Takes the file's text and the identity to read it under. Every message in it is parsed, checked
 * against the schema for its role, and measured for the text that cannot be seen while reading the
 * file: a directional override, an unbalanced isolate, a byte-order mark inside a value.
 *
 * Diagnostics carry the line and column in the original text, so a problem points at the place in
 * the file rather than at a path through the parsed object.
 *
 * Refuses a file past the size ceiling before parsing it, and returns a failure rather than
 * throwing for anything wrong with its content.
 */
export function parseAtlasCatalog(
  sourceValue: unknown,
  options: AtlasCatalogParseOptions,
): AtlasResult<AtlasCatalog> {
  const sourceText = atlasUntrustedText(
    sourceValue,
    'ATL1101',
    'Catalog source',
    ATLAS_RESOURCE_LIMITS.catalogBytes,
  );
  if (!sourceText.ok) return sourceText;
  const source = sourceText.value;
  if (Buffer.byteLength(source, 'utf8') > ATLAS_RESOURCE_LIMITS.catalogBytes) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1101',
        `Atlas catalog exceeds the ${ATLAS_RESOURCE_LIMITS.catalogBytes}-byte implementation ceiling.`,
        {
          span: atlasSourceSpan(source, 0, source.length, options.sourcePath),
        },
      ),
    ]);
  }
  const context = contextDiagnostics(options);
  if (context.diagnostics.length > 0) {
    return atlasFailure(context.diagnostics);
  }

  let documents: Document.Parsed<ParsedNode>[];
  try {
    documents = parseAllDocuments<ParsedNode>(source, {
      customTags: [],
      merge: false,
      resolveKnownTags: false,
      schema: 'core',
      strict: true,
      uniqueKeys: false,
    });
  } catch {
    return atlasFailure([
      atlasDiagnostic('ATL1101', 'Atlas catalog is not valid YAML.', {
        span: atlasSourceSpan(
          source,
          0,
          Math.min(1, source.length),
          options.sourcePath,
        ),
      }),
    ]);
  }

  if (documents.length !== 1) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1101',
        'Atlas catalogs must contain exactly one YAML document.',
        {
          span: atlasSourceSpan(source, 0, source.length, options.sourcePath),
        },
      ),
    ]);
  }

  const document = documents[0];
  if (document === undefined) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1101',
        'Atlas catalog must contain one YAML document.',
      ),
    ]);
  }

  const parserDiagnostics = [...document.errors, ...document.warnings].map(
    (error) => {
      const span = yamlRangeSpan(source, error.pos, options.sourcePath);
      return atlasDiagnostic(
        'ATL1101',
        `Atlas catalog YAML is invalid: ${yamlErrorSentence(error.message)}`,
        span === undefined ? {} : { span },
      );
    },
  );
  if (parserDiagnostics.length > 0) {
    return atlasFailure(parserDiagnostics);
  }

  if (
    document.directives.yaml.explicit === true ||
    Object.keys(document.directives.tags).some((tag) => tag !== '!!')
  ) {
    const span = yamlRangeSpan(source, document.range, options.sourcePath);
    return atlasFailure([
      atlasDiagnostic(
        'ATL1101',
        'Atlas catalogs cannot contain YAML directives.',
        span === undefined ? {} : { span },
      ),
    ]);
  }

  const root = document.contents;
  if (!isMap<ParsedNode, ParsedNode | null>(root)) {
    const span = yamlNodeSpan(source, root, options.sourcePath);
    return atlasFailure([
      atlasDiagnostic(
        'ATL1101',
        'Atlas catalog root must be a mapping.',
        span === undefined ? {} : { span },
      ),
    ]);
  }

  const structuralDiagnostics: AtlasDiagnostic[] = [];
  inspectYamlNode(source, root, options.sourcePath, [], structuralDiagnostics);
  if (structuralDiagnostics.length > 0) {
    return atlasFailure(structuralDiagnostics);
  }

  const value = constructYamlValue(root);
  const validator =
    options.role === 'source' ? validateSourceCatalog : validateTargetCatalog;
  if (!validator(value)) {
    const errors = sortedAtlasSchemaErrors(validator.errors);
    return atlasFailure(
      reportableSchemaErrors(errors).map((error) => {
        const path = atlasSchemaErrorPath(error);
        const node = yamlPathNode(root, path).node;
        const targetContract =
          options.role === 'target' &&
          path.some((part) => part === 'inputs' || part === 'slots');
        return yamlDiagnostic(
          source,
          options.sourcePath,
          targetContract ? 'ATL1105' : 'ATL1102',
          targetContract
            ? 'Target catalog entries inherit inputs and slots from the source catalog.'
            : (rejectedKeySummary(error, errors) ??
                atlasSchemaErrorSummary('Atlas catalog', error)),
          {
            path,
            ...(node === undefined ? {} : { node }),
          },
        );
      }),
    );
  }

  const objectValue = value as JsonObject;
  if (
    Object.keys(objectValue['messages'] as JsonObject).length >
    ATLAS_RESOURCE_LIMITS.messagesPerCatalog
  ) {
    const messagesNode = yamlPathNode(root, ['messages']).node;
    return atlasFailure([
      yamlDiagnostic(
        source,
        options.sourcePath,
        'ATL1101',
        `Atlas catalog exceeds the ${ATLAS_RESOURCE_LIMITS.messagesPerCatalog}-message implementation ceiling.`,
        {
          path: ['messages'],
          ...(messagesNode === undefined ? {} : { node: messagesNode }),
        },
      ),
    ]);
  }
  for (const messageId of Object.keys(objectValue['messages'] as JsonObject)) {
    const parsedMessageId = parseAtlasMessageId(messageId);
    const node = yamlPathNode(root, ['messages', messageId]).node;
    if (!parsedMessageId.ok) {
      return atlasFailure([
        yamlDiagnostic(
          source,
          options.sourcePath,
          'ATL1104',
          `Message identity ${JSON.stringify(messageId)} is malformed.`,
          {
            path: ['messages', messageId],
            ...(node === undefined ? {} : { node }),
          },
        ),
      ]);
    }
  }

  const customFunctions = atlasMessageCustomFunctions(options.extensions);
  const messageSemantics = new Map<string, AtlasMessageSemanticModel>();
  for (const [messageId, authored] of Object.entries(
    objectValue['messages'] as JsonObject,
  )) {
    const record =
      typeof authored === 'object' && authored !== null
        ? (authored as JsonObject)
        : undefined;
    const body =
      typeof authored === 'string'
        ? authored
        : typeof record?.['message'] === 'string'
          ? record['message']
          : undefined;
    if (body === undefined) {
      continue;
    }

    const semantics = parseAtlasMessage(body, {
      path: ['messages', messageId],
      customFunctions,
    });
    if (!semantics.ok) {
      const node = yamlPathNode(root, ['messages', messageId]).node;
      return atlasFailure(
        semantics.diagnostics.map((diagnostic) =>
          yamlDiagnostic(
            source,
            options.sourcePath,
            diagnostic.code,
            diagnostic.summary,
            {
              path: diagnostic.path,
              ...(node === undefined ? {} : { node }),
            },
          ),
        ),
      );
    }
    messageSemantics.set(messageId, semantics.value);
  }

  const catalog: AtlasCatalog = Object.freeze({
    role: options.role,
    providerId: context.providerId as AtlasProviderId,
    scopeId: context.scopeId as AtlasScopeId,
    locale: context.locale as AtlasLocale,
    ...(options.sourcePath === undefined
      ? {}
      : { sourcePath: options.sourcePath }),
    messages: normalizeMessages(objectValue, messageSemantics),
    families: normalizeFamilies(objectValue),
  });
  // Held alongside the catalog, never on it: see atlasCatalogPathSpan.
  catalogSourceText.set(catalog, source);
  return atlasSuccess(catalog);
}

function normalizeFamilies(
  value: JsonObject,
): Readonly<Record<string, AtlasCatalogFamily>> {
  const result = Object.create(null) as Record<string, AtlasCatalogFamily>;
  const families = value['families'];
  if (
    typeof families !== 'object' ||
    families === null ||
    Array.isArray(families)
  ) {
    return Object.freeze(result);
  }
  for (const [name, authored] of Object.entries(families as JsonObject).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    const record =
      typeof authored === 'object' && authored !== null
        ? (authored as JsonObject)
        : undefined;
    const template =
      typeof authored === 'string'
        ? authored
        : typeof record?.['template'] === 'string'
          ? record['template']
          : '';
    const segments = Object.create(null) as Record<string, string>;
    for (const [segment, type] of Object.entries(
      (record?.['segments'] as JsonObject | undefined) ?? {},
    ).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      if (typeof type === 'string') segments[segment] = type;
    }
    result[name] = Object.freeze({
      template,
      segments: Object.freeze(segments),
    });
  }
  return Object.freeze(result);
}

function authoredInput(refinement: AtlasInputRefinement): unknown {
  const expanded = {
    ...(refinement.type === undefined ? {} : { type: refinement.type }),
    ...(refinement.enum === undefined ? {} : { enum: refinement.enum }),
    ...(refinement.optional ? { optional: true } : {}),
    ...(refinement.nullable ? { nullable: true } : {}),
    ...(refinement.description === undefined
      ? {}
      : { description: refinement.description }),
  };
  return Object.keys(expanded).length === 1 && refinement.type !== undefined
    ? refinement.type
    : expanded;
}

function authoredSlot(refinement: AtlasSlotRefinement): unknown {
  const expanded = {
    ...(refinement.kind === undefined ? {} : { kind: refinement.kind }),
    ...(refinement.shape === undefined ? {} : { shape: refinement.shape }),
    ...(refinement.optional ? { optional: true } : {}),
    ...(refinement.repeatable ? { repeatable: true } : {}),
    ...(refinement.within === undefined
      ? {}
      : {
          within: [...refinement.within].sort((left, right) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        }),
    ...(refinement.description === undefined
      ? {}
      : { description: refinement.description }),
  };
  return Object.keys(expanded).length === 1 && refinement.kind !== undefined
    ? refinement.kind
    : expanded;
}

function authoredMessage(message: AtlasCatalogMessage): unknown {
  const hasMetadata =
    message.description !== undefined ||
    message.context !== undefined ||
    Object.keys(message.inputs).length > 0 ||
    Object.keys(message.slots).length > 0;
  if (message.kind === 'message' && !hasMetadata) {
    return message.message;
  }

  return {
    ...(message.kind === 'message'
      ? { message: message.message }
      : { empty: true }),
    ...(message.description === undefined
      ? {}
      : { description: message.description }),
    ...(message.context === undefined ? {} : { context: message.context }),
    ...(Object.keys(message.inputs).length === 0
      ? {}
      : {
          inputs: Object.fromEntries(
            Object.entries(message.inputs).map(([key, value]) => [
              key,
              authoredInput(value),
            ]),
          ),
        }),
    ...(Object.keys(message.slots).length === 0
      ? {}
      : {
          slots: Object.fromEntries(
            Object.entries(message.slots).map(([key, value]) => [
              key,
              authoredSlot(value),
            ]),
          ),
        }),
  };
}

function authoredFamily(family: AtlasCatalogFamily): unknown {
  return Object.keys(family.segments).length === 0
    ? family.template
    : {
        template: family.template,
        segments: family.segments,
      };
}

/**
 * A scalar that means the same thing written without quotes.
 *
 * Deliberately narrow. Everything a message can contain that YAML would read as structure
 * (`{$name}` opening a flow mapping, a leading `-` opening a sequence, `: ` opening a pair, ` #`
 * opening a comment) keeps its quotes, as does anything a reader could mistake for a boolean,
 * a number, or null. The cost of being wrong is a catalog that parses to something else, so the
 * test refuses whatever it is not sure about.
 */
const PLAIN_SAFE =
  /^(?![-?:,[\]{}#&*!|>'"%@`\s])(?!.*(?::\s|\s#))[^\r\n\t]*[^\s:]$/u;

const PLAIN_UNSAFE_WORDS = new Set([
  'true',
  'false',
  'null',
  '~',
  'yes',
  'no',
  'on',
  'off',
  'True',
  'False',
  'Null',
  'TRUE',
  'FALSE',
  'NULL',
]);

function plainSafe(value: string): boolean {
  if (value.length === 0) return false;
  if (PLAIN_UNSAFE_WORDS.has(value)) return false;
  // Anything the core schema would read as a number rather than a string.
  if (/^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u.test(value)) {
    return false;
  }
  if (/^0[xXoO]/u.test(value)) return false;
  return PLAIN_SAFE.test(value);
}

/**
 * Normalise how a catalog is written without rewriting what it says.
 *
 * A formatter that builds a plain object from the semantic model and stringifies it drops every
 * comment, because comments are not in that model (they go when the YAML becomes the model,
 * several steps before anything writes a file) so a command whose name promises presentation
 * changes only deletes every comment in a consumer's catalog. Forced double quotes and a rewritten
 * key order come from the same place: that is regeneration rather than reformatting.
 *
 * Regenerating from a model is right for `src/generated/i18n/`, where nothing is the consumer's.
 * It is the wrong shape for a file a person wrote. This edits the parsed document instead, which
 * is what every formatter for authored code does, and which makes losing content impossible
 * rather than merely unintended: the content is never converted away.
 *
 * Key order is authorial information and is never touched. Quoting is reduced to the least a
 * scalar needs, and left alone wherever plain would be ambiguous.
 */
export function formatAtlasCatalogSource(
  source: string,
  options: AtlasCatalogParseOptions,
): AtlasResult<string> {
  // Presentation is normalised only on a catalog Atlas can read. Reformatting a file whose
  // meaning is unknown is how a formatter turns one problem into two.
  const parsed = parseAtlasCatalog(source, options);
  if (!parsed.ok) return parsed;

  let document: Document.Parsed<ParsedNode>;
  try {
    document = parseDocument<ParsedNode>(source, {
      customTags: [],
      merge: false,
      resolveKnownTags: false,
      schema: 'core',
      strict: true,
      uniqueKeys: false,
      keepSourceTokens: false,
    });
  } catch {
    return atlasFailure([
      atlasDiagnostic('ATL1101', 'Atlas catalog is not valid YAML.', {
        span: atlasSourceSpan(
          source,
          0,
          Math.min(1, source.length),
          options.sourcePath,
        ),
      }),
    ]);
  }

  const restyle = (node: unknown): void => {
    if (isScalar(node)) {
      if (typeof node.value !== 'string') return;
      if (
        node.type === Scalar.BLOCK_LITERAL ||
        node.type === Scalar.BLOCK_FOLDED
      ) {
        // A block scalar is a deliberate authorial choice about line structure. Collapsing it to
        // a quoted string would preserve the characters and lose the shape.
        return;
      }
      node.type = plainSafe(node.value)
        ? Scalar.PLAIN
        : node.value.includes("'") || /[\u0000-\u001f\u007f]/u.test(node.value)
          ? Scalar.QUOTE_DOUBLE
          : Scalar.QUOTE_SINGLE;
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        restyle(pair.key);
        restyle(pair.value);
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) restyle(item);
    }
  };
  restyle(document.contents);

  return atlasSuccess(
    document.toString({
      defaultKeyType: 'PLAIN',
      doubleQuotedAsJSON: true,
      indent: 2,
      lineWidth: 0,
      simpleKeys: true,
    }),
  );
}

/**
 * Write a catalog that does not exist yet, from the model.
 *
 * Correct only where there is no authored file to preserve: an interchange import creating a
 * target catalog for the first time. Anything editing a file a person wrote goes through
 * `formatAtlasCatalogSource`.
 */
export function formatAtlasCatalog(catalog: AtlasCatalog): string {
  const value = {
    messages: Object.fromEntries(
      Object.entries(catalog.messages).map(([messageId, message]) => [
        messageId,
        authoredMessage(message),
      ]),
    ),
    ...(Object.keys(catalog.families).length === 0
      ? {}
      : {
          families: Object.fromEntries(
            Object.entries(catalog.families).map(([name, family]) => [
              name,
              authoredFamily(family),
            ]),
          ),
        }),
  };
  return stringify(value, {
    defaultKeyType: 'PLAIN',
    defaultStringType: 'QUOTE_DOUBLE',
    doubleQuotedAsJSON: true,
    lineWidth: 0,
    simpleKeys: true,
  });
}
