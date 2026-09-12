/**
 * The interchange view of a catalog, and what has to survive the round trip.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 15 keeps authored YAML authoritative and makes
 * this a view of it, so an export carries the identity, the source fingerprint, the
 * MessageFormat structure and the typed contracts, and an import matches on protected identity
 * alone. Matching on wording or on file order would let a translation land on another message.
 */

import { parseCST, type CST } from 'messageformat/cst';

import type {
  AtlasCatalog,
  AtlasCatalogMessage,
  AtlasEmptyCatalogMessage,
  AtlasTextCatalogMessage,
} from './catalog.js';
import {
  digestAtlasCanonicalJson,
  type AtlasCanonicalJsonValue,
} from './canonical-json.js';
import {
  atlasDiagnostic,
  atlasFailure,
  atlasSuccess,
  type AtlasDiagnostic,
  type AtlasResult,
} from './diagnostics.js';
import { canonicalizeAtlasLocale } from './locales.js';
import { parseAtlasMessage } from './message-format.js';
import {
  ATLAS_TOOLKIT_EVENT_CODES,
  emitAtlasToolkitEvent,
  type AtlasToolkitObservabilityOptions,
} from './observability.js';
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';
import {
  isAtlasSafeStructuralText,
  isAtlasSafeXmlText,
} from './unicode-safety.js';
import { compareCodePoint } from './sorted-records.js';
import { escapeXml } from './xml-text.js';

/**
 * The Atlas XLIFF profile, bumped to `/3` when the output was first run through the schema.
 *
 * A bump marks a wire format an older importer must not quietly accept. The profile is written into
 * every unit's contract, which is what makes the refusal specific: an older document is rejected as
 * the wrong profile rather than as a malformed one.
 *
 * `/1` declared `urn:oasis:names:tc:xliff:document:2.0` alongside `version="2.2"`, a pairing that
 * belongs to no schema. `/2` corrected the namespace and was still invalid against it in three
 * ways, none of which anything could have noticed, because no schema had ever been run over the
 * output: XLIFF 2.2 Core types every `id` as `xs:NMTOKEN` and Atlas wrote `@example/app:shell`
 * there, and it put `atlas:empty` on `<source>` and `<target>`, the two elements inside a unit that
 * admit no foreign attributes at all. `/3` corrects both and carries a message's placeholders as
 * inline codes rather than as raw MessageFormat text a translator can delete by accident.
 */
export const ATLAS_XLIFF_PROFILE = 'atlas-xliff-2.2/3' as const;

/**
 * Categories Atlas puts on the notes it authors.
 *
 * `category` is free text in XLIFF 2.2, so the prefix is what keeps an Atlas note distinguishable
 * from a note a translator or a translation-management system wrote. Atlas reads back only its own.
 */
const ATLAS_NOTE_DESCRIPTION = 'atlas:description' as const;
const ATLAS_NOTE_CONTEXT = 'atlas:context' as const;

/**
 * The refinement of `state="translated"` that says the translation is deliberately the empty
 * string rather than a blank nobody filled in.
 *
 * `subState` rather than an `atlas:empty` attribute on `<source>` and `<target>`. Those two
 * elements carry no `anyAttribute`, so a document carrying that attribute is schema-invalid.
 * `subState` is XLIFF's own extension point for exactly this, a prefixed refinement of the
 * segment's state, so the flag lands next to the `state` it refines, in the part of the document a
 * translation tool already understands, and needs no Atlas namespace to say it.
 */
const ATLAS_SEGMENT_SUBSTATE_EMPTY = 'atlas:empty' as const;

/**
 * XLIFF 2.2 Core §3.2.2.6: the `state` attribute belongs to `<segment>`, takes one of exactly
 * these four values, and defaults to `initial`.
 */
const XLIFF_SEGMENT_STATES = Object.freeze(
  new Set(['initial', 'translated', 'reviewed', 'final']),
);
/**
 * XLIFF 2.2's core namespace, which is version-stamped: the 2.2 core schema declares
 * `targetNamespace="urn:oasis:names:tc:xliff:document:2.2"`, and its `version` attribute admits
 * 2.0, 2.1 and 2.2. Atlas paired the `:2.0` namespace with `version="2.2"`, which belongs to no
 * schema, so every exported document validated against neither.
 *
 * The metadata module namespace below keeps its `:2.0` designation, because XLIFF 2.2 leaves it
 * there. Moving it with the core namespace is the plausible over-correction and it would make the
 * metadata module unrecognised.
 */
export const ATLAS_XLIFF_NAMESPACE =
  'urn:oasis:names:tc:xliff:document:2.2' as const;
export const ATLAS_XLIFF_METADATA_NAMESPACE =
  'urn:oasis:names:tc:xliff:metadata:2.0' as const;

/** What to hand a translation tool: the authored catalog, and whatever has been translated so far. */
export interface AtlasXliffExportRequest extends AtlasToolkitObservabilityOptions {
  /** The authored catalog, which is what fixes each unit's identity and contract. */
  readonly source: AtlasCatalog;
  /** The existing translation, so work already done comes back in the document rather than blank. */
  readonly target?: AtlasCatalog;
  /** Which locale the document is for. Taken from the target catalog when one is given. */
  readonly targetLocale?: string;
}

/** What to read a returned translation against, which is always the catalog it was exported from. */
export interface AtlasXliffImportRequest extends AtlasToolkitObservabilityOptions {
  /** The returned document, as text. */
  readonly document: string;
  /** The authored catalog the export was made from, which is what each unit is matched against. */
  readonly source: AtlasCatalog;
  /** Which locale to read it as. Taken from the document when it is not given. */
  readonly targetLocale?: string;
  /** Where the document came from, carried into every diagnostic about it. */
  readonly sourcePath?: string;
}

/**
 * A parsed element, carrying its namespace rather than the prefix it happened to be written with.
 *
 * `name` is the qualified name as authored and exists for diagnostics. Every structural comparison
 * uses `namespace` and `localName`, because a prefix is a local choice of whoever serialized the
 * document: `mda:metadata` and `m:metadata` are the same element, and a document that binds `mda:`
 * to something else entirely is a different one. Comparing the authored string accepts Atlas's own
 * output and rejects conformant documents that spell the prefixes differently.
 *
 * `scope` is the in-scope prefix binding at this element, kept because an attribute's prefix has to
 * be resolved against the element that carries it.
 */
interface XmlElement {
  readonly name: string;
  readonly namespace: string | undefined;
  readonly localName: string;
  readonly scope: NamespaceScope;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly (XmlElement | string)[];
}

interface MutableXmlElement {
  readonly name: string;
  readonly namespace: string | undefined;
  readonly localName: string;
  readonly scope: NamespaceScope;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: (XmlElement | string)[];
}

/** Prefix to namespace URI, with the empty prefix holding the default namespace. */
type NamespaceScope = ReadonlyMap<string, string>;

/** Bound by the XML specification itself and never declared, so it seeds every scope. */
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace' as const;

const ROOT_NAMESPACE_SCOPE: NamespaceScope = Object.freeze(
  new Map([
    ['', ''],
    ['xml', XML_NAMESPACE],
  ]),
);

/**
 * How a unit carries its message.
 *
 * `inline` is the pattern as XLIFF inline codes over `<originalData>`: literal text is text a
 * translator edits, and every placeholder is an element they can move but not retype. `flat` is the
 * MessageFormat source as a single run of text, which is all a unit can be without inline codes.
 *
 * `.match` messages are still `flat`, because a unit holds one pattern and a `.match` message is
 * several. Carrying them properly needs the plural/gender select module and a group of units, which
 * is a change of its own.
 *
 * The unit records which one it uses rather than leaving it to be sniffed from the content, because
 * the two are not distinguishable by looking: a target that is plain text is either flat
 * MessageFormat or an inline pattern whose codes a translator deleted, and those two readings
 * differ by exactly the failure this profile is meant to catch.
 */
type XliffRepresentation = 'inline' | 'flat';

interface XliffUnitContract {
  readonly profile: typeof ATLAS_XLIFF_PROFILE;
  readonly identity: string;
  readonly messageId: string;
  readonly representation: XliffRepresentation;
  readonly sourceFingerprint: string;
}

