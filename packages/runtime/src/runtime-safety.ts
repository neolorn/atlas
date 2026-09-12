// The fixed ceilings, and the snapshot that turns an untrusted value into inert data.
//
// Every bound here is a constant rather than a setting, because
// `specs/05-compiled-artifacts-and-trust.spec.md` section 7 puts the ceilings out of reach of the
// artifact and the consumer alike.
//
// Section 1 of `specs/05-compiled-artifacts-and-trust.spec.md` is what the snapshot enforces: a
// candidate is copied into plain data before anything reads it, so an accessor, a foreign
// prototype or a cycle in the candidate never reaches the code that evaluates messages.
import {
  LocalizationError,
  type LocalizationDiagnostic,
} from '@neolorn/atlas/core';

/**
 * Every ceiling the runtime enforces, as one frozen table of counts and byte sizes.
 *
 * Published so a consumer can read a bound rather than discover it by hitting it: a build script
 * can check a catalog against `messagesPerCatalog` before shipping it, and a test can assert on the
 * same number the runtime refuses at. Nothing here is a setting. A limit that an artifact or an
 * application could raise would be a limit an attacker could raise, so the values are fixed for a
 * given version of Atlas and a change to one is a change to the package.
 */
export const RUNTIME_LIMITS = Object.freeze({
  catalogBytes: 16_777_216,
  catalogsPerTransfer: 512,
  transferBytes: 67_108_864,
  jsonDepth: 128,
  jsonNodes: 2_500_000,
  messagesPerCatalog: 20_000,
  identifiersPerCatalog: 4_000_000,
  literalsPerCatalog: 2_000_000,
  irNodesPerCatalog: 2_000_000,
  selectorsPerCatalog: 320_000,
  variantsPerCatalog: 2_000_000,
  inputsPerCatalog: 2_560_000,
  slotsPerCatalog: 2_560_000,
  referencesPerCatalog: 2_000_000,
  functionsPerCatalog: 2_000_000,
  outputPartsPerCatalog: 2_000_000,
  inputsPerMessage: 128,
  slotsPerMessage: 128,
  selectorsPerMessage: 16,
  variantsPerMessage: 4_096,
  outputPartsPerMessage: 65_536,
  formatterCacheEntries: 4_096,
  evaluationSteps: 1_000_000,
  evaluationReferences: 262_144,
  evaluationFunctions: 65_536,
  evaluationLiterals: 262_144,
  outputCodePoints: 65_536,
  outputParts: 65_536,
  localizedInputCodePoints: 65_536,
  canonicalNumberCodeUnits: 65_536,
  destinationCodeUnits: 8_192,
  /**
   * Addresses a transferred route record may carry: one per locale a build can be addressed in.
   *
   * The same bound as `catalogsPerTransfer`, for the same reason. It is far past any real locale
   * set, and what it is for is the record that is not real: a transfer state is served to a
   * document and comes back edited, so every list in it needs a length that stops the reader
   * before the work does.
   */
  transferredAddresses: 512,
  destinationOrigins: 64,
  destinationOriginCodeUnits: 2_048,
  extensionDescriptors: 256,
  extensionOptions: 128,
  extensionOptionValues: 256,
  /**
   * Keys one extension result may claim to match.
   *
   * The list comes from consumer code and is walked once per variant, so it needs a length that
   * stops the reader before the work does. It is the variant ceiling the compiler already enforces
   * per message, because a key that matches no variant changes nothing.
   */
  extensionSelectKeys: 4_096,
  diagnosticIdentifierCodePoints: 128,
} as const);

export interface InertJsonLimits {
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  readonly maximumCodeUnits: number;
}

export interface InertJsonSnapshot {
  readonly value: unknown;
  readonly canonical: string;
  readonly nodes: number;
  readonly depth: number;
  readonly utf8Bytes: number;
}

/**
 * A value whose stamped fields carry what was read rather than what a valid one would hold.
 *
 * A profile, a schema or an ABI marker is declared as the single literal a correct artifact
 * carries. That is a description of an artifact which has been checked, and a claim about one
 * which has not. A function that receives an artifact takes it in this form, so that reading the
 * stamp is a comparison against the bytes rather than a formality the compiler folds away.
 *
 * Only the stamps widen. Every other field keeps the type it had, because every other check
 * already compares values the type system does not pin to one literal.
 */
export type AsReceived<Value, Stamp extends keyof Value> = Omit<
  Value,
  Stamp
> & {
  readonly [Key in Stamp]: unknown;
};

