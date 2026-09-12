import { describe, expect, it } from 'vitest';

import { parseAtlasCatalog } from '../src/index.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';
// Direct, because the anchor is an internal rule rather than public surface: widening the package's
// API so a test can reach it would trade the thing being protected for the protection.
import { atlasCatalogPathAnchor } from '../src/catalog.js';
import { testProjectConfiguration } from './fixtures.js';

/**
 * Where a semantic diagnostic says it is, and the rule that stops it lying.
 *
 * Falling back to `atlasSourceSpan('', 0, 0, sourcePath)` when a diagnostic's JSON pointer does
 * not resolve gives offset zero of an empty string, which renders as `file:1:1`: one expression
 * shared by fifty call sites, sending readers to a line that has nothing to do with the report. A
 * wrong location is worse than no location: no location makes a reader search, and a wrong one
 * makes them read the wrong thing and believe it.
 *
 * The rule is: resolve as far down the pointer as the document goes, point at the nearest
 * ancestor that exists, and say in the summary that you had to. Where there is no honest position at
 * all, carry none. **`file:1:1` never renders.**
 *
 * *Two codes was the ask and one is what exists.* ATL1307 is the only semantic diagnostic whose
 * pointer cannot resolve by construction: it reports a message that is absent from the file it is
 * reported against. Every other one points at something it has just read out of that same file, so
 * its pointer resolves whenever it fires and no fixture reachable through the analyser breaks it.
 * That is the argument for fixing this at the constructor rather than at ATL1307: the next code to
 * report an absence inherits the rule instead of the bug. The broken pointers below are therefore
 * put to the resolver directly, at three depths, which is the part a second code would have
 * exercised.
 */

const configuration = testProjectConfiguration(['en-US', 'ar-EG']);

function catalog(role: 'source' | 'target', locale: string, body: string) {
  const result = parseAtlasCatalog(body, {
    role,
    providerId: 'home',
    scopeId: 'shell',
    locale,
    sourcePath: `i18n/shell/${locale}.yaml`,
  });
  if (!result.ok) throw new Error(`fixture ${locale} failed to parse`);
  return result.value;
}

const SOURCE = 'messages:\n  greeting: Hello\n  farewell: Goodbye\n';

describe('a diagnostic about something that is not in the file', () => {
  it('points at the nearest thing that is, and says why', () => {
    const analysis = analyzeAtlasCatalogSet({
      configuration,
      catalogs: [
        catalog('source', 'en-US', SOURCE),
        catalog('target', 'ar-EG', 'messages:\n  greeting: مرحبا\n'),
      ],
      requireCompleteTargets: true,
    });
    const omitted = analysis.diagnostics.find(({ code }) => code === 'ATL1307');
    expect(omitted, 'the fixture did not produce ATL1307').toBeDefined();

    // Line 2 rather than line 1: `messages:` is on line 1 and its value, the map that should have
    // contained `farewell`, begins at the first key inside it. That is the collection a reader has
    // to add the message to, which is the most useful true statement available.
    expect(omitted?.span?.sourcePath).toBe('i18n/shell/ar-EG.yaml');
    expect(omitted?.span?.start.line).toBe(1);
    // Not 1:1, which is what this replaces and what a synthetic span always produced.
    expect(
      `${(omitted?.span?.start.line ?? 0) + 1}:${(omitted?.span?.start.column ?? 0) + 1}`,
    ).not.toBe('1:1');

    // And the summary accounts for the caret, because a location the reader was not told about is
    // its own small mystery.
    expect(omitted?.summary).toContain('omits message "farewell"');
    expect(omitted?.summary).toContain(
      'Reported at messages, because messages/farewell is not in this file',
    );
    // The machine-readable pointer is still the whole of it. Only the span moved.
    expect(omitted?.path).toEqual(['messages', 'farewell']);
  });

  it('says nothing extra when the pointer resolves exactly', () => {
    // The control. A rule that explains itself on every diagnostic would be noise, and a test that
    // only ever sees the fallback cannot tell the two apart.
    const analysis = analyzeAtlasCatalogSet({
      configuration,
      catalogs: [
        catalog('source', 'en-US', SOURCE),
        catalog(
          'target',
          'ar-EG',
          'messages:\n  greeting: مرحبا\n  farewell: مع السلامة\n  invented: زائد\n',
        ),
      ],
      requireCompleteTargets: true,
    });
    const invented = analysis.diagnostics.find(
      ({ code }) => code === 'ATL1304',
    );
    expect(invented, 'the fixture did not produce ATL1304').toBeDefined();
    expect(invented?.summary).not.toContain('Reported at');
    // Line 4, the message it is actually about.
    expect(invented?.span?.start.line).toBe(3);
  });
});

describe('the resolver the rule is built on', () => {
  const target = catalog('target', 'ar-EG', 'messages:\n  greeting: مرحبا\n');

  it('stops at the nearest ancestor, at whatever depth the pointer breaks', () => {
    // Depth 1: `messages` exists, the message does not.
    expect(
      atlasCatalogPathAnchor(target, ['messages', 'absent'])?.resolved,
    ).toBe(1);
    // Depth 2: the message exists, and a scalar has nothing beneath it.
    expect(
      atlasCatalogPathAnchor(target, ['messages', 'greeting', 'inputs'])
        ?.resolved,
    ).toBe(2);
    // Depth 0: the top-level key itself is absent, so the document root is the answer.
    expect(
      atlasCatalogPathAnchor(target, ['families', 'x', 'template'])?.resolved,
    ).toBe(0);
    // Deep: everything after the first missing segment is missing with it.
    expect(
      atlasCatalogPathAnchor(target, [
        'messages',
        'absent',
        'inputs',
        'count',
        'type',
      ])?.resolved,
    ).toBe(1);
  });

  it('reports an exact hit as one', () => {
    const anchor = atlasCatalogPathAnchor(target, ['messages', 'greeting']);
    expect(anchor?.resolved).toBe(2);
    expect(anchor?.span.start.line).toBe(1);
  });

  it('answers nothing rather than a position it made up', () => {
    // An empty pointer has no ancestor to fall back to, and a catalog whose source text was never
    // retained has no positions at all. Both answer no location rather than `file:1:1`, and the
    // file name a diagnostic carries elsewhere remains a true statement on its own.
    expect(atlasCatalogPathAnchor(target, [])).toBeUndefined();
  });
});