/**
 * XML 1.0 (Fifth Edition) §2.3 NameChar, one or more of which is an `xs:NMTOKEN`.
 *
 * Every `id` in XLIFF 2.2 Core is typed `xs:NMTOKEN`. `@` and `/` are not NameChars and an Atlas
 * provider identity is spelled `@scope/name`, so `@example/app:shell` on the file and
 * `@example/app:shell:greeting` on every unit made each exported document invalid before anything
 * else in it was considered.
 *
 * Writing the production out is safe here in a way that writing out a Unicode property is not: this
 * is a grammar in a specification that has not moved since 2008, with no data release behind it to
 * drift away from.
 */
const XML_NMTOKEN =
  /^[-.0-9:A-Z_a-z\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C\u200D\u203F\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]+$/u;

/**
 * The XLIFF id for a catalog's `<file>`.
 *
 * `providerId:scopeId` is the Atlas identity and cannot be an NMTOKEN, so the leading `@` goes and
 * the `/` becomes `:`. That is injective over the Atlas identity grammars (a provider is
 * `@scope/name` or `name`, and no part of either may contain a `:`), which is what matters,
 * because XLIFF requires file ids to be unique within the document and a translation-management
 * system may hold several Atlas catalogs in one.
 *
 * Nothing reads the identity back out of this. The unit contract carries it verbatim, and the
 * importer derives the id from the catalog it was handed rather than parsing it out of the
 * document.
 */
function xliffFileId(catalog: AtlasCatalog): string {
  return `${catalog.providerId.replaceAll('@', '').replaceAll('/', ':')}:${catalog.scopeId}`;
}

function decodeXml(value: string): string | undefined {
  if (/&(?!#x[0-9A-Fa-f]+;|#[0-9]+;|amp;|lt;|gt;|quot;|apos;)/u.test(value)) {
    return undefined;
  }
  let valid = true;
  // Cleared inside the replacement below, which is an assignment the compiler cannot order
  // against a plain read of the variable.
  const stayedValid = (): boolean => valid;
  const decoded = value.replace(
    /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gu,
    (
      _match,
      hex: string | undefined,
      decimal: string | undefined,
      named: string | undefined,
    ) => {
      if (named !== undefined) {
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[
          named
        ] as string;
      }
      const codePoint = Number.parseInt(
        hex ?? (decimal as string),
        hex === undefined ? 10 : 16,
      );
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        valid = false;
        return '';
      }
      return String.fromCodePoint(codePoint);
    },
  );
  if (!stayedValid() || !isAtlasSafeXmlText(decoded)) {
    return undefined;
  }
  return decoded;
}

function parseAttributes(source: string):
  | {
      readonly attributes: Readonly<Record<string, string>>;
      readonly count: number;
    }
  | undefined {
  const attributes: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? '')) index += 1;
    if (index >= source.length) break;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(source.slice(index));
    if (nameMatch === null) return undefined;
    const name = nameMatch[0];
    if (Object.hasOwn(attributes, name)) return undefined;
    if (
      Object.keys(attributes).length >=
      ATLAS_RESOURCE_LIMITS.xliffAttributesPerElement
    ) {
      return undefined;
    }
    index += name.length;
    while (/\s/u.test(source[index] ?? '')) index += 1;
    if (source[index] !== '=') return undefined;
    index += 1;
    while (/\s/u.test(source[index] ?? '')) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") return undefined;
    index += 1;
    const end = source.indexOf(quote, index);
    if (end < 0) return undefined;
    const value = decodeXml(source.slice(index, end));
    if (value === undefined) return undefined;
    attributes[name] = value;
    index = end + 1;
  }
  return Object.freeze({
    attributes: Object.freeze(attributes),
    count: Object.keys(attributes).length,
  });
}

function readTag(
  source: string,
  start: number,
): { readonly token: string; readonly end: number } | undefined {
  let quote: string | undefined;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] as string;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      if (index - start + 1 > ATLAS_RESOURCE_LIMITS.xliffTagBytes) {
        return undefined;
      }
      return { token: source.slice(start, index + 1), end: index + 1 };
    }
  }
  return undefined;
}

function parseXml(document: string): AtlasResult<XmlElement> {
  if (Buffer.byteLength(document, 'utf8') > ATLAS_RESOURCE_LIMITS.xliffBytes) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1801',
        'XLIFF document exceeds the Atlas byte ceiling.',
      ),
    ]);
  }
  const stack: MutableXmlElement[] = [];
  let root: XmlElement | undefined;
  let nodes = 0;
  let index = 0;
  if (document.charCodeAt(0) === 0xfeff) index = 1;
  const fail = (summary: string): AtlasResult<XmlElement> =>
    atlasFailure([atlasDiagnostic('ATL1801', summary)]);

  while (index < document.length) {
    if (document[index] !== '<') {
      const end = document.indexOf('<', index);
      const boundary = end < 0 ? document.length : end;
      const text = decodeXml(document.slice(index, boundary));
      if (text === undefined)
        return fail('XLIFF contains malformed or unsafe XML text.');
      if (text.length > 0) {
        nodes += 1;
        if (nodes > ATLAS_RESOURCE_LIMITS.xliffNodes)
          return fail('XLIFF exceeds the Atlas node ceiling.');
        const parent = stack.at(-1);
        if (parent === undefined) {
          if (/\S/u.test(text))
            return fail('XLIFF contains text outside its root element.');
        } else {
          parent.children.push(text);
        }
      }
      index = boundary;
      continue;
    }
    if (document.startsWith('<!--', index)) {
      const end = document.indexOf('-->', index + 4);
      const comment = end < 0 ? '' : document.slice(index + 4, end);
      if (
        end < 0 ||
        comment.includes('--') ||
        !isAtlasSafeStructuralText(comment)
      ) {
        return fail('XLIFF contains an invalid XML comment.');
      }
      nodes += 1;
      if (nodes > ATLAS_RESOURCE_LIMITS.xliffNodes)
        return fail('XLIFF exceeds the Atlas node ceiling.');
      index = end + 3;
      continue;
    }
    if (document.startsWith('<![CDATA[', index)) {
      const end = document.indexOf(']]>', index + 9);
      const parent = stack.at(-1);
      if (end < 0 || parent === undefined)
        return fail('XLIFF contains invalid CDATA.');
      const text = document.slice(index + 9, end);
      if (!isAtlasSafeXmlText(text))
        return fail('XLIFF CDATA contains invalid or unsafe Unicode.');
      nodes += 1;
      if (nodes > ATLAS_RESOURCE_LIMITS.xliffNodes)
        return fail('XLIFF exceeds the Atlas node ceiling.');
      parent.children.push(text);
      index = end + 3;
      continue;
    }
    if (document.startsWith('<?xml', index)) {
      const declaration =
        /^<\?xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])UTF-8\2)?(?:\s+standalone=(["'])(?:yes|no)\3)?\s*\?>/iu.exec(
          document.slice(index),
        );
      if (
        declaration === null ||
        index !== (document.charCodeAt(0) === 0xfeff ? 1 : 0) ||
        root !== undefined ||
        stack.length !== 0
      ) {
        return fail('XLIFF contains an invalid or misplaced XML declaration.');
      }
      index += declaration[0].length;
      continue;
    }
    if (document.startsWith('<!', index) || document.startsWith('<?', index)) {
      return fail(
        'XLIFF cannot contain DTDs, entities, or processing instructions.',
      );
    }
    const tag = readTag(document, index);
    if (tag === undefined) return fail('XLIFF contains an incomplete XML tag.');
    const inner = tag.token.slice(1, -1).trim();
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const element = stack.pop();
      if (element === undefined || name !== element.name) {
        return fail('XLIFF XML elements are not correctly nested.');
      }
      const frozen = Object.freeze({
        ...element,
        children: Object.freeze(element.children),
      });
      const parent = stack.at(-1);
      if (parent === undefined) {
        if (root !== undefined)
          return fail('XLIFF must contain one root element.');
        root = frozen;
      } else {
        parent.children.push(frozen);
      }
    } else {
      const selfClosing = inner.endsWith('/');
      const content = selfClosing ? inner.slice(0, -1).trimEnd() : inner;
      const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(content);
      if (nameMatch === null)
        return fail('XLIFF contains an invalid element name.');
      const name = nameMatch[0];
      const parsedAttributes = parseAttributes(content.slice(name.length));
      if (parsedAttributes === undefined)
        return fail('XLIFF contains invalid attributes.');
      nodes += 1 + parsedAttributes.count;
      if (nodes > ATLAS_RESOURCE_LIMITS.xliffNodes)
        return fail('XLIFF exceeds the Atlas node ceiling.');
      if (stack.length + 1 > ATLAS_RESOURCE_LIMITS.xliffDepth)
        return fail('XLIFF exceeds the Atlas depth ceiling.');
      const scope = namespaceScope(
        stack.at(-1)?.scope ?? ROOT_NAMESPACE_SCOPE,
        parsedAttributes.attributes,
      );
      const element: MutableXmlElement = {
        name,
        ...qualifiedName(name, scope, scope.get('') ?? ''),
        scope,
        attributes: parsedAttributes.attributes,
        children: [],
      };
      if (selfClosing) {
        const frozen = Object.freeze({
          ...element,
          children: Object.freeze([]),
        });
        const parent = stack.at(-1);
        if (parent === undefined) {
          if (root !== undefined)
            return fail('XLIFF must contain one root element.');
          root = frozen;
        } else {
          parent.children.push(frozen);
        }
      } else {
        stack.push(element);
      }
    }
    index = tag.end;
  }
  if (stack.length > 0 || root === undefined)
    return fail('XLIFF XML is incomplete.');
  return atlasSuccess(root);
}