export function hasOwn(value: object, property: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

export function isDataRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * An object that is not an array, without asking what it was constructed from.
 *
 * Weaker than `isDataRecord` on purpose. The callers are walking values Atlas itself produced, or
 * participant data an application hands over as its own object, where a class instance is a
 * legitimate answer and the prototype check would refuse it.
 */
export function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Orders two keys by code point, for a table whose order has to be the same on every run. */
export function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A path a transferred record may state, held to what the address bar could hold.
 *
 * This was written inline for the transferred route's `canonicalPath` and is shared now that the
 * record carries a second kind of address. It is not a formality: an address that leaves here is
 * written to a link's `href` by the locale switcher, and a transfer state is served to a document
 * and can come back edited, so a string that leaves this function is a string a reader can be
 * sent to. A schemed URL is refused by the leading `/`, another site by the refusal of `//`, a
 * separator some parsers fold by the backslash, and a display spoof by the control scan.
 */
export function isTransferredPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    value.length <= RUNTIME_LIMITS.destinationCodeUnits &&
    !/\\/u.test(value) &&
    !containsUrlSpoofingControl(value)
  );
}

/**
 * The optional address table on a transferred route record, or nothing at all.
 *
 * One bad entry refuses the table, and the caller refuses the whole transfer for it. That is the
 * proportionate answer rather than a harsh one: a transfer with one edited address is not a
 * transfer with one bad address, it is a transfer someone has been inside, and the document can
 * render from its own generated defaults instead.
 */
export function areTransferredAddresses(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isDataRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > RUNTIME_LIMITS.transferredAddresses) return false;
  return entries.every(
    ([locale, address]) =>
      locale.length > 0 && locale.length <= 128 && isTransferredPath(address),
  );
}

export function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string')
  );
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    return Object.freeze(value);
  }
  if (isDataRecord(value)) {
    for (const item of Object.values(value)) freezeJson(item);
    return Object.freeze(value);
  }
  return value;
}

export function snapshotInertJson(
  candidate: unknown,
  limits: InertJsonLimits,
): InertJsonSnapshot {
  if (
    !Number.isSafeInteger(limits.maximumDepth) ||
    !Number.isSafeInteger(limits.maximumNodes) ||
    !Number.isSafeInteger(limits.maximumCodeUnits) ||
    limits.maximumDepth < 1 ||
    limits.maximumNodes < 1 ||
    limits.maximumCodeUnits < 1
  ) {
    throw new TypeError('Inert JSON admission limits are invalid.');
  }
  const active = new WeakSet<object>();
  let nodes = 0;
  let maximumDepth = 0;
  let codeUnits = 0;

  const copy = (value: unknown, depth: number): unknown => {
    nodes += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    if (nodes > limits.maximumNodes || depth > limits.maximumDepth) {
      throw new TypeError('Inert JSON exceeds its structural limit.');
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (
        !Number.isFinite(value) ||
        Object.is(value, -0) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      ) {
        throw new TypeError('Inert JSON contains a non-canonical number.');
      }
      return value;
    }
    if (typeof value === 'string') {
      if (!validUnicode(value)) {
        throw new TypeError('Inert JSON contains invalid Unicode.');
      }
      codeUnits += value.length;
      if (codeUnits > limits.maximumCodeUnits) {
        throw new TypeError('Inert JSON exceeds its aggregate string limit.');
      }
      return value;
    }
    if (typeof value !== 'object') {
      throw new TypeError('Only inert JSON data is admitted.');
    }
    if (active.has(value)) throw new TypeError('Inert JSON contains a cycle.');
    active.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Array.isArray(value)) {
        const keys = Reflect.ownKeys(value);
        if (
          keys.some((key) => typeof key !== 'string') ||
          !hasOwn(descriptors, 'length') ||
          Object.keys(descriptors).some(
            (key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key),
          ) ||
          Object.keys(descriptors).length !== value.length + 1
        ) {
          throw new TypeError('Inert JSON arrays must be dense data arrays.');
        }
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined ||
            !hasOwn(descriptor, 'value') ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined ||
            descriptor.enumerable !== true
          ) {
            throw new TypeError('Inert JSON arrays cannot contain accessors.');
          }
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      if (!isDataRecord(value)) {
        throw new TypeError('Inert JSON objects require a plain prototype.');
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !validUnicode(key)) {
          throw new TypeError('Inert JSON object keys are invalid.');
        }
        codeUnits += key.length;
        if (codeUnits > limits.maximumCodeUnits) {
          throw new TypeError('Inert JSON exceeds its aggregate string limit.');
        }
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !hasOwn(descriptor, 'value') ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.enumerable !== true
        ) {
          throw new TypeError('Inert JSON objects cannot contain accessors.');
        }
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } finally {
      active.delete(value);
    }
  };

  const value = freezeJson(copy(candidate, 1));
  const canonical = canonicalJson(value);
  const utf8Bytes = new TextEncoder().encode(canonical).byteLength;
  if (utf8Bytes > limits.maximumCodeUnits * 4 + nodes * 16) {
    throw new TypeError('Inert JSON exceeds its encoded aggregate limit.');
  }
  return Object.freeze({
    value,
    canonical,
    nodes,
    depth: maximumDepth,
    utf8Bytes,
  });
}

