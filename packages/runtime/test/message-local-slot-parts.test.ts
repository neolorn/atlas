import { describe, expect, it } from 'vitest';

import type {
  FormattingContext,
  LocalizedParts,
  LocalizedSlotPart,
  MessageHandle,
  RuntimeRichSlotKindBinding,
  RuntimeRichSlotKindDescriptor,
} from '@neolorn/atlas/core';
import { defineAtlasExtensionRegistry } from '../../toolkit/src/extensions.js';
import { parseAtlasMessage } from '../../toolkit/src/message-format.js';
import type { AtlasMessageSemanticModel } from '../../toolkit/src/message-format.js';
import type { CompiledCatalog } from '../src/catalog-runtime.js';
import {
  FormatterCache,
  evaluateCandidate,
  findEvaluationCandidate,
} from '../src/evaluator.js';
import { RuntimeExtensions } from '../src/extensions.js';

/**
 * What a message-local slot hands the two bindings that render one.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 3 gives a slot that is neither a link nor an
 * action to a template or a text binding, and section 4 says styling part of a message uses a
 * message-local slot implemented in trusted consumer code. Both bindings read the same object:
 * `LocalizedSlotTemplateContext` carries the slot part and nothing else, so every field asserted
 * here is one a consumer template can bind and one whose loss would be silent.
 *
 * The renderer itself is asserted in the consumer fixture, which is the only place an Angular
 * component can be instantiated: `vitest.config.ts` records why the primary entry point cannot be
 * loaded outside an Angular application. What belongs here is the part the renderer is given,
 * evaluated by the real evaluator against a real extension registry.
 *
 * The children are asserted rather than the projected string alone, because a template binding
 * renders them and a text binding does not, and a slot whose children arrived empty would still
 * project correctly through a `projectText` that ignores them.
 */

const REGISTRY = (() => {
  const registry = defineAtlasExtensionRegistry([
    {
      kind: 'rich-slot-kind',
      id: 'feature:badge',
      shape: 'paired',
      interactive: false,
      textProjection: 'binding-required',
      options: { tone: ['info', 'warning'] },
    },
  ]);
  if (!registry.ok) {
    throw new Error(
      `the descriptor under test was refused: ${registry.diagnostics
        .map(({ summary }) => summary)
        .join('; ')}`,
    );
  }
  return registry.value;
})();

const BADGE = REGISTRY
  .descriptors[0] as unknown as RuntimeRichSlotKindDescriptor;

/** Children in, text out. The half a `text` binding stands in for. */
const projection: RuntimeRichSlotKindBinding = Object.freeze({
  descriptor: BADGE,
  projectText: (part: LocalizedSlotPart) =>
    `Badge: ${part.children
      .map((child) => (child.kind === 'slot' ? '' : child.value))
      .join('')}`,
});

function parse(source: string): AtlasMessageSemanticModel {
  const parsed = parseAtlasMessage(source);
  if (!parsed.ok) {
    throw new Error(
      `The message under test did not parse: ${parsed.diagnostics
        .map((diagnostic) => diagnostic.summary)
        .join('; ')}`,
    );
  }
  return parsed.value;
}

function catalogFor(
  semantics: AtlasMessageSemanticModel,
  locale: string,
): CompiledCatalog {
  const body =
    semantics.kind === 'pattern'
      ? {
          kind: 'pattern',
          declarations: semantics.declarations,
          pattern: semantics.pattern,
        }
      : {
          kind: 'select',
          declarations: semantics.declarations,
          selectors: semantics.selectors,
          variants: semantics.variants,
        };
  const resources = {
    irNodes: 1,
    depth: 1,
    selectors: 0,
    variants: 0,
    inputs: 0,
    slots: 1,
    outputParts: 64,
  };
  return {
    profile: 'atlas-compiled-ir/1',
    generatedAbi: 'atlas-generated/1',
    standardsProfile: 'atlas-1',
    key: { providerId: 'slot', scopeId: 'slot', catalogLocale: locale },
    applicationContractFingerprint: 'test',
    semanticRegistryFingerprint: 'test',
    requiredExtensions: Object.freeze([]),
    messages: Object.freeze([
      {
        messageId: 'subject',
        kind: 'message' as const,
        resultKind: 'structured' as const,
        sourceFingerprint: 'test',
        inputs: Object.freeze([]),
        slots: Object.freeze([
          {
            name: 'badge',
            kind: 'feature:badge',
            shape: 'paired' as const,
            optional: false,
            repeatable: false,
            within: Object.freeze([]),
          },
        ]),
        body,
      },
    ]),
    resources: { ...resources, maximumMessage: resources },
  } as unknown as CompiledCatalog;
}

function evaluateParts(source: string, locale = 'en-US'): LocalizedParts {
  const handle: MessageHandle = {
    generatedAbi: 'atlas-generated/1',
    providerId: 'slot',
    scopeId: 'slot',
    messageId: 'subject',
    identity: 'slot:slot:subject',
    resultKind: 'structured',
    inputNames: Object.freeze([]),
    slotNames: Object.freeze(['badge']),
  } as MessageHandle;
  const context: FormattingContext = Object.freeze({ locale });
  const result = evaluateCandidate(
    handle,
    findEvaluationCandidate(handle, locale, [
      catalogFor(parse(source), locale),
    ]),
    {},
    context,
    new FormatterCache(8),
    new RuntimeExtensions([projection]),
  );
  if (result.kind !== 'parts') throw new Error('Expected a structured result.');
  return result;
}

function onlySlot(parts: LocalizedParts): LocalizedSlotPart {
  const slot = parts.value.find((part) => part.kind === 'slot');
  if (slot === undefined) {
    throw new Error('The message under test produced no slot part.');
  }
  return slot;
}

describe('a message-local slot part', () => {
  it('carries everything a template binding renders from', () => {
    const slot = onlySlot(evaluateParts('{#badge tone=info}New{/badge}'));

    expect(slot).toMatchObject({
      kind: 'slot',
      name: 'badge',
      slotKind: 'feature:badge',
      shape: 'paired',
      options: { tone: 'info' },
      language: 'en',
      direction: 'ltr',
      supplyingLocale: 'en-US',
    });
    // The children are the slot's content, which is what the outlet renders. A binding that
    // rendered the projected string instead would lose the emphasis a translator put inside it.
    expect(slot.children).toEqual([
      {
        kind: 'text',
        value: 'New',
        language: 'en',
        direction: 'ltr',
        supplyingLocale: 'en-US',
      },
    ]);
  });

  it('projects to the text a text binding stands in for', () => {
    const parts = evaluateParts('{#badge tone=info}New{/badge}');

    // `textProjection: 'binding-required'` means the registry's own projection decides this, so a
    // slot whose kind lost its binding projects to nothing rather than to its children.
    expect(parts.text).toBe('Badge: New');
  });

  it('carries the supplying catalog direction rather than the reader locale', () => {
    const slot = onlySlot(
      evaluateParts('{#badge tone=warning}جديد{/badge}', 'ar-EG'),
    );

    expect(slot).toMatchObject({
      slotKind: 'feature:badge',
      options: { tone: 'warning' },
      language: 'ar',
      direction: 'rtl',
      supplyingLocale: 'ar-EG',
    });
  });
});