/**
 * The scope in force inside `element`, given the scope outside it and its own declarations.
 *
 * Returns the parent scope unchanged when nothing is declared, so an unremarkable document shares
 * one map for its whole depth rather than copying a map per element.
 */
function namespaceScope(
  parent: NamespaceScope,
  attributes: Readonly<Record<string, string>>,
): NamespaceScope {
  let declared: Map<string, string> | undefined;
  for (const [name, value] of Object.entries(attributes)) {
    if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
    declared ??= new Map(parent);
    declared.set(name === 'xmlns' ? '' : name.slice('xmlns:'.length), value);
  }
  return declared === undefined ? parent : Object.freeze(declared);
}

function qualifiedName(
  name: string,
  scope: NamespaceScope,
  prefixless: string | undefined,
): { readonly namespace: string | undefined; readonly localName: string } {
  const separator = name.indexOf(':');
  if (separator < 0) return { namespace: prefixless, localName: name };
  return {
    // An unbound prefix resolves to no namespace rather than to the prefix text, so a document
    // that uses `mda:` without declaring it matches nothing instead of matching by coincidence.
    namespace: scope.get(name.slice(0, separator)),
    localName: name.slice(separator + 1),
  };
}

function childElements(
  element: XmlElement,
  namespace: string,
  localName: string,
): readonly XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement =>
      typeof child !== 'string' &&
      child.namespace === namespace &&
      child.localName === localName,
  );
}

/**
 * The text of an element that is supposed to hold only text.
 *
 * Notes, metadata and `<data>` are text and nothing else, so an element child is not something to
 * interpret: it is a document Atlas does not understand, and saying so is the whole job. Nothing
 * is flattened here through an `equiv` attribute, which would read a `<note>` holding a `<pc>` as
 * if the code were text. The codes inside a `<source>` or `<target>` are read by `patternText`,
 * where the original data is in scope and the reading can be checked.
 */
function textContent(element: XmlElement): string | undefined {
  const chunks: string[] = [];
  let bytes = 0;
  for (const child of element.children) {
    if (typeof child !== 'string') return undefined;
    bytes += Buffer.byteLength(child, 'utf8');
    if (bytes > ATLAS_RESOURCE_LIMITS.messageBytes) return undefined;
    chunks.push(child);
  }
  return chunks.join('');
}

/**
 * A unit's `<originalData>` as id to original text.
 *
 * `undefined` means the element is not one Atlas can read (two of them, a duplicate id, a `<cp>`
 * child) and the unit is refused rather than half-read.
 */
function originalData(
  unit: XmlElement,
): ReadonlyMap<string, string> | undefined {
  const containers = childElements(unit, ATLAS_XLIFF_NAMESPACE, 'originalData');
  if (containers.length > 1) return undefined;
  const data = new Map<string, string>();
  if (containers.length === 0) return data;
  for (const entry of childElements(
    containers[0] as XmlElement,
    ATLAS_XLIFF_NAMESPACE,
    'data',
  )) {
    const id = entry.attributes['id'];
    const value = textContent(entry);
    if (id === undefined || value === undefined || data.has(id)) {
      return undefined;
    }
    data.set(id, value);
  }
  return data;
}

/**
 * The original text one inline code stands for.
 *
 * Atlas writes `dataRef` into `<originalData>`, because a conformant XML parser normalizes the
 * newlines in an attribute value to spaces and a declaration block has newlines in it. A document
 * from somewhere else may carry the text in `equiv` instead, which is a legal thing to do and is
 * read here rather than refused: it just cannot be what Atlas writes.
 */
function codeText(
  element: XmlElement,
  data: ReadonlyMap<string, string>,
  dataAttribute: string,
  equivalentAttribute: string,
): string | undefined {
  const reference = element.attributes[dataAttribute];
  if (reference !== undefined) return data.get(reference);
  return element.attributes[equivalentAttribute];
}

/**
 * Literal text, escaped so that it survives being put back into a MessageFormat pattern.
 *
 * The XML carries the translator's text as text: a brace they typed is a brace, not the start of a
 * placeholder. Escaping on the way in is what makes that true, and it is why the codes have to be
 * elements: a placeholder written as text would be escaped into a literal by this line.
 */
function escapeMessageFormatText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}');
}

interface XliffPatternText {
  readonly text: string;
  readonly codes: readonly string[];
}

/**
 * A `<source>` or `<target>` in the inline representation, back as MessageFormat text.
 *
 * Text becomes escaped literal text and each code becomes the original text it stands for, so the
 * result is the message the translator produced with every placeholder exactly as it was authored.
 * The codes are collected on the way through, keyed the same way `inlineContent` keys them, so the
 * caller can ask whether the translation still carries all of them.
 */
function patternText(
  element: XmlElement,
  data: ReadonlyMap<string, string>,
): XliffPatternText | undefined {
  const codes: string[] = [];
  const nextKey = codeKeys();
  let nodes = 0;
  let opensWithText = true;
  // Set inside the visit below, which is an assignment the compiler cannot order against a plain
  // read of the variable.
  const openedWithText = (): boolean => opensWithText;
  let first = true;
  const visit = (parent: XmlElement): string | undefined => {
    const chunks: string[] = [];
    for (const child of parent.children) {
      nodes += 1;
      if (nodes > ATLAS_RESOURCE_LIMITS.xliffNodes) return undefined;
      if (typeof child === 'string') {
        if (first) {
          first = false;
          opensWithText = true;
        }
        chunks.push(escapeMessageFormatText(child));
        continue;
      }
      if (first) {
        first = false;
        opensWithText = false;
      }
      if (child.namespace !== ATLAS_XLIFF_NAMESPACE) return undefined;
      if (child.localName === 'ph') {
        const value = codeText(child, data, 'dataRef', 'equiv');
        if (value === undefined || child.children.length > 0) return undefined;
        codes.push(nextKey(value));
        chunks.push(value);
        continue;
      }
      if (child.localName !== 'pc') return undefined;
      const start = codeText(child, data, 'dataRefStart', 'equivStart');
      const end = codeText(child, data, 'dataRefEnd', 'equivEnd');
      if (start === undefined || end === undefined) return undefined;
      const inner = visit(child);
      if (inner === undefined) return undefined;
      codes.push(nextKey(`${start}${CODE_KEY_SEPARATOR}${end}`));
      chunks.push(`${start}${inner}${end}`);
    }
    return chunks.join('');
  };
  const body = visit(element);
  if (body === undefined) return undefined;
  if (Buffer.byteLength(body, 'utf8') > ATLAS_RESOURCE_LIMITS.messageBytes) {
    return undefined;
  }
  // A simple MessageFormat message cannot begin with `.`, because that is how a complex one begins,
  // and no escape exists for it. A translation that opens with a period is otherwise perfectly
  // ordinary, so it goes back in the quoted-pattern form rather than being refused. A pattern that
  // opens with a code (which includes every message that had declarations, since those arrive
  // wrapped in a paired code) already begins legally and is left alone.
  const quote = openedWithText() && body.startsWith('.');
  return { text: quote ? `{{${body}}}` : body, codes };
}

function messageIdentity(catalog: AtlasCatalog, messageId: string): string {
  return `${catalog.providerId}:${catalog.scopeId}:${messageId}`;
}

