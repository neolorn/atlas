import {
  LocalizationError,
  type LocalizationDiagnostic,
  type TrustedDestination,
} from '@neolorn/atlas/core';
import { RUNTIME_LIMITS, containsUrlSpoofingControl } from './runtime-safety';

function unsafeUrlText(value: unknown, maximum: number): boolean {
  return (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    containsUrlSpoofingControl(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|e2%80%(?:8[bcdef]|a[abcde]))/iu.test(value)
  );
}

/**
 * A rich-message destination failure, carrying what the caller knew about it.
 *
 * The same defect as `routeError` in the routing core and found the same way: three call sites pass
 * `'malformed-input'` and the `URL` parser's own error, and the thrown diagnostic carried neither.
 */
function invalidDestination(
  message: string,
  reason?: LocalizationDiagnostic['reason'],
  cause?: unknown,
): never {
  throw new LocalizationError(
    Object.freeze({
      code: 'invalid-rich-message',
      outcome: 'operational-failure',
      message,
      ...(reason === undefined ? {} : { reason }),
    }),
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Builds a link inside this application for a slot in a structured message.
 *
 * Takes an origin-relative address and returns the binding to hand to a link slot. Throws for
 * anything that could leave the application: a scheme, a protocol-relative address, a backslash a
 * parser might fold, a character that makes a rendered address read as somewhere else, or a length
 * past the runtime's bound.
 *
 * Refusing rather than repairing is the point. The words around a link come from a catalog, and a
 * catalog is the file most likely to have arrived from outside the team that wrote the code.
 */
export function internalDestination(href: string): TrustedDestination {
  if (
    unsafeUrlText(href, RUNTIME_LIMITS.destinationCodeUnits) ||
    !href.startsWith('/') ||
    href.startsWith('//') ||
    /\\/u.test(href)
  ) {
    return invalidDestination(
      'An internal rich-message destination must be a safe origin-relative URL.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(href, 'https://atlas.invalid');
  } catch (cause) {
    return invalidDestination(
      'The internal rich-message destination is invalid.',
      'malformed-input',
      cause,
    );
  }
  if (parsed.origin !== 'https://atlas.invalid') {
    return invalidDestination('The internal destination cannot change origin.');
  }
  return Object.freeze({
    kind: 'internal',
    href: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  });
}

/**
 * Builds a link to another site for a slot in a structured message, against an allowlist.
 *
 * Takes the address, the origins it may point at, and whether it opens in a new tab, which is the
 * default. Returns the binding to hand to a link slot.
 *
 * The allowlist is required and may not be empty: there is no call that means any origin at all.
 * Each entry must be an HTTPS origin with no credentials, path, query or fragment, and the address
 * must be HTTPS at one of them. Anything else throws, as does an address carrying a character that
 * makes it read as somewhere it does not go.
 */
export function externalDestination(
  href: string,
  allowedOrigins: readonly string[],
  target: '_blank' | '_self' = '_blank',
): TrustedDestination {
  if (
    unsafeUrlText(href, RUNTIME_LIMITS.destinationCodeUnits) ||
    !Array.isArray(allowedOrigins) ||
    allowedOrigins.length === 0 ||
    allowedOrigins.length > RUNTIME_LIMITS.destinationOrigins ||
    !['_blank', '_self'].includes(target)
  ) {
    return invalidDestination(
      'The external rich-message destination exceeds a fixed safety policy.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch (cause) {
    return invalidDestination(
      'The external rich-message destination is invalid.',
      'malformed-input',
      cause,
    );
  }
  const origins = new Set(
    allowedOrigins.map((origin) => {
      if (unsafeUrlText(origin, RUNTIME_LIMITS.destinationOriginCodeUnits)) {
        return invalidDestination(
          'An external destination allowlist origin is invalid.',
        );
      }
      let parsedOrigin: URL;
      try {
        parsedOrigin = new URL(origin);
      } catch (cause) {
        return invalidDestination(
          'An external destination allowlist origin is invalid.',
          'malformed-input',
          cause,
        );
      }
      if (
        parsedOrigin.protocol !== 'https:' ||
        parsedOrigin.username.length > 0 ||
        parsedOrigin.password.length > 0 ||
        parsedOrigin.pathname !== '/' ||
        parsedOrigin.search.length > 0 ||
        parsedOrigin.hash.length > 0
      ) {
        return invalidDestination(
          'An external destination allowlist entry must be a credential-free HTTPS origin.',
        );
      }
      return parsedOrigin.origin;
    }),
  );
  if (
    parsed.protocol !== 'https:' ||
    !origins.has(parsed.origin) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return invalidDestination(
      'The external destination violates the application-owned HTTPS allowlist.',
    );
  }
  return Object.freeze({
    kind: 'external',
    href: parsed.href,
    target,
    rel: target === '_blank' ? 'noopener noreferrer' : 'noopener',
  });
}
