const { build } = require('./package.json');

const local = process.env.DSH_MAC_LOCAL === '1';
const mac = {
  ...build.mac,
  artifactName: '${productName}-${version}-mac-${arch}.${ext}',
  hardenedRuntime: !local,
  notarize: !local,
  ...(local
    ? { identity: null }
    : {
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.plist',
      }),
};

module.exports = {
  ...build,
  ...(local ? {} : { forceCodeSigning: true }),
  mac,
  afterPack: local ? './scripts/after-pack-macos.cjs' : undefined,
};
