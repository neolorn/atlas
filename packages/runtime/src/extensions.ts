// What a consumer's own function, slot kind, or adapter is allowed to reach.
//
// `specs/09-safe-content-and-ux.spec.md` section 15 gives an extension the capabilities its
// contract declares and no way out of validation, the resource limits, request isolation, or
// transaction semantics. A descriptor is inert data and a binding is trusted code, which is why
// a binding is resolved through the calling context's own registry: one belonging to another
// context, or never installed here, is refused rather than run.

import {
  EXTENSION_DESCRIPTOR_PROFILE,
  LocalizationError,
  type LocalizedSlotPart,
  type RuntimeExtensionBinding,
  type RuntimeExtensionDescriptor,
  type RuntimeFormattingAdapterBinding,
  type RuntimeMessageFunctionBinding,
  type RuntimeParsingAdapterBinding,
  type RuntimeRichSlotKindBinding,
} from '@neolorn/atlas/core';
import { atlasIsMessageName } from './message-format-syntax';
import {
  RUNTIME_LIMITS,
  codePointLengthAtMost,
  hasExactKeys,
  isDataRecord,
  sha256Base64Url,
  snapshotInertJson,
  compareCodePoint,
} from './runtime-safety';

const extensionValueTypes = new Set([
  'boolean',
  'date-time',
  'integer',
  'number',
  'string',
]);

function descriptorSnapshot(value: unknown) {
  return snapshotInertJson(value, {
    maximumDepth: 16,
    maximumNodes: 100_000,
    maximumCodeUnits: 1_048_576,
  });
}

function key(descriptor: RuntimeExtensionDescriptor): string {
  return `${descriptor.kind}\u0000${descriptor.id}`;
}

function invalid(message: string): never {
  throw new LocalizationError(
    Object.freeze({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message,
    }),
  );
}

function validBound(value: unknown, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= maximum
  );
}

function validOptions(value: unknown, rich: boolean): boolean {
  if (value === undefined) return true;
  if (!isDataRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > RUNTIME_LIMITS.extensionOptions) return false;
  for (const [name, option] of entries) {
    // A rich-slot option name is Atlas's own vocabulary; a message-function option name is
    // MessageFormat's, and the two productions are different on purpose.
    if (
      rich ? !/^[a-z][a-z0-9-]{0,63}$/u.test(name) : !atlasIsMessageName(name)
    ) {
      return false;
    }
    if (rich) {
      if (
        !Array.isArray(option) ||
        option.length === 0 ||
        option.length > RUNTIME_LIMITS.extensionOptionValues ||
        option.some(
          (item) =>
            typeof item !== 'string' ||
            codePointLengthAtMost(item, 128) === undefined,
        ) ||
        new Set(option).size !== option.length
      ) {
        return false;
      }
      continue;
    }
    if (
      !isDataRecord(option) ||
      !hasExactKeys(option, ['type'], ['required', 'values']) ||
      !extensionValueTypes.has(String(option['type'])) ||
      (option['required'] !== undefined &&
        typeof option['required'] !== 'boolean')
    ) {
      return false;
    }
    const values = option['values'];
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        values.length === 0 ||
        values.length > RUNTIME_LIMITS.extensionOptionValues ||
        values.some(
          (item) =>
            !['string', 'number', 'boolean'].includes(typeof item) ||
            (typeof item === 'number' && !Number.isFinite(item)) ||
            (typeof item === 'string' &&
              codePointLengthAtMost(item, 128) === undefined),
        ) ||
        new Set(values).size !== values.length)
    ) {
      return false;
    }
  }
  return true;
}

