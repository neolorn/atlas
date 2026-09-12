import {
  ATLAS_MESSAGE_NAME_CHARACTERS,
  ATLAS_MESSAGE_NAME_PATTERN,
} from './message-format-syntax.js';
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';

const localeTextSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
} as const;

const nonemptyTextSchema = {
  type: 'string',
  minLength: 1,
} as const;

/**
 * A Unicode locale extension `type` value: `latn`, `arabext`, `islamic-umalqura`, `gregory`.
 *
 * BCP 47 section 2.2.6 and UTS #35 spell a `-u-` keyword's value as one or more subtags of three to
 * eight alphanumerics. Well-formedness is all a schema can decide here; whether a runtime has data
 * for a well-formed value is the formatting runtime's question, and it refuses rather than
 * approximating.
 */
const unicodeKeywordTypeSchema = {
  type: 'string',
  pattern: '^[a-z0-9]{3,8}(?:-[a-z0-9]{3,8})*$',
} as const;

const portableTypeIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
} as const;

const inputRefinementSchema = {
  oneOf: [
    portableTypeIdSchema,
    {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        type: portableTypeIdSchema,
        enum: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
            ],
          },
        },
        optional: { type: 'boolean' },
        nullable: { type: 'boolean' },
        description: nonemptyTextSchema,
      },
    },
  ],
} as const;

const slotRefinementSchema = {
  oneOf: [
    portableTypeIdSchema,
    {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        kind: portableTypeIdSchema,
        shape: { enum: ['paired', 'standalone'] },
        optional: { type: 'boolean' },
        repeatable: { type: 'boolean' },
        within: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'string',
            pattern: '^(?:@root|[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)$',
          },
        },
        description: nonemptyTextSchema,
      },
    },
  ],
} as const;

/**
 * The entry shape, closed on purpose.
 *
 * `specs/04-message-authoring-and-catalogs.spec.md` section 5 permits exactly one of `message` and
 * `empty`, plus the four localization-intrinsic fields, and refuses workflow metadata. The `oneOf`
 * below is what makes a deliberate empty result distinguishable from an accidental blank one, which
 * a schema that merely allowed both fields could not do.
 */
const messageRecordSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: nonemptyTextSchema,
    empty: { const: true },
    description: nonemptyTextSchema,
    context: nonemptyTextSchema,
    inputs: {
      type: 'object',
      minProperties: 1,
      propertyNames: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      additionalProperties: inputRefinementSchema,
    },
    slots: {
      type: 'object',
      minProperties: 1,
      propertyNames: {
        type: 'string',
        pattern: '^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$',
      },
      additionalProperties: slotRefinementSchema,
    },
  },
  oneOf: [
    { required: ['message'], properties: { message: true } },
    { required: ['empty'], properties: { empty: true } },
  ],
} as const;

const familySchema = {
  oneOf: [
    nonemptyTextSchema,
    {
      type: 'object',
      additionalProperties: false,
      required: ['template'],
      properties: {
        template: nonemptyTextSchema,
        segments: {
          type: 'object',
          minProperties: 1,
          propertyNames: {
            type: 'string',
            pattern: '^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$',
          },
          additionalProperties: portableTypeIdSchema,
        },
      },
    },
  ],
} as const;

/**
 * The JSON Schema for `atlas.config.json`.
 *
 * Published so an editor can validate and complete the file as it is typed, and so a build script
 * can check one before running anything. It is the same schema the parser uses, so what an editor
 * accepts and what Atlas accepts cannot drift apart.
 */
