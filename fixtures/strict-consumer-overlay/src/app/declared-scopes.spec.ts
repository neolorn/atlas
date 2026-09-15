import { configuration } from '#i18n';

import {
  declaredScopeCount,
  deferredScopeIds,
  startupScopeIds,
} from './declared-scopes';

/**
 * These run against the real generated table, where the field carries an answer, so they also
 * hold the generation to emitting one. The overlay states no answer, and what proves the reader
 * survives that is the source above compiling at all during analysis.
 */
describe('the generated scope table read as data', () => {
  it('counts every scope this build declares', () => {
    expect(declaredScopeCount).toBe(configuration.scopes.length);
    expect(declaredScopeCount).toBeGreaterThan(1);
  });

  it('needs the shell scope for the first render', () => {
    expect(startupScopeIds()).toContain('shell');
  });

  it('leaves the scope behind a lazy boundary to its route', () => {
    expect(deferredScopeIds()).toContain('lazy');
    expect(startupScopeIds()).not.toContain('lazy');
  });

  it('accounts for every scope one way or the other', () => {
    expect([...startupScopeIds(), ...deferredScopeIds()].sort()).toEqual(
      configuration.scopes.map(({ scopeId }) => scopeId).sort(),
    );
  });
});