function sourceFingerprint(
  catalog: AtlasCatalog,
  messageId: string,
  message: AtlasCatalogMessage,
): string {
  const portableContracts = JSON.parse(
    JSON.stringify({ inputs: message.inputs, slots: message.slots }),
  ) as Readonly<{
    readonly inputs: AtlasCanonicalJsonValue;
    readonly slots: AtlasCanonicalJsonValue;
  }>;
  return digestAtlasCanonicalJson('atlas-xliff-source-message/1', {
    identity: messageIdentity(catalog, messageId),
    kind: message.kind,
    source:
      message.kind === 'message' ? message.semantics.canonicalSource : null,
    inputs: portableContracts.inputs,
    slots: portableContracts.slots,
  });
}

function unitContract(
  source: AtlasCatalog,
  messageId: string,
  message: AtlasCatalogMessage,
  representation: XliffRepresentation,
): XliffUnitContract {
  return Object.freeze({
    profile: ATLAS_XLIFF_PROFILE,
    identity: messageIdentity(source, messageId),
    messageId,
    representation,
    sourceFingerprint: sourceFingerprint(source, messageId, message),
  });
}

function contractText(contract: XliffUnitContract): string {
  return JSON.stringify(contract);
}

function unitMetadata(contract: XliffUnitContract): string {
  return [
    '      <mda:metadata>',
    '        <mda:metaGroup category="atlas:unit">',
    `          <mda:meta type="atlas:contract">${escapeXml(contractText(contract))}</mda:meta>`,
    '        </mda:metaGroup>',
    '      </mda:metadata>',
  ].join('\n');
}

function noteElement(
  id: string,
  category: string,
  appliesTo: 'source' | 'target',
  text: string,
): string {
  return `        <note id="${id}" category="${category}" appliesTo="${appliesTo}">${escapeXml(text)}</note>`;
}

/**
 * Translator guidance, as XLIFF Core notes.
 *
 * `specs/01-standards-profile.spec.md` section 12 requires the mapping to preserve notes and
 * context. Until now `description` and `context` were parsed from YAML, carried through the
 * compiled model, and dropped at the one boundary where a translator would ever read them: the
 * message went out with no explanation of what it means or where it appears.
 *
 * Source guidance and target guidance are separate notes rather than one merged blob, because they
 * answer to different owners: the source note is Atlas's authored explanation of the message, and
 * the target note is whatever the target catalog itself says about its own translation.
 *
 * Emitted only when the data exists, per `specs/01-standards-profile.spec.md` section 11.
 */
function unitNotes(
  source: AtlasCatalogMessage,
  target: AtlasCatalogMessage | undefined,
): readonly string[] {
  const notes = [
    ...(source.description === undefined
      ? []
      : [
          noteElement(
            'atlas-source-description',
            ATLAS_NOTE_DESCRIPTION,
            'source',
            source.description,
          ),
        ]),
    ...(source.context === undefined
      ? []
      : [
          noteElement(
            'atlas-source-context',
            ATLAS_NOTE_CONTEXT,
            'source',
            source.context,
          ),
        ]),
    ...(target?.description === undefined
      ? []
      : [
          noteElement(
            'atlas-target-description',
            ATLAS_NOTE_DESCRIPTION,
            'target',
            target.description,
          ),
        ]),
    ...(target?.context === undefined
      ? []
      : [
          noteElement(
            'atlas-target-context',
            ATLAS_NOTE_CONTEXT,
            'target',
            target.context,
          ),
        ]),
  ];
  return notes.length === 0
    ? []
    : ['      <notes>', ...notes, '      </notes>'];
}

/**
 * Ids for a unit's inline codes and original data, minted from the source and reused by the target.
 *
 * XLIFF matches a code in the target to the one in the source by id, so the two sides cannot be
 * numbered independently. The source mints; the target looks up. A code the target uses and the
 * source does not have is a placeholder somebody introduced while translating, and it gets no id at
 * all: the export refuses, because an invented id matches nothing on the way back.
 *
 * Codes are keyed by their MessageFormat text together with which occurrence of that text they are,
 * because `{$name}` twice in one message is two codes and XLIFF requires their ids to differ. Data
 * is keyed by text alone: `<originalData>` is a pool and two codes may share an entry.
 */
interface XliffCodeTable {
  readonly codeIds: Map<string, string>;
  readonly dataIds: Map<string, string>;
  readonly dataOrder: string[];
}

function codeTable(): XliffCodeTable {
  return { codeIds: new Map(), dataIds: new Map(), dataOrder: [] };
}

function dataIdFor(
  table: XliffCodeTable,
  text: string,
  mint: boolean,
): string | undefined {
  const existing = table.dataIds.get(text);
  if (existing !== undefined || !mint) return existing;
  const id = `d${table.dataOrder.length}`;
  table.dataIds.set(text, id);
  table.dataOrder.push(text);
  return id;
}

function codeIdFor(
  table: XliffCodeTable,
  key: string,
  mint: boolean,
): string | undefined {
  const existing = table.codeIds.get(key);
  if (existing !== undefined || !mint) return existing;
  const id = `c${table.codeIds.size}`;
  table.codeIds.set(key, id);
  return id;
}

/** The separator inside a code key. It cannot occur in a message: `isAtlasSafeXmlText` forbids it. */
const CODE_KEY_SEPARATOR = '\u0000';

/** The MessageFormat text a code key was built from, for a diagnostic a human has to read. */
function codeKeyText(key: string): string {
  return key.split(CODE_KEY_SEPARATOR).slice(1).join(' ... ');
}

/** Counts occurrences so that the second `{$name}` in a pattern is a different code from the first. */
function codeKeys(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const occurrence = seen.get(text) ?? 0;
    seen.set(text, occurrence + 1);
    return `${occurrence}${CODE_KEY_SEPARATOR}${text}`;
  };
}

interface XliffInlineContent {
  /** The children of `<source>` or `<target>`, already XML-escaped. */
  readonly xml: string;
  /** Every code this content uses, in the order the codes close. */
  readonly codes: readonly string[];
}

type XliffPatternCst = CST.SimpleMessage | CST.ComplexMessage;

/**
 * A message's pattern as XLIFF inline content.
 *
 * The exact source text of every placeholder goes to `<originalData>` and the element refers to it
 * by `dataRef`, rather than carrying it in an `equiv` attribute. That is not a style choice: a
 * conformant XML parser normalizes newlines in an attribute value to spaces, and a declaration
 * block has newlines in it, so an attribute would corrupt exactly the messages that need this most.
 *
 * A quoted pattern (anything with declarations, and anything authored as `{{...}}`) becomes a
 * paired code wrapping the whole content, whose two halves are the text before `{{` and the `}}`.
 * That is what a paired code is for, and it means a translator cannot lose the declarations without
 * losing a code the reader will notice is missing.
 *
 * Returns `undefined` when the markup does not nest, or, when looking ids up rather than minting
 * them, when the content uses a code the source does not have.
 */
function inlineContent(
  source: string,
  cst: XliffPatternCst,
  table: XliffCodeTable,
  mint: boolean,
): XliffInlineContent | undefined {
  const parts: string[] = [];
  const open: { readonly text: string; readonly children: string[] }[] = [];
  const codes: string[] = [];
  const nextKey = codeKeys();
  const emit = (xml: string): void => {
    (open.at(-1)?.children ?? parts).push(xml);
  };
  const paired = (
    startText: string,
    endText: string,
    children: string,
  ): string | undefined => {
    const key = nextKey(`${startText}${CODE_KEY_SEPARATOR}${endText}`);
    const id = codeIdFor(table, key, mint);
    const startData = dataIdFor(table, startText, mint);
    const endData = dataIdFor(table, endText, mint);
    if (id === undefined || startData === undefined || endData === undefined) {
      return undefined;
    }
    codes.push(key);
    return `<pc id="${id}" dataRefStart="${startData}" dataRefEnd="${endData}">${children}</pc>`;
  };
  for (const node of cst.pattern.body) {
    if (node.type === 'text') {
      emit(escapeXml(node.value));
      continue;
    }
    const text = source.slice(node.start, node.end);
    const markup = node.markup;
    if (
      markup !== undefined &&
      markup.open.value === '#' &&
      markup.close === undefined
    ) {
      open.push({ text, children: [] });
      continue;
    }
    if (markup !== undefined && markup.open.value === '/') {
      const started = open.pop();
      if (started === undefined) return undefined;
      const element = paired(started.text, text, started.children.join(''));
      if (element === undefined) return undefined;
      emit(element);
      continue;
    }
    const key = nextKey(text);
    const id = codeIdFor(table, key, mint);
    const data = dataIdFor(table, text, mint);
    if (id === undefined || data === undefined) return undefined;
    codes.push(key);
    emit(`<ph id="${id}" dataRef="${data}"/>`);
  }
  if (open.length > 0) return undefined;
  const braces = cst.pattern.braces;
  const body = parts.join('');
  if (braces === undefined) return { xml: body, codes };
  const startText = source.slice(0, braces[0].end);
  const closing = braces[1];
  const endText =
    closing === undefined ? '}}' : source.slice(closing.start, closing.end);
  const element = paired(startText, endText, body);
  if (element === undefined) return undefined;
  return { xml: element, codes };
}

