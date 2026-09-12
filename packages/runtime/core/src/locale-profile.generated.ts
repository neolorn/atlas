/** Generated from cldr-core 48.2.0 and Unicode 17.0.0 by tools/generate-locale-profile.mjs. */
export const LOCALE_DATA_PROFILE =
  'cldr-48.2+unicode-17.0/atlas-rtl-bidi-1' as const;

/**
 * Every script code written right to left, from the CLDR release named above.
 *
 * What a locale's direction is decided by: the script, rather than the language, because a language
 * written in two scripts reads in two directions.
 */
// prettier-ignore
export const RTL_SCRIPTS = Object.freeze(["Adlm","Arab","Armi","Avst","Chrs","Cprt","Elym","Gara","Hatr","Hebr","Hung","Khar","Lydi","Mand","Mani","Mend","Merc","Mero","Narb","Nbat","Nkoo","Orkh","Ougr","Palm","Phli","Phlp","Phnx","Prti","Rohg","Samr","Sarb","Sidt","Sogd","Sogo","Syrc","Thaa","Yezi"] as const);

/**
 * Every code point whose Unicode `Bidi_Class` is `R` or `AL`.
 *
 * The source of a character class rather than a compiled expression, so the runtime picks its
 * own flags. Derived from the vendored UCD file that `standards/sources.lock.json` names. `Bidi_Class`
 * is the property that says whether a character reorders the text around it; script membership only
 * stood in for it, and missed the Siyaq numerals in both of the forms that were tried.
 *
 * Unassigned code points in blocks reserved for right-to-left scripts are included, because that is
 * what the standard says they are: the next character added to the Arabic block is `AL` before
 * anyone regenerates this file.
 */
// prettier-ignore
export const RTL_STRONG_CHARACTERS = "[\\u{590}\\u{5BE}\\u{5C0}\\u{5C3}\\u{5C6}\\u{5C8}-\\u{5FF}\\u{608}\\u{60B}\\u{60D}\\u{61B}-\\u{64A}\\u{66D}-\\u{66F}\\u{671}-\\u{6D5}\\u{6E5}-\\u{6E6}\\u{6EE}-\\u{6EF}\\u{6FA}-\\u{710}\\u{712}-\\u{72F}\\u{74B}-\\u{7A5}\\u{7B1}-\\u{7EA}\\u{7F4}-\\u{7F5}\\u{7FA}-\\u{7FC}\\u{7FE}-\\u{815}\\u{81A}\\u{824}\\u{828}\\u{82E}-\\u{858}\\u{85C}-\\u{88F}\\u{892}-\\u{896}\\u{8A0}-\\u{8C9}\\u{200F}\\u{FB1D}\\u{FB1F}-\\u{FB28}\\u{FB2A}-\\u{FBC2}\\u{FBD3}-\\u{FD3D}\\u{FD50}-\\u{FD8F}\\u{FD92}-\\u{FDC7}\\u{FDF0}-\\u{FDFC}\\u{FE70}-\\u{FEFE}\\u{10800}-\\u{1091E}\\u{10920}-\\u{10A00}\\u{10A04}\\u{10A07}-\\u{10A0B}\\u{10A10}-\\u{10A37}\\u{10A3B}-\\u{10A3E}\\u{10A40}-\\u{10AE4}\\u{10AE7}-\\u{10B38}\\u{10B40}-\\u{10D23}\\u{10D28}-\\u{10D2F}\\u{10D3A}-\\u{10D3F}\\u{10D4A}-\\u{10D68}\\u{10D6F}-\\u{10E5F}\\u{10E7F}-\\u{10EAA}\\u{10EAD}-\\u{10ECF}\\u{10ED9}-\\u{10EF9}\\u{10F00}-\\u{10F45}\\u{10F51}-\\u{10F81}\\u{10F86}-\\u{10FFF}\\u{1E800}-\\u{1E8CF}\\u{1E8D7}-\\u{1E943}\\u{1E94B}-\\u{1EEEF}\\u{1EEF2}-\\u{1EFFF}]" as const;
