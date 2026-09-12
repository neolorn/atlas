/** Generated from cldr-person-names-full 48.2.0 by tools/generate-person-names.mjs. */

/**
 * Cube axes, in the order the flat cell index walks them.
 *
 * The runtime reads these rather than restating them: the index is computed in two places and
 * a disagreement between them would be a silent read of the wrong pattern, not an error.
 */
// prettier-ignore
export const ATLAS_PERSON_NAME_ORDERS = ["givenFirst","surnameFirst","sorting"] as const;
// prettier-ignore
export const ATLAS_PERSON_NAME_LENGTHS = ["long","medium","short"] as const;
// prettier-ignore
export const ATLAS_PERSON_NAME_USAGES = ["referring","addressing","monogram"] as const;
// prettier-ignore
export const ATLAS_PERSON_NAME_FORMALITIES = ["formal","informal"] as const;

/**
 * CLDR root, in the shape a generated profile set uses.
 *
 * Used when a formatting context carries no profile set. Root is not a good answer for any
 * particular locale: it is the answer that is not invented.
 */
// prettier-ignore
export const ATLAS_PERSON_NAME_ROOT: {
  readonly profile: string;
  readonly patterns: readonly string[];
  readonly rows: readonly (readonly [
    string, readonly number[], number, number, number, number, number, number,
    readonly string[], readonly string[],
  ])[];
} = Object.freeze({
  profile: "cldr-48.2/atlas-person-names-1",
  patterns: Object.freeze(["{title} {given} {given2} {surname} {surname2} {credentials}","{given-monogram-allCaps}{given2-monogram-allCaps}{surname-monogram-allCaps}","{surname} {surname2} {title} {given} {given2} {credentials}","{surname-monogram-allCaps}{given-monogram-allCaps}{given2-monogram-allCaps}","{surname} {surname2}, {title} {given} {given2} {credentials}","{0}.","{0} {1}"," "] as const),
  rows: Object.freeze([["und",[0,0,0,0,1,1,0,0,0,0,1,1,0,0,0,0,1,1,2,2,2,2,3,3,2,2,2,2,3,3,2,2,2,2,3,3,4,4,-1,-1,-1,-1,4,4,-1,-1,-1,-1,4,4,-1,-1,-1,-1],5,6,7,7,1,0,["und"],["ja","ko","vi","yue","zh"]]] as const),
});
