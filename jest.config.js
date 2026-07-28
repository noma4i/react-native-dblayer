module.exports = {
  testEnvironment: 'node',
  restoreMocks: true,
  resetMocks: true,
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts', '<rootDir>/src/**/__tests__/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  transform: {
    '^.+\\.js$': [
      'babel-jest',
      {
        presets: [['@babel/preset-env', { targets: { node: 'current' } }]]
      }
    ],
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          jsx: 'react-jsx'
        }
      }
    ]
  },
  coverageThreshold: {
    global: {
      statements: 93,
      branches: 83,
      functions: 92,
      lines: 95
    }
  },
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.js',
    '^react-native-mmkv$': '<rootDir>/__mocks__/react-native-mmkv.js'
  },
  transformIgnorePatterns: ['/node_modules/(?!fractional-indexing/)']
};
