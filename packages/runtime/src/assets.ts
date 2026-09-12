// An application's own images and documents, and the few of them that have a language.
//
// `specs/09-safe-content-and-ux.spec.md` section 14 keeps an asset locale-neutral until the
// application declares otherwise, so a descriptor's source stays opaque consumer data that
// Atlas never builds, parses, or fetches, and a variant is chosen from an explicit ordered
// fallback list rather than from a chain Atlas guessed. A report about a dynamic asset carries
// status, identity and representation and no payload, because the payload is the consumer's.

import {
  directionForLocale,
  LocalizationError,
  type LocaleDirection,
  type LocalizationParticipantOperationalReason,
  type LocalizationParticipantReport,
  type LocalizationParticipantRepresentation,
  type LocalizedParts,
  type LocalizedText,
} from '@neolorn/atlas/core';
import { languageForLocale } from './evaluator';

/**
 * Copy that describes an asset, either as finished text or as the parts a template places.
 *
 * Parts are what a caption carrying a link or an emphasized run needs. Plain text is enough for
 * everything else.
 */
export type LocalizedAssetDescription = LocalizedText | LocalizedParts;

/**
 * The words that go around an asset, held apart from the asset itself.
 *
 * Every field is optional, and each one supplied is already localized: this copy comes from the
 * catalog like any other message, so Atlas carries it through resolution rather than choosing it
 * per locale. Which fields an asset needs is the application's judgement, not a shape Atlas checks.
 */
export interface LocalizedAssetMetadata {
  /** The short substitute an assistive reader announces in place of the asset. */
  readonly alt?: LocalizedText;
  /** The line shown beside the asset, which may carry parts. */
  readonly caption?: LocalizedAssetDescription;
  /** The full text of what an audio or video asset says. */
  readonly transcript?: LocalizedAssetDescription;
  /** The short name of the control an asset stands for, such as an icon button. */
  readonly label?: LocalizedText;
  /** The long description, for an asset no short substitute can carry, such as a chart. */
  readonly description?: LocalizedAssetDescription;
}

interface AssetDescriptorBase {
  readonly id: string;
}

/**
 * An asset that reads the same in every locale: a logo, a product photo, a wordless diagram.
 *
 * Resolution returns the one source whatever locale is asked for, and reports no fallback, because
 * nothing was substituted.
 */
export interface NeutralAssetDescriptor<Source> extends AssetDescriptorBase {
  readonly kind: 'neutral';
  /**
   * Whatever the application uses to reach the asset: a URL, an import, a handle.
   *
   * Atlas holds it and never builds, parses or fetches it, so the type is the application's own.
   */
  readonly source: Source;
}

/** One locale's version of an asset, as the locale paired with the source that serves it. */
export interface LocalizedAssetVariant<Source> {
  /** The locale this version is for, canonically spelled. No two variants may name the same one. */
  readonly locale: string;
  /** How the application reaches this version. Opaque to Atlas. */
  readonly source: Source;
}

/**
 * What to serve when no variant matches, stated by the application rather than worked out.
 *
 * Either a version with no language in it, or a version in one named language whose direction the
 * application declares. A descriptor with no fallback resolves to unavailable instead, which is the
 * honest outcome: serving text in a language the reader did not ask for is worse than serving none.
 */
export type LocalizedAssetFallback<Source> =
  | {
      readonly kind: 'language-independent';
      readonly source: Source;
    }
  | {
      readonly kind: 'fixed-language';
      readonly source: Source;
      readonly language: string;
      readonly direction: LocaleDirection;
    };

/**
 * An asset that exists in several locales, with those locales listed and the miss case declared.
 *
 * The list is the whole of the policy. Resolution walks the target locale and then the fallback
 * locales the request names, in that order, and widens no further on its own.
 */
export interface VariantAssetDescriptor<Source> extends AssetDescriptorBase {
  readonly kind: 'localized-variants';
  /**
   * The versions that exist, each on a distinct canonical locale.
   *
   * Sorted by locale when the descriptor is built, so two descriptors carrying the same variants
   * compare as the same thing however they were written.
   */
  readonly variants: readonly LocalizedAssetVariant<Source>[];
  /** What to serve when no variant answers. Absent means the asset resolves to unavailable. */
  readonly fallback?: LocalizedAssetFallback<Source>;
}

