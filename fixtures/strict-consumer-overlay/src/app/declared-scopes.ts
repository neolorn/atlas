import { configuration } from '#i18n';

/**
 * The scope table, read as data by the application that declared it.
 *
 * An application that reports what its first screen costs reads this the way the runtime does,
 * treating a scope as needed at startup unless the table says otherwise. That reading is the one
 * the overlay has to survive: which scopes are deferred is discovered by the analysis pass, so the
 * table the pass starts from states nothing about them, and a reader written against the real
 * table has to keep compiling against the one that answers nothing.
 */
export function startupScopeIds(): readonly string[] {
  return configuration.scopes
    .filter(({ startup }) => startup !== false)
    .map(({ scopeId }) => scopeId);
}

/** The scopes that arrive with a route rather than with the first render. */
export function deferredScopeIds(): readonly string[] {
  return configuration.scopes
    .filter(({ startup }) => startup === false)
    .map(({ scopeId }) => scopeId);
}

/** How many scopes this build declares, whichever way each one loads. */
export const declaredScopeCount: number = configuration.scopes.length;
