import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

/**
 * The linter, carrying only what the compiler cannot answer.
 *
 * `tsconfig.base.json` already runs `strict` with `noUncheckedIndexedAccess`,
 * `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`,
 * `useUnknownInCatchVariables`, `noImplicitOverride`, `noImplicitReturns`,
 * `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters` and `skipLibCheck: false`.
 * Every rule below is one the compiler cannot express, so nothing here is a second opinion on a
 * question `typecheck` already settles, and a preset is not extended: a rule that arrives in a
 * minor version of somebody else's recommended set is a gate nobody chose.
 *
 * Type-aware, which is the reason the tool is `typescript-eslint` rather than a faster linter that
 * cannot see types. `oxlint` would be first on cost (40 packages against 219, and its multi-file
 * analysis is in the core engine rather than rebuilt per rule) but its type-aware rules come from
 * `oxlint-tsgolint`, which requires TypeScript 7.0+; Atlas is on 6.0.3, so it cannot see a floating
 * promise here at all. It is worth revisiting, and would be the better tool, the day Atlas moves to
 * TypeScript 7. Biome is smaller still and its `noFloatingPromises` is in `lint/nursery` on Biome's
 * own inference engine, with no `typescript` dependency of any kind: an incubating rule on an
 * independent inference is the wrong place for a check whose whole value is being right about a
 * type.
 *
 * The program is `tsconfig.typecheck.json`, which is the one configuration in this repository that
 * is *checked* to load every file under `packages/`: `tools/verify-typecheck.mjs` derives the source
 * roots from disk and fails naming any file the program did not reach. Pointing the linter at the
 * same config means a file outside every program cannot be quietly unlinted either.
 */
export default tseslint.config(
  {
    // The linter reads what the compiler reads. `tools/` is JavaScript with no program to type it,
    // the fixtures are consumer applications with their own toolchains, and everything else here is
    // output.
    ignores: [
      '**/node_modules/',
      '.atlas/',
      '.runtimes/',
      'tmp/',
      'dist/',
      'fixtures/',
      'tools/',
      '*.mjs',
      '*.ts',
    ],
  },
  {
    files: ['packages/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.typecheck.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'import-x': importX },
    settings: {
      // The module graph `import-x/no-cycle` walks is built by the plugin, not by the compiler, so
      // the plugin has to be told two separate things: how to turn a specifier into a path, and how
      // to read the file at the end of it. Only the first is obvious. Without `import-x/parsers`
      // the plugin cannot parse a TypeScript file at all, and every graph rule then reports nothing
      // (not an error, nothing), which is indistinguishable from a repository with no cycles.
      // That is exactly the state this configuration was in when `lint:self-test` first ran, and
      // finding it is the whole reason that stage exists.
      'import-x/extensions': ['.ts', '.mts', '.cts'],
      'import-x/parsers': {
        '@typescript-eslint/parser': ['.ts', '.mts', '.cts'],
      },
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          project: './tsconfig.typecheck.json',
        }),
      ],
    },
    rules: {
      // The one the stage was asked for. The idiom it expects is already in use here: eleven
      // deliberate `void` calls across the source say "started, not awaited, on purpose".
      '@typescript-eslint/no-floating-promises': 'error',
      // A promise where a boolean or a void callback is expected. The compiler accepts both: a
      // promise is truthy, and a function returning one is assignable to a void-returning type.
      '@typescript-eslint/no-misused-promises': 'error',
      // Awaiting something that is not thenable. It reads as a guarantee about ordering and is not
      // one.
      '@typescript-eslint/await-thenable': 'error',
      // An `async` with no `await` announces a boundary that is not there, and callers write their
      // own code around that announcement.
      '@typescript-eslint/require-await': 'error',
      // The other one the stage was asked for. There are no cycles today, measured over the source
      // with the scan shown to find a seeded one first.
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      // It reads a declared type as runtime truth, so it fails wherever a type claims more than
      // the bytes guarantee. That is the value of it here: an artifact from disk, a value a
      // consumer passed and a host whose own declarations over-promise each arrive in a form that
      // says what was read, and the check that settles it is a check the compiler cannot fold
      // away. A warning from this rule means a type is claiming something, not that a check is
      // spare.
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },
);
