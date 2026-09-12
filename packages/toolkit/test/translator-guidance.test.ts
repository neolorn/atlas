import { describe, expect, it } from 'vitest';

import {
  exportAtlasXliff22,
  formatAtlasCatalog,
  importAtlasXliff22,
  parseAtlasCatalog,
  type AtlasCatalog,
  type AtlasCatalogParseOptions,
} from '../src/index.js';

/**
 * Notes and target state across the XLIFF boundary.
 *
 * `specs/01-standards-profile.spec.md` section 12 requires the interchange mapping to preserve
 * notes, context and segment state. Each of the three is lost quietly when it is not carried:
 *
 * - `description` and `context` can be parsed from YAML and carried through the compiled model and
 *   still be dropped where the document is written, which nothing in a build reports. It leaves
 *   the translator, the one person the fields exist for, with no statement of what the message
 *   means or where it appears.
 * - `state` belongs on `<segment>` by XLIFF 2.2 Core §3.2.2.6 and never on `<target>`, and a
 *   value hardcoded to `translated` makes an untranslated placeholder import as finished work and
 *   report success.
 *
 * What Atlas does *not* do is absorb notes it did not write. XLIFF is an interchange artifact and
 * never an authoring format under `specs/01-standards-profile.spec.md` section 10; a translator's
 * own commentary belongs in the document and the translation-management system, not in a catalog
 * field with no way to edit it.
 * It is reported rather than dropped, which is what that mapping requires of a note Atlas did not
 * write.
 */

const sourceOptions: AtlasCatalogParseOptions = {
  role: 'source',
  providerId: '@example/app',
  scopeId: 'shell',
  locale: 'en-US',
};

const targetOptions: AtlasCatalogParseOptions = {
  ...sourceOptions,
  role: 'target',
  locale: 'ar-EG',
};

function catalog(
  text: string,
  options: AtlasCatalogParseOptions,
): AtlasCatalog {
  const parsed = parseAtlasCatalog(text, options);
  if (!parsed.ok) {
    throw new Error(
      `fixture catalog is invalid: ${parsed.diagnostics.map(({ summary }) => summary).join('; ')}`,
    );
  }
  return parsed.value;
}

const source = catalog(
  [
    'messages:',
    '  checkout:',
    '    message: "Place order"',
    '    description: "Button that submits the cart"',
    '    context: "Checkout page, primary action"',
    '',
  ].join('\n'),
  sourceOptions,
);

const target = catalog(
  ['messages:', '  checkout: "إتمام الطلب"', ''].join('\n'),
  targetOptions,
);

function exported(): string {
  const result = exportAtlasXliff22({ source, target });
  if (!result.ok) throw new Error('export failed');
  return result.value;
}

describe('guidance reaching the translator', () => {
  it('writes description and context as XLIFF Core notes', () => {
    const document = exported();

    expect(document).toContain(
      '<note id="atlas-source-description" category="atlas:description" appliesTo="source">Button that submits the cart</note>',
    );
    expect(document).toContain(
      '<note id="atlas-source-context" category="atlas:context" appliesTo="source">Checkout page, primary action</note>',
    );
  });

  it('places the notes where XLIFF 2.2 says a unit puts them', () => {
    // XLIFF 2.2 Core §3.2.2.5 orders a unit: other-namespace elements, then <notes>, then
    // <originalData>, then segments. A conforming consumer is entitled to reject any other order,
    // so position is part of the contract, not formatting.
    const document = exported();
    const metadata = document.indexOf('<mda:metadata>');
    const notes = document.indexOf('<notes>');
    const segment = document.indexOf('<segment');

    expect(metadata).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(metadata);
    expect(segment).toBeGreaterThan(notes);
  });

  it('writes no notes element at all when there is no guidance', () => {
    // `specs/01-standards-profile.spec.md` section 11 emits a module's data only where that data
    // exists. An empty <notes> element is also invalid: the content model requires one or more
    // <note>.
    const bare = catalog(
      ['messages:', '  plain: "Plain"', ''].join('\n'),
      sourceOptions,
    );
    const result = exportAtlasXliff22({ source: bare, targetLocale: 'ar-EG' });
    if (!result.ok) throw new Error('export failed');

    expect(result.value).not.toContain('<notes>');
  });

  it('keeps source and target guidance in separate notes', () => {
    const annotated = catalog(
      [
        'messages:',
        '  checkout:',
        '    message: "إتمام الطلب"',
        '    description: "صيغة رسمية"',
        '',
      ].join('\n'),
      targetOptions,
    );
    const result = exportAtlasXliff22({ source, target: annotated });
    if (!result.ok) throw new Error('export failed');

    expect(result.value).toContain(
      '<note id="atlas-target-description" category="atlas:description" appliesTo="target">صيغة رسمية</note>',
    );
    expect(result.value).toContain('appliesTo="source">Button that submits');
  });

  it('carries target guidance back on import', () => {
    const annotated = catalog(
      [
        'messages:',
        '  checkout:',
        '    message: "إتمام الطلب"',
        '    description: "صيغة رسمية"',
        '    context: "زر أساسي"',
        '',
      ].join('\n'),
      targetOptions,
    );
    const document = exportAtlasXliff22({ source, target: annotated });
    if (!document.ok) throw new Error('export failed');

    const imported = importAtlasXliff22({ document: document.value, source });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.value.messages['checkout']).toMatchObject({
      description: 'صيغة رسمية',
      context: 'زر أساسي',
    });

    // And back out to YAML, which is where the round trip actually ends: guidance that survives
    // only in memory has not survived anything.
    expect(formatAtlasCatalog(imported.value)).toBe(
      formatAtlasCatalog(annotated),
    );
  });
});

