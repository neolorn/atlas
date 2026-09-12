/**
 * How much a diagnostic matters: `error` stops the operation, `warning` and `info` do not.
 *
 * A result carrying only warnings is still a success, so a caller that treats any diagnostic as a
 * failure will reject builds that are fine.
 */
export type AtlasDiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * Every diagnostic Atlas can report, as its stable code.
 *
 * Grouped by the thousand: configuration, catalogs, messages, compilation, routing, extensions and
 * output each have their own band. A code is never reused and never changes meaning, which is what
 * lets a build script suppress one particular warning without matching on its wording.
 */
export type AtlasDiagnosticCode =
  | 'ATL1001'
  | 'ATL1002'
  | 'ATL1003'
  | 'ATL1004'
  | 'ATL1005'
  | 'ATL1006'
  | 'ATL1007'
  | 'ATL1101'
  | 'ATL1102'
  | 'ATL1103'
  | 'ATL1104'
  | 'ATL1105'
  | 'ATL1201'
  | 'ATL1202'
  | 'ATL1203'
  | 'ATL1204'
  | 'ATL1205'
  | 'ATL1206'
  | 'ATL1301'
  | 'ATL1302'
  | 'ATL1303'
  | 'ATL1304'
  | 'ATL1305'
  | 'ATL1306'
  | 'ATL1307'
  | 'ATL1308'
  | 'ATL1309'
  | 'ATL1310'
  | 'ATL1311'
  | 'ATL1401'
  | 'ATL1402'
  | 'ATL1403'
  | 'ATL1404'
  | 'ATL1405'
  | 'ATL1406'
  | 'ATL1407'
  | 'ATL1408'
  | 'ATL1409'
  | 'ATL1410'
  | 'ATL1411'
  | 'ATL1412'
  | 'ATL1501'
  | 'ATL1502'
  | 'ATL1503'
  | 'ATL1601'
  | 'ATL1602'
  | 'ATL1603'
  | 'ATL1701'
  | 'ATL1702'
  | 'ATL1703'
  | 'ATL1704'
  | 'ATL1705'
  | 'ATL1706'
  | 'ATL1801'
  | 'ATL1802'
  | 'ATL1803'
  | 'ATL1804'
  | 'ATL1805'
  | 'ATL1806';

/** One point in a source file, given three ways so a caller can use whichever it needs. */
export interface AtlasSourcePosition {
  /** Characters from the start of the file, counting from zero. */
  readonly offset: number;
  /** Line number, counting from one, which is what an editor shows. */
  readonly line: number;
  /** Column within that line, counting from one. */
  readonly column: number;
}

/** The stretch of a file a diagnostic is about, from where it starts to where it ends. */
export interface AtlasSourceSpan {
  /** Which file, when the span came from one. Absent for text that was parsed out of memory. */
  readonly sourcePath?: string;
  /** Where the stretch begins. */
  readonly start: AtlasSourcePosition;
  /** Where it ends, one past the last character in it. */
  readonly end: AtlasSourcePosition;
}

/**
 * One thing Atlas has to say about what it was given: what it is, how much it matters, and where.
 *
 * The text is sanitized and bounded before it reaches here, because a diagnostic is printed to a
 * terminal and read by a machine, and neither should be steerable by the file that caused it.
 */
export interface AtlasDiagnostic {
  /** The stable code, for matching on without depending on the wording. */
  readonly code: AtlasDiagnosticCode;
  /** Whether this stopped the operation. */
  readonly severity: AtlasDiagnosticSeverity;
  /** What is wrong, in a sentence, for a person to read. */
  readonly summary: string;
  /**
   * Where inside the data it is, as the keys and indexes to walk from the root.
   *
   * For a diagnostic about a whole file this is empty; for one about a message in a catalog it
   * names the scope and the message.
   */
  readonly path: readonly (string | number)[];
  /** Where in the source text, when the input was text Atlas parsed. */
  readonly span?: AtlasSourceSpan;
}

/** An operation that finished, with what it produced and anything it had to say along the way. */
export interface AtlasSuccess<T> {
  readonly ok: true;
  /** What the operation produced. */
  readonly value: T;
  /** Warnings and notes. Never an error: an error would have made this a failure. */
  readonly diagnostics: readonly AtlasDiagnostic[];
}

/** An operation that did not finish, with the reasons. There is no partial value to read. */
export interface AtlasFailure {
  readonly ok: false;
  /** Why it failed, with at least one error among them, and possibly warnings beside it. */
  readonly diagnostics: readonly AtlasDiagnostic[];
}

/**
 * What every toolkit operation returns: a value with its diagnostics, or diagnostics alone.
 *
 * Returned rather than thrown, because a build that produced twelve problems should report twelve
 * rather than the first. Check `ok` before reading `value`.
 */
export type AtlasResult<T> = AtlasSuccess<T> | AtlasFailure;

