import { describe, expect, it } from 'vitest';

import { parseAtlasCatalog } from '../src/index.js';
import { inspectAtlasAuthoredBidi } from '../src/unicode-safety.js';

/**
 * The bidi policy for authored catalog values.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 7.1 is the policy, and this is where a value
 * carrying one of the refused characters is refused. Measured without one: every control reached rendered output through both render paths, with no
 * diagnostic at any stage. Translator-supplied content is untrusted data: it arrives from
 * outside the codebase, and these characters are invisible, so neither a reviewer reading a diff
 * nor a translator pasting from a tool can see what they do.
 *
 * Every character is written as an escape. A test whose fixtures are invisible cannot be reviewed,
 * which is the same reason the corpus in the feature lab is written this way.
 */

const LRE = '\u202a';
const RLE = '\u202b';
const PDF = '\u202c';
const LRO = '\u202d';
const RLO = '\u202e';
const LRI = '\u2066';
const RLI = '\u2067';
const FSI = '\u2068';
const PDI = '\u2069';
const LRM = '\u200e';
const RLM = '\u200f';
const ALM = '\u061c';
const ZWSP = '\u200b';
const WJ = '\u2060';
const BOM = '\ufeff';

function parse(value: string) {
  return parseAtlasCatalog(`messages:\n  m: ${JSON.stringify(value)}\n`, {
    role: 'source',
    providerId: 'p',
    scopeId: 's',
    locale: 'ar-EG',
    sourcePath: 'i18n/s/ar-EG.yaml',
  });
}

describe('characters that can reorder surrounding text', () => {
  it('refuses overrides and embeddings', () => {
    // The spoofing case: "Order <RLO>12345 shipped" displays as "Order deppihs 54321".
    for (const control of [LRE, RLE, PDF, LRO, RLO]) {
      expect(inspectAtlasAuthoredBidi(`Order ${control}12345 shipped`)).toBe(
        'directional-override',
      );
    }
  });

  it('refuses an isolate that is opened and never closed', () => {
    // Leaks exactly like an override: the run it was meant to contain never ends.
    for (const open of [LRI, RLI, FSI]) {
      expect(inspectAtlasAuthoredBidi(`مرحبا ${open}Acme Ltd`)).toBe(
        'unbalanced-isolate',
      );
    }
  });

  it('refuses an isolate that is closed and never opened', () => {
    expect(inspectAtlasAuthoredBidi(`مرحبا Acme${PDI} Ltd`)).toBe(
      'unbalanced-isolate',
    );
  });

  it('refuses a byte-order mark inside a value', () => {
    expect(inspectAtlasAuthoredBidi(`SKU${BOM}A`)).toBe('byte-order-mark');
  });

  it('refuses an override hidden inside a balanced isolate', () => {
    // The isolate is well formed, so a balance check alone would pass this.
    expect(inspectAtlasAuthoredBidi(`a ${FSI}x${RLO}y${PDI} b`)).toBe(
      'directional-override',
    );
  });

  it('reports the refusal through the catalog parser with a code', () => {
    const result = parse(`Order ${RLO}12345 shipped`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain('ATL1103');
    // The summary has to explain what the character does, since the reader cannot see it.
    expect(result.diagnostics[0]?.summary).toContain('reorders');
  });
});

describe('characters the policy keeps', () => {
  it('permits a balanced isolate', () => {
    // The capability deliberately retained: a translator needs this to wrap a Latin product name
    // inside Arabic prose, and refusing every isolate would remove it with nothing in its place.
    expect(
      inspectAtlasAuthoredBidi(`مرحبا ${FSI}Acme Ltd${PDI} اليوم`),
    ).toBeUndefined();
    expect(parse(`مرحبا ${FSI}Acme Ltd${PDI} اليوم`).ok).toBe(true);
  });

  it('permits nested balanced isolates', () => {
    expect(
      inspectAtlasAuthoredBidi(`a ${LRI}b ${FSI}c${PDI} d${PDI} e`),
    ).toBeUndefined();
  });

  it('permits directional marks', () => {
    // Each nudges one adjacent character and cannot reorder a run.
    for (const mark of [LRM, RLM, ALM]) {
      expect(inspectAtlasAuthoredBidi(`Total ${mark}42 due`)).toBeUndefined();
    }
  });

  it('permits zero-width space and word joiner', () => {
    expect(inspectAtlasAuthoredBidi(`SKU${ZWSP}A${WJ}B`)).toBeUndefined();
    expect(parse(`SKU${ZWSP}A${WJ}B`).ok).toBe(true);
  });

  it('permits ordinary text in either script', () => {
    expect(inspectAtlasAuthoredBidi('Order 12345 shipped')).toBeUndefined();
    expect(inspectAtlasAuthoredBidi('مرحبا بالعالم')).toBeUndefined();
  });
});
