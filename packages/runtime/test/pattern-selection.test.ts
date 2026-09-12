import { describe, expect, it } from 'vitest';

import type {
  AtlasPatternMessageSemanticModel,
  AtlasSelectMessageSemanticModel,
} from '../../toolkit/src/message-format.js';
import type { CompiledInputContract } from '../src/catalog-runtime.js';
import { COUNT, parse, render, renderSemantics } from './message-harness.js';

/**
 * MF2 pattern selection, checked against the algorithm the specification defines.
 *
 * The specification walks every variant and keeps a provisional best. Returning the first variant
 * whose keys all match, in source order, is observably different in two directions for identical
 * catalog input:
 *
 * - a catch-all written above a matching keyed variant wins, and must not;
 * - a plural category written above an exact numeric key wins, and must not.
 *
 * The second cannot come out right in any order while the ranking that says "exact beats category"
 * is handed one key at a time and has nothing to choose between.
 *
 * The messages are parsed rather than hand-written as IR, so the variant order under test is the
 * order a catalog actually produces; `./message-harness.ts` holds that and says why.
 *
 * **Every assertion names which pattern was chosen, and the patterns are distinguishable.** A check
 * that asserted "some variant rendered" would pass for every ordering, which is the shape of check
 * that let this survive.
 */

describe('MF2 Compare Variants', () => {
  it('does not let a catch-all written first win over a keyed variant', () => {
    const source = [
      '.input {$count :number}',
      '.match $count',
      '* {{catch-all}}',
      'one {{category}}',
    ].join('\n');
    expect(render(source, COUNT, { count: 1 })).toBe('category');
  });

  it('still selects the catch-all when nothing else matches', () => {
    const source = [
      '.input {$count :number}',
      '.match $count',
      '* {{catch-all}}',
      'one {{category}}',
    ].join('\n');
    expect(render(source, COUNT, { count: 7 })).toBe('catch-all');
  });

  it('prefers an exact numeric key over a plural category written above it', () => {
    const source = [
      '.input {$count :number}',
      '.match $count',
      'one {{category}}',
      '1 {{exact}}',
      '* {{catch-all}}',
    ].join('\n');
    expect(render(source, COUNT, { count: 1 })).toBe('exact');
  });

  it('prefers an exact numeric key written above the category as well', () => {
    const source = [
      '.input {$count :number}',
      '.match $count',
      '1 {{exact}}',
      'one {{category}}',
      '* {{catch-all}}',
    ].join('\n');
    expect(render(source, COUNT, { count: 1 })).toBe('exact');
  });

  it('falls back to the category when no exact key matches', () => {
    const source = [
      '.input {$count :number}',
      '.match $count',
      '1 {{exact}}',
      'one {{category}}',
      '* {{catch-all}}',
    ].join('\n');
    // English gives 21 the `other` category, so neither the exact key nor `one` matches.
    expect(render(source, COUNT, { count: 21 })).toBe('catch-all');
  });

  it('ranks by the earlier selector first when two variants both match', () => {
    const source = [
      '.input {$count :number}',
      '.input {$other :number}',
      '.match $count $other',
      '* 1 {{second exact}}',
      '1 * {{first exact}}',
      '* * {{catch-all}}',
    ].join('\n');
    const inputs: readonly CompiledInputContract[] = Object.freeze([
      { name: 'count', type: 'number', optional: false, nullable: false },
      { name: 'other', type: 'number', optional: false, nullable: false },
    ]);
    expect(render(source, inputs, { count: 1, other: 1 })).toBe('first exact');
  });

  it('normalizes a variant key the compiled catalog did not normalize', () => {
    // The key is put into the compiled message in NFD, which the authoring path cannot produce:
    // an NFD key authored in a catalog reaches the runtime already in NFC. That is why this case
    // is built by rewriting one key of a real parse rather than by writing NFD in the source.
    //
    // What normalizes it is `messageformat`'s parser, not Atlas. `normalizeVariantKey` in
    // `packages/toolkit/src/message-format.ts` copies a key's value through untouched: it
    // normalizes the *shape* into Atlas's semantic model, not the string into NFC. Naming the
    // toolkit here would put Atlas's name on a third-party parser's behaviour, and the day that
    // behaviour changed the sentence would still read as though Atlas guaranteed it.
    // `packages/toolkit/test/message-format.test.ts` pins the parser so the change is a failing
    // test rather than a silent one.
    //
    // It still has to hold. The runtime is a separately published package whose input is a
    // compiled artifact, and it has no way to know what produced one. NormalizeKey is where the
    // specification puts the guarantee, so the guarantee is checked against the input the runtime
    // actually receives.
    const nfcKey = 'café';
    const nfdKey = 'café';
    expect(nfdKey).not.toBe(nfcKey);
    expect(nfdKey.normalize('NFC')).toBe(nfcKey);
    const parsed = parse(
      [
        '.input {$name :string}',
        '.match $name',
        `${nfcKey} {{matched}}`,
        '* {{catch-all}}',
      ].join('\n'),
    ) as AtlasSelectMessageSemanticModel;
    const denormalized: AtlasSelectMessageSemanticModel = {
      ...parsed,
      variants: parsed.variants.map((variant) => ({
        ...variant,
        keys: variant.keys.map((key) =>
          key.kind === 'literal' && key.value === nfcKey
            ? { ...key, value: nfdKey }
            : key,
        ),
      })),
    };
    const inputs: readonly CompiledInputContract[] = Object.freeze([
      { name: 'name', type: 'string', optional: false, nullable: false },
    ]);
    expect(renderSemantics(denormalized, inputs, { name: nfcKey })).toBe(
      'matched',
    );
  });
});
/**
 * A `.match` whose selector was produced by a function that formats but does not select.
 *
 * MessageFormat requires a *Bad Selector* here. Atlas reported nothing, and worse than nothing:
 * one factory builds the resolved value for all six numeric functions, so `:currency` and `:unit`
 * inherited numeric selection and matched keyed variants the standard says are unreachable.
 * `.match {42 :currency currency=EUR} 42 {{keyed}} * {{other}}` chose `keyed`. `:date` was quieter
 * and no better: its `match` returned false for every key, which is the visible half of the rule
 * with the reported half missing, so the author was never told the keyed variants were dead.
 *
 * The toolkit refuses such a message at parse (ATL1206), so no catalog can carry one here and the
 * sources below do not parse whole. The runtime keeps the rule anyway, because its input is a
 * compiled artifact and it has no way to know what produced one. The same reason and the same
 * construction as the NFD key above and the inherited `select` in `declaration-values.test.ts`:
 * the select body comes from a message that parses, the declaration from another that parses, and
 * only the join of the two is the shape under test.
 */
