const pak = require('../package.json');

const modules = [...Object.keys(pak.dependencies), ...Object.keys(pak.peerDependencies)]
  .filter((name) => name.startsWith('react-native-'));

module.exports = {
  dependencies: Object.fromEntries(
    modules.map((name) => [
      name,
      { root: require.resolve(name + '/package.json').replace('/package.json', '') }
    ])
  ),
};