export const ATLAS_CONFIGURATION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Atlas project configuration',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'sourceLocale', 'defaultLocale', 'locales'],
  // Every settable property carries a `description`, and it is not decoration.
  //
  // `atlas init`'s option table is generated from this schema by `tools/generate-cli-options.mjs`,
  // and `--help` prints these lines. A settable property without one fails that generator, so the
  // install line states what the configuration accepts because it is reading the thing that
  // decides rather than a second list of it. They ship too, this constant is staged as
  // `schemas/configuration.v1.schema.json`, so an editor's JSON Schema tooling shows the same
  // sentence a consumer reads in `--help`.
  //
  // `description` is a standard JSON Schema annotation and Ajv runs `strict: true`, so a
  // non-standard keyword here would throw at compile time. That is why the *flag spelling* lives in
  // the generator instead: JSON Schema has no keyword for it, and inventing one would break
  // validation to save a table.
  properties: {
    schemaVersion: { const: 1 },
    sourceLocale: {
      ...localeTextSchema,
      description: 'The locale the authored source catalogs are written in.',
    },
    defaultLocale: {
      ...localeTextSchema,
      description:
        'The locale served when a request asks for none Atlas supports.',
    },
    locales: {
      type: 'array',
      minItems: 1,
      maxItems: ATLAS_RESOURCE_LIMITS.localesPerProject,
      uniqueItems: true,
      items: localeTextSchema,
      description: 'Every locale this project supports. Repeat for each one.',
    },
    personNameLocales: {
      type: 'array',
      minItems: 1,
      maxItems: ATLAS_RESOURCE_LIMITS.localesPerProject,
      uniqueItems: true,
      items: localeTextSchema,
      description:
        'Locales a person name may be written in, beyond the ones this project is translated into.',
    },
    pseudoLocales: {
      type: 'object',
      minProperties: 1,
      maxProperties: ATLAS_RESOURCE_LIMITS.localesPerProject,
      propertyNames: localeTextSchema,
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // Signed, and bounded by what the transform can honour: -1 already elides every vowel.
          // Absent means the length behaviour is off, which is not the same as zero being applied.
          lengthFactor: {
            type: 'number',
            minimum: -1,
            maximum: 2,
            description:
              'Signed length change. Positive expands, negative elides vowels; absent leaves length alone.',
          },
          markers: {
            type: 'boolean',
            description:
              'Wrap the whole rendered message in boundary markers, so untranslated text has none.',
          },
        },
      },
      description:
        'Locales derived from the source catalog rather than authored. Generated only by --pseudo.',
    },
    // How each locale is written, where the application disagrees with CLDR about it.
    //
    // The application-wide context that `withFormattingContext()` installs is the default every
    // locale inherits; an entry here overrides it for one locale; a field neither of them sets is
    // whatever CLDR says for that locale, which is the standard's choice rather than an absence.
    //
    // Three fields and not four. A numbering system, a calendar and an hour cycle are facts about
    // how a locale is *written*: `ar-EG` resolves to `arab` and `fa-IR` to `arabext`, and an
    // application that wants Western digits on its Arabic pages is stating something about Arabic.
    // A time zone is not a fact about a locale at all (it belongs to the reader or to the
    // business, and Cairo is Cairo in both languages) so it stays application-wide, where a
    // consumer sets it once and per-request. Putting it here would let a configuration say
    // "Arabic means Egypt", which is a market model Atlas would then have to defend.
    //
    // The values are checked for well-formedness and not for availability. `latn` and `zzzz` are
    // both well-formed `-u-` type subtags; whether this runtime has data for one is a question only
    // the runtime that formats can answer, and it already does: an unsupported numbering system
    // returns `unsupported-formatting-capability` rather than silently rendering something else.
    formatting: {
      type: 'object',
      minProperties: 1,
      maxProperties: ATLAS_RESOURCE_LIMITS.localesPerProject,
      propertyNames: localeTextSchema,
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        // An entry that sets nothing states nothing, and would read as a decision that was made.
        minProperties: 1,
        properties: {
          numberingSystem: {
            ...unicodeKeywordTypeSchema,
            description:
              'The digits this locale is written in, where they differ from the ones CLDR gives it.',
          },
          calendar: {
            ...unicodeKeywordTypeSchema,
            description:
              'The calendar this locale is written in, where it differs from the one CLDR gives it.',
          },
          hourCycle: {
            type: 'string',
            enum: ['h11', 'h12', 'h23', 'h24'],
            description:
              'The hour cycle this locale is written in, where it differs from the one CLDR gives it.',
          },
        },
      },
      description:
        'How a locale is written, where the application disagrees with CLDR about that locale.',
    },
    // Which locales are still being translated, and why.
    //
    // The release completeness gate (`atlas check --require-complete`) requires every locale this
    // project ships to carry every source message. The default is that every locale is required,
    // because a locale nobody has said anything about is one somebody expects to be finished. A
    // locale named here is exempt: its findings are still reported, at `warning`, and they no
    // longer stop the release.
    //
    // A locale that is complete needs no entry, and a locale somebody is still translating needs
    // one line, once, which is why this is a declaration in the project's own file rather than a
    // list of locales passed to a command. Which locales must be complete is a fact about the
    // project and is stable across runs; whether to enforce it on this run is a fact about the run
    // and stays on the command.
    //
    // `note` is required and is not decoration. An exemption with no reason is the kind that
    // outlives its reason: it is quoted back in every finding it downgrades, so the person reading
    // a green gate is told why it is green.
    inProgress: {
      type: 'object',
      minProperties: 1,
      maxProperties: ATLAS_RESOURCE_LIMITS.localesPerProject,
      propertyNames: localeTextSchema,
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['note'],
        properties: {
          note: {
            type: 'string',
            minLength: 1,
            maxLength: 160,
            description:
              'Why this locale is not complete yet. Quoted back in every finding it downgrades.',
          },
        },
      },
      description:
        'Locales still being translated. Their completeness findings never block a release.',
    },
    // Which locale each locale inherits from, where the project disagrees with CLDR.
    //
    // A locale falls back to its parent before the source locale, and the parents are the pinned
    // CLDR ones: `en-AU` inherits from `en-001`, which inherits from `en`. An entry here replaces
    // one hop of that. The value is a locale, or `und` to say this locale inherits from root and
    // therefore has no parent at all.
    //
    // A key does not have to be a locale this project ships, and that is the difference from
    // `formatting`. A chain runs through locales nobody serves, `en-001` among them, and moving
    // one of those links is how a project moves a whole family of locales with one line. A key
    // that no configured locale inherits through is still reported, because it states a decision
    // that has no effect.
    //
    // The four CLDR parents that change the language are the reason this key exists: `hi-Latn`
    // inherits from `en-IN`, `ht` from `fr-HT`, and `nb` and `nn` from `no`. Leaving those out of
    // the chain would be Atlas overriding pinned data on taste, so they are followed, and this is
    // where a project that disagrees says so.
    parentLocales: {
      type: 'object',
      minProperties: 1,
      maxProperties: ATLAS_RESOURCE_LIMITS.localesPerProject,
      propertyNames: localeTextSchema,
      additionalProperties: localeTextSchema,
      description:
        'Which locale a locale inherits from, where CLDR is wrong for this project. `und` means none.',
    },
    aliases: {
      type: 'object',
      minProperties: 1,
      maxProperties: ATLAS_RESOURCE_LIMITS.localeAliasesPerProject,
      propertyNames: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
      },
      additionalProperties: localeTextSchema,
      description: 'Extra identifiers that resolve to a supported locale.',
    },
  },
} as const);