/**
 * An asset that is in one language and stays in it whoever is reading.
 *
 * A signed contract, a scanned form, a screenshot of an interface that exists in one language only.
 * Resolution returns it for every target locale and reports its language and direction alongside,
 * so the page can mark up the region it sits in rather than letting it inherit the page's.
 */
export interface FixedLanguageAssetDescriptor<
  Source,
> extends AssetDescriptorBase {
  readonly kind: 'fixed-language';
  /** How the application reaches it. Opaque to Atlas. */
  readonly source: Source;
  /** The language the asset is in, canonically spelled. The asset's language, not the reader's. */
  readonly language: string;
  /** Which way that language runs, for the `dir` on whatever wraps the asset. */
  readonly direction: LocaleDirection;
}

/**
 * Any of the three ways an asset can be declared.
 *
 * What `resolveLocalizedAsset` takes, so one rendering path handles assets that are neutral,
 * translated, or fixed in a single language without branching on which kind it was handed.
 */
export type LocalizedAssetDescriptor<Source> =
  | NeutralAssetDescriptor<Source>
  | VariantAssetDescriptor<Source>
  | FixedLanguageAssetDescriptor<Source>;

/** What to resolve an asset for: the locale, the fallbacks allowed, and the copy to carry. */
export interface LocalizedAssetResolutionRequest {
  /**
   * The locale to serve, canonically spelled, which is normally the one currently committed.
   *
   * It and the fallback locales together may not exceed 33 entries; duplicates are dropped rather
   * than refused.
   */
  readonly targetLocale: string;
  /** Explicit application policy; Atlas never guesses a locale fallback chain. */
  readonly fallbackLocales?: readonly string[];
  /** Descriptive copy is already localized independently from the asset. */
  readonly metadata?: LocalizedAssetMetadata;
}

interface LocalizedAssetResolutionBase {
  readonly assetId: string;
  readonly targetLocale: string;
  readonly attemptedLocales: readonly string[];
  readonly metadata: LocalizedAssetMetadata;
}

/**
 * What resolution returns: a source with everything needed to mark it up, or a stated miss.
 *
 * Both arms carry the asset identity, the locale asked for, and the locales tried in order, so a
 * miss can be explained without running the resolution again. A ready result says whether what it
 * found was the target locale or a fallback, and its representation says whether the source carries
 * no language, is bound to the locale that supplied it, or is fixed in one language.
 */
export type ResolvedLocalizedAsset<Source> =
  | (LocalizedAssetResolutionBase & {
      readonly status: 'ready';
      readonly fallback: boolean;
      readonly representation:
        | {
            readonly kind: 'language-independent';
            readonly source: Source;
          }
        | {
            readonly kind: 'locale-bound';
            readonly source: Source;
            readonly supplyingLocale: string;
            readonly language: string;
            readonly direction: LocaleDirection;
          }
        | {
            readonly kind: 'fixed-language';
            readonly source: Source;
            readonly language: string;
            readonly direction: LocaleDirection;
          };
    })
  | (LocalizedAssetResolutionBase & {
      readonly status: 'unavailable';
      readonly outcome: 'localized-representation-unavailable';
    });

/**
 * How an asset the application fetched itself is to be marked up.
 *
 * Bound to the locale that supplied it, carrying no language at all, or fixed in one. The
 * participant states this rather than Atlas deciding it, because the application is the side that
 * knows what came back.
 */
export type DynamicAssetParticipantRepresentation =
  | {
      readonly kind: 'locale-bound';
      readonly supplyingLocale: string;
    }
  | {
      readonly kind: 'language-independent';
      readonly direction?: LocaleDirection;
    }
  | {
      readonly kind: 'fixed-language';
      readonly language: string;
      readonly direction: LocaleDirection;
    };

interface DynamicAssetParticipantBase {
  readonly assetId: string;
  readonly representationId?: string;
  readonly revision?: string;
}

/**
 * What a participant states about an asset it fetched, in place of the asset.
 *
 * Carries the asset identity, optionally which representation and which revision it got, and one of
 * four outcomes: ready with its representation, unavailable, a domain outcome under the
 * application's own code, or a failure with an operational reason. No source and no payload come
 * through here, so a report can be logged whole without carrying the application's content into
 * Atlas.
 */
