const { build } = require('./package.json');

module.exports = {
  ...build,
  extraResources: [{ from: 'runtime-win32-x64', to: 'runtime', filter: ['**/*'] }],
  win: { target: ['nsis'], artifactName: '${productName}-Setup-${version}-${arch}.${ext}' },
};
