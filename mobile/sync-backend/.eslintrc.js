// Sem este arquivo o `npm run lint` falhava com "eslint não é reconhecido" —
// o script existia, mas o eslint nem estava nas devDependencies.
//
// Sem plugin de prettier de propósito: o objetivo aqui é achar problema de
// código (variável não usada, promise solta), não reformatar projeto pronto.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { project: 'tsconfig.json', tsconfigRootDir: __dirname, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.js', 'dist/', 'node_modules/', 'prisma/seed.ts'],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    // O `data` de um erro do axios e o corpo de uma resposta HTTP são `any`
    // na origem. Tratar como AVISO (não erro): fica visível como dívida —
    // tipar as respostas do Django resolveria — sem reprovar o lint por algo
    // que o try/catch já cobre em runtime.
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-return': 'warn',
  },
  overrides: [
    {
      // supertest devolve `resp.body` como `any` por design; exigir tipagem
      // aqui gerava 105 erros que não apontam defeito nenhum.
      files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
