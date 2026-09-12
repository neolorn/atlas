import {
  buildLocalizedRoute,
  compareLocalized,
  createIdentifierParameterCodec,
  createIntegerParameterCodec,
  createPathPrefixLocalePolicy,
  decimal,
  duration,
  externalDestination,
  formatDisplayName,
  formatDuration,
  formatInstantRange,
  formatList,
  formatLocalizedInput,
  formatNumberRange,
  formatPersonName,
  formatPlainDateTime,
  formatPlainDate,
  formatPlainTime,
  formatRelativeTime,
  formatZonedDateTime,
  iconPresentation,
  instant,
  internalDestination,
  localeMetadata,
  measurement,
  money,
  parseLocalizedInput,
  percent,
  percentagePoints,
  personName,
  plainDate,
  plainDateTime,
  plainTime,
  projectRouteSeo,
  resolveInitialRouteLocale,
  resolveLocalizedRoute,
  resolveTypography,
  routeHttpDescriptor,
  segmentText,
  selectPlural,
  timeZone,
  zonedDateTime,
  type FormattingContext,
  type FormattingResult,
} from '@neolorn/atlas';
import { configuration } from '#i18n';

import { routePolicy, appRouteProjection } from './localization.routes';

const english: FormattingContext = Object.freeze({
  locale: 'en-US',
  timeZone: 'UTC',
  calendar: 'gregory',
  numberingSystem: 'latn',
  hourCycle: 'h23',
});

const arabic: FormattingContext = Object.freeze({
  locale: 'ar-EG',
  timeZone: 'UTC',
  calendar: 'gregory',
  numberingSystem: 'arab',
  hourCycle: 'h23',
});

function expectExplicitCapability(result: FormattingResult): void {
  if (result.ok) {
    expect(result.value.text.length).toBeGreaterThan(0);
    return;
  }
  expect(result.diagnostic.code).toBe('unsupported-formatting-capability');
}

/**
 * The locale set a production build of this fixture generates.
 *
 * Stated rather than read off `configuration`, because `configuration` carries a third locale when
 * the suite's `atlas generate` was given `--pseudo` and these assertions are about the projection,
 * not about which command ran. The pseudo-locale's own case is asserted directly, below.
 */
const shippedLocales = Object.freeze(['en-US', 'ar-EG']);