function normalizeDescriptor(candidate: unknown): RuntimeExtensionDescriptor {
  const snapshot = descriptorSnapshot(candidate);
  if (!isDataRecord(snapshot.value)) {
    return invalid('Runtime extension descriptor must be inert data.');
  }
  const descriptor = snapshot.value;
  if (
    descriptor['profile'] !== EXTENSION_DESCRIPTOR_PROFILE ||
    typeof descriptor['id'] !== 'string' ||
    !/^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,63}$/u.test(descriptor['id']) ||
    typeof descriptor['fingerprint'] !== 'string'
  ) {
    return invalid('Runtime extension descriptor identity is invalid.');
  }
  let valid = false;
  let inputKeys: readonly string[] = [];
  switch (descriptor['kind']) {
    case 'message-function':
      valid =
        hasExactKeys(
          descriptor,
          [
            'profile',
            'fingerprint',
            'kind',
            'id',
            'operandType',
            'resultType',
            'selector',
            'maximumOutputLength',
          ],
          ['options'],
        ) &&
        extensionValueTypes.has(String(descriptor['operandType'])) &&
        ['string', 'number', 'date-time'].includes(
          String(descriptor['resultType']),
        ) &&
        ['none', 'exact'].includes(String(descriptor['selector'])) &&
        validBound(
          descriptor['maximumOutputLength'],
          RUNTIME_LIMITS.outputCodePoints,
        ) &&
        validOptions(descriptor['options'], false);
      inputKeys = [
        'kind',
        'id',
        'operandType',
        'options',
        'resultType',
        'selector',
        'maximumOutputLength',
      ];
      break;
    case 'identifier-segment':
      valid =
        hasExactKeys(descriptor, [
          'profile',
          'fingerprint',
          'kind',
          'id',
          'syntax',
          'maximumLength',
        ]) &&
        ['lower-kebab', 'ascii-token', 'unicode-token'].includes(
          String(descriptor['syntax']),
        ) &&
        validBound(descriptor['maximumLength'], 128);
      inputKeys = ['kind', 'id', 'syntax', 'maximumLength'];
      break;
    case 'rich-slot-kind':
      valid =
        hasExactKeys(
          descriptor,
          [
            'profile',
            'fingerprint',
            'kind',
            'id',
            'shape',
            'interactive',
            'textProjection',
          ],
          ['options'],
        ) &&
        ['paired', 'standalone'].includes(String(descriptor['shape'])) &&
        typeof descriptor['interactive'] === 'boolean' &&
        ['children', 'binding-required'].includes(
          String(descriptor['textProjection']),
        ) &&
        validOptions(descriptor['options'], true);
      inputKeys = [
        'kind',
        'id',
        'shape',
        'interactive',
        'textProjection',
        'options',
      ];
      break;
    case 'formatting-adapter':
      valid =
        hasExactKeys(descriptor, [
          'profile',
          'fingerprint',
          'kind',
          'id',
          'inputType',
          'result',
          'maximumOutputLength',
        ]) &&
        typeof descriptor['inputType'] === 'string' &&
        codePointLengthAtMost(descriptor['inputType'], 128) !== undefined &&
        descriptor['inputType'].length > 0 &&
        ['text', 'parts'].includes(String(descriptor['result'])) &&
        validBound(
          descriptor['maximumOutputLength'],
          RUNTIME_LIMITS.outputCodePoints,
        );
      inputKeys = ['kind', 'id', 'inputType', 'result', 'maximumOutputLength'];
      break;
    case 'parsing-adapter':
      valid =
        hasExactKeys(descriptor, [
          'profile',
          'fingerprint',
          'kind',
          'id',
          'outputType',
          'maximumInputLength',
        ]) &&
        typeof descriptor['outputType'] === 'string' &&
        descriptor['outputType'].length > 0 &&
        codePointLengthAtMost(descriptor['outputType'], 128) !== undefined &&
        validBound(
          descriptor['maximumInputLength'],
          RUNTIME_LIMITS.localizedInputCodePoints,
        );
      inputKeys = ['kind', 'id', 'outputType', 'maximumInputLength'];
      break;
  }
  if (!valid) return invalid('Runtime extension descriptor is invalid.');
  const input = Object.create(null) as Record<string, unknown>;
  for (const property of inputKeys) {
    if (descriptor[property] !== undefined)
      input[property] = descriptor[property];
  }
  const canonicalInput = descriptorSnapshot(input).canonical;
  const expected = `sha256-${sha256Base64Url(
    `${EXTENSION_DESCRIPTOR_PROFILE}\u0000${canonicalInput}`,
  )}`;
  if (descriptor['fingerprint'] !== expected) {
    return invalid('Runtime extension descriptor fingerprint is invalid.');
  }
  return descriptor as unknown as RuntimeExtensionDescriptor;
}

function normalizeBinding(candidate: unknown): RuntimeExtensionBinding {
  if (!isDataRecord(candidate)) {
    return invalid('Runtime extension binding must be a plain data object.');
  }
  const properties = Object.getOwnPropertyDescriptors(candidate);
  const descriptorProperty = properties['descriptor'];
  if (
    descriptorProperty === undefined ||
    descriptorProperty.get !== undefined ||
    descriptorProperty.set !== undefined
  ) {
    return invalid('Runtime extension binding descriptor must be inert.');
  }
  const descriptor = normalizeDescriptor(descriptorProperty.value);
  const handlerName =
    descriptor.kind === 'message-function'
      ? 'evaluate'
      : descriptor.kind === 'identifier-segment'
        ? 'canonicalize'
        : descriptor.kind === 'rich-slot-kind'
          ? 'projectText'
          : descriptor.kind === 'formatting-adapter'
            ? 'format'
            : 'parse';
  if (!hasExactKeys(candidate, ['descriptor', handlerName])) {
    return invalid('Runtime extension binding shape is invalid.');
  }
  const handler = properties[handlerName];
  if (
    handler === undefined ||
    handler.get !== undefined ||
    handler.set !== undefined ||
    typeof handler.value !== 'function'
  ) {
    return invalid('Runtime extension binding handler is invalid.');
  }
  return Object.freeze({
    descriptor,
    [handlerName]: handler.value,
  }) as RuntimeExtensionBinding;
}

