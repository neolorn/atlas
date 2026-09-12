import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { atlasDiagnosticsBlock } from '../src/diagnostics.js';

/**
 * Can the gate fail at all?
 *
 * The rest of the checks are verified by `atlas check` or by the `verify` scripts, and until this
 * existed neither could fail on what they depend on. `atlas check --require-complete` returned
 * exit 0 and `"status": "success"` while carrying `ATL1310` at `severity: error`; `atlas generate`
 * did the same on the same input. A gate that cannot report a failure is not a weaker gate, it is a
 * claim nobody is holding.
 *
 * Kept apart from the freshness criterion next door, which shares no surface with it: this one is a
 * pure question about a predicate and a source file and runs in milliseconds, while that one builds
 * a project on disk per case. The assurance harness runs one named file per injection, so the split
 * is what lets `success-path-never-inspects-severity` be checked without dragging two project
 * builds along behind it.
 */

describe('a blocking diagnostic is decided by severity, never by a code list', () => {
  it('blocks on error severity and passes on warning, for a code no list mentions', () => {
    // `ATL1310` is deliberate: it is error-severity, it is in none of the CLI's code lists, and it
    // is the diagnostic that was silently passing.
    const diagnostic = {
      code: 'ATL1310',
      severity: 'error',
      summary: 'synthetic',
      path: ['messages', 'cart.items'],
    } as const;
    expect(atlasDiagnosticsBlock([diagnostic])).toBe(true);
    expect(
      atlasDiagnosticsBlock([{ ...diagnostic, severity: 'warning' }]),
    ).toBe(false);
    expect(atlasDiagnosticsBlock([])).toBe(false);
  });

  it('blocks on a code that exists nowhere in the CLI, so the rule cannot be code-keyed', async () => {
    const cli = await readFile(
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'utf8',
    );
    // The wrong fix this refuses: adding ATL1310 to a hardcoded blocking-codes list. Such a fix
    // passes the test above and fails this one, because the code used here is in no list at all
    // and does not appear in the CLI.
    const absent = 'ATL9999';
    expect(cli.includes(absent)).toBe(false);
    expect(
      atlasDiagnosticsBlock([
        {
          code: absent as never,
          severity: 'error',
          summary: 'a diagnostic the CLI has never heard of',
          path: ['messages', 'cart.items'],
        },
      ]),
    ).toBe(true);
  });
});