describe('route and SEO contracts, called directly', () => {
  it('uses the generated Angular route projection as the single route authority', () => {
    expect(appRouteProjection.generated).toMatchObject({
      profile: 'atlas-route-projection/1',
      identity: expect.stringMatching(/^sha256-[A-Za-z0-9_-]{43}$/u),
    });
    expect(
      appRouteProjection.generated.routes.map(
        ({ id, path, parameterNames, indexing }) => ({
          id,
          path,
          parameterNames,
          indexing,
        }),
      ),
    ).toEqual([
      {
        id: 'article',
        path: 'articles/:slug',
        parameterNames: ['slug'],
        indexing: 'indexable',
      },
      {
        id: 'dossier',
        path: 'dossiers/:slug',
        parameterNames: ['slug'],
        indexing: 'indexable',
      },
      {
        id: 'item',
        path: 'items/:id',
        parameterNames: ['id'],
        indexing: 'non-indexable',
      },
      {
        id: 'route:_index',
        path: '',
        parameterNames: [],
        indexing: 'indexable',
      },
      {
        id: 'route:lazy',
        path: 'lazy',
        parameterNames: [],
        indexing: 'non-indexable',
      },
      {
        id: 'route:second',
        path: 'second',
        parameterNames: [],
        indexing: 'indexable',
      },
      {
        id: 'topic',
        path: 'topics/:topic',
        parameterNames: ['topic'],
        indexing: 'indexable',
      },
    ]);
  });

  /**
   * The identifier codec, through the route path rather than by calling it.
   *
   * `createIdentifierParameterCodec` is exported and reachable, and an export no route exercises
   * is an export nothing has watched work. Its sibling `createIntegerParameterCodec` is exercised
   * by the `items/:id` route.
   *
   * Asserted through `buildLocalizedRoute` and `resolveLocalizedRoute` rather than against the
   * codec object, because the claim worth having is not that a regular expression matches. It is
   * that a route whose parameter is an opaque identifier round-trips through the projection, is
   * byte-identical in every locale, and refuses the segments a path parameter must refuse.
   */
  it('round-trips an opaque identifier parameter and refuses what a path segment must refuse', () => {
    const address = '/en-us/topics/atlas-handbook';

    expect(
      buildLocalizedRoute(routePolicy, appRouteProjection, 'topic', 'en-US', {
        topic: 'atlas-handbook',
      }),
    ).toBe(address);

    // The property that separates this codec from the article slug beside it in the same
    // projection: an identifier names a thing, so it does not translate. A codec that localized
    // this would produce two addresses for one resource and split its indexing in half.
    expect(
      buildLocalizedRoute(routePolicy, appRouteProjection, 'topic', 'ar-EG', {
        topic: 'atlas-handbook',
      }),
    ).toBe('/ar-eg/topics/atlas-handbook');

    const resolved = resolveLocalizedRoute(
      address,
      routePolicy,
      appRouteProjection,
    );
    expect(resolved).toMatchObject({ status: 'success', routeId: 'topic' });
    if (resolved.status === 'success') {
      expect(resolved.parameters).toEqual({ topic: 'atlas-handbook' });
    }

    // The permissive half. `.`, `_`, `~` and `-` are legal inside an identifier and a codec that
    // forgot any of them would send a working address to a not-found page.
    expect(
      resolveLocalizedRoute(
        '/en-us/topics/a.b_c~d-e',
        routePolicy,
        appRouteProjection,
      ),
    ).toMatchObject({ status: 'success', routeId: 'topic' });

    // The refusing half, which is what a default pattern is for. Each of these is a real way a
    // path parameter is abused or malformed, and none of them may resolve to this route.
    for (const rejected of [
      'topics/..',
      'topics/%2e%2e',
      'topics/-leading-hyphen',
      'topics/has%20a%20space',
      `topics/${'x'.repeat(129)}`,
      'topics/',
    ]) {
      expect(
        resolveLocalizedRoute(
          `/en-us/${rejected}`,
          routePolicy,
          appRouteProjection,
        ).status,
      ).not.toBe('success');
    }

    // Building is the other direction and fails loudly rather than silently, because a link an
    // application writes with a value its own codec refuses is a bug in the application.
    expect(() =>
      buildLocalizedRoute(routePolicy, appRouteProjection, 'topic', 'en-US', {
        topic: '../etc',
      }),
    ).toThrow(/violates its codec/u);

    // Refused at construction: a global or sticky pattern carries `lastIndex` between calls, so
    // the same identifier would parse and then fail to parse.
    expect(() => createIdentifierParameterCodec(/^[a-z]+$/gu)).toThrow(
      /global or sticky/u,
    );
  });

  it('classifies locale entry, aliases, canonical corrections, and failures without guessing', () => {
    // No resolution context, so nothing about this request changed the answer, and the redirect
    // is still not publicly cacheable, because "/" is also the address every other visitor's answer
    // is served from. Reading this as a wasted round trip per visitor and making it public was
    // wrong. The round trip is what keeps a shared cache from handing one visitor's language
    // to the next, and cacheability is a property of the address rather than of the request
    // that happened to arrive at it.
    expect(resolveLocalizedRoute('/', routePolicy, appRouteProjection)).toEqual(
      {
        status: 'redirect',
        reason: 'locale-entry',
        httpStatus: 307,
        cache: 'private-no-store',
        locale: 'en-US',
        routeId: 'route:_index',
        location: '/en-us',
      },
    );
    expect(
      resolveLocalizedRoute(
        '/EN-US/Second/?tab=one#details',
        routePolicy,
        appRouteProjection,
      ),
    ).toMatchObject({
      status: 'redirect',
      reason: 'canonical-correction',
      httpStatus: 308,
      location: '/en-us/second?tab=one#details',
    });
    expect(
      resolveLocalizedRoute('/en/items/042', routePolicy, appRouteProjection),
    ).toMatchObject({
      status: 'redirect',
      reason: 'canonical-correction',
      location: '/en-us/items/42',
    });
    expect(
      resolveLocalizedRoute('/second', routePolicy, appRouteProjection),
    ).toMatchObject({
      status: 'redirect',
      reason: 'locale-entry',
      location: '/en-us/second',
    });
    expect(
      resolveLocalizedRoute('/fr/second', routePolicy, appRouteProjection),
    ).toMatchObject({
      status: 'unsupported-locale',
      httpStatus: 404,
      requestedLocale: 'fr',
    });
    expect(
      resolveLocalizedRoute(
        '/en-us/legacy?tab=one#details',
        routePolicy,
        appRouteProjection,
      ),
    ).toMatchObject({
      status: 'redirect',
      reason: 'replacement',
      httpStatus: 308,
      location: '/en-us/second?tab=one#details',
    });
    const gone = resolveLocalizedRoute(
      '/ar-eg/removed',
      routePolicy,
      appRouteProjection,
    );
    expect(gone).toEqual({
      status: 'gone',
      httpStatus: 410,
      presentationLocale: 'ar-EG',
    });
    expect(routeHttpDescriptor(gone)).toEqual({
      status: 410,
      contentLanguage: 'ar-EG',
      robots: 'noindex',
      cache: 'private-no-store',
    });
    const malformed = resolveLocalizedRoute(
      '/en-us/%2F',
      routePolicy,
      appRouteProjection,
    );
    expect(malformed).toMatchObject({
      status: 'malformed',
      httpStatus: 400,
      presentationLocale: 'en-US',
    });
    expect(routeHttpDescriptor(malformed)).toEqual({
      status: 400,
      contentLanguage: 'en-US',
      robots: 'noindex',
      cache: 'private-no-store',
    });
    expect(
      resolveLocalizedRoute('/en-us//second', routePolicy, appRouteProjection),
    ).toMatchObject({ status: 'malformed', httpStatus: 400 });
    expect(() =>
      createPathPrefixLocalePolicy({
        defaultLocale: 'en-US',
        locales: { 'en-US': 'en', 'en-us': 'english' },
      }),
    ).toThrow(/invalid or colliding/u);
    expect(() => createIntegerParameterCodec(10, 1)).toThrow(
      /ordered safe range/u,
    );
  });

  it('preserves typed route state and emits one coherent SEO/HTTP projection', () => {
    const resolution = resolveLocalizedRoute(
      '/en-us/second?tab=one#details',
      routePolicy,
      appRouteProjection,
    );
    expect(resolution.status).toBe('success');
    if (resolution.status !== 'success') return;

    expect(
      buildLocalizedRoute(
        routePolicy,
        appRouteProjection,
        'item',
        'ar-EG',
        { id: 42 },
        [{ name: 'tab', value: 'one' }],
        'details',
      ),
    ).toBe('/ar-eg/items/42?tab=one#details');
    expect(
      projectRouteSeo(
        resolution,
        routePolicy,
        appRouteProjection,
        { ...configuration, locales: shippedLocales },
        'https://atlas.example',
      ),
    ).toEqual({
      indexing: 'indexable',
      canonical: 'https://atlas.example/en-us/second',
      alternates: [
        {
          locale: 'en-US',
          hreflang: 'en-US',
          url: 'https://atlas.example/en-us/second',
        },
        {
          locale: 'ar-EG',
          hreflang: 'ar-EG',
          url: 'https://atlas.example/ar-eg/second',
        },
      ],
      xDefault: 'https://atlas.example/',
    });

    // The other direction of the same rule, and the reason the configuration is an argument at
    // all. This policy names three locales in every build; an `hreflang` link is a public claim
    // that the same page exists in another language, so the claim is made for the locales the
    // build generated and no others. Two above, three here, one file.
    expect(
      projectRouteSeo(
        resolution,
        routePolicy,
        appRouteProjection,
        { ...configuration, locales: [...shippedLocales, 'en-Arab-XB'] },
        'https://atlas.example',
      ).alternates.map(({ url }) => url),
    ).toEqual([
      'https://atlas.example/en-us/second',
      'https://atlas.example/ar-eg/second',
      'https://atlas.example/en-arab-xb/second',
    ]);

    expect(routeHttpDescriptor(resolution)).toEqual({
      status: 200,
      contentLanguage: 'en-US',
      cache: 'public',
    });
    expect(
      resolveInitialRouteLocale(
        { url: 'https://host.invalid/ar-eg/second?x=1' },
        routePolicy,
        appRouteProjection,
      ),
    ).toBe('ar-EG');

    const privateResolution = resolveLocalizedRoute(
      '/en-us/items/42',
      routePolicy,
      appRouteProjection,
    );
    expect(privateResolution.status).toBe('success');
    if (privateResolution.status !== 'success') return;
    expect(
      projectRouteSeo(
        privateResolution,
        routePolicy,
        appRouteProjection,
        configuration,
        'https://atlas.example',
      ),
    ).toEqual({
      indexing: 'non-indexable',
      alternates: [],
      robots: 'noindex',
    });
  });
});

