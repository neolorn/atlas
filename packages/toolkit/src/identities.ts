/**
 * Provider, scope and message, and the grammars that keep them separable.
 *
 * `specs/04-message-authoring-and-catalogs.spec.md` section 4 makes identity exactly those three and
 * leaves locale out of it, which is what lets one identity have many representations. The grammars
 * are narrow so that a projection into a generated name is reversible, which is what keeps two
 * identities from projecting onto one name.
 */
import {
  atlasDiagnostic,
  atlasFailure,
  atlasSuccess,
  type AtlasDiagnosticCode,
  type AtlasResult,
} from './diagnostics.js';
import { atlasUntrustedText } from './untrusted-text.js';

/**
 * How a catalog key is spelled in the file and how code reaches it, in one place.
 *
 * The mapping was documented nowhere and implemented in the generator, so the only way
 * to learn that `sign-in-button` is `messages.signInButton` was to generate a project and read the
 * output. A diagnostic about a key that says nothing about the spelling rule sends a reader to look
 * for a rule that is not written down anywhere.
 *
 * `generated-contracts.ts` now takes its projection from here rather than keeping a private copy,
 * so the sentence a diagnostic prints and the name the generator emits cannot disagree.
 */
export function atlasMessagePartInCode(part: string): string {
  return part.replace(/-([a-z0-9])/gu, (_match, character: string) =>
    character.toUpperCase(),
  );
}

/** The whole dotted key as code reaches it: `cart.line-items` is `cart.lineItems`. */
export function atlasMessageKeyInCode(key: string): string {
  return key.split('.').map(atlasMessagePartInCode).join('.');
}

/**
 * The catalog spelling of a key someone wrote the way code spells it.
 *
 * A suggestion rather than a rule: it undoes the three mistakes people actually make (camel case,
 * capitals, and underscores or spaces for hyphens) and every caller checks the result against the
 * schema's own pattern before offering it. A key it cannot repair gets the rule and no suggestion,
 * which is better than a suggestion that is also rejected.
 */
export function atlasMessageKeyInCatalog(key: string): string {
  return key
    .split('.')
    .map((part) =>
      part
        .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
        .replace(/[_\s]+/gu, '-')
        .toLowerCase(),
    )
    .join('.');
}

declare const providerIdBrand: unique symbol;
declare const scopeIdBrand: unique symbol;
declare const messageIdBrand: unique symbol;

/**
 * A package's identity, which is the name it publishes under, checked and normalized.
 *
 * Branded, so a bare string cannot stand in for one. `parseAtlasProviderId` is what produces one,
 * and it is the only thing that does: an identity that reached here reached here through a check.
 */
export type AtlasProviderId = string & {
  readonly [providerIdBrand]: 'AtlasProviderId';
};

/**
 * A scope's identity within a package, checked and normalized.
 *
 * A scope is the unit catalogs are loaded in, so this is the name a route or a feature names when
 * it says which messages it needs. Branded for the same reason a provider identity is.
 */
export type AtlasScopeId = string & {
  readonly [scopeIdBrand]: 'AtlasScopeId';
};

export type AtlasMessageId = string & {
  readonly [messageIdBrand]: 'AtlasMessageId';
};

export interface AtlasMessageIdentity {
  readonly providerId: AtlasProviderId;
  readonly scopeId: AtlasScopeId;
  readonly messageId: AtlasMessageId;
}

const providerPattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const scopePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const messagePattern =
  /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*(?:\.[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)*$/u;

function parseIdentity<T extends string>(
  value: unknown,
  pattern: RegExp,
  code: AtlasDiagnosticCode,
  label: string,
): AtlasResult<T> {
  // Before the grammar, because `RegExp.prototype.test` coerces and a coerced number satisfies an
  // identifier grammar as readily as a real identity does.
  const text = atlasUntrustedText(value, code, label);
  if (!text.ok) return text;
  if (!pattern.test(text.value)) {
    return atlasFailure([
      atlasDiagnostic(
        code,
        `${label} does not match the Atlas identity grammar.`,
      ),
    ]);
  }

  return atlasSuccess(text.value as T);
}

export function parseAtlasProviderId(
  value: unknown,
): AtlasResult<AtlasProviderId> {
  return parseIdentity<AtlasProviderId>(
    value,
    providerPattern,
    'ATL1104',
    'Provider identity',
  );
}

export function parseAtlasScopeId(value: unknown): AtlasResult<AtlasScopeId> {
  return parseIdentity<AtlasScopeId>(
    value,
    scopePattern,
    'ATL1104',
    'Scope identity',
  );
}

export function parseAtlasMessageId(
  value: unknown,
): AtlasResult<AtlasMessageId> {
  return parseIdentity<AtlasMessageId>(
    value,
    messagePattern,
    'ATL1104',
    'Message identity',
  );
}

export function createAtlasMessageIdentity(
  providerId: unknown,
  scopeId: unknown,
  messageId: unknown,
): AtlasResult<AtlasMessageIdentity> {
  const provider = parseAtlasProviderId(providerId);
  const scope = parseAtlasScopeId(scopeId);
  const message = parseAtlasMessageId(messageId);
  const diagnostics = [
    ...provider.diagnostics,
    ...scope.diagnostics,
    ...message.diagnostics,
  ];

  if (!provider.ok || !scope.ok || !message.ok) {
    return atlasFailure(diagnostics);
  }

  return atlasSuccess(
    Object.freeze({
      providerId: provider.value,
      scopeId: scope.value,
      messageId: message.value,
    }),
  );
}
