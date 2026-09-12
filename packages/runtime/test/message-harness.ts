import {
  parseAtlasMessage,
  type AtlasMessageCustomFunction,
  type AtlasMessageSemanticModel,
} from '../../toolkit/src/message-format.js';
import {
  FormatterCache,
  evaluateCandidate,
  findEvaluationCandidate,
} from '../src/evaluator.js';
import { RuntimeExtensions } from '../src/extensions.js';
import type {
  CompiledCatalog,
  CompiledInputContract,
} from '../src/catalog-runtime.js';
import {
  type FormattingContext,
  type MessageHandle,
} from '@neolorn/atlas/core';

/**
 * One message, parsed by the real parser and evaluated by the real evaluator.
 *
 * **The messages are parsed, not hand-written as IR.** `parseAtlasMessage` is the parser the
 * compiler uses and the compiler stores its output verbatim, so what reaches the evaluator here is
 * what a catalog actually produces. Only the catalog envelope is built, because nothing in the
 * envelope participates in evaluating a message.
 *
 * `renderSemantics` takes the model rather than the source, for the cases that have to hand the
 * runtime input the authoring path cannot produce: a compiled artifact is the runtime's input and
 * it has no way to know what produced one.
 */

export const CONTEXT: FormattingContext = Object.freeze({ locale: 'en-US' });

export const COUNT: readonly CompiledInputContract[] = Object.freeze([
  { name: 'count', type: 'number', optional: false, nullable: false },
]);

function compiledCatalogFor(
  semantics: AtlasMessageSemanticModel,
  inputs: readonly CompiledInputContract[],
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
  const outputParts = 64;
  const resources = {
    irNodes: 1,
    depth: 1,
    selectors: 1,
    variants: 8,
    inputs: inputs.length,
    slots: 0,
    outputParts,
  };
  return {
    profile: 'atlas-compiled-ir/1',
    generatedAbi: 'atlas-generated/1',
    standardsProfile: 'atlas-1',
    key: {
      providerId: 'selection',
      scopeId: 'selection',
      catalogLocale: 'en-US',
    },
    applicationContractFingerprint: 'test',
    semanticRegistryFingerprint: 'test',
    requiredExtensions: Object.freeze([]),
    messages: Object.freeze([
      {
        messageId: 'subject',
        kind: 'message' as const,
        resultKind: 'plain' as const,
        sourceFingerprint: 'test',
        inputs: Object.freeze(inputs),
        slots: Object.freeze([]),
        body,
      },
    ]),
    resources: { ...resources, maximumMessage: resources },
  } as unknown as CompiledCatalog;
}

export function renderSemantics(
  semantics: AtlasMessageSemanticModel,
  inputs: readonly CompiledInputContract[],
  values: Readonly<Record<string, unknown>>,
  extensions: RuntimeExtensions = new RuntimeExtensions(),
  context: FormattingContext = CONTEXT,
): string {
  const catalog = compiledCatalogFor(semantics, inputs);
  const handle: MessageHandle = {
    generatedAbi: 'atlas-generated/1',
    providerId: 'selection',
    scopeId: 'selection',
    messageId: 'subject',
    identity: 'selection:selection:subject',
    resultKind: 'plain',
    inputNames: Object.freeze(inputs.map(({ name }) => name)),
    slotNames: Object.freeze([]),
  } as MessageHandle;
  const result = evaluateCandidate(
    handle,
    findEvaluationCandidate(handle, 'en-US', [catalog]),
    values,
    context,
    new FormatterCache(8),
    extensions,
  );
  if (result.kind !== 'text') throw new Error('Expected a plain text result.');
  return result.value;
}

export function parse(
  source: string,
  customFunctions: readonly AtlasMessageCustomFunction[] = [],
): AtlasMessageSemanticModel {
  const parsed = parseAtlasMessage(source, { customFunctions });
  if (!parsed.ok) {
    throw new Error(
      `The message under test did not parse: ${parsed.diagnostics
        .map((diagnostic) => diagnostic.summary)
        .join('; ')}`,
    );
  }
  return parsed.value;
}

export function render(
  source: string,
  inputs: readonly CompiledInputContract[],
  values: Readonly<Record<string, unknown>>,
  context: FormattingContext = CONTEXT,
): string {
  return renderSemantics(
    parse(source),
    inputs,
    values,
    new RuntimeExtensions(),
    context,
  );
}
