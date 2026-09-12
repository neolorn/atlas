import { describe, expect, it } from 'vitest';

import {
  createPathPrefixLocalePolicy,
  LocalizationError,
} from '@neolorn/atlas/core';

import { externalDestination } from '../src/destinations.js';

/**
 * A refusal says why it refused, and keeps what it was refusing.
 *
 * `LocalizationDiagnostic.reason` and the `cause` option on `LocalizationError` are both published,
 * and both helpers that raise these two failures took a reason and a cause from their callers and
 * threw them away. Eight call sites hand over `'malformed-input'` and the `Intl` or `URL` error that
 * decided it, and none of it reached the person reading the failure.
 *
 * Nothing asserted either field, which is how it survived: the compiler reported it the day
 * `noUnusedParameters` was turned on, and these two rows are what watches it now. They assert the
 * fields rather than the message, because the message is prose and the fields are the contract: a
 * consumer filtering on `reason`, or reading `cause` to find out which of its own inputs the
 * platform refused, is reading these.
 */
describe('a refused value carries its reason and its cause', () => {
  it('carries what Intl refused about a route locale', () => {
    let thrown: unknown;
    try {
      createPathPrefixLocalePolicy({
        defaultLocale: 'en-US',
        locales: { 'not a locale': 'x' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LocalizationError);
    const failure = thrown as LocalizationError;
    expect(failure.diagnostic.code).toBe('invalid-configuration');
    expect(failure.diagnostic.reason).toBe('malformed-input');
    expect(failure.cause).toBeInstanceOf(RangeError);
  });

  it('carries what URL refused about a rich-message destination', () => {
    let thrown: unknown;
    try {
      externalDestination('https://', ['https://example.com']);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LocalizationError);
    const failure = thrown as LocalizationError;
    expect(failure.diagnostic.code).toBe('invalid-rich-message');
    expect(failure.diagnostic.reason).toBe('malformed-input');
    expect(failure.cause).toBeInstanceOf(TypeError);
  });
});
