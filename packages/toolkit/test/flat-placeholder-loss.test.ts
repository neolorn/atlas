import { describe, expect, it } from 'vitest';

import {
  exportAtlasXliff22,
  importAtlasXliff22,
  parseAtlasCatalog,
  type AtlasCatalog,
  type AtlasCatalogParseOptions,
} from '../src/index.js';

/**
 * A translation that stopped rendering a value the source renders.
 *
 * A message with variants has no inline XLIFF representation, one unit holds one pattern, so
 * it is exported flat: the whole MessageFormat source as text, with no `<ph>` elements and no
 * `<originalData>`. Nothing in that representation is structural, so until now nothing compared it
 * to the source, and a translator or a translation-management system could delete `{$count}` and
 * hand back a document that parses, validates, imports, and renders a sentence with the number
 * missing.
 *
 * The comparison these cases pin down is between the inputs the source renders anywhere and the
 * inputs the translation renders anywhere. It is coarser than the inline check on purpose, and the
 * two cases that hold it there (a variant that legitimately omits the value, and a locale with
 * three times as many variants as the source) are asserted alongside the ones that catch loss,
 * because a check that refuses those would be worse than no check at all.
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
  lines: readonly string[],
  options: AtlasCatalogParseOptions,
): AtlasCatalog {
  const parsed = parseAtlasCatalog([...lines, ''].join('\n'), options);
  if (!parsed.ok) {
    throw new Error(
      `fixture catalog is invalid: ${parsed.diagnostics.map(({ summary }) => summary).join('; ')}`,
    );
  }
  return parsed.value;
}

/** Two variants, both rendering the count. */
const ENGLISH = catalog(
  [
    'messages:',
    '  files: |-',
    '    .input {$count :number}',
    '    .match $count',
    '    one {{You have {$count} file.}}',
    '    * {{You have {$count} files.}}',
  ],
  sourceOptions,
);

function arabic(...variants: readonly string[]): AtlasCatalog {
  return catalog(
    [
      'messages:',
      '  files: |-',
      '    .input {$count :number}',
      '    .match $count',
      ...variants.map((variant) => `    ${variant}`),
    ],
    targetOptions,
  );
}

function summaries(
  diagnostics: readonly { readonly summary: string }[],
): string {
  return diagnostics.map(({ summary }) => summary).join('\n');
}