/** The pattern CST of a message, or `'select'` for the one shape a single unit cannot hold. */
function patternCst(cst: CST.Message): XliffPatternCst | 'select' {
  return cst.type === 'select' ? 'select' : cst;
}

/** A markup or function name, namespace included, as it was written. */
function identifierText(identifier: CST.Identifier): string {
  const parts: readonly { readonly value: string }[] = identifier;
  return parts.map((part) => part.value).join('');
}

/**
 * The inputs a message renders, one entry per distinct input.
 *
 * A value reaches the text through an expression's operand, through a variable-valued option, or
 * through markup. A `.local` declaration renames one, so a local resolves to whatever it was
 * declared from, and a translation that reaches the same input under its own name has lost nothing.
 *
 * Selectors are deliberately not inputs. `.match $count` decides which variant renders, it does not
 * render `$count`. A translation that selects on a value and prints it nowhere has dropped it, and
 * counting the selector would hide exactly that.
 *
 * Function names, literal operands and literal options are not inputs either. `:number` carrying
 * different options per locale is what localizing a number looks like, not a defect.
 */
function renderedInputs(cst: CST.Message): readonly string[] {
  const locals = new Map<string, CST.Expression>();
  for (const declaration of cst.declarations ?? []) {
    if (declaration.type !== 'local') continue;
    const { target, value } = declaration;
    if (target.type !== 'variable' || value.type !== 'expression') continue;
    if (!locals.has(target.name)) locals.set(target.name, value);
  }
  const inputs = new Set<string>();
  const read = (
    expression: CST.Expression,
    seen: ReadonlySet<string>,
  ): void => {
    const names: string[] = [];
    const markup = expression.markup;
    if (markup !== undefined) {
      inputs.add(`#${identifierText(markup.name)}`);
      for (const option of markup.options) {
        if (option.value.type === 'variable') names.push(option.value.name);
      }
    } else {
      const operand = expression.arg;
      if (operand !== undefined && operand.type === 'variable') {
        names.push(operand.name);
      }
      const call = expression.functionRef;
      if (call !== undefined && call.type === 'function') {
        for (const option of call.options) {
          if (option.value.type === 'variable') names.push(option.value.name);
        }
      }
    }
    for (const name of names) {
      const local = locals.get(name);
      if (local === undefined || seen.has(name)) {
        inputs.add(`$${name}`);
        continue;
      }
      read(local, new Set([...seen, name]));
    }
  };
  const patterns =
    cst.type === 'select'
      ? cst.variants.map((variant) => variant.value)
      : [cst.pattern];
  for (const pattern of patterns) {
    for (const node of pattern.body) {
      if (node.type === 'expression') read(node, new Set());
    }
  }
  return [...inputs];
}

/**
 * The inputs a source message renders that its translation renders nowhere.
 *
 * This is the flat representation's placeholder check, and it is deliberately coarser than the
 * inline one. A message with variants is compared across all of its variants at once, because a
 * variant legitimately omits a placeholder the others carry, `zero {{You deleted no files.}}` is
 * a correct translation, and because two locales do not have the same variants to line up: six
 * in Arabic against two in English. Comparing variant against variant would need the translation's
 * variants keyed to the source's, which is structure the flat representation does not have.
 *
 * What survives the coarsening is the case that matters most, and the one nothing else catches: a
 * `{$count}` the translation dropped from every variant, which reaches production as a sentence
 * missing its number and parses perfectly on the way there.
 *
 * Only losses are compared. A translation selecting on an input the source never mentions is
 * normal, a gendered language needs `$gender` where English needs nothing, and selectors are
 * outside the comparison already. Whether a translation may go further and *render* an input the
 * source does not is a separate question with a separate answer, because it turns on what the
 * runtime supplies rather than on what the document holds, and this check does not decide it.
 */
function droppedInputs(
  source: CST.Message,
  target: CST.Message,
): readonly string[] {
  const rendered = renderedInputs(target);
  return renderedInputs(source).filter((input) => !rendered.includes(input));
}

/** The codes a source message expects its translation to carry, in closing order. */
function sourceCodes(message: AtlasCatalogMessage): readonly string[] {
  if (message.kind !== 'message') return [];
  const cst = patternCst(parseCST(message.message));
  if (cst === 'select') return [];
  return inlineContent(message.message, cst, codeTable(), true)?.codes ?? [];
}

interface XliffUnitContent {
  readonly representation: XliffRepresentation;
  readonly originalData: readonly string[];
  readonly source: string;
  readonly target: string | undefined;
}

function originalDataElement(table: XliffCodeTable): readonly string[] {
  if (table.dataOrder.length === 0) return [];
  return [
    '      <originalData>',
    ...table.dataOrder.map(
      (text) =>
        `        <data id="${table.dataIds.get(text) as string}" xml:space="preserve">${escapeXml(text)}</data>`,
    ),
    '      </originalData>',
  ];
}

function unitContent(
  messageId: string,
  source: AtlasCatalogMessage,
  target: AtlasCatalogMessage | undefined,
): AtlasResult<XliffUnitContent> {
  const sourceText = source.kind === 'message' ? source.message : undefined;
  const targetText =
    target !== undefined && target.kind === 'message'
      ? target.message
      : undefined;
  const sourceRoot =
    sourceText === undefined ? undefined : parseCST(sourceText);
  const targetRoot =
    targetText === undefined ? undefined : parseCST(targetText);
  const sourceCst =
    sourceRoot === undefined ? undefined : patternCst(sourceRoot);
  const targetCst =
    targetRoot === undefined ? undefined : patternCst(targetRoot);
  if (sourceCst === 'select' || targetCst === 'select') {
    const dropped =
      sourceRoot === undefined || targetRoot === undefined
        ? []
        : droppedInputs(sourceRoot, targetRoot);
    if (dropped.length > 0) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1802',
          `Translation of ${JSON.stringify(messageId)} never renders ${dropped.length} value(s) the source message renders: ${dropped.map((input) => JSON.stringify(input)).join(', ')}. A message with variants is compared across all of them together, so a value only has to appear in one of them.`,
          { path: ['messages', messageId] },
        ),
      ]);
    }
    return atlasSuccess(
      Object.freeze({
        representation: 'flat' as const,
        originalData: [],
        source: sourceText === undefined ? '' : escapeXml(sourceText),
        target:
          target === undefined
            ? undefined
            : targetText === undefined
              ? ''
              : escapeXml(targetText),
      }),
    );
  }
  const table = codeTable();
  const inlineSource =
    sourceText === undefined || sourceCst === undefined
      ? { xml: '', codes: [] as readonly string[] }
      : inlineContent(sourceText, sourceCst, table, true);
  if (inlineSource === undefined) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        `Source message ${JSON.stringify(messageId)} has markup that does not nest, so it has no XLIFF inline representation.`,
        { path: ['messages', messageId] },
      ),
    ]);
  }
  const inlineTarget =
    targetText === undefined || targetCst === undefined
      ? undefined
      : inlineContent(targetText, targetCst, table, false);
  if (targetText !== undefined && inlineTarget === undefined) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        `Translation of ${JSON.stringify(messageId)} has a structure the source message does not: a placeholder or a pattern form the source does not have, or markup that does not nest.`,
        { path: ['messages', messageId] },
      ),
    ]);
  }
  if (inlineTarget !== undefined) {
    const missing = inlineSource.codes.filter(
      (key) => !inlineTarget.codes.includes(key),
    );
    if (missing.length > 0) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1802',
          `Translation of ${JSON.stringify(messageId)} drops ${missing.length} placeholder(s) the source message has: ${missing.map((key) => JSON.stringify(codeKeyText(key))).join(', ')}.`,
          { path: ['messages', messageId] },
        ),
      ]);
    }
  }
  return atlasSuccess(
    Object.freeze({
      representation: 'inline' as const,
      originalData: originalDataElement(table),
      source: inlineSource.xml,
      target: target === undefined ? undefined : (inlineTarget?.xml ?? ''),
    }),
  );
}

