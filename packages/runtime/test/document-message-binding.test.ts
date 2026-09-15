/**
 * A document title that takes a value, and the declaration that has to carry it.
 *
 * Section 12 of `specs/07-routing-rendering-and-seo.spec.md` authors the title and the description
 * as messages, resolves a declared message with the inputs declared beside it, and refuses a
 * declaration naming a message that takes inputs with none bound to it. The refusal is what this
 * file is about: `PlainMessageHandle` is deliberately assignable from a handle that declares
 * inputs, which is what lets one type serve every plain message, so the type cannot be the check.
 * Resolved with nothing bound, the title reaches the tab and the search result with its
 * placeholders unfilled.
 */

import { describe, expect, it } from 'vitest';

import {
  documentMessage,
  isBoundDocumentMessage,
  refuseUnboundDocumentMessage,
} from '../router/src/document-messages.js';
import {
  GENERATED_ABI,
  LocalizationError,
  type PlainMessageHandle,
} from '@neolorn/atlas/core';

/** A generated handle, as a catalog compilation produces one. */
const handle = (
  messageId: string,
  inputNames: readonly string[],
): PlainMessageHandle =>
  Object.freeze({
    generatedAbi: GENERATED_ABI,
    providerId: 'fixture',
    scopeId: 'shell',
    messageId,
    identity: `atlas:fixture/shell/${messageId}`,
    resultKind: 'plain' as const,
    inputNames: Object.freeze(inputNames),
    slotNames: Object.freeze([]),
  });

const plain = handle('document.title', []);
const takesAName = handle('document.greeting', ['name']);

describe('a document field that takes no values', () => {
  it('stays the bare handle every declaration written before this was', () => {
    expect(isBoundDocumentMessage(plain)).toBe(false);
    expect(() => refuseUnboundDocumentMessage(plain, undefined)).not.toThrow();
  });
});

describe('a document field whose message takes a value', () => {
  it('carries the value when it is bound', () => {
    const bound = documentMessage(takesAName, { name: 'Atlas' });

    expect(isBoundDocumentMessage(bound)).toBe(true);
    expect(bound.message).toBe(takesAName);
    expect(bound.inputs).toEqual({ name: 'Atlas' });
  });

  it('is refused when it is declared bare', () => {
    // The shape a consumer writes by accident, and the one the type cannot catch. Refused where
    // the declaration is built, so the application fails to configure rather than serving a title
    // reading "Welcome, {$name}!" on one route in one locale.
    expect(() => refuseUnboundDocumentMessage(takesAName, undefined)).toThrow(
      LocalizationError,
    );
  });

  it('is refused when the binding leaves a value out', () => {
    const takesTwo = handle('document.greeting', ['name', 'section']);

    expect(() =>
      refuseUnboundDocumentMessage(takesTwo, { name: 'Atlas' }),
    ).toThrow(LocalizationError);
  });

  it('names the message and what it takes', () => {
    let reported = '';
    try {
      refuseUnboundDocumentMessage(takesAName, undefined);
    } catch (error: unknown) {
      reported = error instanceof Error ? error.message : '';
    }

    expect(reported).toContain('document.greeting');
    expect(reported).toContain('name');
    expect(reported).toContain('documentMessage()');
  });

  it('refuses at the call that binds it, rather than at the page that reads it', () => {
    // `documentMessage` runs the same refusal, so a binding assembled from stored data fails where
    // it is assembled instead of at the first navigation that reads it.
    expect(() => documentMessage(takesAName as PlainMessageHandle)).toThrow(
      LocalizationError,
    );
  });
});
