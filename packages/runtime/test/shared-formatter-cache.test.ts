import { describe, expect, it, vi } from 'vitest';

import { type FormattingContext } from '@neolorn/atlas/core';

import { RUNTIME_LIMITS } from '../src/runtime-safety.js';

/**
 * The standalone formatting functions cache their `Intl` objects, and the cache is the module's.
 *
 * `specs/12-verification.spec.md` section 11 requires a cost to be verified by a count the machine
 * cannot change, which for a cache is the number of formatters it constructs.
 *
 * `cache?: FormatterCache` came off twenty exported signatures. The parameter delivered
 * nothing: `FormatterCache` is absent from the package's type exports and from its runtime
 * exports, so no consumer could construct one to pass, and the default was a fresh one-entry cache
 * per call. What replaces it is a module-scope store, which means the properties worth asserting
 * are not "does it format correctly": every one of those tests passed before and after, because a
 * cache that misses every time returns exactly what no cache returns.
 *
 * **That is the shape this file exists for.** A cache keyed on the options object's identity, or on
 * the `FormattingContext`, would fill and evict on every call, produce correct output throughout,
 * and show up nowhere except in a benchmark number that did not move. So every case here counts
 * `Intl.NumberFormat` constructions rather than reading output.
 *
 * Each case takes a fresh module instance. The store is module scope, so a case that inherits one
 * from the case before it is asserting about whatever that case happened to leave in it.
 */

/**
 * Count constructions without changing what is constructed.
 *
 * A `Proxy` with only a `construct` trap rather than a replacement class: `FormatterCache.number`
 * narrows its stored value with `cached instanceof Intl.NumberFormat`, and a proxy forwards both
 * `Symbol.hasInstance` and `prototype` to the real constructor, so the narrowing still holds. A
 * hand-written subclass or wrapper would break it and the failure would look like a cache miss.
 */
const countingNumberFormat = (): {
  built: () => number;
  restore: () => void;
} => {
  const real = Intl.NumberFormat;
  let built = 0;
  const install = (value: typeof Intl.NumberFormat): void => {
    Object.defineProperty(Intl, 'NumberFormat', {
      value,
      configurable: true,
      writable: true,
    });
  };
  install(
    new Proxy(real, {
      construct(target, args, newTarget) {
        built += 1;
        return Reflect.construct(target, args, newTarget);
      },
    }),
  );
  return { built: () => built, restore: () => install(real) };
};

const freshFormatting = async (): Promise<
  typeof import('../src/formatting.js')
> => {
  vi.resetModules();
  return import('../src/formatting.js');
};

const EN: FormattingContext = { locale: 'en-US' };

describe('the store the standalone formatting functions share', () => {
  it('constructs one formatter for a hundred identical calls', async () => {
    const { decimal, formatNumber } = await freshFormatting();
    const counter = countingNumberFormat();
    try {
      for (let call = 0; call < 100; call += 1) {
        formatNumber(decimal('1234.5'), EN);
      }
      // 100 before this step, measured against the built package: the parameter defaulted to
      // `new FormatterCache(1)`, constructed on entry and discarded on return.
      expect(counter.built()).toBe(1);
    } finally {
      counter.restore();
    }
  });

  it('gives the same entry to two option objects that differ only in key order', async () => {
    const { decimal, formatNumber } = await freshFormatting();
    const counter = countingNumberFormat();
    try {
      formatNumber(decimal('1'), EN, {
        minimumFractionDigits: 2,
        style: 'decimal',
      });
      const afterFirst = counter.built();
      formatNumber(decimal('1'), EN, {
        style: 'decimal',
        minimumFractionDigits: 2,
      });
      expect(counter.built() - afterFirst).toBe(0);
      // And the first call did construct, so a zero above is a hit rather than a path that never
      // reaches the cache at all.
      expect(afterFirst).toBe(1);
    } finally {
      counter.restore();
    }
  });

  it('does not hand an ar-EG entry to a request for a different numbering system', async () => {
    const { decimal, formatNumber } = await freshFormatting();
    const arab: FormattingContext = {
      locale: 'ar-EG',
      numberingSystem: 'arab',
    };
    const latn: FormattingContext = {
      locale: 'ar-EG',
      numberingSystem: 'latn',
    };
    const counter = countingNumberFormat();
    try {
      const first = formatNumber(decimal('1234.5'), arab);
      const second = formatNumber(decimal('1234.5'), latn);
      expect(counter.built()).toBe(2);
      // The correctness risk the key design turns on, asserted on the digits rather than on the
      // count: a key that dropped the `-u-nu-` tag would return the Arabic-Indic formatter for the
      // Latin request, the count would read 1, and every other test in this repository would pass.
      expect(first.ok && first.value.text).toBe('١٬٢٣٤٫٥');
      expect(second.ok && second.value.text).toBe('1,234.5');
    } finally {
      counter.restore();
    }
  });

  /**
   * The bound, and the half of it that is easy to leave untested.
   *
   * An eviction test that only fills the store proves it does not grow. It does not prove the store
   * keeps what is in use, and a cache that evicts the entry you just asked for is worse than no
   * cache: it pays the eviction cost and never hits. So the working entry is touched before the
   * store overflows, and what must go is the one nothing has asked for since.
   *
   * The two assertions together pin the ceiling from both sides. At exactly the ceiling nothing has
   * been evicted; one entry past it, one has. A store built with any smaller capacity fails the
   * first, and an unbounded one fails the second.
   */
  it('evicts the entry nothing is using and keeps the one that is', async () => {
    const { decimal, formatNumber } = await freshFormatting();
    const ceiling = RUNTIME_LIMITS.formatterCacheEntries;
    const shapes: Intl.NumberFormatOptions[] = [];
    // `useGrouping` varies over the two values this TypeScript version's `Intl.NumberFormatOptions`
    // declares. The runtime accepts `'always'` too and the ES spec defines it, but the lib type does
    // not, and widening the fixture with a cast to reach a third value would be asserting about a
    // call no consumer can typecheck.
    build: for (const useGrouping of [true, false] as const) {
      for (let integers = 1; integers <= 21; integers += 1) {
        for (let least = 0; least <= 20; least += 1) {
          for (let most = least; most <= 20; most += 1) {
            shapes.push({
              useGrouping,
              minimumIntegerDigits: integers,
              minimumFractionDigits: least,
              maximumFractionDigits: most,
            });
            if (shapes.length > ceiling) break build;
          }
        }
      }
    }
    expect(shapes.length).toBe(ceiling + 1);

    const one = decimal('1');
    for (let index = 0; index < ceiling; index += 1) {
      formatNumber(one, EN, shapes[index]);
    }
    const counter = countingNumberFormat();
    try {
      // Full to the ceiling and nothing thrown away yet. This is also the touch that makes the
      // first shape the most recently used, so the next eviction must not be it.
      formatNumber(one, EN, shapes[0]);
      expect(counter.built()).toBe(0);

      // One past the ceiling.
      formatNumber(one, EN, shapes[ceiling]);
      expect(counter.built()).toBe(1);

      // The least recently used is gone. It was shapes[1] and not shapes[0], because shapes[0] was
      // asked for above and shapes[1] has not been touched since it was stored.
      formatNumber(one, EN, shapes[1]);
      expect(counter.built()).toBe(2);

      // And the one that was in use survived.
      formatNumber(one, EN, shapes[0]);
      expect(counter.built()).toBe(2);
    } finally {
      counter.restore();
    }
  });
});
