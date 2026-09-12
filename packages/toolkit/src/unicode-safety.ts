const unsafeInvisibleOrBidiControl =
  /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

function isNoncharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint & 0xffff) === 0xfffe ||
    (codePoint & 0xffff) === 0xffff
  );
}

export function isAtlasUnicodeScalarText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return false;
      codePoint = (first - 0xd800) * 0x400 + (second - 0xdc00) + 0x10000;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return false;
    }
    if (isNoncharacter(codePoint)) return false;
  }
  return true;
}

export function isAtlasSafeAuthoredText(value: string): boolean {
  return (
    isAtlasUnicodeScalarText(value) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  );
}

export function isAtlasSafeStructuralText(value: string): boolean {
  return (
    isAtlasSafeAuthoredText(value) && !unsafeInvisibleOrBidiControl.test(value)
  );
}

/**
 * Why an authored message value was refused.
 *
 * Named rather than boolean because "contains a forbidden character" is useless to a translator
 * who cannot see the character. The diagnostic has to say which kind and what it does.
 */
export type AtlasBidiViolation =
  | 'directional-override'
  | 'unbalanced-isolate'
  | 'byte-order-mark';

const DIRECTIONAL_OVERRIDE = /[\u202a-\u202e]/u;
const ISOLATE_OPEN = /[\u2066-\u2068]/u;

/**
 * The bidi policy for authored message values.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 7.1 divides these characters by what they can
 * do to the text around them. Translator-supplied text is untrusted input, and the characters
 * are invisible, so neither a reviewer reading a diff nor a translator pasting from a tool can
 * see what they do.
 *
 * Refused:
 *
 * - **Overrides and embeddings** (U+202A to U+202E) force a direction on the text around them, so a
 *   value can reorder the sentence it sits in: "Order 12345 shipped" renders as
 *   "Order deppihs 54321". Unicode deprecated the embeddings in favor of isolates, and neither
 *   has a legitimate use inside a user-interface message.
 * - **Unbalanced isolates.** An isolate that is opened and not closed leaks exactly like an
 *   override; the run it was meant to contain never ends.
 * - **U+FEFF**, which is a byte-order mark that has ended up inside text rather than content
 *   anyone typed on purpose, and a known obfuscation vector.
 *
 * Permitted:
 *
 * - **Balanced isolates** (U+2066 to U+2069). These contain a direction instead of leaking it, and a
 *   translator genuinely needs one around a Latin product name inside Arabic prose. Refusing them
 *   outright would remove a capability and leave nothing in its place.
 * - **Directional marks** (U+200E, U+200F, U+061C). Each nudges one adjacent character and cannot
 *   reorder a run. Ordinary bidi authoring.
 * - **Zero-width space and word joiner** (U+200B, U+2060), which have real typographic uses.
 */
export function inspectAtlasAuthoredBidi(
  value: string,
): AtlasBidiViolation | undefined {
  if (DIRECTIONAL_OVERRIDE.test(value)) return 'directional-override';
  if (value.includes('\ufeff')) return 'byte-order-mark';

  let depth = 0;
  for (const character of value) {
    if (ISOLATE_OPEN.test(character)) depth += 1;
    else if (character === '\u2069') {
      depth -= 1;
      // Closing an isolate that was never opened leaves the surrounding text unbalanced just as
      // surely as failing to close one.
      if (depth < 0) return 'unbalanced-isolate';
    }
  }
  return depth === 0 ? undefined : 'unbalanced-isolate';
}

export function isAtlasSafeXmlText(value: string): boolean {
  if (!isAtlasSafeAuthoredText(value)) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d &&
      (codePoint < 0x20 ||
        (codePoint > 0xd7ff && codePoint < 0xe000) ||
        codePoint > 0xfffd)
    ) {
      return false;
    }
  }
  return true;
}