function exportAtlasXliff22Core(
  request: AtlasXliffExportRequest,
): AtlasResult<string> {
  const { source, target } = request;
  if (source.role !== 'source') {
    return atlasFailure([
      atlasDiagnostic('ATL1802', 'XLIFF export requires a source catalog.'),
    ]);
  }
  if (
    target !== undefined &&
    (target.role !== 'target' ||
      target.providerId !== source.providerId ||
      target.scopeId !== source.scopeId)
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        'XLIFF target catalog does not match the source authority and scope.',
      ),
    ]);
  }
  const targetLocaleValue = target?.locale ?? request.targetLocale;
  if (targetLocaleValue === undefined) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        'XLIFF export requires a target locale or target catalog.',
      ),
    ]);
  }
  const targetLocale = canonicalizeAtlasLocale(targetLocaleValue);
  if (!targetLocale.ok) return targetLocale;
  if (target !== undefined && target.locale !== targetLocale.value) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        'XLIFF target locale does not match the target catalog.',
      ),
    ]);
  }
  // Every `id` in XLIFF 2.2 Core is an `xs:NMTOKEN`, so the ids are checked rather than assumed.
  // The Atlas identity grammars cannot currently produce anything else once the provider's `@` and
  // `/` are folded away, but a grammar that widens later has to fail here, loudly and at the
  // point of export, instead of quietly writing a document no schema accepts.
  const fileId = xliffFileId(source);
  if (!XML_NMTOKEN.test(fileId)) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        `XLIFF file id ${JSON.stringify(fileId)} is not an xs:NMTOKEN, which XLIFF 2.2 Core requires.`,
      ),
    ]);
  }
  const units: string[] = [];
  for (const [messageId, sourceMessage] of Object.entries(source.messages).sort(
    ([left], [right]) => compareCodePoint(left, right),
  )) {
    if (!XML_NMTOKEN.test(messageId)) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1802',
          `XLIFF unit id ${JSON.stringify(messageId)} is not an xs:NMTOKEN, which XLIFF 2.2 Core requires.`,
          { path: ['messages', messageId] },
        ),
      ]);
    }
    const targetMessage = target?.messages[messageId];
    const content = unitContent(messageId, sourceMessage, targetMessage);
    if (!content.ok) return content;
    const contract = unitContract(
      source,
      messageId,
      sourceMessage,
      content.value.representation,
    );
    units.push(
      [
        // The unit id is the message id, not the full Atlas identity. It has to be an NMTOKEN and
        // the identity is not one; it only has to be unique inside its <file>, which a message id
        // in a single catalog is; and the identity is carried verbatim in the contract below, so
        // nothing is lost by not spelling it twice.
        `    <unit id="${escapeXml(messageId)}" name="${escapeXml(messageId)}">`,
        // XLIFF 2.2 Core §3.2.2.5 orders a unit's children: other-namespace elements, then
        // <notes>, then <originalData>, then segments. The metadata module comes first for that
        // reason, not by accident.
        unitMetadata(contract),
        ...unitNotes(sourceMessage, targetMessage),
        ...content.value.originalData,
        // `state` is an attribute of <segment> in XLIFF 2.2 Core §3.2.2.6, not of <target>, so a
        // document writing it there is non-conformant against the profile this package pins.
        targetMessage === undefined
          ? '      <segment>'
          : targetMessage.kind === 'empty'
            ? `      <segment state="translated" subState="${ATLAS_SEGMENT_SUBSTATE_EMPTY}">`
            : '      <segment state="translated">',
        `        <source xml:space="preserve">${content.value.source}</source>`,
        ...(targetMessage === undefined
          ? []
          : [
              `        <target xml:space="preserve">${content.value.target ?? ''}</target>`,
            ]),
        '      </segment>',
        '    </unit>',
      ].join('\n'),
    );
  }
  return atlasSuccess(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      // `xmlns:atlas` is gone with the attribute that needed it. Everything Atlas puts in a
      // document now goes either in the metadata module or in a `subState`, both of which are
      // XLIFF's own extension points, so the format carries one fewer namespace to get wrong.
      `<xliff xmlns="${ATLAS_XLIFF_NAMESPACE}" xmlns:mda="${ATLAS_XLIFF_METADATA_NAMESPACE}" version="2.2" srcLang="${escapeXml(source.locale)}" trgLang="${escapeXml(targetLocale.value)}">`,
      `  <file id="${escapeXml(fileId)}" original="${escapeXml(source.sourcePath ?? `i18n/${source.scopeId}/${source.locale}.yaml`)}">`,
      ...units,
      '  </file>',
      '</xliff>',
      '',
    ].join('\n'),
  );
}

/**
 * Writes a catalog out as an XLIFF 2.2 document for a translation tool.
 *
 * Takes the authored catalog and, where there is one, the existing translation, and returns the
 * document as text. Each unit carries the message's protected identity, a fingerprint of the
 * authored text, the message structure and the typed contracts, so a tool can show a translator
 * what a placeholder is for and an import can tell a stale translation from a current one.
 *
 * The authored catalog stays authoritative: this is a view of it, and nothing a tool changes about
 * a unit's identity or structure survives the return trip.
 */
export function exportAtlasXliff22(
  request: AtlasXliffExportRequest,
): AtlasResult<string> {
  const sink = request.observability;
  if (sink === undefined) return exportAtlasXliff22Core(request);
  const eventContext = {
    code: ATLAS_TOOLKIT_EVENT_CODES.interchange,
    phase: 'interchange' as const,
    providerId: request.source.providerId,
    scopeId: request.source.scopeId,
  };
  emitAtlasToolkitEvent(sink, {
    ...eventContext,
    status: 'started',
  });
  let result: AtlasResult<string>;
  try {
    result = exportAtlasXliff22Core(request);
  } catch (error) {
    emitAtlasToolkitEvent(sink, {
      ...eventContext,
      status: 'failed',
    });
    throw error;
  }
  if (result.ok) {
    const localeValue = request.target?.locale ?? request.targetLocale;
    const locale =
      localeValue === undefined
        ? undefined
        : canonicalizeAtlasLocale(localeValue);
    emitAtlasToolkitEvent(sink, {
      ...eventContext,
      status: 'succeeded',
      ...(locale?.ok ? { locale: locale.value } : {}),
      count: Object.keys(request.source.messages).length,
    });
  } else {
    const diagnosticCode = result.diagnostics[0]?.code;
    emitAtlasToolkitEvent(sink, {
      ...eventContext,
      status: 'failed',
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    });
  }
  return result;
}