/**
 * The JSON Schema for a catalog in the locale its messages were authored in.
 *
 * Stricter than the target schema: a source catalog is where a message's inputs and slots are
 * declared, so it carries shapes a translation does not.
 */
export const ATLAS_SOURCE_CATALOG_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Atlas source catalog',
  type: 'object',
  additionalProperties: false,
  required: ['messages'],
  properties: {
    messages: {
      type: 'object',
      minProperties: 1,
      maxProperties: ATLAS_RESOURCE_LIMITS.messagesPerCatalog,
      propertyNames: {
        type: 'string',
        pattern:
          '^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*(?:\\.[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)*$',
      },
      additionalProperties: {
        oneOf: [nonemptyTextSchema, messageRecordSchema],
      },
    },
    families: {
      type: 'object',
      minProperties: 1,
      maxProperties: ATLAS_RESOURCE_LIMITS.familiesPerCatalog,
      propertyNames: {
        type: 'string',
        pattern: '^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$',
      },
      additionalProperties: familySchema,
    },
  },
} as const);

/**
 * The JSON Schema for a translated catalog.
 *
 * Allows a message to be present with no text, which is how an entry waiting for a translator is
 * recorded without losing the brief that came with it.
 */
export const ATLAS_TARGET_CATALOG_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Atlas target catalog',
  type: 'object',
  additionalProperties: false,
  required: ['messages'],
  properties: {
    messages: {
      type: 'object',
      minProperties: 1,
      maxProperties: ATLAS_RESOURCE_LIMITS.messagesPerCatalog,
      propertyNames: {
        type: 'string',
        pattern:
          '^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*(?:\\.[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)*$',
      },
      additionalProperties: {
        oneOf: [
          nonemptyTextSchema,
          {
            ...messageRecordSchema,
            properties: {
              message: nonemptyTextSchema,
              empty: { const: true },
              description: nonemptyTextSchema,
              context: nonemptyTextSchema,
            },
          },
        ],
      },
    },
  },
} as const);

