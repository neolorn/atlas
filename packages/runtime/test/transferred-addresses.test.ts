import { describe, expect, it } from 'vitest';

import {
  RUNTIME_LIMITS,
  areTransferredAddresses,
  isTransferredPath,
} from '../src/runtime-safety.js';

/**
 * What a transferred route record is allowed to say about where the other locales live.
 *
 * These addresses arrive with the server-rendered document and leave as the `href` of a locale
 * switcher's links. A transfer state is served to a browser and can come back edited, so this is
 * the boundary between "the server said so" and "something in the document said so", and both
 * sides of it need exercising: the accepting side runs on every hydration the browser gate
 * performs, and the refusing side runs here, where each rejection can be named.
 */

describe('a transferred switch address', () => {
  it('accepts the paths the routing integration produces', () => {
    // Every shape a locale policy can build: a bare prefix, a nested route, a percent-encoded
    // slug, the reader's query, a fragment, and a path that is only the root.
    for (const address of [
      '/en-us',
      '/ar-eg/articles/atlas-handbook',
      '/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
      '/en-us/search?q=chair&page=2',
      '/en-us/guide#section-3',
      '/',
    ]) {
      expect(isTransferredPath(address)).toBe(true);
    }
  });

  it('refuses anything that could send the reader somewhere else', () => {
    const refused: readonly [string, unknown][] = [
      [
        'a script URL, which is why this validates at all',
        'javascript:alert(1)',
      ],
      ['a data URL', 'data:text/html,<script>alert(1)</script>'],
      ['an absolute URL to another site', 'https://evil.example/ar-eg'],
      [
        'protocol-relative: a path to a reader, an origin to a browser',
        '//evil.example/ar-eg',
      ],
      [
        'a backslash, which some parsers fold to a separator',
        '/\\evil.example',
      ],
      [
        'a right-to-left override, which hides where the address ends',
        '/ar-eg\u202E',
      ],
      ['a newline', '/ar-eg\nx'],
      ['a relative path, which has no fixed meaning to a link', 'ar-eg/second'],
      ['the empty string', ''],
      ['a number', 42],
      ['null', null],
      ['undefined', undefined],
    ];
    for (const [reason, address] of refused) {
      expect(isTransferredPath(address), reason).toBe(false);
    }
  });

  it('refuses a path longer than a destination may be', () => {
    const limit = RUNTIME_LIMITS.destinationCodeUnits;
    expect(isTransferredPath(`/${'a'.repeat(limit - 1)}`)).toBe(true);
    expect(isTransferredPath(`/${'a'.repeat(limit)}`)).toBe(false);
  });
});

describe('a transferred address table', () => {
  const table = (entries: number): Record<string, string> =>
    Object.fromEntries(
      Array.from({ length: entries }, (_, index) => [
        `en-US-x-p${index}`,
        `/en-us/${index}`,
      ]),
    );

  it('accepts a table of locales and paths, and its absence', () => {
    expect(areTransferredAddresses(undefined)).toBe(true);
    expect(areTransferredAddresses({})).toBe(true);
    expect(
      areTransferredAddresses({ 'en-US': '/en-us', 'ar-EG': '/ar-eg?page=2' }),
    ).toBe(true);
  });

  it('refuses the whole table for one bad address', () => {
    // Not trimmed to the good entries. A transfer with one edited address is not a transfer with
    // one bad address, it is a transfer someone has been inside.
    expect(
      areTransferredAddresses({
        'en-US': '/en-us',
        'ar-EG': 'javascript:alert(1)',
      }),
    ).toBe(false);
  });

  it('refuses a shape that is not a table of strings', () => {
    expect(areTransferredAddresses(['/en-us'])).toBe(false);
    expect(areTransferredAddresses('/en-us')).toBe(false);
    expect(areTransferredAddresses(null)).toBe(false);
    expect(areTransferredAddresses({ 'en-US': 42 })).toBe(false);
    expect(areTransferredAddresses({ '': '/en-us' })).toBe(false);
    expect(areTransferredAddresses({ [`x${'y'.repeat(128)}`]: '/en-us' })).toBe(
      false,
    );
  });

  it('refuses more addresses than a build can have locales', () => {
    const limit = RUNTIME_LIMITS.transferredAddresses;
    expect(areTransferredAddresses(table(limit))).toBe(true);
    expect(areTransferredAddresses(table(limit + 1))).toBe(false);
  });
});
