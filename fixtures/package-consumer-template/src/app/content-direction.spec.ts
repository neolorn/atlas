import { describe, expect, it } from 'vitest';

import { contentPresentation, languagePresentation } from '@neolorn/atlas';

/**
 * Consumer content whose language may not be known.
 *
 * `specs/03-locale-identity-and-resolution.spec.md` section 10 says user-authored, multilingual and
 * language-independent values "retain
 * their own known language and direction … or an explicit unknown state". The unknown state had no
 * representation: `languagePresentation('und')` answered `ltr`, so content explicitly marked
 * undetermined was assigned a direction Atlas had no basis for.
 *
 * A customer types their name in Arabic, the application stores it without a language tag
 * (user-supplied text usually arrives without one) and it renders left-to-right, with nothing in
 * the output to record that the direction was guessed.
 *
 * `auto` is not a third direction. It defers to the renderer's first-strong rule, which is what
 * `dir="auto"` already does in a browser, so Atlas still never determines the authoritative
 * language of consumer content.
 */

describe('content whose language is known', () => {
  it('keeps its direction', () => {
    expect(contentPresentation('ar-EG')).toEqual({
      language: 'ar-EG',
      direction: 'rtl',
      classification: 'known',
    });
    expect(contentPresentation('en-US')).toEqual({
      language: 'en-US',
      direction: 'ltr',
      classification: 'known',
    });
  });

  it('keeps a direction that comes from the script when the language is undetermined', () => {
    // und-Arab says "we do not know the language, but we know it is written in Arabic script".
    // That is a real answer and must not be flattened into the unknown case.
    expect(contentPresentation('und-Arab')).toMatchObject({
      direction: 'rtl',
      classification: 'known',
    });
  });
});

describe('content whose language is not known', () => {
  it('defers instead of guessing when no tag is supplied', () => {
    expect(contentPresentation()).toEqual({
      direction: 'auto',
      classification: 'unknown',
    });
  });

  it('defers for an explicitly undetermined tag', () => {
    // The regression this pins. languagePresentation still answers 'ltr' here, because it answers
    // a different question, what direction a *locale* runs in, and a locale is always known.
    expect(contentPresentation('und')).toMatchObject({
      direction: 'auto',
      classification: 'unknown',
    });
    expect(languagePresentation('und').direction).toBe('ltr');
  });

  it('does not infer a direction from region alone', () => {
    // und-EG is "undetermined, in Egypt". Reading Arabic out of the region would be inferring the
    // language of consumer content, which is exactly what Atlas must not do.
    expect(contentPresentation('und-EG')).toMatchObject({
      direction: 'auto',
      classification: 'unknown',
    });
  });

  it('treats language-independent content as its own case', () => {
    // An order reference or a SKU has no language to take a direction from, and calling that
    // "unknown" would misdescribe it, since nobody is missing information.
    expect(contentPresentation('zxx')).toMatchObject({
      direction: 'auto',
      classification: 'language-independent',
    });
  });

  it('still rejects a malformed tag', () => {
    // Garbage is a programming error, not an unknown. Silently returning 'auto' here would hide a
    // consumer bug behind a legitimate-looking answer.
    expect(() => contentPresentation('!!bad')).toThrow();
    expect(() => contentPresentation('')).toThrow();
  });
});
