/**
 * One key order and one record shape, for every table the toolkit emits.
 *
 * Everything Atlas writes is compared against something: a digest, a catalog diff, a generated file
 * checked against the source it came from. Those comparisons only mean anything if two runs over
 * the same input produce the same order, so keys are ordered by code point everywhere rather than
 * by whatever order they were inserted in.
 *
 * The records are built with no prototype and frozen, because the keys in them come from authored
 * files. A key spelled `__proto__` reaches `Object.prototype` on a plain object literal and reaches
 * nothing here.
 */

/** Orders two keys by code point, which is the order every table below is written in. */
export function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Builds a frozen, prototype-less record from entries already in the order they belong in. */
export function frozenRecord<T>(
  entries: readonly (readonly [string, T])[],
): Readonly<Record<string, T>> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }
  return Object.freeze(record);
}