describe('a selector that cannot select', () => {
  const NONE: readonly CompiledInputContract[] = Object.freeze([]);

  const spliceSelector = (
    annotation: string,
    key: string,
  ): AtlasSelectMessageSemanticModel => {
    const selecting = parse(
      [
        `.local $v = {42 :number}`,
        '.match $v',
        `${key} {{keyed}}`,
        '* {{other}}',
      ].join('\n'),
    ) as AtlasSelectMessageSemanticModel;
    const formatting = parse(
      [`.local $v = {${annotation}}`, '{{{$v}}}'].join('\n'),
    ) as AtlasPatternMessageSemanticModel;
    return { ...selecting, declarations: formatting.declarations };
  };

  it.each([
    [':currency', '42 :currency currency=EUR', '42'],
    [':unit', '42 :unit unit=meter', '42'],
    [':date', '|2024-05-01| :date timeZone=UTC', '42'],
  ])('refuses %s', (label, annotation, key) => {
    expect(() =>
      renderSemantics(spliceSelector(annotation, key), NONE, {}),
    ).toThrow(new RegExp(`${label}, which formats but does not select`));
  });

  /**
   * The two paths differ by the annotation and nothing else, so the refusal above is known to be
   * the annotation's doing rather than the splice's. Without this the failing path would be the
   * only one ever exercised through `spliceSelector`, and a check exercised only where it fails
   * has been tested on one path.
   */
  it('renders the same shape when the annotation selects', () => {
    const selecting = parse(
      [
        '.local $v = {42 :number}',
        '.match $v',
        '42 {{keyed}}',
        '* {{other}}',
      ].join('\n'),
    ) as AtlasSelectMessageSemanticModel;
    const spliced = spliceSelector('42 :number', '42');
    expect(renderSemantics(selecting, NONE, {})).toBe('keyed');
    expect(renderSemantics(spliced, NONE, {})).toBe('keyed');
  });
});