function parseContract(unit: XmlElement): XliffUnitContract | undefined {
  const metadataNamespace = ATLAS_XLIFF_METADATA_NAMESPACE;
  for (const metadata of childElements(unit, metadataNamespace, 'metadata')) {
    for (const group of childElements(
      metadata,
      metadataNamespace,
      'metaGroup',
    )) {
      if (group.attributes['category'] !== 'atlas:unit') continue;
      for (const meta of childElements(group, metadataNamespace, 'meta')) {
        if (meta.attributes['type'] !== 'atlas:contract') continue;
        const text = textContent(meta);
        if (text === undefined || Buffer.byteLength(text, 'utf8') > 65_536)
          return undefined;
        try {
          const value = JSON.parse(text) as Record<string, unknown>;
          const representation = value['representation'];
          if (
            Object.keys(value).sort(compareCodePoint).join(',') !==
              'identity,messageId,profile,representation,sourceFingerprint' ||
            value['profile'] !== ATLAS_XLIFF_PROFILE ||
            typeof value['identity'] !== 'string' ||
            typeof value['messageId'] !== 'string' ||
            (representation !== 'inline' && representation !== 'flat') ||
            typeof value['sourceFingerprint'] !== 'string'
          ) {
            return undefined;
          }
          return Object.freeze({
            profile: ATLAS_XLIFF_PROFILE,
            identity: value['identity'],
            messageId: value['messageId'],
            representation,
            sourceFingerprint: value['sourceFingerprint'],
          });
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

interface XliffGuidance {
  readonly description?: string;
  readonly context?: string;
}

interface XliffUnitNotes {
  /** Guidance the notes state about the translation. */
  readonly target: XliffGuidance;
  /** Guidance the notes state about the source message. */
  readonly source: XliffGuidance;
  /** Notes carrying guidance Atlas has no field for: a translator's or a tool's own commentary. */
  readonly foreign: readonly string[];
  /** A note that is not plain text, or more than one <notes> element. */
  readonly malformed: boolean;
}

/**
 * Read the notes on a unit.
 *
 * Only Atlas's own categories are absorbed. A note written by a translator or a translation-
 * management system stays where it was written: `specs/01-standards-profile.spec.md` section 10
 * refuses XLIFF as an authoring format, so absorbing arbitrary commentary into the catalog would
 * give it a home with no way to edit it and a guaranteed re-export. It is reported instead of
 * dropped.
 */
function parseNotes(unit: XmlElement): XliffUnitNotes {
  const containers = childElements(unit, ATLAS_XLIFF_NAMESPACE, 'notes');
  if (containers.length === 0) {
    return { target: {}, source: {}, foreign: [], malformed: false };
  }
  if (containers.length > 1) {
    // XLIFF 2.2 Core §3.2.2.5 permits zero or one.
    return { target: {}, source: {}, foreign: [], malformed: true };
  }
  const target: { description?: string; context?: string } = {};
  const source: { description?: string; context?: string } = {};
  const foreign: string[] = [];
  for (const note of childElements(
    containers[0] as XmlElement,
    ATLAS_XLIFF_NAMESPACE,
    'note',
  )) {
    const text = textContent(note);
    if (text === undefined) {
      return { target: {}, source: {}, foreign: [], malformed: true };
    }
    const category = note.attributes['category'];
    if (
      category !== ATLAS_NOTE_DESCRIPTION &&
      category !== ATLAS_NOTE_CONTEXT
    ) {
      foreign.push(category ?? '(uncategorized)');
      continue;
    }
    // Atlas always writes appliesTo explicitly, so a note without it was hand-authored. Reading it
    // as source guidance is the reading that changes nothing: source guidance is advisory here.
    const bucket = note.attributes['appliesTo'] === 'target' ? target : source;
    if (category === ATLAS_NOTE_DESCRIPTION) bucket.description = text;
    else bucket.context = text;
  }
  return {
    target: Object.freeze({ ...target }),
    source: Object.freeze({ ...source }),
    foreign: Object.freeze(foreign),
    malformed: false,
  };
}

/**
 * One `<target>` as an Atlas catalog message.
 *
 * The empty translation is `subState="atlas:empty"` on the segment rather than a flag on the
 * target, so it is a refinement of the state that already says whether the target is a translation
 * at all. An empty target without it stays what it was: a blank nobody filled in, refused rather
 * than imported as a deliberately empty message.
 *
 * In the inline representation the pattern is rebuilt from the codes and then checked against the
 * codes the source message has. A translation that lost a placeholder is refused here: that is
 * the failure the whole representation exists to catch, and a deleted `{$name}` leaves text that
 * still parses, so nothing downstream would notice.
 *
 * The flat representation is checked too, at the only grain it can be: the inputs the source
 * renders anywhere against the inputs the translation renders anywhere. It cannot say which
 * variant lost the value, but it can say the translation no longer renders it at all, and that is
 * the loss that reaches production.
 */
function importedMessage(
  unit: XmlElement,
  segment: XmlElement,
  target: XmlElement,
  contract: XliffUnitContract,
  source: AtlasCatalogMessage,
  guidance: XliffGuidance,
): AtlasResult<AtlasCatalogMessage> {
  const messageId = contract.messageId;
  if (segment.attributes['subState'] === ATLAS_SEGMENT_SUBSTATE_EMPTY) {
    if ((textContent(target) ?? '').length > 0) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1803',
          `Explicitly empty XLIFF target ${JSON.stringify(messageId)} contains text.`,
        ),
      ]);
    }
    return atlasSuccess(
      Object.freeze({
        kind: 'empty',
        ...guidance,
        inputs: Object.freeze({}),
        slots: Object.freeze({}),
      }) satisfies AtlasEmptyCatalogMessage,
    );
  }
  let body: string | undefined;
  if (contract.representation === 'flat') {
    body = textContent(target);
    if (body !== undefined && body.length > 0 && source.kind === 'message') {
      const dropped = droppedInputs(parseCST(source.message), parseCST(body));
      if (dropped.length > 0) {
        return atlasFailure([
          atlasDiagnostic(
            'ATL1803',
            `XLIFF target ${JSON.stringify(messageId)} never renders ${dropped.length} value(s) the source message renders: ${dropped.map((input) => JSON.stringify(input)).join(', ')}. A message with variants is compared across all of them together, so a value only has to appear in one of them.`,
            { path: ['messages', messageId] },
          ),
        ]);
      }
    }
  } else {
    const data = originalData(unit);
    const pattern = data === undefined ? undefined : patternText(target, data);
    if (pattern !== undefined) {
      const expected = sourceCodes(source);
      const missing = expected.filter((key) => !pattern.codes.includes(key));
      if (missing.length > 0) {
        return atlasFailure([
          atlasDiagnostic(
            'ATL1803',
            `XLIFF target ${JSON.stringify(messageId)} is missing ${missing.length} placeholder(s) the source message has: ${missing.map((key) => JSON.stringify(codeKeyText(key))).join(', ')}.`,
            { path: ['messages', messageId] },
          ),
        ]);
      }
      const extra = pattern.codes.filter((key) => !expected.includes(key));
      if (extra.length > 0) {
        return atlasFailure([
          atlasDiagnostic(
            'ATL1803',
            `XLIFF target ${JSON.stringify(messageId)} carries ${extra.length} placeholder(s) the source message does not have: ${extra.map((key) => JSON.stringify(codeKeyText(key))).join(', ')}.`,
            { path: ['messages', messageId] },
          ),
        ]);
      }
    }
    body = pattern?.text;
  }
  if (body === undefined || body.length === 0) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1803',
        `XLIFF target ${JSON.stringify(messageId)} has unsupported inline structure or an accidental blank value.`,
      ),
    ]);
  }
  const semantics = parseAtlasMessage(body, { path: ['messages', messageId] });
  if (!semantics.ok) return semantics;
  return atlasSuccess(
    Object.freeze({
      kind: 'message',
      message: body,
      semantics: semantics.value,
      ...guidance,
      inputs: Object.freeze({}),
      slots: Object.freeze({}),
    }) satisfies AtlasTextCatalogMessage,
  );
}