export type DynamicAssetParticipantReportInput =
  | (DynamicAssetParticipantBase & {
      readonly status: 'ready';
      readonly representation: DynamicAssetParticipantRepresentation;
    })
  | (DynamicAssetParticipantBase & {
      readonly status: 'unavailable';
    })
  | (DynamicAssetParticipantBase & {
      readonly status: 'domain-outcome';
      readonly code: string;
      readonly representation?: DynamicAssetParticipantRepresentation;
    })
  | (DynamicAssetParticipantBase & {
      readonly status: 'failed';
      readonly reason: LocalizationParticipantOperationalReason;
    });

function invalidAsset(message: string): never {
  throw new LocalizationError(
    Object.freeze({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message,
    }),
  );
}

function validIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function validOpaqueIdentity(value: string | undefined): boolean {
  return (
    value === undefined ||
    (value.length > 0 &&
      value.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(value))
  );
}

function canonicalLocale(locale: string): boolean {
  if (locale.length === 0 || locale.length > 64) return false;
  try {
    return Intl.getCanonicalLocales(locale)[0] === locale;
  } catch {
    return false;
  }
}

function validDirection(direction: unknown): direction is LocaleDirection {
  return direction === 'ltr' || direction === 'rtl';
}

function assertDescriptorBase(id: string): void {
  if (!validIdentity(id)) {
    invalidAsset(
      'Asset identities must be bounded invariant application-owned codes.',
    );
  }
}

function freezeFallback<Source>(
  fallback: LocalizedAssetFallback<Source> | undefined,
): LocalizedAssetFallback<Source> | undefined {
  if (fallback === undefined) return undefined;
  if (fallback.kind === 'language-independent') {
    return Object.freeze({
      kind: 'language-independent',
      source: fallback.source,
    });
  }
  // The remaining kind is the one the type leaves, and the one a caller wrote is read here.
  const fallbackKind: unknown = fallback.kind;
  if (
    fallbackKind !== 'fixed-language' ||
    !canonicalLocale(fallback.language) ||
    !validDirection(fallback.direction)
  ) {
    return invalidAsset('A fixed-language asset fallback is invalid.');
  }
  return Object.freeze({
    kind: 'fixed-language',
    source: fallback.source,
    language: fallback.language,
    direction: fallback.direction,
  });
}

function freezeMetadata(
  metadata: LocalizedAssetMetadata | undefined,
): LocalizedAssetMetadata {
  if (metadata === undefined) return Object.freeze({});
  return Object.freeze({
    ...(metadata.alt === undefined ? {} : { alt: metadata.alt }),
    ...(metadata.caption === undefined ? {} : { caption: metadata.caption }),
    ...(metadata.transcript === undefined
      ? {}
      : { transcript: metadata.transcript }),
    ...(metadata.label === undefined ? {} : { label: metadata.label }),
    ...(metadata.description === undefined
      ? {}
      : { description: metadata.description }),
  });
}

/**
 * Declares an asset that is the same in every locale.
 *
 * Takes the identity the application knows it by and whatever it uses to reach it, and returns a
 * frozen descriptor. Throws for an identity that is not a bounded invariant code, because an
 * identity built out of a locale or a path changes under the thing it is supposed to identify.
 */
export function neutralAsset<Source>(
  id: string,
  source: Source,
): NeutralAssetDescriptor<Source> {
  assertDescriptorBase(id);
  return Object.freeze({ kind: 'neutral', id, source });
}

/**
 * Declares an asset that exists in several locales, with each version named explicitly.
 *
 * Takes the identity, one to 256 variants on distinct canonical locales, and optionally what to
 * serve when none of them fits. Returns a frozen descriptor whose variants are sorted by locale.
 *
 * Throws for a repeated or non-canonical locale, for an empty or oversized list, and for a
 * fixed-language fallback missing a valid language or direction.
 */
export function localizedAsset<Source>(
  id: string,
  variants: readonly LocalizedAssetVariant<Source>[],
  fallback?: LocalizedAssetFallback<Source>,
): VariantAssetDescriptor<Source> {
  assertDescriptorBase(id);
  if (variants.length === 0 || variants.length > 256) {
    invalidAsset('Localized assets require one to 256 explicit variants.');
  }
  const seen = new Set<string>();
  const normalized = variants
    .map((variant) => {
      if (!canonicalLocale(variant.locale) || seen.has(variant.locale)) {
        return invalidAsset(
          'Localized asset variants require unique canonical locales.',
        );
      }
      seen.add(variant.locale);
      return Object.freeze({ locale: variant.locale, source: variant.source });
    })
    .sort((left, right) =>
      left.locale < right.locale ? -1 : left.locale > right.locale ? 1 : 0,
    );
  const normalizedFallback = freezeFallback(fallback);
  return Object.freeze({
    kind: 'localized-variants',
    id,
    variants: Object.freeze(normalized),
    ...(normalizedFallback === undefined
      ? {}
      : { fallback: normalizedFallback }),
  });
}