/**
 * Collects the runtime halves of an application's extensions into one checked, ordered list.
 *
 * Takes the bindings, each pairing a descriptor with the handler that implements it, and returns a
 * frozen list sorted by descriptor so that two applications declaring the same extensions in a
 * different order end up with the same list.
 *
 * Throws for a duplicate descriptor, a malformed one, a handler that does not match what its
 * descriptor declares, and for more bindings than the runtime's ceiling allows. The result goes to
 * `withExtensions`.
 */
export function defineRuntimeExtensions(
  bindings: readonly RuntimeExtensionBinding[],
): readonly RuntimeExtensionBinding[] {
  if (
    !Array.isArray(bindings) ||
    bindings.length > RUNTIME_LIMITS.extensionDescriptors
  ) {
    invalid('Runtime extension bindings exceed the fixed descriptor ceiling.');
  }
  const seen = new Set<string>();
  const normalized = bindings.map((binding) => normalizeBinding(binding));
  normalized.sort((left, right) =>
    compareCodePoint(key(left.descriptor), key(right.descriptor)),
  );
  for (const binding of normalized) {
    const identity = key(binding.descriptor);
    if (seen.has(identity)) {
      invalid(
        'Runtime extension bindings contain an invalid or duplicate descriptor.',
      );
    }
    seen.add(identity);
  }
  return Object.freeze(normalized);
}

/**
 * The bindings this runtime has, and the check that they are the ones the catalogs require.
 *
 * `specs/05-compiled-artifacts-and-trust.spec.md` section 6 makes a missing binding and a binding
 * whose descriptor differs the same refusal. The comparison is over the canonical descriptor rather
 * than over its identity, so a descriptor that changed shape under the same name is caught.
 */
export class RuntimeExtensions {
  private readonly bindings: ReadonlyMap<string, RuntimeExtensionBinding>;

  constructor(
    bindings: readonly RuntimeExtensionBinding[] = [],
    required: readonly RuntimeExtensionDescriptor[] = [],
  ) {
    const normalized = defineRuntimeExtensions(bindings);
    this.bindings = new Map(
      normalized.map((binding) => [key(binding.descriptor), binding]),
    );
    for (const descriptor of required) {
      const admitted = normalizeDescriptor(descriptor);
      const binding = this.bindings.get(key(admitted));
      if (
        binding === undefined ||
        descriptorSnapshot(binding.descriptor).canonical !==
          descriptorSnapshot(admitted).canonical
      ) {
        invalid(
          `Required runtime extension ${admitted.kind}/${admitted.id} is missing or fingerprint-incompatible.`,
        );
      }
    }
  }

  messageFunction(id: string): RuntimeMessageFunctionBinding | undefined {
    const binding = this.bindings.get(`message-function\u0000${id}`);
    return binding?.descriptor.kind === 'message-function'
      ? (binding as RuntimeMessageFunctionBinding)
      : undefined;
  }

  formattingAdapter(id: string): RuntimeFormattingAdapterBinding | undefined {
    const binding = this.bindings.get(`formatting-adapter\u0000${id}`);
    return binding?.descriptor.kind === 'formatting-adapter'
      ? (binding as RuntimeFormattingAdapterBinding)
      : undefined;
  }

  parsingAdapter(id: string): RuntimeParsingAdapterBinding | undefined {
    const binding = this.bindings.get(`parsing-adapter\u0000${id}`);
    return binding?.descriptor.kind === 'parsing-adapter'
      ? (binding as RuntimeParsingAdapterBinding)
      : undefined;
  }

  projectSlot(part: LocalizedSlotPart): string | undefined {
    const binding = this.bindings.get(`rich-slot-kind\u0000${part.slotKind}`);
    if (binding?.descriptor.kind !== 'rich-slot-kind') return undefined;
    const value = (binding as RuntimeRichSlotKindBinding).projectText(part);
    if (
      typeof value !== 'string' ||
      codePointLengthAtMost(value, RUNTIME_LIMITS.outputCodePoints) ===
        undefined
    ) {
      invalid(`Rich-slot projection ${part.slotKind} returned invalid text.`);
    }
    return value;
  }
}
