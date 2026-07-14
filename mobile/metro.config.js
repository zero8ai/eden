const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// The mobile app keeps its own dependency tree, while shared Eden packages live
// outside the Expo project root. Metro must watch the symlink targets in order
// to bundle imports such as @eden/api-contract on a physical device.
config.watchFolders = [path.resolve(projectRoot, "..", "packages")];

module.exports = config;
