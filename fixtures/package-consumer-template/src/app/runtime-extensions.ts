import {
  defineRuntimeExtensions,
  type RuntimeExtensionDescriptor,
  type RuntimeFormattingAdapterBinding,
  type RuntimeIdentifierSegmentBinding,
  type RuntimeMessageFunctionBinding,
  type RuntimeParsingAdapterBinding,
  type RuntimeRichSlotKindBinding,
  type LocalizedPart,
} from '@neolorn/atlas';
import { configuration } from '#i18n';

type ExtensionKind = RuntimeExtensionDescriptor['kind'];

function descriptor<Kind extends ExtensionKind>(
  kind: Kind,
  id: string,
): Extract<RuntimeExtensionDescriptor, { readonly kind: Kind }> {
  const value = configuration.extensionDescriptors.find(
    (candidate) => candidate.kind === kind && candidate.id === id,
  );
  if (value === undefined) {
    throw new Error(
      `Generated Atlas extension descriptor ${kind}/${id} is absent.`,
    );
  }
  return value as Extract<RuntimeExtensionDescriptor, { readonly kind: Kind }>;
}

function projectedText(parts: readonly LocalizedPart[]): string {
  return parts
    .map((part) =>
      part.kind === 'slot' ? projectedText(part.children) : part.value,
    )
    .join('');
}

const uppercase = descriptor('message-function', 'feature:uppercase');
const state = descriptor('identifier-segment', 'feature:state');
const badge = descriptor('rich-slot-kind', 'feature:badge');
const skuFormat = descriptor('formatting-adapter', 'feature:sku-format');
const skuParse = descriptor('parsing-adapter', 'feature:sku-parse');

/** The SKU an adapter parses back out of localized text. */
export interface FeatureSku {
  readonly value: string;
}

/**
 * Exported so call sites can name the adapter itself.
 *
 * `formatWithAdapter('feature:sku-format', value)` addressed an adapter by an unchecked string and
 * carried a value unrelated to it. The binding knows both its identity and the value it works
 * with, which is what makes a call site checkable.
 */
export const skuFormatAdapter = Object.freeze<
  RuntimeFormattingAdapterBinding<string>
>({
  descriptor: skuFormat,
  format: ({ value }) => Object.freeze({ text: `SKU-${value.toUpperCase()}` }),
});

export const skuParseAdapter = Object.freeze<
  RuntimeParsingAdapterBinding<FeatureSku>
>({
  descriptor: skuParse,
  parse: ({ text }) => {
    const value = text.trim().replace(/^SKU-/iu, '').toUpperCase();
    return /^[A-Z0-9-]+$/u.test(value)
      ? Object.freeze({
          status: 'valid' as const,
          text,
          value: Object.freeze({ value }),
        })
      : Object.freeze({
          status: 'invalid' as const,
          text,
          diagnostic: Object.freeze({
            code: 'invalid-localized-input' as const,
            outcome: 'operational-failure' as const,
            message: 'The feature-lab SKU is invalid.',
          }),
        });
  },
});

export const atlasRuntimeExtensions = defineRuntimeExtensions([
  Object.freeze({
    descriptor: uppercase,
    evaluate: ({ operand, options, locale }) => {
      const value = (operand as string).toLocaleUpperCase(locale);
      return Object.freeze({
        text: options['emphasis'] === 'loud' ? `${value}!` : value,
        value,
      });
    },
  } satisfies RuntimeMessageFunctionBinding),
  Object.freeze({
    descriptor: state,
    canonicalize: (value: string) => {
      const canonical = value.normalize('NFC').toLowerCase();
      return /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/u.test(canonical)
        ? canonical
        : undefined;
    },
  } satisfies RuntimeIdentifierSegmentBinding),
  Object.freeze({
    descriptor: badge,
    projectText: (part) => `Badge: ${projectedText(part.children)}`,
  } satisfies RuntimeRichSlotKindBinding),
  skuFormatAdapter,
  skuParseAdapter,
]);
