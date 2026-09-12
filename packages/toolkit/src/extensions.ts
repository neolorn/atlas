/**
 * Extension registries, read as data and never as code.
 *
 * `specs/01-standards-profile.spec.md` section 9 splits an extension into two projections and keeps
 * them apart: an inert descriptor the toolkit reads, and a trusted handler the application
 * registers at runtime. Everything in this file is the first half. Nothing here imports a
 * consumer's module, and nothing a registry carries is executed, because the alternative is a
 * compiler that runs application code to find out what the application declares.
 */
import {
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from 'jsonc-parser';

import {
  digestAtlasCanonicalJson,
  type AtlasCanonicalJsonValue,
} from './canonical-json.js';
import {
  atlasDiagnostic,
  atlasFailure,
  atlasSuccess,
  atlasSourceSpan,
  type AtlasDiagnostic,
  type AtlasResult,
} from './diagnostics.js';
import {
  atlasSchemaErrorPath,
  atlasSchemaErrorSummary,
  compileAtlasSchema,
  sortedAtlasSchemaErrors,
} from './schema-validation.js';
import { inspectAtlasTree } from './bounded-data.js';
import type { AtlasMessageCustomFunction } from './message-format.js';
import { atlasIsMessageName } from './message-format-syntax.js';
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';
import { ATLAS_EXTENSION_REGISTRY_SCHEMA } from './schemas.js';
import { compareCodePoint } from './sorted-records.js';
import { constructJsonValue } from './json-tree.js';

/** The version stamp on an extension registry file, checked before one is read. */
export const ATLAS_EXTENSION_REGISTRY_PROFILE =
  'atlas-extension-registry/1' as const;
/** The version stamp on a single extension descriptor. */
export const EXTENSION_DESCRIPTOR_PROFILE =
  'atlas-extension-descriptor/1' as const;

/**
 * The five value types an extension may declare, matching what a message input can be.
 *
 * The same five everywhere, so a function an extension adds takes the kinds of value a built-in
 * takes and nothing more exotic.
 */
export type ExtensionValueType =
  | 'boolean'
  | 'date-time'
  | 'integer'
  | 'number'
  | 'string';

/**
 * Declares a function messages may call, such as a domain-specific way of writing a quantity.
 *
 * The declaration only. What the function does is registered separately at runtime, so nothing here
 * is executed and the compiler never loads application code to find out what it says.
 */
export interface AtlasMessageFunctionDescriptorInput {
  readonly kind: 'message-function';
  /** The name messages call it by, without a leading colon. */
  readonly id: string;
  /** What kind of value it may be applied to. */
  readonly operandType: ExtensionValueType;
  /**
   * The options it accepts, by name, each with its type, whether it is required, and the values
   * allowed.
   *
   * An option a message writes that is not declared here is refused when the catalog is parsed.
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
  /** What it produces, which is what decides where in a message it may appear. */
  readonly resultType: 'string' | 'number' | 'date-time';
  /**
   * Whether a selection may branch on its result.
   *
   * `none` means it formats only, so a selection over it is refused. `exact` means keys are
   * compared to the result as written.
   */
  readonly selector: 'none' | 'exact';
  /** How long its output may be, which bounds what one message can make the runtime produce. */
  readonly maximumOutputLength: number;
}

/**
 * Declares a kind of value a message family may vary over, beyond Atlas's own message parts.
 *
 * For a family keyed by something the application owns: a product line, a document type, a tier.
 */
export interface AtlasIdentifierSegmentDescriptorInput {
  readonly kind: 'identifier-segment';
  /** The name a family names this segment type by. */
  readonly id: string;
  /** Which spelling a value must follow, which keeps the generated names predictable. */
  readonly syntax: 'lower-kebab' | 'ascii-token' | 'unicode-token';
  /** The longest a value may be. */
  readonly maximumLength: number;
}

/**
 * Declares a kind of named region messages may place, beyond the ones Atlas ships.
 *
 * The catalog can then place it and name it; what it renders as is still decided in application
 * code, so a catalog gains a position in a sentence rather than a component.
 */
export interface AtlasRichSlotKindDescriptorInput {
  readonly kind: 'rich-slot-kind';
  /** The name messages place it under. */
  readonly id: string;
  /** Whether it wraps text or marks a point. */
  readonly shape: 'paired' | 'standalone';
  /**
   * Whether it is something a reader can act on.
   *
   * An interactive slot is held to more: it must be reachable and it must be labelled, and the
   * checks that enforce that read this.
   */
  readonly interactive: boolean;
  /**
   * Where the words inside it come from.
   *
   * `children` means the message supplies them. `binding-required` means the application does, so a
   * message that leaves the binding out is refused rather than rendering empty.
   */
  readonly textProjection: 'children' | 'binding-required';
  /** The options it accepts, by name, each with the values allowed for it. */
  readonly options?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Declares a way of writing a value type Atlas does not know: a domain's own quantity, code or
 * identifier.
 *
 * The declaration only. The code that does the writing is registered at runtime.
 */
export interface AtlasFormattingAdapterDescriptorInput {
  readonly kind: 'formatting-adapter';
  /** The name this adapter is reached by. */
  readonly id: string;
  /** The value type it writes, named by the application. */
  readonly inputType: string;
  /** Whether it produces a string or parts a template places. */
  readonly result: 'text' | 'parts';
  /** How long its output may be. */
  readonly maximumOutputLength: number;
}

/**
 * Declares a way of reading a value type Atlas does not know back out of what a person typed.
 *
 * The other half of a formatting adapter, for a field that has to round-trip.
 */
export interface AtlasParsingAdapterDescriptorInput {
  readonly kind: 'parsing-adapter';
  /** The name this adapter is reached by. */
  readonly id: string;
  /** The value type it produces, named by the application. */
  readonly outputType: string;
  /** How much text it will be handed, which bounds what a pasted field can cost. */
  readonly maximumInputLength: number;
}

/**
 * Any of the five things an extension can declare, as written before it is registered.
 *
 * What `defineAtlasExtensionRegistry` takes. The registry adds a profile stamp and a fingerprint to
 * each one.
 */
export type AtlasExtensionDescriptorInput =
  | AtlasMessageFunctionDescriptorInput
  | AtlasIdentifierSegmentDescriptorInput
  | AtlasRichSlotKindDescriptorInput
  | AtlasFormattingAdapterDescriptorInput
  | AtlasParsingAdapterDescriptorInput;

/**
 * A declaration as the registry holds it: what was written, stamped and fingerprinted.
 *
 * The fingerprint is of the declaration's content, so a compiled artifact can say exactly which
 * version of an extension it was built against and a loader can refuse one that has since changed.
 */
export type AtlasExtensionDescriptor = AtlasExtensionDescriptorInput & {
  readonly profile: typeof EXTENSION_DESCRIPTOR_PROFILE;
  readonly fingerprint: string;
};

/**
 * Everything an application's messages may reach for beyond Atlas's own vocabulary.
 *
 * Inert throughout. Nothing in it is executed, nothing imports a consumer's module, and the whole
 * of it can be read from a file and compared between builds.
 */
export interface AtlasExtensionRegistry {
  /** The registry-shape version stamp. */
  readonly profile: typeof ATLAS_EXTENSION_REGISTRY_PROFILE;
  /** The declarations, sorted so two registries with the same contents compare equal. */
  readonly descriptors: readonly AtlasExtensionDescriptor[];
  /** A digest of the whole registry, which moves when any descriptor in it does. */
  readonly fingerprint: string;
}

export interface AtlasExtensionRegistryParseOptions {
  readonly sourcePath?: string;
}

const validateExtensionRegistry = compileAtlasSchema(
  ATLAS_EXTENSION_REGISTRY_SCHEMA,
);

function portableSnapshot(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): AtlasCanonicalJsonValue {
  budget.nodes += 1;
  if (
    budget.nodes > ATLAS_RESOURCE_LIMITS.jsonNodes ||
    depth > ATLAS_RESOURCE_LIMITS.jsonDepth
  ) {
    throw new TypeError('Extension descriptor data exceeds Atlas tree limits.');
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new TypeError('Extension descriptor numbers must be canonical.');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Extension descriptors must contain inert JSON data.');
  }
  if (seen.has(value)) {
    throw new TypeError(
      'Extension descriptors cannot contain cycles or shared object aliases.',
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) {
      throw new TypeError(
        'Extension descriptor arrays must be dense and inert.',
      );
    }
    return Object.freeze(
      keys.map((key) => {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new TypeError(
            'Extension descriptor arrays cannot contain accessors.',
          );
        }
        return portableSnapshot(descriptor.value, seen, depth + 1, budget);
      }),
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Extension descriptor records must be plain data.');
  }
  const output = Object.create(null) as Record<string, AtlasCanonicalJsonValue>;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(
        'Extension descriptor records cannot contain hidden fields or accessors.',
      );
    }
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value: portableSnapshot(descriptor.value, seen, depth + 1, budget),
      writable: false,
    });
  }
  return Object.freeze(output);
}