/**
 * Declares an asset that stays in one language whatever the reader's locale is.
 *
 * Takes the identity, the source, the language the asset is in, and the direction that language
 * runs. Returns a frozen descriptor. Throws for a language tag that is not canonical or a direction
 * that is neither `ltr` nor `rtl`.
 */
export function fixedLanguageAsset<Source>(
  id: string,
  source: Source,
  language: string,
  direction: LocaleDirection,
): FixedLanguageAssetDescriptor<Source> {
  assertDescriptorBase(id);
  if (!canonicalLocale(language) || !validDirection(direction)) {
    invalidAsset('A fixed-language asset requires valid language metadata.');
  }
  return Object.freeze({
    kind: 'fixed-language',
    id,
    source,
    language,
    direction,
  });
}

function localeSequence(
  request: LocalizedAssetResolutionRequest,
): readonly string[] {
  if (!canonicalLocale(request.targetLocale)) {
    return invalidAsset('Asset selection requires a canonical target locale.');
  }
  const values = [request.targetLocale, ...(request.fallbackLocales ?? [])];
  if (values.length > 33) {
    return invalidAsset('Asset selection exceeds the explicit fallback bound.');
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const locale of values) {
    if (!canonicalLocale(locale)) {
      return invalidAsset('Asset fallback policy contains an invalid locale.');
    }
    if (!seen.has(locale)) {
      seen.add(locale);
      normalized.push(locale);
    }
  }
  return Object.freeze(normalized);
}

/**
 * Picks which version of an asset to serve, and reports what it found.
 *
 * Takes a descriptor of any of the three kinds and a request naming the target locale, the fallback
 * locales allowed, and the copy to carry. Returns a ready result with a source and its
 * representation, or an unavailable one.
 *
 * The search is the target locale followed by the fallback locales in the order given, and nothing
 * else: a request for `fr-CA` does not try `fr` unless the request lists it. A fallback that was
 * taken is reported as a fallback, so a substituted asset can be marked up or logged rather than
 * noticed by eye.
 *
 * Throws for a target or fallback locale that is not canonical, and for a policy longer than 33
 * locales.
 */
export function resolveLocalizedAsset<Source>(
  descriptor: LocalizedAssetDescriptor<Source>,
  request: LocalizedAssetResolutionRequest,
): ResolvedLocalizedAsset<Source> {
  assertDescriptorBase(descriptor.id);
  const attemptedLocales = localeSequence(request);
  const common = {
    assetId: descriptor.id,
    targetLocale: request.targetLocale,
    attemptedLocales,
    metadata: freezeMetadata(request.metadata),
  } as const;
  if (descriptor.kind === 'neutral') {
    return Object.freeze({
      ...common,
      status: 'ready',
      fallback: false,
      representation: Object.freeze({
        kind: 'language-independent' as const,
        source: descriptor.source,
      }),
    });
  }
  if (descriptor.kind === 'fixed-language') {
    if (
      !canonicalLocale(descriptor.language) ||
      !validDirection(descriptor.direction)
    ) {
      return invalidAsset('A fixed-language asset descriptor is invalid.');
    }
    return Object.freeze({
      ...common,
      status: 'ready',
      fallback: false,
      representation: Object.freeze({
        kind: 'fixed-language' as const,
        source: descriptor.source,
        language: descriptor.language,
        direction: descriptor.direction,
      }),
    });
  }
  // Read as what the caller named rather than as the one kind the two tests above leave.
  const descriptorKind: unknown = descriptor.kind;
  if (descriptorKind !== 'localized-variants') {
    return invalidAsset('The localized asset descriptor kind is invalid.');
  }
  const normalizedDescriptor = localizedAsset(
    descriptor.id,
    descriptor.variants,
    descriptor.fallback,
  );
  const variants = new Map(
    normalizedDescriptor.variants.map((variant) => [variant.locale, variant]),
  );
  for (const locale of attemptedLocales) {
    const variant = variants.get(locale);
    if (variant !== undefined) {
      return Object.freeze({
        ...common,
        status: 'ready',
        fallback: locale !== request.targetLocale,
        representation: Object.freeze({
          kind: 'locale-bound' as const,
          source: variant.source,
          supplyingLocale: locale,
          language: languageForLocale(locale),
          direction: directionForLocale(locale),
        }),
      });
    }
  }
  if (normalizedDescriptor.fallback?.kind === 'language-independent') {
    return Object.freeze({
      ...common,
      status: 'ready',
      fallback: true,
      representation: Object.freeze({
        kind: 'language-independent' as const,
        source: normalizedDescriptor.fallback.source,
      }),
    });
  }
  if (normalizedDescriptor.fallback?.kind === 'fixed-language') {
    return Object.freeze({
      ...common,
      status: 'ready',
      fallback: true,
      representation: Object.freeze({
        kind: 'fixed-language' as const,
        source: normalizedDescriptor.fallback.source,
        language: normalizedDescriptor.fallback.language,
        direction: normalizedDescriptor.fallback.direction,
      }),
    });
  }
  return Object.freeze({
    ...common,
    status: 'unavailable',
    outcome: 'localized-representation-unavailable',
  });
}

