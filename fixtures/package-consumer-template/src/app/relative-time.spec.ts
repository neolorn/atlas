import { beforeEach, describe, expect, it } from 'vitest';

import { TestBed } from '@angular/core/testing';
import {
  Localization,
  fixedClock,
  instant,
  provideLocalizationSetup,
  selectRelativeTime,
  withFormattingContext,
  withLocalizationClock,
  withRelativeTimePolicy,
  type RelativeTimePolicy,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * When a timestamp is phrased relatively, and in what unit.
 *
 * `specs/08-formatting-parsing-and-domain.spec.md` section 5 says who decides that a two-hour-old
 * thing reads "2 hours ago" and a two-year-old thing does not read "17,532 hours ago". With
 * nobody assigned, each of four applications would write the same selection loop, and they would
 * disagree.
 *
 * The split: Atlas owns the rule, largest unit the span reaches, truncated and never rounded up,
 * and the consumer owns the thresholds, because "3 days ago" is right on a message and wrong on
 * an invoice and Atlas has no basis for preferring either.
 *
 * The clock is a port for the same reason the reference instant is explicit: a "now" that cannot be
 * supplied cannot be tested, and a server render and the browser render that rehydrates it must be
 * able to agree on what "now" was.
 */

const NOON = 1_800_000_000_000;
const at = (offsetMilliseconds: number) =>
  instant(String(BigInt(NOON + offsetMilliseconds) * 1_000_000n));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function setup(policy?: RelativeTimePolicy): Localization {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideLocalizationSetup(
        {
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
        },
        withFormattingContext({ timeZone: 'Africa/Cairo' }),
        withLocalizationClock(fixedClock(at(0))),
        ...(policy === undefined ? [] : [withRelativeTimePolicy(policy)]),
      ),
    ],
  });
  return TestBed.inject(Localization);
}

describe('unit selection', () => {
  it('takes the largest unit the span reaches', () => {
    expect(selectRelativeTime(at(-30_000), at(0))).toMatchObject({
      unit: 'second',
      value: -30,
    });
    expect(selectRelativeTime(at(-5 * MINUTE), at(0))).toMatchObject({
      unit: 'minute',
      value: -5,
    });
    expect(selectRelativeTime(at(-3 * HOUR), at(0))).toMatchObject({
      unit: 'hour',
      value: -3,
    });
    expect(selectRelativeTime(at(-21 * DAY), at(0))).toMatchObject({
      unit: 'week',
      value: -3,
    });
  });

  it('truncates rather than rounds', () => {
    // 119 minutes is "1 hour ago", not "2 hours ago". Rounding up would claim something happened
    // longer ago than it did; rounding to nearest would claim the opposite at 91 minutes. Only
    // truncation is wrong in a direction nobody misreads.
    expect(selectRelativeTime(at(-119 * MINUTE), at(0))).toMatchObject({
      unit: 'hour',
      value: -1,
    });
  });

  it('keeps the sign, so the future reads as the future', () => {
    expect(selectRelativeTime(at(5 * MINUTE), at(0))).toMatchObject({
      unit: 'minute',
      value: 5,
    });
  });

  it('names the smallest permitted unit rather than inventing wording', () => {
    // Half a second under a minute-floor policy is zero minutes. Atlas does not turn that into
    // "just now": the phrase belongs to the product, and translating it is a catalog entry.
    expect(
      selectRelativeTime(at(-500), at(0), { smallestUnit: 'minute' }),
    ).toEqual({
      unit: 'minute',
      value: 0,
    });
  });
});

describe('thresholds the consumer declares', () => {
  it('stops being relative past the largest unit it will name', () => {
    const decision = selectRelativeTime(at(-425 * DAY), at(0), {
      largestUnit: 'month',
    });
    expect(decision.unit).toBeUndefined();
    expect(decision).toMatchObject({ elapsedMilliseconds: -425 * DAY });
  });

  it('stops being relative past an explicit ceiling', () => {
    const policy: RelativeTimePolicy = {
      absoluteAfterMilliseconds: 7 * DAY,
    };
    expect(selectRelativeTime(at(-2 * DAY), at(0), policy)).toMatchObject({
      unit: 'day',
    });
    expect(
      selectRelativeTime(at(-8 * DAY), at(0), policy).unit,
    ).toBeUndefined();
  });

  it('leaves the absolute rendering to the consumer', () => {
    // Atlas hands back the elapsed span and stops. Choosing the date format, the zone and the
    // wording of the fallback is the product decision this whole mechanism exists to avoid making.
    const decision = selectRelativeTime(at(-8 * DAY), at(0), {
      absoluteAfterMilliseconds: 7 * DAY,
    });
    expect(Object.keys(decision)).toEqual(['elapsedMilliseconds']);
  });
});

describe('the service call', () => {
  let localization: Localization;

  beforeEach(async () => {
    localization = setup();
    await localization.initialize();
  });

  it('selects and formats against the configured clock', () => {
    const outcome = localization.relativeTime(at(-3 * HOUR), {
      numeric: 'auto',
    });

    expect(outcome).toMatchObject({
      kind: 'relative',
      unit: 'hour',
      value: -3,
    });
    if (outcome.kind !== 'relative') return;
    expect(outcome.formatted.text).toBe('3 hours ago');
  });

  it('formats in the active locale', async () => {
    await localization.changeLocale('ar-EG');

    const outcome = localization.relativeTime(at(-2 * DAY));
    if (outcome.kind !== 'relative') {
      throw new Error('expected a relative phrase');
    }

    expect(outcome.unit).toBe('day');
    expect(outcome.formatted.direction).toBe('rtl');
    // Arabic has a dual: two days is one word, not "2 days". Asserting the digit would pass in
    // English and quietly encode a language that does not exist.
    expect(outcome.formatted.text).not.toContain('2');
  });

  it('reports an out-of-range span as a decision, not a failure', async () => {
    localization = setup({ absoluteAfterMilliseconds: 7 * DAY });
    await localization.initialize();

    const outcome = localization.relativeTime(at(-30 * DAY));

    // Not `unavailable`. Nothing broke: the policy did its job and the consumer now renders a
    // date. Folding this into the failure channel would make a correct answer look like a bug.
    expect(outcome.kind).toBe('absolute');
    if (outcome.kind !== 'absolute') return;
    expect(outcome.elapsedMilliseconds).toBe(-30 * DAY);
  });

  it('uses the system clock when none is supplied', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideLocalizationSetup({
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
        }),
      ],
    });
    const unclocked = TestBed.inject(Localization);
    await unclocked.initialize();

    const outcome = unclocked.relativeTime(
      instant(String(BigInt(Date.now() - 3 * HOUR) * 1_000_000n)),
    );

    expect(outcome).toMatchObject({
      kind: 'relative',
      unit: 'hour',
      value: -3,
    });
  });
});