describe('notes Atlas did not write', () => {
  it('reports a translator note instead of dropping it', () => {
    const document = exported().replace(
      '</notes>',
      '  <note category="tms:comment">Confirmed the formal register with the client.</note>\n      </notes>',
    );

    const imported = importAtlasXliff22({ document, source });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // The translation still imports: a note is commentary rather than a defect in it.
    expect(imported.value.messages['checkout']).toBeDefined();
    expect(imported.diagnostics).toMatchObject([
      { code: 'ATL1803', severity: 'warning' },
    ]);
    expect(imported.diagnostics[0]?.summary).toContain('tms:comment');
  });

  it('names an uncategorized note rather than saying nothing', () => {
    const document = exported().replace(
      '</notes>',
      '  <note>Ask the client.</note>\n      </notes>',
    );

    const imported = importAtlasXliff22({ document, source });
    if (!imported.ok) throw new Error('import failed');

    expect(imported.diagnostics[0]?.summary).toContain('(uncategorized)');
  });

  it('reports a note attached to the whole file', () => {
    // Atlas writes no file-level notes, so one that arrives came from a translator or a tool, and
    // the same rule applies one level up: not absorbed, not dropped quietly.
    const document = exported().replace(
      '    <unit',
      [
        '    <notes>',
        '      <note>Deliver by Friday.</note>',
        '    </notes>',
        '    <unit',
      ].join('\n'),
    );

    const imported = importAtlasXliff22({ document, source });
    if (!imported.ok) throw new Error('import failed');

    expect(imported.value.messages['checkout']).toBeDefined();
    expect(imported.diagnostics[0]?.summary).toContain(
      'XLIFF file carries notes',
    );
  });

  it('refuses a note that is not plain text', () => {
    // XLIFF 2.2 Core §3.2.2.9 makes <note> text only. Anything else is a document Atlas cannot
    // read faithfully, and guessing at its meaning is what "MUST fail actionably rather than
    // approximate" forbids.
    const document = exported().replace(
      '</notes>',
      '  <note category="atlas:context"><pc id="1">markup</pc></note>\n      </notes>',
    );

    const imported = importAtlasXliff22({ document, source });
    expect(imported.ok).toBe(false);
  });

  it('does not let an interchange document rewrite the source guidance', () => {
    const document = exported().replace(
      'Button that submits the cart',
      'Button that submits the basket',
    );

    const imported = importAtlasXliff22({ document, source });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // Not applied, because the authoring catalog owns it. Said out loud all the same, because a
    // translator who rewrote the explanation is reporting that the original was unclear.
    expect(imported.diagnostics).toMatchObject([
      { code: 'ATL1803', severity: 'warning' },
    ]);
    expect(imported.diagnostics[0]?.summary).toContain('source description');
    expect(source.messages['checkout']).toMatchObject({
      description: 'Button that submits the cart',
    });
  });
});

describe('target state', () => {
  it('writes state on the segment, which is the element that has it', () => {
    const document = exported();

    expect(document).toContain('<segment state="translated">');
    // XLIFF 2.2 does not allow state on <target>, so writing it there makes every document Atlas
    // produces non-conformant against its own pinned profile.
    expect(document).not.toContain('<target xml:space="preserve" state=');
  });

  it('leaves the segment stateless when there is nothing to translate yet', () => {
    const result = exportAtlasXliff22({ source, targetLocale: 'ar-EG' });
    if (!result.ok) throw new Error('export failed');

    expect(result.value).toContain('<segment>');
    expect(result.value).not.toContain('state=');
  });

  it('does not import a target still in its initial state', () => {
    // A translation-management system pre-populates targets before anyone translates them. Taking
    // one as finished work puts source-language text into an Arabic catalog and calls it success.
    const document = exported().replace(
      '<segment state="translated">',
      '<segment state="initial">',
    );

    const imported = importAtlasXliff22({ document, source });
    expect(imported.ok).toBe(false);
    expect(imported.diagnostics).toMatchObject([
      { code: 'ATL1803', severity: 'warning' },
      { code: 'ATL1803' },
    ]);
    expect(imported.diagnostics[0]?.summary).toContain('initial state');
  });

  it('imports a reviewed or final segment', () => {
    for (const state of ['reviewed', 'final']) {
      const document = exported().replace(
        '<segment state="translated">',
        `<segment state="${state}">`,
      );

      const imported = importAtlasXliff22({ document, source });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      expect(imported.value.messages['checkout']).toBeDefined();
    }
  });

  it('refuses a state the standard does not define', () => {
    const document = exported().replace(
      '<segment state="translated">',
      '<segment state="approved">',
    );

    const imported = importAtlasXliff22({ document, source });
    expect(imported.ok).toBe(false);
    expect(imported.diagnostics[0]?.summary).toContain('approved');
  });
});