function participantIdentity(input: DynamicAssetParticipantBase) {
  if (
    !validIdentity(input.assetId) ||
    !validOpaqueIdentity(input.representationId) ||
    !validOpaqueIdentity(input.revision)
  ) {
    return invalidAsset('Dynamic asset participant identity is invalid.');
  }
  return Object.freeze({
    resourceId: input.assetId,
    ...(input.representationId === undefined
      ? {}
      : { representationId: input.representationId }),
    ...(input.revision === undefined ? {} : { revision: input.revision }),
  });
}

function participantRepresentation(
  value: DynamicAssetParticipantRepresentation,
): LocalizationParticipantRepresentation {
  switch (value.kind) {
    case 'locale-bound':
      if (!canonicalLocale(value.supplyingLocale)) {
        return invalidAsset(
          'Dynamic localized assets require a canonical supplying locale.',
        );
      }
      return Object.freeze({
        kind: 'locale-bound',
        supplyingLocale: value.supplyingLocale,
        direction: directionForLocale(value.supplyingLocale),
      });
    case 'language-independent':
      if (value.direction !== undefined && !validDirection(value.direction)) {
        return invalidAsset('Dynamic asset direction metadata is invalid.');
      }
      return Object.freeze({
        kind: 'language-independent',
        ...(value.direction === undefined
          ? {}
          : { direction: value.direction }),
      });
    case 'fixed-language':
      if (
        !canonicalLocale(value.language) ||
        !validDirection(value.direction)
      ) {
        return invalidAsset(
          'Dynamic fixed-language asset metadata is invalid.',
        );
      }
      return Object.freeze({
        kind: 'fixed-language',
        language: value.language,
        direction: value.direction,
      });
  }
}

const participantFailureReasons =
  new Set<LocalizationParticipantOperationalReason>([
    'invalid-configuration',
    'unsupported-capability',
    'compatibility-rejection',
    'security-rejection',
    'environment-failure',
    'internal-failure',
  ]);

/**
 * Produces only safe participant metadata. Asset payloads, URLs, acquisition,
 * authorization, storage, and cache state never cross this boundary.
 */
export function dynamicAssetParticipantReport(
  input: DynamicAssetParticipantReportInput,
): LocalizationParticipantReport {
  const identity = participantIdentity(input);
  switch (input.status) {
    case 'ready':
      return Object.freeze({
        status: 'ready',
        identity,
        representation: participantRepresentation(input.representation),
      });
    case 'unavailable':
      return Object.freeze({
        status: 'unavailable',
        outcome: 'localized-representation-unavailable',
        identity,
      });
    case 'domain-outcome':
      if (!validIdentity(input.code)) {
        return invalidAsset('Dynamic asset domain outcome code is invalid.');
      }
      return Object.freeze({
        status: 'domain-outcome',
        outcome: 'consumer-domain-outcome',
        code: input.code,
        identity,
        ...(input.representation === undefined
          ? {}
          : {
              representation: participantRepresentation(input.representation),
            }),
      });
    case 'failed':
      if (!participantFailureReasons.has(input.reason)) {
        return invalidAsset('Dynamic asset failure reason is invalid.');
      }
      return Object.freeze({
        status: 'failed',
        outcome: 'operational-failure',
        reason: input.reason,
        identity,
      });
  }
}
