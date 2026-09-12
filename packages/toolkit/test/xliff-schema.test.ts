import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateXML } from 'xmllint-wasm';
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
 * Every document this package writes, against the schema OASIS publishes for the version it claims.
 *
 * `specs/01-standards-profile.spec.md` section 10 pins that version, and section 11 of
 * `specs/01-standards-profile.spec.md` requires what Atlas writes to validate against its schemas.
 * The defect took the shape of a version attribute naming one edition beside a namespace
 * belonging to another, which a test that only reads the document back cannot see.
 *
 * Nothing here is a round trip. An importer built against its own exporter accepts whatever that
 * exporter writes, which is why three separate conformance defects survived every interchange test
 * in the suite: the `id` attributes were not `xs:NMTOKEN`s, and `atlas:empty` sat on `<source>` and
 * `<target>`, the two elements inside a unit that admit no foreign attributes at all. The documents
 * were well-formed, self-consistent, round-tripped perfectly, and validated against nothing.
 *
 * The schemas are the vendored XLIFF 2.2 CS01 set under `standards/`, and the validator makes no
 * network requests: a gate that reaches the internet is a gate that fails when the internet does.
 */
const schemaDirectory = fileURLToPath(
  new URL('../../../standards/data/xliff-2.2-cs01-schemas/', import.meta.url),
);
const CORE_SCHEMA = 'xliff_core_2.2.xsd';

const preload = readdirSync(schemaDirectory)
  .filter((name) => name.endsWith('.xsd'))
  .map((name) => ({
    fileName: name,
    contents: readFileSync(`${schemaDirectory}${name}`, 'utf8'),
  }));

async function schemaErrors(document: string): Promise<readonly string[]> {
  const result = await validateXML({
    xml: [{ fileName: 'atlas-export.xlf', contents: document }],
    schema: [
      {
        fileName: CORE_SCHEMA,
        contents: readFileSync(`${schemaDirectory}${CORE_SCHEMA}`, 'utf8'),
      },
    ],
    preload,
    // The core schema imports the W3C `xml.xsd` by absolute URL. `--path .` is what makes libxml2
    // retry the last segment of a URL it could not open against the working directory, which is
    // where every vendored schema is preloaded; without it the schema does not even compile, and
    // the failure looks like a schema defect rather than a missing import.
    modifyArguments: (args) => ['--path', '.', ...args],
  });
  return result.errors.map(
    (error) => `line ${error.loc?.lineNumber ?? '?'}: ${error.message}`,
  );
}

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
      parsed.diagnostics.map((entry) => entry.summary).join('; '),
    );
  }
  return parsed.value;
}

/**
 * One catalog per message shape the exporter has a branch for.
 *
 * A gate that validates one greeting proves that one greeting validates. The shapes that matter are
 * the ones that reach different code: markup that pairs, markup that nests, markup that stands
 * alone, a placeholder that occurs twice and so cannot share an id, declarations that have to
 * survive as a code rather than as text, literal braces that have to survive escaping in both
 * directions, a pattern that begins with a period, a `.match` message that stays flat, and an empty
 * message that is deliberate rather than missing.
 */
const source = catalog(
  [
    'messages:',
    '  braces:',
    "    message: 'Use \\{curly\\} braces and a backslash \\\\ here.'",
    '  declared: |-',
    '    .input {$count :number}',
    '    {{You have {$count} items}}',
    '  dotted:',
    '    message: "{{...loading}}"',
    '  greeting:',
    '    message: "Hello {#strong}{$name}{/strong}!"',
    '    description: "Shown on the home page"',
    '    context: "Header"',
    '    inputs:',
    '      name: string',
    '    slots:',
    '      strong: strong',
    '  marker:',
    '    message: "Line one{#break /}line two"',
    '    slots:',
    '      break: code',
    '  nested:',
    '    message: "{#link}Read {#strong}this{/strong} now{/link}"',
    '    slots:',
    '      link: link',
    '      strong: strong',
    '  plural: |-',
    '    .input {$count :number}',
    '    .match $count',
    '    one {{One item}}',
    '    * {{{$count} items}}',
    '  repeated:',
    '    message: "{$name} and {$name} again"',
    '    inputs:',
    '      name: string',
    '  spacer:',
    '    empty: true',
    '',
  ].join('\n'),
  sourceOptions,
);

const target = catalog(
  [
    'messages:',
    "  braces: 'Utilisez des \\{accolades\\} et un antislash \\\\ ici.'",
    '  declared: |-',
    '    .input {$count :number}',
    '    {{Vous avez {$count} articles}}',
    '  dotted: "{{...chargement}}"',
    '  marker: "Ligne un{#break /}ligne deux"',
    '  greeting: "Bonjour {#strong}{$name}{/strong} !"',
    '  nested: "{#link}Lisez {#strong}ceci{/strong} maintenant{/link}"',
    '  plural: |-',
    '    .input {$count :number}',
    '    .match $count',
    '    one {{Un article}}',
    '    * {{{$count} articles}}',
    '  repeated: "{$name} et encore {$name}"',
    '  spacer:',
    '    empty: true',
    '',
  ].join('\n'),
  targetOptions,
);

