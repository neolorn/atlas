import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false,
});

export function compileAtlasSchema(
  schema: AnySchema,
): ValidateFunction<unknown> {
  return ajv.compile(schema);
}

function decodeJsonPointerPart(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** One string parameter off an Ajv error, or nothing when it is absent or not a string. */
export function atlasSchemaErrorParameter(
  error: ErrorObject,
  key: string,
): string | undefined {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function atlasSchemaErrorPath(
  error: ErrorObject,
): readonly (string | number)[] {
  const path: (string | number)[] = error.instancePath
    .split('/')
    .slice(1)
    .map(decodeJsonPointerPart)
    .map((part) => (/^(?:0|[1-9][0-9]*)$/u.test(part) ? Number(part) : part));

  const child =
    atlasSchemaErrorParameter(error, 'additionalProperty') ??
    atlasSchemaErrorParameter(error, 'missingProperty') ??
    atlasSchemaErrorParameter(error, 'propertyName');
  if (child !== undefined) {
    path.push(child);
  }

  return Object.freeze(path);
}

export function atlasSchemaErrorSummary(
  subject: string,
  error: ErrorObject,
): string {
  const detail = error.message ?? `violates the ${error.keyword} constraint`;
  return `${subject} ${detail}.`;
}

export function sortedAtlasSchemaErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly ErrorObject[] {
  return Object.freeze(
    [...(errors ?? [])].sort((left, right) => {
      const pathOrder =
        left.instancePath < right.instancePath
          ? -1
          : left.instancePath > right.instancePath
            ? 1
            : 0;
      if (pathOrder !== 0) {
        return pathOrder;
      }

      const keywordOrder =
        left.keyword < right.keyword
          ? -1
          : left.keyword > right.keyword
            ? 1
            : 0;
      if (keywordOrder !== 0) {
        return keywordOrder;
      }

      const leftParameters = JSON.stringify(left.params);
      const rightParameters = JSON.stringify(right.params);
      return leftParameters < rightParameters
        ? -1
        : leftParameters > rightParameters
          ? 1
          : 0;
    }),
  );
}