const extensionIdSchema = {
  type: 'string',
  pattern: '^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,63}$',
} as const;

const extensionValueTypeSchema = {
  enum: ['boolean', 'date-time', 'integer', 'number', 'string'],
} as const;

/**
 * The JSON Schema for an extension registry file.
 *
 * Everything it describes is inert: declarations of functions, slot kinds, segment types and
 * adapters, and no code. A registry that validates against this is one the toolkit can read without
 * loading anything of the application's.
 */
export const ATLAS_EXTENSION_REGISTRY_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Atlas application-local extension registry',
  type: 'object',
  additionalProperties: false,
  required: ['profile', 'descriptors'],
  properties: {
    profile: { const: 'atlas-extension-registry/1' },
    descriptors: {
      type: 'array',
      maxItems: ATLAS_RESOURCE_LIMITS.extensionDescriptors,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: [
              'kind',
              'id',
              'operandType',
              'resultType',
              'selector',
              'maximumOutputLength',
            ],
            properties: {
              kind: { const: 'message-function' },
              id: extensionIdSchema,
              operandType: extensionValueTypeSchema,
              options: {
                type: 'object',
                maxProperties:
                  ATLAS_RESOURCE_LIMITS.extensionOptionsPerDescriptor,
                propertyNames: {
                  type: 'string',
                  maxLength: ATLAS_MESSAGE_NAME_CHARACTERS,
                  pattern: ATLAS_MESSAGE_NAME_PATTERN,
                },
                additionalProperties: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type'],
                  properties: {
                    type: extensionValueTypeSchema,
                    required: { type: 'boolean' },
                    values: {
                      type: 'array',
                      minItems: 1,
                      maxItems: ATLAS_RESOURCE_LIMITS.extensionValuesPerOption,
                      uniqueItems: true,
                      items: {
                        anyOf: [
                          { type: 'string' },
                          { type: 'number' },
                          { type: 'boolean' },
                        ],
                      },
                    },
                  },
                },
              },
              resultType: { enum: ['string', 'number', 'date-time'] },
              selector: { enum: ['none', 'exact'] },
              maximumOutputLength: {
                type: 'integer',
                minimum: 1,
                maximum: 65536,
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'id', 'syntax', 'maximumLength'],
            properties: {
              kind: { const: 'identifier-segment' },
              id: extensionIdSchema,
              syntax: {
                enum: ['lower-kebab', 'ascii-token', 'unicode-token'],
              },
              maximumLength: {
                type: 'integer',
                minimum: 1,
                maximum: 128,
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'id', 'shape', 'interactive', 'textProjection'],
            properties: {
              kind: { const: 'rich-slot-kind' },
              id: extensionIdSchema,
              shape: { enum: ['paired', 'standalone'] },
              interactive: { type: 'boolean' },
              textProjection: {
                enum: ['children', 'binding-required'],
              },
              options: {
                type: 'object',
                maxProperties:
                  ATLAS_RESOURCE_LIMITS.extensionOptionsPerDescriptor,
                propertyNames: {
                  type: 'string',
                  pattern: '^[a-z][a-z0-9-]{0,63}$',
                },
                additionalProperties: {
                  type: 'array',
                  minItems: 1,
                  maxItems: ATLAS_RESOURCE_LIMITS.extensionValuesPerOption,
                  uniqueItems: true,
                  items: { type: 'string', minLength: 1, maxLength: 128 },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: [
              'kind',
              'id',
              'inputType',
              'result',
              'maximumOutputLength',
            ],
            properties: {
              kind: { const: 'formatting-adapter' },
              id: extensionIdSchema,
              inputType: portableTypeIdSchema,
              result: { enum: ['text', 'parts'] },
              maximumOutputLength: {
                type: 'integer',
                minimum: 1,
                maximum: 65536,
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'id', 'outputType', 'maximumInputLength'],
            properties: {
              kind: { const: 'parsing-adapter' },
              id: extensionIdSchema,
              outputType: portableTypeIdSchema,
              maximumInputLength: {
                type: 'integer',
                minimum: 1,
                maximum: 65536,
              },
            },
          },
        ],
      },
    },
  },
} as const);

const cliPositionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['offset', 'line', 'column'],
  properties: {
    offset: { type: 'integer', minimum: 0 },
    line: { type: 'integer', minimum: 0 },
    column: { type: 'integer', minimum: 0 },
  },
} as const;

const cliDiagnosticSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'severity', 'summary', 'path'],
  properties: {
    code: { type: 'string', pattern: '^ATL[0-9]{4}$' },
    severity: { enum: ['error', 'warning', 'info'] },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: ATLAS_RESOURCE_LIMITS.diagnosticSummaryCharacters,
    },
    path: {
      type: 'array',
      maxItems: ATLAS_RESOURCE_LIMITS.diagnosticPathSegments,
      items: {
        oneOf: [
          { type: 'string', maxLength: 128 },
          { type: 'integer', minimum: 0 },
        ],
      },
    },
    span: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'end'],
      properties: {
        sourcePath: { type: 'string', maxLength: 4_096 },
        start: cliPositionSchema,
        end: cliPositionSchema,
      },
    },
  },
} as const;

const cliStatusSchema = {
  enum: [
    'success',
    'diagnostic-failure',
    'invocation-or-configuration-failure',
    'environment-failure',
    'interrupted',
    'failure',
  ],
} as const;

const cliResultValueSchema = {
  oneOf: [{ type: 'object', maxProperties: 32 }, { type: 'null' }],
} as const;

/**
 * The JSON Schema for what the command line prints when it is asked for machine-readable output.
 *
 * Published so a build script or a CI step can parse that output against a contract rather than
 * against the shape it happened to see. A successful command carries its result; a failed one
 * carries diagnostics and a null result.
 */
export const ATLAS_CLI_RESULT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Atlas CLI machine result',
  type: 'object',
  additionalProperties: false,
  required: ['profile', 'command', 'status', 'diagnostics', 'result'],
  properties: {
    profile: { const: 'atlas-cli-result/1' },
    command: {
      enum: [
        'init',
        'generate',
        'check',
        'format',
        'clean',
        'watch',
        'migrate',
        'unknown',
      ],
    },
    status: cliStatusSchema,
    diagnostics: {
      type: 'array',
      maxItems: ATLAS_RESOURCE_LIMITS.diagnostics,
      items: cliDiagnosticSchema,
    },
    result: cliResultValueSchema,
  },
  allOf: [
    {
      if: {
        type: 'object',
        required: ['status'],
        properties: { status: { const: 'success' } },
      },
      then: {
        type: 'object',
        properties: { result: { type: 'object' } },
      },
      else: {
        type: 'object',
        properties: { result: { type: 'null' } },
      },
    },
  ],
} as const);

/**
 * The JSON Schema for one line of the watcher's machine-readable stream.
 *
 * A watch prints one of these per pass rather than one result at the end, so a tool following it
 * can react to each rebuild as it happens.
 */
export const ATLAS_CLI_WATCH_EVENT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Atlas CLI watch machine event',
  type: 'object',
  additionalProperties: false,
  required: [
    'profile',
    'command',
    'sequence',
    'status',
    'diagnostics',
    'result',
  ],
  properties: {
    profile: { const: 'atlas-cli-watch-event/1' },
    command: { const: 'watch' },
    sequence: { type: 'integer', minimum: 1 },
    status: cliStatusSchema,
    diagnostics: {
      type: 'array',
      maxItems: ATLAS_RESOURCE_LIMITS.diagnostics,
      items: cliDiagnosticSchema,
    },
    result: cliResultValueSchema,
  },
  allOf: [
    {
      if: {
        type: 'object',
        required: ['status'],
        properties: { status: { const: 'success' } },
      },
      then: {
        type: 'object',
        properties: { result: { type: 'object' } },
      },
      else: {
        type: 'object',
        properties: { result: { type: 'null' } },
      },
    },
  ],
} as const);
