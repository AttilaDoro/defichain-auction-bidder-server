module.exports = {
  env: {
    browser: true,
    es2021: true,
  },
  extends: [
    'airbnb-base',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  rules: {
    'arrow-parens': [1, 'as-needed', { requireForBlockBody: true }],
    'no-await-in-loop': 0,
    'max-len': ['error', { code: 150 }],
    'object-curly-newline': [
      'error',
      { ObjectPattern: { multiline: true, minProperties: 10 } },
    ],
  },
};