function importAtlasXliff22Core(
  request: AtlasXliffImportRequest,
): AtlasResult<AtlasCatalog> {
  if (request.source.role !== 'source') {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        'XLIFF import requires the authoritative source catalog.',
      ),
    ]);
  }
  const parsed = parseXml(request.document);
  if (!parsed.ok) return parsed;
  const root = parsed.value;
  // The root is identified by namespace, version and source locale, and by nothing else.
  //
  // Not by the prefixes the root happens to declare. Requiring `xmlns:mda` and `xmlns:atlas` on
  // the root element, spelled that way, is not a conformance requirement: a prefix is chosen by
  // whoever serialized the document, and a namespace may be declared on any element that uses it.
  // A check like that rejects a conformant document from a translation-management system for its
  // spelling and passes only the documents Atlas wrote itself. Prefixes are resolved where they
  // are read.
  if (
    root.localName !== 'xliff' ||
    root.namespace !== ATLAS_XLIFF_NAMESPACE ||
    root.attributes['version'] !== '2.2' ||
    root.attributes['srcLang'] !== request.source.locale
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        'XLIFF document does not match the Atlas 2.2 profile or source locale.',
      ),
    ]);
  }
  const targetLocaleValue = request.targetLocale ?? root.attributes['trgLang'];
  if (targetLocaleValue === undefined) {
    return atlasFailure([
      atlasDiagnostic('ATL1802', 'XLIFF document has no target locale.'),
    ]);
  }
  const targetLocale = canonicalizeAtlasLocale(targetLocaleValue);
  if (!targetLocale.ok) return targetLocale;
  if (
    root.attributes['trgLang'] !== undefined &&
    root.attributes['trgLang'] !== targetLocale.value
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        'Requested target locale does not match the XLIFF document.',
      ),
    ]);
  }
  // XLIFF 2.2 Core declares `<file>` with `maxOccurs="unbounded"`, and a translation-management
  // system that holds several catalogs in one document is conformant. Atlas required exactly one,
  // so a document it had not written itself could not be imported at all. It now selects the file
  // belonging to the catalog being imported and leaves the rest of the document alone.
  const catalogIdentity = `${request.source.providerId}:${request.source.scopeId}`;
  const catalogFileId = xliffFileId(request.source);
  const files = childElements(root, ATLAS_XLIFF_NAMESPACE, 'file');
  const matching = files.filter(
    (file) => file.attributes['id'] === catalogFileId,
  );
  if (matching.length !== 1) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1802',
        // Named by the Atlas identity an operator recognises, with the XLIFF id it looked for after
        // it: the two differ because an XLIFF id is an NMTOKEN and `@example/app` is not one, and a
        // diagnostic that mentioned only the id would send somebody looking for the wrong string.
        matching.length === 0
          ? `XLIFF document contains no file for the Atlas catalog ${JSON.stringify(catalogIdentity)} (file id ${JSON.stringify(catalogFileId)}).`
          : `XLIFF document contains ${matching.length} files for the Atlas catalog ${JSON.stringify(catalogIdentity)} (file id ${JSON.stringify(catalogFileId)}).`,
      ),
    ]);
  }
  const catalogFile = matching[0] as XmlElement;
  const diagnostics: AtlasDiagnostic[] = [];
  const fileNotes = childElements(catalogFile, ATLAS_XLIFF_NAMESPACE, 'notes');
  if (fileNotes.length > 0) {
    // Atlas writes no file-level notes, so any that arrive were added by a translator or a tool.
    // Same rule as unit notes: not absorbed, not dropped quietly.
    diagnostics.push(
      atlasDiagnostic(
        'ATL1803',
        'XLIFF file carries notes Atlas does not store. They remain in the interchange document only.',
        { severity: 'warning' },
      ),
    );
  }
  const messages: Record<string, AtlasCatalogMessage> = Object.create(
    null,
  ) as Record<string, AtlasCatalogMessage>;
  const seen = new Set<string>();
  for (const unit of childElements(
    catalogFile,
    ATLAS_XLIFF_NAMESPACE,
    'unit',
  )) {
    const contract = parseContract(unit);
    const unitId = unit.attributes['id'];
    if (
      contract === undefined ||
      unitId !== contract.messageId ||
      seen.has(unitId)
    ) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1803',
          'XLIFF unit identity or protected Atlas metadata is invalid.',
        ),
      );
      continue;
    }
    seen.add(contract.messageId);
    const sourceMessage = request.source.messages[contract.messageId];
    if (
      sourceMessage === undefined ||
      contract.identity !== messageIdentity(request.source, contract.messageId)
    ) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1803',
          `XLIFF unit ${JSON.stringify(contract.identity)} is not part of the authoritative source catalog.`,
        ),
      );
      continue;
    }
    if (
      contract.sourceFingerprint !==
      sourceFingerprint(request.source, contract.messageId, sourceMessage)
    ) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1803',
          `XLIFF unit ${JSON.stringify(contract.identity)} is stale for the current source revision.`,
          {
            severity: 'warning',
            path: ['messages', contract.messageId],
          },
        ),
      );
      continue;
    }
    const notes = parseNotes(unit);
    if (notes.malformed) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1803',
          `XLIFF unit ${JSON.stringify(contract.identity)} has unsupported note structure.`,
          { path: ['messages', contract.messageId] },
        ),
      );
      continue;
    }
    if (notes.foreign.length > 0) {
      // Not dropped quietly. The note stays in the interchange document, where translator and tool
      // commentary belongs; the operator is told Atlas read it and did not absorb it, because
      // `specs/01-standards-profile.spec.md` section 11 forbids removing unsupported content
      // silently.
      diagnostics.push(
        atlasDiagnostic(
          'ATL1803',
          `XLIFF unit ${JSON.stringify(contract.identity)} carries ${notes.foreign.length} note(s) Atlas does not store: ${notes.foreign.map((category) => JSON.stringify(category)).join(', ')}. They remain in the interchange document only.`,
          { severity: 'warning', path: ['messages', contract.messageId] },
        ),
      );
    }
    for (const [field, value] of Object.entries(notes.source)) {
      if (
        value === (sourceMessage as unknown as Record<string, unknown>)[field]
      ) {
        continue;
      }
      // Source guidance is authored in Atlas's own catalogs. An edited copy arriving back through
      // an interchange document is not authoritative and is not applied, but it is said out loud,
      // because a translator who rewrote it is telling us the original was unclear.
      diagnostics.push(
        atlasDiagnostic(
          'ATL1803',
          `XLIFF unit ${JSON.stringify(contract.identity)} changes the source ${field}, which the authoring catalog owns. The change was not applied.`,
          { severity: 'warning', path: ['messages', contract.messageId] },
        ),
      );
    }
    const segments = childElements(unit, ATLAS_XLIFF_NAMESPACE, 'segment');
    const segment = segments.length === 1 ? segments[0] : undefined;
    const target =
      segment === undefined
        ? undefined
        : childElements(segment, ATLAS_XLIFF_NAMESPACE, 'target')[0];
    if (target === undefined || segment === undefined) continue;
    const state = segment.attributes['state'] ?? 'initial';
    if (!XLIFF_SEGMENT_STATES.has(state)) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1803',
          `XLIFF unit ${JSON.stringify(contract.identity)} has an unknown segment state ${JSON.stringify(state)}.`,
          { path: ['messages', contract.messageId] },
        ),
      );
      continue;
    }
    if (state === 'initial') {
      // A target in its initial state is a placeholder a tool wrote, not a translation somebody
      // made. Importing it would put untranslated text into a target catalog and report success.
      diagnostics.push(
        atlasDiagnostic(
          'ATL1803',
          `XLIFF unit ${JSON.stringify(contract.identity)} is still in its initial state and was not imported as a translation.`,
          { severity: 'warning', path: ['messages', contract.messageId] },
        ),
      );
      continue;
    }
    const message = importedMessage(
      unit,
      segment,
      target,
      contract,
      sourceMessage,
      notes.target,
    );
    diagnostics.push(...message.diagnostics);
    if (message.ok) messages[contract.messageId] = message.value;
  }
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    return atlasFailure(diagnostics);
  }
  if (Object.keys(messages).length === 0) {
    return atlasFailure([
      ...diagnostics,
      atlasDiagnostic(
        'ATL1803',
        'XLIFF import contains no current valid target units.',
      ),
    ]);
  }
  return atlasSuccess(
    Object.freeze({
      role: 'target',
      providerId: request.source.providerId,
      scopeId: request.source.scopeId,
      locale: targetLocale.value,
      ...(request.sourcePath === undefined
        ? {}
        : { sourcePath: request.sourcePath }),
      messages: Object.freeze(messages),
      families: Object.freeze({}),
    }),
    diagnostics,
  );
}

/**
 * Reads a returned XLIFF 2.2 document back into a target catalog.
 *
 * Takes the document and the authored catalog it was exported from, and returns the translation, or
 * the reasons it could not be read.
 *
 * Units are matched on the protected identity alone, never on wording or on the order they appear
 * in, so a reordered or partially returned document lands on the right messages. A unit naming a
 * message the source does not have is refused rather than added.
 */
export function importAtlasXliff22(
  request: AtlasXliffImportRequest,
): AtlasResult<AtlasCatalog> {
  const sink = request.observability;
  if (sink === undefined) return importAtlasXliff22Core(request);
  const eventContext = {
    code: ATLAS_TOOLKIT_EVENT_CODES.interchange,
    phase: 'interchange' as const,
    providerId: request.source.providerId,
    scopeId: request.source.scopeId,
  };
  emitAtlasToolkitEvent(sink, {
    ...eventContext,
    status: 'started',
  });
  let result: AtlasResult<AtlasCatalog>;
  try {
    result = importAtlasXliff22Core(request);
  } catch (error) {
    emitAtlasToolkitEvent(sink, {
      ...eventContext,
      status: 'failed',
    });
    throw error;
  }
  if (result.ok) {
    emitAtlasToolkitEvent(sink, {
      ...eventContext,
      status: 'succeeded',
      locale: result.value.locale,
      count: Object.keys(result.value.messages).length,
    });
  } else {
    const diagnosticCode = result.diagnostics[0]?.code;
    emitAtlasToolkitEvent(sink, {
      ...eventContext,
      status: 'failed',
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    });
  }
  return result;
}
