/**
 * XML text, escaped for a document Atlas writes.
 *
 * Both packages emit XML: the core writes a sitemap and the alternate-language links beside it, the
 * toolkit writes XLIFF. Neither can import from the other, so this file is duplicated byte for byte
 * and `packages/runtime/test/message-function-options.test.ts` compares the copies. Duplication
 * without a check is drift with a delay on it.
 *
 * All five predefined entities, including the two that only matter inside an attribute. Escaping a
 * value once by what it is rather than by where it is about to go means no caller has to decide,
 * and a caller that decides wrongly writes a document a parser will not read.
 */

/** Escapes the five characters XML gives a predefined entity. */
export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
