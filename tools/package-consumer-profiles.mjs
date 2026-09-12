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
