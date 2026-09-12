/**
 * What to do about an offline install that cannot find a package, said where the failure is read.
 *
 * The consumer gates install `--offline --frozen-lockfile` on purpose: an upstream publish must not
 * be able to change what a run means. That has a precondition: the store already holds every
 * package those committed lockfiles name, and `pnpm run stage:consumer-store` is the command
 * that establishes it. On a machine that has never run it, pnpm says `ERR_PNPM_NO_OFFLINE_TARBALL` and
 * names a package, which is what is missing rather than what puts it there. Working that out from
 * the package name cost two red runs on the first machine that was not this one.
 *
 * Detected rather than appended to every install failure. A lockfile that disagrees with a manifest,
 * a network that is not there, a disk that is full: those are different problems, and a remedy that
 * is confidently wrong is worse than no remedy at all.
 */

const OFFLINE_STORE_MISS = /ERR_PNPM_NO_OFFLINE_(?:TARBALL|META)/u;

/** The one sentence, so the four gates that can hit this do not each write their own. */
export const OFFLINE_STORE_REMEDY =
  'The pnpm store does not hold everything the committed consumer lockfiles name, which is what ' +
  'an `--offline --frozen-lockfile` install needs and what nothing else establishes. Run ' +
  '`pnpm run stage:consumer-store` and try again: it fetches every package those lockfiles name ' +
  'into the store, and asserts that it did.';

/** A child's own output, with the remedy after it when the output is that failure. */
export const withOfflineStoreRemedy = (text) =>
  OFFLINE_STORE_MISS.test(text) ? `${text}\n\n${OFFLINE_STORE_REMEDY}` : text;
