/**
 * The `Intl` capabilities Atlas relies on, probed on every engine it claims to support.
 *
 * `specs/01-standards-profile.spec.md` section 5 makes the host's own implementation the engine and
 * requires a capability to be feature-detected before anything rests on it. The probe runs on the
 * pinned Node version and in the three browser engines, so each detection is exercised against
 * the engines a release claims rather than against a stub.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { chromium, firefox, webkit } from 'playwright';

assert.equal(
  process.version,
  'v24.18.0',
  `The exact capability row requires Node v24.18.0; received ${process.version}`,
);

async function probePlatform() {
  const requiredIntl = {
    canonicalLocales: typeof Intl.getCanonicalLocales === 'function',
    locale:
      typeof Intl.Locale === 'function' &&
      new Intl.Locale('ar-EG').baseName === 'ar-EG',
    numberParts:
      typeof Intl.NumberFormat === 'function' &&
      typeof Intl.NumberFormat.prototype.formatToParts === 'function',
    dateTimeParts:
      typeof Intl.DateTimeFormat === 'function' &&
      typeof Intl.DateTimeFormat.prototype.formatToParts === 'function',
    dateTimeRange:
      typeof Intl.DateTimeFormat.prototype.formatRange === 'function' &&
      typeof Intl.DateTimeFormat.prototype.formatRangeToParts === 'function',
    pluralRules:
      typeof Intl.PluralRules === 'function' &&
      typeof Intl.PluralRules.prototype.select === 'function',
    relativeTime: typeof Intl.RelativeTimeFormat === 'function',
    list: typeof Intl.ListFormat === 'function',
    displayNames: typeof Intl.DisplayNames === 'function',
    collator: typeof Intl.Collator === 'function',
    supportedValues:
      typeof Intl.supportedValuesOf === 'function' &&
      Intl.supportedValuesOf('timeZone').length > 0,
  };

  const optionalIntl = {
    durationFormat: typeof Intl.DurationFormat === 'function',
    numberRange:
      typeof Intl.NumberFormat.prototype.formatRange === 'function' &&
      typeof Intl.NumberFormat.prototype.formatRangeToParts === 'function',
    pluralRange: typeof Intl.PluralRules.prototype.selectRange === 'function',
    segmenter: typeof Intl.Segmenter === 'function',
    temporal: typeof globalThis.Temporal === 'object',
  };

  const localeProfiles = Object.fromEntries(
    [
      'ar-EG',
      'en-US',
      'az-Arab',
      'az-Latn',
      'ff-Adlm',
      'ff-Latn',
      'pa-Arab',
      'pa-Guru',
      'sd-Deva',
      'sd-PK',
      'und-Hebr',
      'und-Latn',
    ].map((input) => {
      const locale = new Intl.Locale(input);
      const maximized = locale.maximize();
      return [
        input,
        {
          canonical: locale.toString(),
          language: maximized.language,
          script: maximized.script ?? null,
          region: maximized.region ?? null,
        },
      ];
    }),
  );

  const encoder = new TextEncoder();
  const bytes = encoder.encode('atlas-platform-capability-probe');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  let ed25519 = false;

  try {
    const keys = await globalThis.crypto.subtle.generateKey(
      { name: 'Ed25519' },
      false,
      ['sign', 'verify'],
    );
    const signature = await globalThis.crypto.subtle.sign(
      'Ed25519',
      keys.privateKey,
      bytes,
    );
    ed25519 = await globalThis.crypto.subtle.verify(
      'Ed25519',
      keys.publicKey,
      signature,
      bytes,
    );
  } catch {
    ed25519 = false;
  }

  const instant = new Date('2026-01-02T15:04:05.000Z');
  const rangeEnd = new Date('2026-01-04T15:04:05.000Z');

  // Where each engine puts a direction control inside a number.
  //
  // Every such control is data rather than an algorithm. LDML part 3 says number patterns may carry
  // LRM, RLM and ALM, and the release ships them inside the symbols themselves: the Arabic minus
  // sign is U+061C followed by the hyphen, the Latin-digit one is U+200E followed by it, and the
  // Arabic currency pattern opens with U+200F. Atlas builds no numeric text of its own and inserts
  // none of these, so a control reaches a page only because an engine emitted it out of whatever
  // release that engine carries.
  //
  // Which is why the row measures it. A server emitting one set and a browser emitting another
  // differ by characters nobody can see, inside a string this project server-renders and the
  // browser then renders again from the same values: the same shape as the locale self-name
  // difference, and invisible to any assertion about the text a reader sees. The positions are
  // recorded beside the strings so that a drift in the controls alone is named as one rather than
  // hidden inside a whole-string comparison.
  const controlsOf = (text) => {
    if (text === null) return null;
    const found = [];
    let index = 0;
    for (const character of text) {
      const point = character.codePointAt(0);
      if (
        point === 0x061c ||
        point === 0x200e ||
        point === 0x200f ||
        (point >= 0x202a && point <= 0x202e) ||
        (point >= 0x2066 && point <= 0x2069)
      ) {
        found.push(`${index}:${point.toString(16)}`);
      }
      index += 1;
    }
    return found.join(' ');
  };

  const formats = Object.fromEntries(
    ['en-US', 'ar-EG'].map((locale) => {
      const currency = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
      }).format(1234.5);
      const number = new Intl.NumberFormat(locale).format(1234.5);
      const numberSigned = new Intl.NumberFormat(locale).format(-1234.5);
      // Null where the engine has no number range at all, which is what the runtime reports rather
      // than composing one, so null here is the same answer read at the same place.
      const numberRange =
        typeof Intl.NumberFormat.prototype.formatRange === 'function'
          ? new Intl.NumberFormat(locale).formatRange(-5, 3)
          : null;
      return [
        locale,
        {
          currency,
          currencyControls: controlsOf(currency),
          date: new Intl.DateTimeFormat(locale, {
            dateStyle: 'full',
            timeZone: 'UTC',
          }).format(instant),
          dateRange: new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeZone: 'UTC',
          }).formatRange(instant, rangeEnd),
          displayLanguage: new Intl.DisplayNames([locale], {
            type: 'language',
          }).of('fr'),
          list: new Intl.ListFormat(locale, {
            style: 'long',
            type: 'conjunction',
          }).format(['alpha', 'bravo', 'charlie']),
          number,
          numberControls: controlsOf(number),
          numberRange,
          numberRangeControls: controlsOf(numberRange),
          numberSigned,
          numberSignedControls: controlsOf(numberSigned),
          plural: new Intl.PluralRules(locale).select(2),
          relativeDay: new Intl.RelativeTimeFormat(locale, {
            numeric: 'always',
          }).format(-1, 'day'),
        },
      ];
    }),
  );

  return {
    crypto: {
      ed25519,
      sha256: digest.byteLength === 32,
    },
    formats,
    localeProfiles,
    optionalIntl,
    requiredIntl,
  };
}

function assertRequiredCapabilities(evidence, runtime) {
  for (const [capability, supported] of Object.entries(evidence.requiredIntl)) {
    assert.equal(
      supported,
      true,
      `${runtime} lacks required Intl capability ${capability}`,
    );
  }

  assert.equal(
    evidence.crypto.sha256,
    true,
    `${runtime} lacks required Web Crypto SHA-256`,
  );
}

const nodeEvidence = await probePlatform();
assertRequiredCapabilities(nodeEvidence, `Node ${process.version}`);
assert.deepEqual(nodeEvidence.localeProfiles, {
  'ar-EG': {
    canonical: 'ar-EG',
    language: 'ar',
    script: 'Arab',
    region: 'EG',
  },
  'en-US': {
    canonical: 'en-US',
    language: 'en',
    script: 'Latn',
    region: 'US',
  },
  'az-Arab': {
    canonical: 'az-Arab',
    language: 'az',
    script: 'Arab',
    region: 'IR',
  },
  'az-Latn': {
    canonical: 'az-Latn',
    language: 'az',
    script: 'Latn',
    region: 'AZ',
  },
  'ff-Adlm': {
    canonical: 'ff-Adlm',
    language: 'ff',
    script: 'Adlm',
    region: 'GN',
  },
  'ff-Latn': {
    canonical: 'ff-Latn',
    language: 'ff',
    script: 'Latn',
    region: 'SN',
  },
  'pa-Arab': {
    canonical: 'pa-Arab',
    language: 'pa',
    script: 'Arab',
    region: 'PK',
  },
  'pa-Guru': {
    canonical: 'pa-Guru',
    language: 'pa',
    script: 'Guru',
    region: 'IN',
  },
  'sd-Deva': {
    canonical: 'sd-Deva',
    language: 'sd',
    script: 'Deva',
    region: 'IN',
  },
  'sd-PK': {
    canonical: 'sd-PK',
    language: 'sd',
    script: 'Arab',
    region: 'PK',
  },
  'und-Hebr': {
    canonical: 'und-Hebr',
    language: 'he',
    script: 'Hebr',
    region: 'IL',
  },
  'und-Latn': {
    canonical: 'und-Latn',
    language: 'en',
    script: 'Latn',
    region: 'US',
  },
});

const capabilityServer = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Atlas capability probe</title>');
});

await new Promise((resolveListen, rejectListen) => {
  capabilityServer.once('error', rejectListen);
  capabilityServer.listen(0, '127.0.0.1', resolveListen);
});

const browserRows = Object.freeze([
  Object.freeze({ id: 'chromium', label: 'Chromium', browserType: chromium }),
  Object.freeze({ id: 'firefox', label: 'Firefox', browserType: firefox }),
  Object.freeze({ id: 'webkit', label: 'WebKit', browserType: webkit }),
]);
const reviewedEnglishDateRangeSpacing = Object.freeze([
  Object.freeze({ format: 'dateRange', locale: 'en-US' }),
]);
const reviewedFormatDifferences = Object.freeze({
  chromium: reviewedEnglishDateRangeSpacing,
  firefox: reviewedEnglishDateRangeSpacing,
  webkit: reviewedEnglishDateRangeSpacing,
});
const browserResults = [];

try {
  const address = capabilityServer.address();
  assert.notEqual(address, null, 'Capability server has no address');
  assert.equal(typeof address, 'object', 'Capability server is not TCP');
  const capabilityOrigin = `http://127.0.0.1:${address.port}`;

  for (const row of browserRows) {
    let browser;

    try {
      browser = await row.browserType.launch({ headless: true });
    } catch (error) {
      throw new Error(
        `${row.label} could not start for the Atlas platform capability row. ` +
          `Install the pinned browser engines with "pnpm exec playwright install chromium firefox webkit" and retry. ` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    try {
      const version = browser.version();
      const page = await browser.newPage();
      await page.goto(capabilityOrigin);
      const evidence = await page.evaluate(probePlatform);
      assertRequiredCapabilities(evidence, `${row.label} ${version}`);
      assert.deepEqual(
        evidence.localeProfiles,
        nodeEvidence.localeProfiles,
        `${row.label} ${version} likely-script results differ from the Node reference row`,
      );

      const formatDifferences = [];
      const formatDifferenceDetails = [];
      for (const locale of Object.keys(nodeEvidence.formats)) {
        const nodeFormats = nodeEvidence.formats[locale];
        const browserFormats = evidence.formats[locale];

        for (const format of Object.keys(nodeFormats)) {
          if (nodeFormats[format] !== browserFormats[format]) {
            formatDifferences.push({ format, locale });
            formatDifferenceDetails.push({
              browser: browserFormats[format],
              format,
              locale,
              node: nodeFormats[format],
            });
          }
        }
      }

      const reviewedDifferences = reviewedFormatDifferences[row.id];
      if (reviewedDifferences !== undefined) {
        assert.deepEqual(
          formatDifferences,
          reviewedDifferences,
          `${row.label} ${version} native-formatting differences changed; review hydration safety`,
        );
      }

      browserResults.push({
        evidence,
        formatDifferenceDetails,
        formatDifferences,
        formatDifferencesReviewed: reviewedDifferences !== undefined,
        id: row.id,
        label: row.label,
        version,
      });
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolveClose, rejectClose) => {
    capabilityServer.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

// The row above proves agreement; this says what was agreed. A record that reports only "no
// differences" cannot be read later to find out what the engines actually emitted, and the
// positions are the whole content of the numeric direction-control measurement.
const numericControlEvidence = Object.entries(nodeEvidence.formats).map(
  ([locale, values]) =>
    `${locale}: number=[${values.numberControls}] signed=[${values.numberSignedControls}] ` +
    `range=[${values.numberRangeControls}] currency=[${values.currencyControls}]`,
);

process.stdout.write(
  [
    `Atlas platform capability rows verified against Node ${process.version}.`,
    `Numeric direction controls, agreed by every row above, as code-point index and value: ${numericControlEvidence.join('; ')}.`,
    ...browserResults.flatMap((result) => [
      `${result.label} ${result.version}: native formatting differences=${JSON.stringify(result.formatDifferences)}${result.formatDifferencesReviewed ? ' (reviewed)' : ' (uncharacterized; record after review)'}.`,
      `${result.label} ${result.version}: native formatting difference details=${JSON.stringify(result.formatDifferenceDetails)}.`,
      `${result.label} ${result.version}: conditional Intl=${JSON.stringify(result.evidence.optionalIntl)}.`,
      `${result.label} ${result.version}: conditional Ed25519 node=${nodeEvidence.crypto.ed25519}, browser=${result.evidence.crypto.ed25519}.`,
    ]),
  ].join('\n') + '\n',
);