describe('Atlas XLIFF 2.2 documents against the OASIS schema', () => {
  it('validates a bilingual export of every message shape', async () => {
    const exported = exportAtlasXliff22({ source, target });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(await schemaErrors(exported.value)).toEqual([]);
  });

  it('validates a source-only export, which has no <target> at all', async () => {
    const exported = exportAtlasXliff22({ source, targetLocale: 'ar-EG' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(await schemaErrors(exported.value)).toEqual([]);
  });

  it('round-trips every shape back to the target catalog it came from', () => {
    const exported = exportAtlasXliff22({ source, target });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const imported = importAtlasXliff22({ document: exported.value, source });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(formatAtlasCatalog(imported.value)).toBe(formatAtlasCatalog(target));
  });
});

describe('Atlas XLIFF inline codes', () => {
  const exported = exportAtlasXliff22({ source, target });

  it('carries a placeholder as an element and its text as original data', () => {
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value).toContain(
      '<data id="d0" xml:space="preserve">{$name}</data>',
    );
    expect(exported.value).toContain('dataRef="d0"');
    // The pattern is text plus codes, never raw MessageFormat a translator can retype.
    expect(exported.value).not.toContain(
      '<source xml:space="preserve">Hello {',
    );
  });

  it('gives the same placeholder twice two ids, because XLIFF requires it', () => {
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const unit = exported.value.slice(
      exported.value.indexOf('<unit id="repeated"'),
      exported.value.indexOf('<unit id="spacer"'),
    );
    const ids = [...unit.matchAll(/<ph id="([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(2);
    // One <data> entry for both, because original data is a pool and the text is identical.
    expect(unit.match(/<data /gu)).toHaveLength(1);
  });

  it('keeps a declaration block in a code rather than in text', () => {
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value).toContain('.input {$count :number}\n{{</data>');
    expect(exported.value).toContain('dataRefStart=');
  });

  it('leaves a .match message flat and says so in the contract', () => {
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const unit = exported.value.slice(
      exported.value.indexOf('<unit id="plural"'),
      exported.value.indexOf('<unit id="repeated"'),
    );
    expect(unit).toContain('&quot;representation&quot;:&quot;flat&quot;');
    expect(unit).not.toContain('<originalData>');
    expect(unit).toContain('.match $count');
  });

  /** Where one unit's `<target>` sits in the document. */
  function targetSpan(
    document: string,
    unitId: string,
  ): { readonly start: number; readonly end: number; readonly inner: string } {
    const unit = document.indexOf(`<unit id="${unitId}"`);
    expect(unit).toBeGreaterThan(-1);
    const start = document.indexOf('<target ', unit);
    expect(start).toBeGreaterThan(unit);
    const end = document.indexOf('</target>', start) + '</target>'.length;
    const open = document.indexOf('>', start) + 1;
    return {
      start,
      end,
      inner: document.slice(open, end - '</target>'.length),
    };
  }

  /** Rewrite one unit's `<target>` the way a translator working in a text editor would. */
  function retranslate(
    document: string,
    unitId: string,
    inner: string,
  ): string {
    const span = targetSpan(document, unitId);
    return `${document.slice(0, span.start)}<target xml:space="preserve">${inner}</target>${document.slice(span.end)}`;
  }

  it('refuses a translation that dropped a placeholder', () => {
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    // The words are still there and the markup around them is gone. The text parses as a perfectly
    // good message; it is simply the wrong one, and a flat run of MessageFormat could never have
    // said so: a deleted `{#strong}` leaves text that still parses.
    const imported = importAtlasXliff22({
      document: retranslate(exported.value, 'greeting', 'Bonjour toi !'),
      source,
    });
    expect(imported.ok).toBe(false);
  });

  it('names the placeholder a translation is missing', () => {
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const imported = importAtlasXliff22({
      document: retranslate(exported.value, 'repeated', 'Rien du tout'),
      source,
    });
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(
      imported.diagnostics.some((entry) => entry.summary.includes('{$name}')),
    ).toBe(true);
  });

  it('refuses a translation that invented a placeholder', () => {
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    // A code that stands for `{$name}` where the source has only one. The message it rebuilds to is
    // valid MessageFormat and refers to a declared input; it is simply not a translation of this
    // source message, and the only thing that can say so is the code table.
    const inner = targetSpan(exported.value, 'greeting').inner;
    const imported = importAtlasXliff22({
      document: retranslate(
        exported.value,
        'greeting',
        `${inner} et <ph id="cx" dataRef="d0"/>`,
      ),
      source,
    });
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(
      imported.diagnostics.some((entry) => entry.summary.includes('{$name}')),
    ).toBe(true);
  });

  it('accepts a translation that reorders the placeholders it kept', () => {
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const [first, second] = targetSpan(exported.value, 'repeated')
      .inner.split(' et encore ')
      .map((part) => part.trim());
    const imported = importAtlasXliff22({
      document: retranslate(
        exported.value,
        'repeated',
        `${second} avant ${first}`,
      ),
      source,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(
      (imported.value.messages['repeated'] as { message?: string }).message,
    ).toBe('{$name} avant {$name}');
  });

  it('reads a brace a translator typed as a brace, not as a placeholder', () => {
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const imported = importAtlasXliff22({ document: exported.value, source });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const braces = imported.value.messages['braces'] as { message?: string };
    expect(braces.message).toBe(
      'Utilisez des \\{accolades\\} et un antislash \\\\ ici.',
    );
  });
});
