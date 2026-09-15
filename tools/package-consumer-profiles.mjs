import { floorOf, peerRange } from './supported-versions.mjs';

// Angular ships its framework and its tooling on separate patch trains, so the two can sit at
// different versions on the same day. A profile that says nothing about tooling gets the framework
// version for both, which is how every row behaved before the trains diverged.
export const angularToolingPackages = new Set([
  '@angular/build',
  '@angular/cli',
  '@angular/ssr',
]);

export const consumerProfiles = new Map([
  [
    'package-consumer',
    {
      angular: '22.1.3',
      angularTooling: '22.1.7',
      typescript: '6.0.3',
      rxjs: '7.8.2',
      label: 'Atlas development row',
    },
  ],
  [
    'angular-22.0.4-consumer',
    {
      angular: '22.0.4',
      typescript: '6.0.3',
      rxjs: '7.8.2',
      label: 'Angular patch compatibility row',
    },
  ],
  // The versions of the development row, so the one thing this row varies is the compiler.
  //
  // What the other rows vary is the versions an application pins; what none of them varied is how
  // strictly it compiles, and a consumer's own options are the options analysis adopts, so every
  // row exercised one setting of them. The set below is what a demanding application turns on and
  // is the set the library holds itself to, minus two.
  //
  // `isolatedModules` and `verbatimModuleSyntax` are absent from this list for two different
  // reasons, and neither is an oversight.
  //
  // `isolatedModules` is already on. The fixture template sets it, so every row compiles under it
  // and this one inherits it; repeating it here would name a setting the list does not vary.
  //
  // `verbatimModuleSyntax` is left out because it cannot change an Atlas diagnostic. TypeScript
  // 6.0 describes it as not transforming or eliding imports and exports that are not marked
  // type-only, so that they are written in the output file's format, which is a rule about emit.
  // What a name resolves to, and therefore what analysis sees, is the same with it and without it.
  // A row carrying it would be testing the fixture's import style. Adding it later needs a reason
  // of that kind, not the observation that the library sets it.
  [
    'strict-consumer',
    {
      angular: '22.1.3',
      angularTooling: '22.1.7',
      typescript: '6.0.3',
      rxjs: '7.8.2',
      label: 'Demanding compiler options',
      compilerOptions: {
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        useUnknownInCatchVariables: true,
        noImplicitOverride: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
        noPropertyAccessFromIndexSignature: true,
        skipLibCheck: false,
      },
      overlay: 'fixtures/strict-consumer-overlay',
    },
  ],
  // Read from the peer ranges rather than written out. The floor of a range is what the range
  // claims to support, so a floor raised in a manifest moves this row with it, and there is no
  // window where the row proves a version the packages no longer admit.
  [
    'lower-bounds-consumer',
    {
      angular: floorOf(peerRange('@angular/core')),
      typescript: floorOf(peerRange('typescript')),
      rxjs: floorOf(peerRange('rxjs')),
      label: 'Lowest supported versions',
    },
  ],
]);

export const resolveConsumerProfile = (consumerName) => {
  const consumerProfile = consumerProfiles.get(consumerName);
  if (consumerProfile === undefined) {
    throw new Error(`Unknown package-consumer profile: ${consumerName}`);
  }

  return consumerProfile;
};

export const resolveAngularVersion = (consumerProfile, packageName) =>
  angularToolingPackages.has(packageName)
    ? (consumerProfile.angularTooling ?? consumerProfile.angular)
    : consumerProfile.angular;