export function codePointLengthAtMost(
  value: string,
  maximum: number,
): number | undefined {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    value.length > maximum * 2
  ) {
    return undefined;
  }
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return undefined;
  }
  return count;
}

export function safeDiagnosticIdentifier(
  value: unknown,
  maximum = RUNTIME_LIMITS.diagnosticIdentifierCodePoints,
): string {
  if (typeof value !== 'string') return '<invalid>';
  let result = '';
  let count = 0;
  for (const character of value) {
    if (count >= maximum) {
      result += '\u2026';
      break;
    }
    result += /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(character)
      ? '\ufffd'
      : character;
    count += 1;
  }
  return result;
}

export function containsUrlSpoofingControl(value: string): boolean {
  return /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(
    value,
  );
}

export function waitForSignal<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Aborted', 'AbortError'),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

export function sha256Base64Url(value: string): string {
  const source = new TextEncoder().encode(value);
  const bitLength = source.length * 8;
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15] as number;
      const second = words[index - 2] as number;
      const sigma0 =
        rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
      const sigma1 =
        rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] =
        ((words[index - 16] as number) +
          sigma0 +
          (words[index - 7] as number) +
          sigma1) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const big1 =
        rotateRight(e as number, 6) ^
        rotateRight(e as number, 11) ^
        rotateRight(e as number, 25);
      const choice =
        ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const temporary1 =
        ((h as number) +
          big1 +
          choice +
          (constants[index] as number) +
          (words[index] as number)) >>>
        0;
      const big0 =
        rotateRight(a as number, 2) ^
        rotateRight(a as number, 13) ^
        rotateRight(a as number, 22);
      const majority =
        ((a as number) & (b as number)) ^
        ((a as number) & (c as number)) ^
        ((b as number) & (c as number));
      const temporary2 = (big0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = ((d as number) + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] as number) + (a as number)) >>> 0;
    hash[1] = ((hash[1] as number) + (b as number)) >>> 0;
    hash[2] = ((hash[2] as number) + (c as number)) >>> 0;
    hash[3] = ((hash[3] as number) + (d as number)) >>> 0;
    hash[4] = ((hash[4] as number) + (e as number)) >>> 0;
    hash[5] = ((hash[5] as number) + (f as number)) >>> 0;
    hash[6] = ((hash[6] as number) + (g as number)) >>> 0;
    hash[7] = ((hash[7] as number) + (h as number)) >>> 0;
  }
  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  hash.forEach((word, index) => digestView.setUint32(index * 4, word));
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let index = 0; index < digest.length; index += 3) {
    const first = digest[index] as number;
    const second = digest[index + 1];
    const third = digest[index + 2];
    result += alphabet[first >> 2];
    result += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) {
      result += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== undefined) result += alphabet[third & 63];
  }
  return result;
}

/**
 * A diagnostic with its identifiers made safe to print. It lived in `localization.ts` until
 * formatting moved out and took four of its thirty-five call sites with it: a helper two
 * modules need belongs to neither of them. `safeDiagnosticIdentifier`, which it is built on,
 * was already here.
 *
 * `specs/11-diagnostics-and-observability.spec.md` section 3 gives a runtime diagnostic a code
 * naming the operation, an outcome class naming what kind of thing happened, and bounded
 * identities that locate it. Every identity that reaches one passes through here first,
 * because a provider, scope or participant name is a value a consumer chose.
 */
export function operationalDiagnostic(
  code: LocalizationDiagnostic['code'],
  message: string,
  details: Partial<LocalizationDiagnostic> = {},
): LocalizationDiagnostic {
  const safeDetails = {
    ...details,
    ...(details.targetLocale === undefined
      ? {}
      : { targetLocale: safeDiagnosticIdentifier(details.targetLocale) }),
    ...(details.providerId === undefined
      ? {}
      : { providerId: safeDiagnosticIdentifier(details.providerId) }),
    ...(details.scopeId === undefined
      ? {}
      : { scopeId: safeDiagnosticIdentifier(details.scopeId) }),
    ...(details.participantId === undefined
      ? {}
      : { participantId: safeDiagnosticIdentifier(details.participantId) }),
  };
  return Object.freeze({
    code,
    outcome: 'operational-failure',
    message,
    ...safeDetails,
  });
}

/**
 * The diagnostic an error is carrying, or a safe one saying only that something failed.
 *
 * Here for the same reason as its neighbour above: eight of its nine call sites stayed in the
 * localization module and one left with formatting, and a helper that two modules need belongs
 * to neither of them.
 */
export function asDiagnostic(error: unknown): LocalizationDiagnostic {
  if (error instanceof LocalizationError) return error.diagnostic;
  return operationalDiagnostic(
    'internal-invariant',
    'Localization failed without exposing unsafe implementation details.',
  );
}
