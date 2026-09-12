import {
  atlasDiagnostic,
  atlasFailure,
  atlasSuccess,
  type AtlasDiagnosticCode,
  type AtlasResult,
} from './diagnostics.js';
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';

/**
 * Checking that untrusted input is text at all, before anything reads it as text.
 *
 * `parseAtlasProviderId(42)` returned success with the number `42` branded as a provider
 * identity, and `parseAtlasLocaleAlias(undefined)` returned success with `undefined` branded as
 * an alias. Neither function was broken in an interesting way: `RegExp.prototype.test`
 * coerces its argument, so `42` is tested as `"42"` and `undefined` as `"undefined"`, and both
 * happen to satisfy an identifier grammar. The validator agreed, and the caller received a value
 * that was not a string at all wearing a type that says it is.
 *
 * The same coercion has a second face. `parseAtlasConfiguration(42)` reached
 * `Buffer.byteLength(42)` and threw a raw `TypeError` out of a function whose entire contract is to
 * return a diagnostic rather than throw.
 *
 * These are validators. Their callers hold values from JSON, from a command line, from a consumer's
 * configuration, `unknown` every one of them. Declaring the parameter as `string` did not stop a
 * number arriving; it only stopped the check that would have caught it from being written. So the
 * parameter is `unknown` and the check happens here, once.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 1 is the wider rule this belongs to: nothing is
 * trusted until bounded parsing and complete validation have passed it, whatever repository it
 * was stored in.
 */

/** No Atlas identity, locale, or alias approaches this. Anything that does is not one. */
const MAXIMUM_IDENTITY_CHARACTERS = 256;

export function atlasUntrustedText(
  value: unknown,
  code: AtlasDiagnosticCode,
  label: string,
  maximumCharacters: number = MAXIMUM_IDENTITY_CHARACTERS,
): AtlasResult<string> {
  if (typeof value !== 'string') {
    return atlasFailure([
      atlasDiagnostic(
        code,
        // The type is named and the value is not. A value that reached a validator by mistake is
        // exactly the kind of value that should not be echoed into a diagnostic.
        `${label} must be a string, not ${describeType(value)}.`,
      ),
    ]);
  }
  if (value.length > maximumCharacters) {
    return atlasFailure([
      atlasDiagnostic(
        code,
        `${label} exceeds the ${maximumCharacters}-character implementation ceiling.`,
      ),
    ]);
  }
  return atlasSuccess(value);
}

export function atlasUntrustedSource(
  value: unknown,
  code: AtlasDiagnosticCode,
  label: string,
): AtlasResult<string> {
  return atlasUntrustedText(
    value,
    code,
    label,
    ATLAS_RESOURCE_LIMITS.configurationBytes,
  );
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'undefined'
    ? 'undefined'
    : type === 'object'
      ? 'an object'
      : `a ${type}`;
}
