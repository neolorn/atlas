// A document title is a sentence, and some sentences take a value.
//
// Section 12 of `specs/07-routing-rendering-and-seo.spec.md` authors the title and the description
// as messages rather than in a metadata format of their own, and requires a declaration naming a
// message that takes inputs with none bound to it to be refused where the declaration is built.
// Resolving one with no inputs writes the message with its placeholders unfilled, in the tab, in
// the search result, and in the social card, and nothing reports it.

import {
  LocalizationError,
  type MessageHandle,
  type MessageInputArguments,
  type PlainMessageHandle,
} from '@neolorn/atlas/core';

/**
 * A document message together with the values it takes.
 *
 * Built by `documentMessage`, which types the values against the message that needs them. The
 * fields are ordinary rather than internal, so a declaration assembled from stored data is as
 * valid as one written by hand; either way it is checked when the router is provided.
 */
export interface BoundDocumentMessage {
  /** The message whose text this field carries. */
  readonly message: PlainMessageHandle;
  /** What it takes, by name. */
  readonly inputs: Readonly<Record<string, unknown>>;
}

/**
 * One field of a document declaration: a message that takes nothing, or one with its values bound.
 *
 * A bare handle stays valid, which is what every declaration written before this was, and it is the
 * right shape for the ordinary title: a sentence with nothing in it that varies.
 */
export type RouteDocumentField = PlainMessageHandle | BoundDocumentMessage;

/**
 * Binds a document message to the values it takes.
 *
 * ```ts
 * documentMetadata: {
 *   article: { title: documentMessage(messages.document.article.title, { section }) },
 * }
 * ```
 *
 * Refuses a message whose inputs are not all bound, at the call that names it rather than at the
 * page that reads it, because a title resolved with nothing bound is written with its placeholders
 * showing and no diagnostic says so.
 */
export function documentMessage<Handle extends PlainMessageHandle>(
  message: Handle,
  ...[inputs]: MessageInputArguments<Handle>
): BoundDocumentMessage {
  // Copied into a record rather than carried as the contract type. The contract exists only at
  // compile time and the runtime reads values by name, so this is the shape the evaluator takes and
  // the shape the refusal below can look a name up in.
  const bound = Object.assign({} as Record<string, unknown>, inputs ?? {});
  refuseUnboundDocumentMessage(message, bound);
  return Object.freeze({ message, inputs: Object.freeze(bound) });
}

/** Whether a declared field carries values, as against being a message that takes none. */
export function isBoundDocumentMessage(
  field: RouteDocumentField,
): field is BoundDocumentMessage {
  return 'message' in field;
}

/**
 * Refuses a document message whose values are not all bound.
 *
 * One function for both shapes a declaration can take, so a binding assembled by hand is held to
 * what `documentMessage` holds its own callers to.
 */
export function refuseUnboundDocumentMessage(
  message: MessageHandle,
  inputs: Readonly<Record<string, unknown>> | undefined,
): void {
  const missing = message.inputNames.filter(
    (name) => inputs?.[name] === undefined,
  );
  if (missing.length === 0) return;
  throw new LocalizationError({
    code: 'invalid-configuration',
    outcome: 'operational-failure',
    message: `The document message ${JSON.stringify(message.messageId)} takes ${message.inputNames
      .map((name) => JSON.stringify(name))
      .join(', ')} and the declaration binds none of ${missing
      .map((name) => JSON.stringify(name))
      .join(
        ', ',
      )}. Bind them with documentMessage(), or declare a message that takes nothing.`,
  });
}
