// babel-preset-expo is expo's own dependency, not the app's: under pnpm's isolated node_modules
// it is not resolvable from apps/mobile, so Babel's by-name lookup fails whenever Metro starts
// with an empty cache (Gradle's export:embed in CI, `--reset-cache` locally). It is resolved
// from expo, which pins the version it expects. (Adding it as a devDependency instead leaves a
// dangling link under pnpm 12.3.4: the importer resolves without its peers and the store
// directory is never created.)
const preset = require.resolve('babel-preset-expo', {
  paths: [require.resolve('expo/package.json')],
});

module.exports = function (api) {
  api.cache(true);
  return { presets: [preset] };
};
