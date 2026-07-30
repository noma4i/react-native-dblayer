module.exports = {
  testEnvironment: 'node',
  restoreMocks: true,
  resetMocks: true,
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts', '<rootDir>/src/**/__tests__/**/*.test.tsx'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.types.ts',
    '!src/**/__tests__/**',
    '!src/index.ts'
  ],
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
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    }
  },
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.js',
    '^react-native-mmkv$': '<rootDir>/__mocks__/react-native-mmkv.js'
  },
  transformIgnorePatterns: ['/node_modules/(?!fractional-indexing/)']
};