describe('native formatting and localized input contracts', () => {
  it('covers the native formatting surface with typed capability outcomes', () => {
    const formattedDate = formatPlainDate(plainDate(2026, 8, 3), english);
    const formattedTime = formatPlainTime(plainTime(14, 30, 15), english);
    const formattedDateTime = formatPlainDateTime(
      plainDateTime(plainDate(2026, 8, 3), plainTime(14, 30, 15)),
      english,
    );
    const zoned = formatZonedDateTime(
      zonedDateTime(instant('0'), 'UTC'),
      english,
      { dateStyle: 'medium', timeStyle: 'short' },
    );
    const range = formatNumberRange(decimal('1'), decimal('2'), english);
    const dateRange = formatInstantRange(
      instant('0'),
      instant('86400000000000'),
      english,
      { dateStyle: 'medium', timeZone: 'UTC' },
    );
    const nativeDuration = formatDuration(duration({ minutes: 5 }), english);
    const list = formatList(['Atlas', 'Angular', 'Intl'], english);
    const relative = formatRelativeTime(decimal('-1'), 'day', english, {
      numeric: 'auto',
    });
    const display = formatDisplayName('EG', english, { type: 'region' });

    for (const result of [
      formattedDate,
      formattedTime,
      formattedDateTime,
      zoned,
      range,
      dateRange,
      nativeDuration,
      list,
      relative,
      display,
    ]) {
      expectExplicitCapability(result);
    }
    expect(formattedDate.ok && formattedDate.value.language).toBe('en-US');
    expect(relative.ok && relative.value.text.toLowerCase()).toContain(
      'yesterday',
    );

    const name = formatPersonName(
      personName('ar', { given: 'هشام', surname: 'محمد' }),
      english,
      { order: 'given-first' },
    );
    expect(name).toMatchObject({
      ok: true,
      value: {
        text: 'هشام محمد',
        language: 'ar',
        direction: 'rtl',
      },
    });
    // No profile set is threaded here, so this is CLDR root: root lists zh as surname-first, and
    // root`s surnameFirst/medium/referring/formal is
    // `{surname} {surname2} {title} {given} {given2} {credentials}`. A space between them,
    // because root has no reason to know that Chinese joins them without one. An application that
    // configures a Chinese locale gets the compact form from the zh profile; this one asserts what
    // root says, which is what Atlas answers when it was given nothing else.
    expect(
      formatPersonName(
        personName('zh', { given: '明', surname: '王' }),
        english,
      ),
    ).toMatchObject({
      ok: true,
      value: { text: '王 明', language: 'zh', direction: 'ltr' },
    });
    expect(formatPlainTime(plainTime(14, 30, 15, 1), english)).toMatchObject({
      ok: false,
      diagnostic: { code: 'unsupported-formatting-capability' },
    });
    expect(() => duration({ seconds: decimal('-1') })).toThrow(
      /duration sign is separate/u,
    );
    expect(selectPlural(decimal('1'), english)).toEqual({
      ok: true,
      value: 'one',
    });
    expect(compareLocalized('a', 'b', english)).toEqual({
      ok: true,
      value: -1,
    });
    expect(
      segmentText('Atlas works', english, { granularity: 'word' }),
    ).toMatchObject({
      ok: true,
    });
    expect(localeMetadata('ar-EG')).toMatchObject({
      ok: true,
      value: { locale: 'ar-EG', language: 'ar', direction: 'rtl' },
    });
  });

  it('round-trips declared input profiles and rejects ambiguous or hidden repair', () => {
    const decimalProfile = {
      kind: 'decimal',
      allowGrouping: true,
      maximumFractionDigits: 2,
    } as const;
    expect(
      parseLocalizedInput('1,234.50', decimalProfile, english),
    ).toMatchObject({ status: 'valid', value: { value: '1234.5' } });
    expect(parseLocalizedInput('1 2', decimalProfile, english)).toMatchObject({
      status: 'invalid',
    });
    expect(parseLocalizedInput(' 12', decimalProfile, english)).toMatchObject({
      status: 'invalid',
    });
    expect(parseLocalizedInput('1.', decimalProfile, english)).toMatchObject({
      status: 'incomplete',
    });
    expect(
      parseLocalizedInput(
        '1,234',
        { kind: 'decimal', maximumFractionDigits: 2 },
        english,
      ),
    ).toMatchObject({ status: 'policy-rejected' });

    const percentProfile = {
      kind: 'percent',
      scale: 'fractional',
      requirePercentSign: true,
      maximumFractionDigits: 2,
    } as const;
    const localizedPercent = formatLocalizedInput(
      percent(decimal('0.25')),
      percentProfile,
      arabic,
    );
    expect(localizedPercent.ok).toBe(true);
    if (!localizedPercent.ok) return;
    expect(
      parseLocalizedInput(localizedPercent.value.text, percentProfile, arabic),
    ).toMatchObject({
      status: 'valid',
      value: {
        kind: 'percent',
        amount: { value: '0.25' },
        scale: 'fractional',
      },
    });

    const moneyProfile = {
      kind: 'money',
      currency: 'USD',
      requireCurrency: true,
      maximumFractionDigits: 2,
    } as const;
    const localizedMoney = formatLocalizedInput(
      money(decimal('12.5'), 'USD'),
      moneyProfile,
      english,
    );
    expect(localizedMoney.ok).toBe(true);
    if (!localizedMoney.ok) return;
    expect(
      parseLocalizedInput(localizedMoney.value.text, moneyProfile, english),
    ).toMatchObject({ status: 'valid', value: { amount: { value: '12.5' } } });
    const negativeMoney = formatLocalizedInput(
      money(decimal('-12.5'), 'USD'),
      moneyProfile,
      english,
    );
    expect(negativeMoney.ok).toBe(true);
    if (!negativeMoney.ok) return;
    expect(
      parseLocalizedInput(negativeMoney.value.text, moneyProfile, english),
    ).toMatchObject({
      status: 'valid',
      value: { amount: { value: '-12.5' } },
    });
    expect(
      formatLocalizedInput(
        money(decimal('12.5'), 'EUR'),
        moneyProfile,
        english,
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: 'invalid-localized-input' },
    });

    const measurementProfile = {
      kind: 'measurement',
      unit: 'kilometer',
      requireUnit: true,
      maximumFractionDigits: 2,
    } as const;
    const localizedMeasurement = formatLocalizedInput(
      measurement(decimal('-12.5'), 'kilometer'),
      measurementProfile,
      arabic,
    );
    expect(localizedMeasurement.ok).toBe(true);
    if (!localizedMeasurement.ok) return;
    expect(
      parseLocalizedInput(
        localizedMeasurement.value.text,
        measurementProfile,
        arabic,
      ),
    ).toMatchObject({
      status: 'valid',
      value: { amount: { value: '-12.5' }, unit: 'kilometer' },
    });

    const pointsProfile = {
      kind: 'percentage-points',
      maximumFractionDigits: 1,
    } as const;
    const localizedPoints = formatLocalizedInput(
      percentagePoints(decimal('5.5')),
      pointsProfile,
      arabic,
    );
    expect(localizedPoints.ok).toBe(true);
    if (!localizedPoints.ok) return;
    expect(
      parseLocalizedInput(localizedPoints.value.text, pointsProfile, arabic),
    ).toMatchObject({
      status: 'valid',
      value: { amount: { value: '5.5' } },
    });

    expect(
      parseLocalizedInput(
        '03/08/2026',
        { kind: 'plain-date', order: 'day-month-year', separator: '/' },
        english,
      ),
    ).toMatchObject({
      status: 'valid',
      value: { year: 2026, month: 8, day: 3 },
    });
    expect(
      parseLocalizedInput(
        '2026-02-30',
        { kind: 'plain-date', order: 'year-month-day', separator: '-' },
        english,
      ),
    ).toMatchObject({ status: 'out-of-range' });

    const timeProfile = {
      kind: 'plain-time',
      hourCycle: 'h12',
      precision: 'fraction',
      separator: ':',
      fractionalSecondDigits: 3,
      dayPeriod: {
        am: 'AM',
        pm: 'PM',
        position: 'suffix',
        separator: ' ',
      },
    } as const;
    const localizedTime = formatLocalizedInput(
      plainTime(14, 5, 6, 120_000_000),
      timeProfile,
      english,
    );
    expect(localizedTime).toMatchObject({
      ok: true,
      value: { text: '02:05:06.120 PM' },
    });
    if (!localizedTime.ok) return;
    expect(
      parseLocalizedInput(localizedTime.value.text, timeProfile, english),
    ).toMatchObject({
      status: 'valid',
      value: { hour: 14, minute: 5, second: 6, nanosecond: 120_000_000 },
    });
    expect(
      parseLocalizedInput(
        '25:00',
        {
          kind: 'plain-time',
          hourCycle: 'h23',
          precision: 'minute',
          separator: ':',
        },
        english,
      ),
    ).toMatchObject({ status: 'out-of-range' });
    expect(
      parseLocalizedInput(
        '١٤٤٨-٠١-٠١',
        {
          kind: 'plain-date',
          order: 'year-month-day',
          separator: '-',
          calendar: 'islamic',
        },
        arabic,
      ),
    ).toMatchObject({ status: 'unsupported-capability' });

    const dateTimeProfile = {
      kind: 'plain-date-time',
      date: { order: 'day-month-year', separator: '/' },
      time: {
        hourCycle: 'h23',
        precision: 'second',
        separator: ':',
      },
      separator: ' ',
    } as const;
    const localizedDateTime = formatLocalizedInput(
      plainDateTime(plainDate(2026, 8, 3), plainTime(14, 5, 6)),
      dateTimeProfile,
      arabic,
    );
    expect(localizedDateTime.ok).toBe(true);
    if (!localizedDateTime.ok) return;
    expect(
      parseLocalizedInput(
        localizedDateTime.value.text,
        dateTimeProfile,
        arabic,
      ),
    ).toMatchObject({
      status: 'valid',
      value: {
        date: { year: 2026, month: 8, day: 3 },
        time: { hour: 14, minute: 5, second: 6 },
      },
    });

    const zoneProfile = {
      kind: 'time-zone',
      options: [
        { timeZone: 'Africa/Cairo', labels: ['القاهرة', 'Africa/Cairo'] },
        { timeZone: 'America/Chicago', labels: ['وسط'] },
        { timeZone: 'Asia/Shanghai', labels: ['وسط'] },
      ],
    } as const;
    const localizedZone = formatLocalizedInput(
      timeZone('Africa/Cairo'),
      zoneProfile,
      arabic,
    );
    expect(localizedZone).toMatchObject({
      ok: true,
      value: { text: 'القاهرة' },
    });
    expect(parseLocalizedInput('القاهرة', zoneProfile, arabic)).toMatchObject({
      status: 'valid',
      value: { id: 'Africa/Cairo' },
    });
    expect(parseLocalizedInput('وسط', zoneProfile, arabic)).toMatchObject({
      status: 'ambiguous',
    });
    expect(parseLocalizedInput('الق', zoneProfile, arabic)).toMatchObject({
      status: 'incomplete',
    });

    const durationProfile = {
      kind: 'duration',
      sign: 'optional',
      pattern: [
        {
          field: 'hours',
          minimumIntegerDigits: 2,
          maximumIntegerDigits: 2,
        },
        ':',
        {
          field: 'minutes',
          minimumIntegerDigits: 2,
          maximumIntegerDigits: 2,
          maximum: decimal('59'),
        },
        ':',
        {
          field: 'seconds',
          minimumIntegerDigits: 2,
          maximumIntegerDigits: 2,
          maximumFractionDigits: 3,
          maximum: decimal('59.999'),
        },
      ],
    } as const;
    const localizedDuration = formatLocalizedInput(
      duration({ hours: 2, minutes: 3, seconds: decimal('4.5') }, -1),
      durationProfile,
      arabic,
    );
    expect(localizedDuration.ok).toBe(true);
    if (!localizedDuration.ok) return;
    expect(
      parseLocalizedInput(
        localizedDuration.value.text,
        durationProfile,
        arabic,
      ),
    ).toMatchObject({
      status: 'valid',
      value: {
        sign: -1,
        hours: 2,
        minutes: 3,
        seconds: { value: '4.5' },
      },
    });
    expect(
      parseLocalizedInput('-00:00:00', durationProfile, english),
    ).toMatchObject({ status: 'policy-rejected' });
    expect(
      parseLocalizedInput('00:60:00', durationProfile, english),
    ).toMatchObject({ status: 'out-of-range' });
    expect(
      parseLocalizedInput(
        '1970-01-01T00:00:00Z',
        { kind: 'instant', syntax: 'rfc3339' },
        english,
      ),
    ).toMatchObject({
      status: 'valid',
      value: { epochNanoseconds: '0' },
    });
    const instantProfile = { kind: 'instant', syntax: 'rfc3339' } as const;
    const localizedInstant = formatLocalizedInput(
      instant('-500000000'),
      instantProfile,
      english,
    );
    expect(localizedInstant).toMatchObject({
      ok: true,
      value: { text: '1969-12-31T23:59:59.5Z' },
    });
    if (!localizedInstant.ok) return;
    expect(
      parseLocalizedInput(localizedInstant.value.text, instantProfile, english),
    ).toMatchObject({
      status: 'valid',
      value: { epochNanoseconds: '-500000000' },
    });
    expect(
      parseLocalizedInput('1970-01-01T00:00:00-00:00', instantProfile, english),
    ).toMatchObject({ status: 'policy-rejected' });
  });
});

describe('rich-content, bidi, typography, and icon policy', () => {
  it('requires application-owned destinations and preserves direction semantics', () => {
    expect(internalDestination('/help?from=atlas')).toEqual({
      kind: 'internal',
      href: '/help?from=atlas',
    });
    expect(
      externalDestination('https://support.example/guide', [
        'https://support.example',
      ]),
    ).toMatchObject({
      kind: 'external',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(() => internalDestination('//evil.example')).toThrow();
    expect(() =>
      externalDestination('javascript:alert(1)', ['https://support.example']),
    ).toThrow();
    expect(() =>
      externalDestination('https://support.example/guide', [
        'https://support.example/path',
      ]),
    ).toThrow(/HTTPS origin/u);

    expect(iconPresentation('relative', 'rtl').mirror).toBe(true);
    expect(iconPresentation('physical', 'rtl').mirror).toBe(false);
    expect(iconPresentation('neutral', 'ltr').mirror).toBe(false);
    expect(
      resolveTypography('ar-EG', {
        default: { id: 'default' },
        scripts: { Arab: { id: 'arabic', lineHeight: 1.7 } },
      }),
    ).toEqual({ id: 'arabic', lineHeight: 1.7 });
  });
});