describe('a flat translation that drops a value', () => {
  it('is refused on export, and a selector is not a rendering', () => {
    // Every variant kept its plural category and its `.match`, so the message still selects on the
    // count: it just never prints it. That is the exact shape a deletion leaves behind, and it is
    // why the check reads patterns rather than the whole message text: a rule that looked for
    // `$count` anywhere would find it in `.input` and `.match` and pass this.
    const dropped = exportAtlasXliff22({
      source: ENGLISH,
      target: arabic('one {{لديك ملف.}}', '* {{لديك ملفات.}}'),
    });
    expect(dropped.ok).toBe(false);
    expect(summaries(dropped.diagnostics)).toContain('"$count"');
    expect(dropped.diagnostics.map(({ code }) => code)).toContain('ATL1802');

    // The control: the same two variants, same locale, same call, with the count printed.
    expect(
      exportAtlasXliff22({
        source: ENGLISH,
        target: arabic(
          'one {{لديك {$count} ملف.}}',
          '* {{لديك {$count} ملفات.}}',
        ),
      }).ok,
    ).toBe(true);
  });

  it('accepts a locale whose variants do not line up with the source, and need not', () => {
    // Six variants against the source's two, and three of the six print no number at all, because
    // Arabic does not need one to say "no files" or "one file". A per-variant comparison would
    // have to reject this, and there is no way to key these variants to the source's anyway:
    // there is no `zero` and no `two` on the English side to key them to.
    const exported = exportAtlasXliff22({
      source: ENGLISH,
      target: arabic(
        'zero {{ليس لديك ملفات.}}',
        'one {{لديك ملف واحد.}}',
        'two {{لديك ملفان.}}',
        'few {{لديك {$count} ملفات.}}',
        'many {{لديك {$count} ملفًا.}}',
        '* {{لديك {$count} ملف.}}',
      ),
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    // And the whole MessageFormat source went across, which is what makes the flat representation
    // usable at all: the translator sees the variants even though XLIFF cannot key them.
    expect(exported.value).toContain('.match $count');
  });

  it('follows a renamed local to the input it was declared from', () => {
    // The source names the value `$shown`; the translation reaches the same input directly. Nothing
    // is lost, and a comparison of variable names as written would say two things were.
    const renamed = catalog(
      [
        'messages:',
        '  total: |-',
        '    .local $shown = {$count :number}',
        '    .match $shown',
        '    one {{Total: {$shown} item}}',
        '    * {{Total: {$shown} items}}',
      ],
      sourceOptions,
    );
    const direct = catalog(
      [
        'messages:',
        '  total: |-',
        '    .input {$count :number}',
        '    .match $count',
        '    one {{الإجمالي: {$count} عنصر}}',
        '    * {{الإجمالي: {$count} عناصر}}',
      ],
      targetOptions,
    );
    expect(exportAtlasXliff22({ source: renamed, target: direct }).ok).toBe(
      true,
    );

    // The check is still live under that resolution: the same rename with the value gone is caught.
    const gone = catalog(
      [
        'messages:',
        '  total: |-',
        '    .input {$count :number}',
        '    .match $count',
        '    one {{الإجمالي: عنصر}}',
        '    * {{الإجمالي: عناصر}}',
      ],
      targetOptions,
    );
    const refused = exportAtlasXliff22({ source: renamed, target: gone });
    expect(refused.ok).toBe(false);
    expect(summaries(refused.diagnostics)).toContain('"$count"');
  });

  it('does not count an input the translation only selects on', () => {
    // Arabic addresses a reader by gender where English addresses nobody, so the translation has a
    // selector the source has no counterpart for at all. Selectors are outside the comparison in
    // both directions, and this is the case that needs them to be: `$gender` is neither a value the
    // source lost nor one the translation invented, it is how this locale picks a sentence.
    const plain = catalog(
      ['messages:', '  greeting: "Welcome, {$name}."'],
      sourceOptions,
    );
    const gendered = catalog(
      [
        'messages:',
        '  greeting: |-',
        '    .input {$gender :string}',
        '    .match $gender',
        '    feminine {{أهلًا بكِ يا {$name}.}}',
        '    * {{أهلًا بك يا {$name}.}}',
      ],
      targetOptions,
    );
    expect(exportAtlasXliff22({ source: plain, target: gendered }).ok).toBe(
      true,
    );
  });

  it('is refused on import, which is where it actually arrives', () => {
    // Export is Atlas checking its own catalogs. Import is the direction a translation comes back
    // from someone else, so it is the one that has to hold.
    const document = exportAtlasXliff22({
      source: ENGLISH,
      target: arabic('one {{ملف واحد}}', '* {{عدد الملفات: {$count}}}'),
    });
    expect(document.ok).toBe(true);
    if (!document.ok) return;

    // The control, before the edit: this document imports.
    expect(
      importAtlasXliff22({ document: document.value, source: ENGLISH }).ok,
    ).toBe(true);

    // The edit a translation tool makes when someone deletes the placeholder from the one variant
    // that had it. The English `<source>` is untouched: this substring is Arabic.
    const edited = document.value.replace(
      'عدد الملفات: {$count}',
      'عدد الملفات',
    );
    expect(edited).not.toBe(document.value);

    const imported = importAtlasXliff22({ document: edited, source: ENGLISH });
    expect(imported.ok).toBe(false);
    expect(summaries(imported.diagnostics)).toContain('"$count"');
    expect(imported.diagnostics.map(({ code }) => code)).toContain('ATL1803');
  });
});
