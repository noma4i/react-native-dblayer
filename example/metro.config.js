const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const repositoryRoot = path.resolve(__dirname, '..');

const config = {
  watchFolders: [repositoryRoot],
  resolver: {
    disableHierarchicalLookup: true,
    nodeModulesPaths: [path.join(__dirname, 'node_modules'), path.join(repositoryRoot, 'node_modules')],
    extraNodeModules: {
      '@noma4i/react-native-dblayer': path.join(repositoryRoot, 'src'),
      react: path.join(__dirname, 'node_modules/react'),
      'react-native': path.join(__dirname, 'node_modules/react-native'),
      'react-native-mmkv': path.join(__dirname, 'node_modules/react-native-mmkv'),
      'react-native-nitro-modules': path.join(__dirname, 'node_modules/react-native-nitro-modules'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