// A diagnostic is printed to a terminal and read by a machine, and
// `specs/11-diagnostics-and-observability.spec.md` section 2 says neither should be steerable
// by the input that produced it. A control character, a directional override or an isolate
// reaching diagnostic text is replaced rather than passed through, and the summary, the path
// and the number of diagnostics one operation produces are bounded beside it.
const unsafeDiagnosticControl =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function boundedDiagnosticText(
  value: string,
  maximumCodePoints: number,
): string {
  let result = '';
  let codePoints = 0;
  for (const character of value) {
    if (codePoints >= maximumCodePoints) break;
    result += unsafeDiagnosticControl.test(character) ? '\ufffd' : character;
    codePoints += 1;
  }
  return result;
}

function boundedPosition(position: AtlasSourcePosition): AtlasSourcePosition {
  const safe = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return Object.freeze({
    offset: safe(position.offset),
    line: safe(position.line),
    column: safe(position.column),
  });
}

function boundedSpan(span: AtlasSourceSpan): AtlasSourceSpan {
  const sourcePath =
    span.sourcePath === undefined
      ? undefined
      : boundedDiagnosticText(span.sourcePath, 4_096);
  return Object.freeze({
    ...(sourcePath === undefined ? {} : { sourcePath }),
    start: boundedPosition(span.start),
    end: boundedPosition(span.end),
  });
}

function boundedDiagnostics(
  diagnostics: readonly AtlasDiagnostic[],
): readonly AtlasDiagnostic[] {
  return Object.freeze(
    diagnostics.slice(0, ATLAS_RESOURCE_LIMITS.diagnostics).map((diagnostic) =>
      atlasDiagnostic(diagnostic.code, diagnostic.summary, {
        severity: diagnostic.severity,
        path: diagnostic.path,
        ...(diagnostic.span === undefined
          ? {}
          : { span: boundedSpan(diagnostic.span) }),
      }),
    ),
  );
}

export function atlasSuccess<T>(
  value: T,
  diagnostics: readonly AtlasDiagnostic[] = [],
): AtlasSuccess<T> {
  return Object.freeze({
    ok: true,
    value,
    diagnostics: boundedDiagnostics(diagnostics),
  });
}

export function atlasFailure(
  diagnostics: readonly AtlasDiagnostic[],
): AtlasFailure {
  if (diagnostics.length === 0) {
    throw new TypeError('An Atlas failure requires at least one diagnostic.');
  }

  return Object.freeze({
    ok: false,
    diagnostics: boundedDiagnostics(diagnostics),
  });
}

/**
 * Whether a set of diagnostics is allowed to pass.
 *
 * The single place that question is answered, and it is answered on **severity**.
 * `specs/10-compiler-and-tooling.spec.md` section 12 says a bare check fails only on an error,
 * and every opt-in policy expresses itself by raising a finding to that severity rather than by
 * joining a list somewhere else.
 *
 * The alternative is what this replaces. The CLI's success path returned 0 unconditionally, and the
 * only severity test in it was `code === 'ATL1602' || code === 'ATL1703'`, so `atlas check
 * --require-complete` reported `"status": "success"` and exit 0 while carrying `ATL1310` at
 * `severity: error`. A hardcoded blocking-codes list is a second register that every new
 * error-severity diagnostic has to be added to, and the one nobody remembers to add is silent. Any
 * fix keyed to codes rather than severity reintroduces exactly that.
 */
export function atlasDiagnosticsBlock(
  diagnostics: readonly AtlasDiagnostic[],
): boolean {
  return diagnostics.some(({ severity }) => severity === 'error');
}

export function atlasDiagnostic(
  code: AtlasDiagnosticCode,
  summary: string,
  options: {
    readonly path?: readonly (string | number)[];
    readonly span?: AtlasSourceSpan;
    readonly severity?: AtlasDiagnosticSeverity;
  } = {},
): AtlasDiagnostic {
  const safeSummary = boundedDiagnosticText(
    summary,
    ATLAS_RESOURCE_LIMITS.diagnosticSummaryCharacters,
  );
  const safePath = options.path
    ?.slice(0, ATLAS_RESOURCE_LIMITS.diagnosticPathSegments)
    .map((segment) =>
      typeof segment === 'string'
        ? boundedDiagnosticText(segment, 128)
        : Number.isSafeInteger(segment) && segment >= 0
          ? segment
          : 0,
    );
  return Object.freeze({
    code,
    severity: options.severity ?? 'error',
    summary: safeSummary.length === 0 ? 'Atlas diagnostic.' : safeSummary,
    path: Object.freeze([...(safePath ?? [])]),
    ...(options.span === undefined ? {} : { span: boundedSpan(options.span) }),
  });
}

function positionAt(source: string, offset: number): AtlasSourcePosition {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  let line = 0;
  let column = 0;

  for (let index = 0; index < boundedOffset; index += 1) {
    const character = source.charCodeAt(index);
    if (character === 0x0a) {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }

  return Object.freeze({ offset: boundedOffset, line, column });
}

export function atlasSourceSpan(
  source: string,
  offset: number,
  length: number,
  sourcePath?: string,
): AtlasSourceSpan {
  const start = positionAt(source, offset);
  const end = positionAt(source, offset + Math.max(0, length));
  return Object.freeze({
    ...(sourcePath === undefined ? {} : { sourcePath }),
    start,
    end,
  });
}
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';
