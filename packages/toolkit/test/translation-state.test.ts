import { describe, expect, it } from 'vitest';

import { parseAtlasCatalog } from '../src/index.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';
import { testProjectConfiguration } from './fixtures.js';
import {
  ATLAS_TRANSLATION_STATE_PROFILE,
  EMPTY_ATLAS_TRANSLATION_STATE,
  formatAtlasTranslationState,
  parseAtlasTranslationState,
  reconcileAtlasTranslationState,
} from '../src/translation-state.js';

/**
 * The English wording changes and the old translation stays.
 *
 * Nothing recorded what a translation was written against, so this produced success with an empty
 * diagnostics array. Atlas now keeps that record itself.
 *
 * The property worth protecting is that a report survives being seen. An advisory derived from a
 * cache clears itself on the next run, and one derived from a marker a person deletes depends on
 * them remembering. Neither is a record; both are a reminder that expires.
 */

const configuration = testProjectConfiguration(['en-US', 'ar-EG']);

function catalog(role: 'source' | 'target', locale: string, text: string) {
  const result = parseAtlasCatalog(`messages:\n  nav.home: ${text}\n`, {
    role,
    providerId: 'home',
    scopeId: 'shell',
    locale,
    sourcePath: `i18n/shell/${locale}.yaml`,
  });
  if (!result.ok) throw new Error(`fixture ${locale} failed to parse`);
  return result.value;
}

function graphOf(english: string, arabic: string) {
  const analysis = analyzeAtlasCatalogSet({
    configuration,
    catalogs: [
      catalog('source', 'en-US', english),
      catalog('target', 'ar-EG', arabic),
    ],
  });
  if (!analysis.ok) throw new Error('fixture failed to analyse');
  return analysis.value;
}

describe('translation provenance', () => {
  it('records nothing to report the first time it sees a translation', () => {
    const reconciled = reconcileAtlasTranslationState(
      graphOf('Home', 'الرئيسية'),
    );

    expect(reconciled.stale).toHaveLength(0);
    expect(Object.keys(reconciled.state.entries)).toHaveLength(1);
    expect(reconciled.changed).toBe(true);
  });

  it('reports a translation whose source has moved underneath it', () => {
    const first = reconcileAtlasTranslationState(graphOf('Home', 'الرئيسية'));
    const second = reconcileAtlasTranslationState(
      graphOf('Home page', 'الرئيسية'),
      first.state,
    );

    expect(second.stale).toHaveLength(1);
    expect(second.stale[0]?.messageId).toBe('nav.home');
    expect(second.stale[0]?.locale).toBe('ar-EG');
  });

  it('keeps reporting it until the translation actually changes', () => {
    // The whole reason the record is durable. A reminder that expires on the run that raises it
    // is worse than none, because a later clean run reads as "nothing wrong".
    const first = reconcileAtlasTranslationState(graphOf('Home', 'الرئيسية'));
    let state = first.state;

    for (let run = 0; run < 3; run += 1) {
      const reconciled = reconcileAtlasTranslationState(
        graphOf('Home page', 'الرئيسية'),
        state,
      );
      expect(reconciled.stale, `run ${run}`).toHaveLength(1);
      state = reconciled.state;
    }
  });

  it('clears itself when the translation is updated, with nothing asked of anyone', () => {
    const first = reconcileAtlasTranslationState(graphOf('Home', 'الرئيسية'));
    const stale = reconcileAtlasTranslationState(
      graphOf('Home page', 'الرئيسية'),
      first.state,
    );
    const updated = reconcileAtlasTranslationState(
      graphOf('Home page', 'الصفحة الرئيسية'),
      stale.state,
    );

    expect(updated.stale).toHaveLength(0);
  });

  it('says nothing when a translation changes on its own', () => {
    // Retranslating without a source change is ordinary work, not staleness.
    const first = reconcileAtlasTranslationState(graphOf('Home', 'الرئيسية'));
    const second = reconcileAtlasTranslationState(
      graphOf('Home', 'الصفحة الرئيسية'),
      first.state,
    );

    expect(second.stale).toHaveLength(0);
  });

  it('drops entries for messages that no longer exist', () => {
    const populated = reconcileAtlasTranslationState(
      graphOf('Home', 'الرئيسية'),
    ).state;
    const withStrayEntry = {
      ...populated,
      entries: {
        ...populated.entries,
        'home:shell:deleted:ar-EG': { source: 'sha256-x', target: 'sha256-y' },
      },
    };

    const reconciled = reconcileAtlasTranslationState(
      graphOf('Home', 'الرئيسية'),
      withStrayEntry,
    );

    expect(Object.keys(reconciled.state.entries)).toHaveLength(1);
  });

  it('treats an unreadable record as absent rather than failing a build', () => {
    // A corrupt or hand-edited file re-stamps from scratch, which reports nothing rather than
    // something false, and never stops work.
    for (const text of ['', 'not json', '{}', '{"profile":"other"}', '[]']) {
      expect(parseAtlasTranslationState(text)).toEqual(
        EMPTY_ATLAS_TRANSLATION_STATE,
      );
    }
  });

  it('round-trips and serialises deterministically', () => {
    const state = reconcileAtlasTranslationState(
      graphOf('Home', 'الرئيسية'),
    ).state;
    const text = formatAtlasTranslationState(state);

    expect(text).toContain(ATLAS_TRANSLATION_STATE_PROFILE);
    expect(parseAtlasTranslationState(text)).toEqual(state);
    expect(formatAtlasTranslationState(parseAtlasTranslationState(text))).toBe(
      text,
    );
  });
});
