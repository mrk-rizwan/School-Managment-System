// Expo's defaults. They detect the pnpm workspace and follow its symlinks (slice-15 §2.3);
// nothing is customised until a verified failure demands it.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