function validExtensionId(id: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,63}$/u.test(id);
}

function validBound(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function descriptorError(
  descriptor: AtlasExtensionDescriptorInput,
): string | undefined {
  if (!validExtensionId(descriptor.id)) {
    return 'Application-local extension identities require a provider namespace and bounded lowercase name.';
  }
  switch (descriptor.kind) {
    case 'message-function': {
      if (!validBound(descriptor.maximumOutputLength, 65_536)) {
        return 'Custom message function output bound is invalid.';
      }
      if (
        Object.keys(descriptor.options ?? {}).length >
        ATLAS_RESOURCE_LIMITS.extensionOptionsPerDescriptor
      ) {
        return 'Custom message function exceeds the option ceiling.';
      }
      for (const [name, option] of Object.entries(descriptor.options ?? {})) {
        if (!atlasIsMessageName(name)) {
          return 'Custom message function option name is invalid.';
        }
        if (
          option.values !== undefined &&
          (option.values.length === 0 ||
            option.values.length >
              ATLAS_RESOURCE_LIMITS.extensionValuesPerOption ||
            new Set(option.values).size !== option.values.length)
        ) {
          return 'Custom message function option values must be nonempty and unique.';
        }
      }
      return undefined;
    }
    case 'identifier-segment':
      return validBound(descriptor.maximumLength, 128)
        ? undefined
        : 'Identifier-segment bound is invalid.';
    case 'rich-slot-kind':
      if (
        Object.keys(descriptor.options ?? {}).length >
        ATLAS_RESOURCE_LIMITS.extensionOptionsPerDescriptor
      ) {
        return 'Rich-slot kind exceeds the option ceiling.';
      }
      for (const [name, values] of Object.entries(descriptor.options ?? {})) {
        if (
          !/^[a-z][a-z0-9-]{0,63}$/u.test(name) ||
          values.length === 0 ||
          values.length > ATLAS_RESOURCE_LIMITS.extensionValuesPerOption ||
          new Set(values).size !== values.length ||
          values.some((value) => value.length === 0 || value.length > 128)
        ) {
          return 'Rich-slot option descriptors must be closed, bounded, and unique.';
        }
      }
      return undefined;
    case 'formatting-adapter':
      return descriptor.inputType.length > 0 &&
        descriptor.inputType.length <= 128 &&
        validBound(descriptor.maximumOutputLength, 65_536)
        ? undefined
        : 'Formatting-adapter descriptor is invalid.';
    case 'parsing-adapter':
      return descriptor.outputType.length > 0 &&
        descriptor.outputType.length <= 128 &&
        validBound(descriptor.maximumInputLength, 65_536)
        ? undefined
        : 'Parsing-adapter descriptor is invalid.';
  }
}

/**
 * Builds a registry in code, for an application that declares its extensions rather than shipping a
 * file.
 *
 * Takes the declarations and returns the registry with each one stamped and fingerprinted, or the
 * reasons it could not. Sorts them, so the order they were written in does not change the result.
 *
 * Fails for a duplicate identity within a kind, for a malformed declaration, for more descriptors
 * than the ceiling allows, and for anything that is not bounded inert data: a function, an
 * accessor or a cycle reaching a registry is refused rather than carried into a compilation.
 */
export function defineAtlasExtensionRegistry(
  inputs: readonly AtlasExtensionDescriptorInput[],
): AtlasResult<AtlasExtensionRegistry> {
  let snapshot: AtlasCanonicalJsonValue;
  try {
    snapshot = portableSnapshot(inputs);
  } catch (error) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1805',
        `Application-local extension registry is not bounded inert data: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ]);
  }
  const registryInput = Object.freeze({
    profile: ATLAS_EXTENSION_REGISTRY_PROFILE,
    descriptors: snapshot,
  });
  if (!validateExtensionRegistry(registryInput)) {
    return atlasFailure(
      sortedAtlasSchemaErrors(validateExtensionRegistry.errors)
        .slice(0, ATLAS_RESOURCE_LIMITS.diagnostics)
        .map((error) =>
          atlasDiagnostic(
            'ATL1805',
            atlasSchemaErrorSummary('Atlas extension registry', error),
            { path: atlasSchemaErrorPath(error) },
          ),
        ),
    );
  }
  const normalizedInputs =
    snapshot as unknown as readonly AtlasExtensionDescriptorInput[];
  if (normalizedInputs.length > ATLAS_RESOURCE_LIMITS.extensionDescriptors) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1805',
        'Application-local extension registry exceeds the Atlas descriptor ceiling.',
      ),
    ]);
  }
  const seen = new Set<string>();
  const descriptors: AtlasExtensionDescriptor[] = [];
  for (const input of normalizedInputs) {
    const key = `${input.kind}\u0000${input.id}`;
    const error = descriptorError(input);
    if (error !== undefined || seen.has(key)) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1805',
          error ?? 'Application-local extension descriptor is duplicated.',
          { path: ['extensions', input.kind, input.id] },
        ),
      ]);
    }
    seen.add(key);
    const canonical = input as unknown as AtlasCanonicalJsonValue;
    const normalized = input;
    descriptors.push(
      Object.freeze({
        ...normalized,
        profile: EXTENSION_DESCRIPTOR_PROFILE,
        fingerprint: digestAtlasCanonicalJson(
          EXTENSION_DESCRIPTOR_PROFILE,
          canonical,
        ),
      }),
    );
  }
  descriptors.sort((left, right) =>
    compareCodePoint(
      `${left.kind}\u0000${left.id}`,
      `${right.kind}\u0000${right.id}`,
    ),
  );
  const fingerprint = digestAtlasCanonicalJson(
    ATLAS_EXTENSION_REGISTRY_PROFILE,
    descriptors.map(({ kind, id, fingerprint: value }) => ({
      kind,
      id,
      fingerprint: value,
    })),
  );
  return atlasSuccess(
    Object.freeze({
      profile: ATLAS_EXTENSION_REGISTRY_PROFILE,
      descriptors: Object.freeze(descriptors),
      fingerprint,
    }),
  );
}

function duplicateKeys(
  source: string,
  node: JsonNode,
  sourcePath: string | undefined,
  path: readonly (string | number)[] = [],
  diagnostics: AtlasDiagnostic[] = [],
): readonly AtlasDiagnostic[] {
  if (diagnostics.length >= ATLAS_RESOURCE_LIMITS.diagnostics) {
    return diagnostics;
  }
  if (node.type === 'object') {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0];
      const child = property.children?.[1];
      if (key?.type !== 'string' || typeof key.value !== 'string') continue;
      const nextPath = [...path, key.value];
      if (seen.has(key.value)) {
        diagnostics.push(
          atlasDiagnostic(
            'ATL1805',
            `Atlas extension registry contains duplicate key ${JSON.stringify(key.value)}.`,
            {
              path: nextPath,
              span: atlasSourceSpan(
                source,
                key.offset,
                Math.max(1, key.length),
                sourcePath,
              ),
            },
          ),
        );
      }
      seen.add(key.value);
      if (child !== undefined) {
        duplicateKeys(source, child, sourcePath, nextPath, diagnostics);
      }
      if (diagnostics.length >= ATLAS_RESOURCE_LIMITS.diagnostics) break;
    }
  } else if (node.type === 'array') {
    for (const [index, child] of (node.children ?? []).entries()) {
      duplicateKeys(source, child, sourcePath, [...path, index], diagnostics);
      if (diagnostics.length >= ATLAS_RESOURCE_LIMITS.diagnostics) break;
    }
  }
  return diagnostics;
}

export function parseAtlasExtensionRegistry(
  source: string,
  options: AtlasExtensionRegistryParseOptions = {},
): AtlasResult<AtlasExtensionRegistry> {
  if (
    Buffer.byteLength(source, 'utf8') > ATLAS_RESOURCE_LIMITS.configurationBytes
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1805',
        'Atlas extension registry exceeds the 1 MiB authored-input ceiling.',
      ),
    ]);
  }
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (root === undefined || errors.length > 0) {
    return atlasFailure(
      (errors.length === 0
        ? [{ error: 1, offset: 0, length: Math.max(1, source.length) }]
        : errors
      )
        .slice(0, ATLAS_RESOURCE_LIMITS.diagnostics)
        .map((error) =>
          atlasDiagnostic(
            'ATL1805',
            `Atlas extension registry contains invalid JSON: ${printParseErrorCode(error.error)}.`,
            {
              span: atlasSourceSpan(
                source,
                error.offset,
                Math.max(1, error.length),
                options.sourcePath,
              ),
            },
          ),
        ),
    );
  }
  const tree = inspectAtlasTree(root, (node) => node.children ?? [], {
    maximumDepth: ATLAS_RESOURCE_LIMITS.jsonDepth,
    maximumNodes: ATLAS_RESOURCE_LIMITS.jsonNodes,
  });
  if (tree.failure !== undefined) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1805',
        tree.failure === 'depth'
          ? `Atlas extension registry exceeds the JSON depth ceiling of ${ATLAS_RESOURCE_LIMITS.jsonDepth}.`
          : `Atlas extension registry exceeds the JSON node ceiling of ${ATLAS_RESOURCE_LIMITS.jsonNodes}.`,
      ),
    ]);
  }
  const duplicates = duplicateKeys(source, root, options.sourcePath);
  if (duplicates.length > 0) return atlasFailure(duplicates);
  const value = constructJsonValue(root);
  if (!validateExtensionRegistry(value)) {
    return atlasFailure(
      sortedAtlasSchemaErrors(validateExtensionRegistry.errors)
        .slice(0, ATLAS_RESOURCE_LIMITS.diagnostics)
        .map((error) =>
          atlasDiagnostic(
            'ATL1805',
            atlasSchemaErrorSummary('Atlas extension registry', error),
            { path: atlasSchemaErrorPath(error) },
          ),
        ),
    );
  }
  const authored = value as Readonly<{
    readonly profile: typeof ATLAS_EXTENSION_REGISTRY_PROFILE;
    readonly descriptors: readonly AtlasExtensionDescriptorInput[];
  }>;
  return defineAtlasExtensionRegistry(authored.descriptors);
}

export function formatAtlasExtensionRegistry(
  registry: AtlasExtensionRegistry,
): string {
  return `${JSON.stringify(
    {
      profile: ATLAS_EXTENSION_REGISTRY_PROFILE,
      descriptors: registry.descriptors.map(
        ({ profile: _profile, fingerprint: _fingerprint, ...descriptor }) =>
          descriptor,
      ),
    },
    null,
    2,
  )}\n`;
}

/**
 * Finds one declaration in a registry by its kind and identity.
 *
 * Takes the registry, which may be absent, the kind wanted, and the identity. Returns the
 * descriptor narrowed to that kind, or `undefined` when the registry is absent or has no such
 * entry.
 */
export function atlasExtensionDescriptor<
  Kind extends AtlasExtensionDescriptor['kind'],
>(
  registry: AtlasExtensionRegistry | undefined,
  kind: Kind,
  id: string,
): Extract<AtlasExtensionDescriptor, { readonly kind: Kind }> | undefined {
  return registry?.descriptors.find(
    (
      descriptor,
    ): descriptor is Extract<
      AtlasExtensionDescriptor,
      { readonly kind: Kind }
    > => descriptor.kind === kind && descriptor.id === id,
  );
}
/**
 * The registered message functions, in the shape the message parser reads them.
 *
 * The parser needs two things about a registered function and they arrive from the same
 * descriptor: its name, so an annotation is not rejected as unknown, and whether it selects, so a
 * `.match` over it is not accepted as a selector it cannot be. Deriving both here keeps the two
 * from drifting apart at the call sites that parse: authored catalogs, and the pseudo-locales
 * derived from them, which must parse identically.
 */
export function atlasMessageCustomFunctions(
  registry: AtlasExtensionRegistry | undefined,
): readonly AtlasMessageCustomFunction[] {
  return Object.freeze(
    (registry?.descriptors ?? [])
      .filter((descriptor) => descriptor.kind === 'message-function')
      .map((descriptor) =>
        Object.freeze({
          name: descriptor.id,
          selects: descriptor.selector === 'exact',
          operandType: descriptor.operandType,
          resultType: descriptor.resultType,
          options: Object.freeze(Object.keys(descriptor.options ?? {}).sort()),
        }),
      ),
  );
}
