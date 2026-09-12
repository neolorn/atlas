/**
 * One occurrence of one `atlas init` configuration flag, folded into the value `init` is handed.
 *
 * Beside `cli.ts` rather than inside it, and not published from the barrel. The refusals here are
 * the half of this that matters (a value the schema would reject several steps later, reported
 * against a file the reader did not write) and a function inside a `#!/usr/bin/env node` entry
 * point can only be reached by spawning a process, and a check whose failure path runs on
 * different machinery from its success path has only been tested on the path that succeeds.
 *
 * The flags themselves are generated. `cli-options.generated.ts` is written from
 * `ATLAS_CONFIGURATION_SCHEMA` by `tools/generate-cli-options.mjs`, so what this file knows is the
 * four *shapes* a value can have, and never which keys exist.
 */

import {
  ATLAS_INIT_OPTIONS,
  type AtlasInitLeafType,
  type AtlasInitOptionDescriptor,
} from './cli-options.generated.js';

/** An invocation Atlas will not act on. The CLI turns this into ATL1701 and exit 2. */
export class InvocationError extends Error {}

const INIT_OPTIONS_BY_FLAG: ReadonlyMap<string, AtlasInitOptionDescriptor> =
  new Map(ATLAS_INIT_OPTIONS.map((option) => [option.flag, option]));

/** The configuration flag this argument is, or `undefined` when it is not one. */
export function initOptionForFlag(
  flag: string,
): AtlasInitOptionDescriptor | undefined {
  return INIT_OPTIONS_BY_FLAG.get(flag);
}

/**
 * One value from the command line, as the type the schema says that leaf is.
 *
 * A shell hands over text and the configuration schema wants `number` and `boolean` in two places,
 * so something has to convert. It is here rather than in the configuration parser because the
 * parser's input is JSON, where `0.3` and `"0.3"` are already different things: teaching it to
 * accept the string would make a hand-edited file with a quoted number valid, which it is not.
 *
 * The refusals are the point. `Number('')` is `0` and `Number('x')` is `NaN`, and both would reach
 * the schema as a number: one silently wrong, the other as a type error naming a value the reader
 * never typed. `Boolean(text)` is worse: every non-empty string is `true`, so `markers=false`
 * would switch markers on.
 */
function initLeafValue(
  label: string,
  type: AtlasInitLeafType,
  text: string,
): string | number | boolean {
  if (type === 'string') return text;
  if (type === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    throw new InvocationError(
      `${label} takes true or false, and received ${JSON.stringify(text)}.`,
    );
  }
  const value = Number(text);
  if (text.trim().length === 0 || !Number.isFinite(value)) {
    throw new InvocationError(
      `${label} takes a number, and received ${JSON.stringify(text)}.`,
    );
  }
  return value;
}

function initEntries(
  target: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = target[key];
  if (existing !== undefined) return existing as Record<string, unknown>;
  const created = Object.create(null) as Record<string, unknown>;
  target[key] = created;
  return created;
}

/**
 * One occurrence of one configuration flag, folded into the value `init` will be handed.
 *
 * Four shapes and one convention: `--flag <path>=<value>`, where the path is a dotted path beneath
 * the field. A scalar and a list have no path, a map of scalars has one segment, a map of objects
 * has two. `--alias eg=ar-EG` is that convention at depth 1 and always was, which is why the two
 * new fields needed no new syntax and a third level would need none either.
 *
 * Every refusal names the flag and what it wanted. A wrong value here becomes a configuration file
 * the schema rejects several steps later, pointing at a file the reader did not write.
 */
export function applyInitOption(
  target: Record<string, unknown>,
  option: AtlasInitOptionDescriptor,
  text: string,
): void {
  if (option.shape === 'scalar') {
    if (target[option.key] !== undefined) {
      throw new InvocationError(`${option.flag} may appear once.`);
    }
    target[option.key] = initLeafValue(option.flag, option.leaf, text);
    return;
  }

  if (option.shape === 'list') {
    const existing = target[option.key];
    const values = (existing ?? []) as unknown[];
    if (existing === undefined) target[option.key] = values;
    values.push(initLeafValue(option.flag, option.leaf, text));
    return;
  }

  const entries = initEntries(target, option.key);
  const dot = text.indexOf('.');
  const equals = text.indexOf('=');

  if (option.depth === 1) {
    if (equals <= 0 || equals === text.length - 1) {
      throw new InvocationError(`${option.flag} takes ${option.value}.`);
    }
    const entry = text.slice(0, equals);
    if (entries[entry] !== undefined) {
      throw new InvocationError(
        `${option.flag} sets ${JSON.stringify(entry)} more than once.`,
      );
    }
    entries[entry] = initLeafValue(
      `${option.flag} ${entry}`,
      option.leaf,
      text.slice(equals + 1),
    );
    return;
  }

  // Depth 2. The entry may be declared on its own: every option beneath it is optional, and an
  // entry with none is a meaningful thing to ask for rather than an incomplete invocation.
  if (dot < 0 && equals < 0) {
    if (text.length === 0) {
      throw new InvocationError(`${option.flag} takes ${option.value}.`);
    }
    initEntries(entries, text);
    return;
  }
  if (dot <= 0 || equals <= dot + 1 || equals === text.length - 1) {
    throw new InvocationError(`${option.flag} takes ${option.value}.`);
  }
  const entry = text.slice(0, dot);
  const name = text.slice(dot + 1, equals);
  const type = option.options[name];
  if (type === undefined) {
    throw new InvocationError(
      `${option.flag} has no option ${JSON.stringify(name)}. It takes ${Object.keys(option.options).join(', ')}.`,
    );
  }
  const beneath = initEntries(entries, entry);
  if (beneath[name] !== undefined) {
    throw new InvocationError(
      `${option.flag} sets ${entry}.${name} more than once.`,
    );
  }
  beneath[name] = initLeafValue(
    `${option.flag} ${entry}.${name}`,
    type,
    text.slice(equals + 1),
  );
}
