// Config do ESLint 8 (formato eslintrc — é o que o eslint-config-universe@12
// usa). Sem este arquivo o `npm run lint` falha com "couldn't find a
// configuration file" e o projeto fica sem lint nenhum, apesar de o eslint
// estar nas devDependencies.
module.exports = {
  root: true,
  extends: ['universe/native'],
  ignorePatterns: ['node_modules/', '.expo/', 'dist/', 'web-build/', 'coverage/'],
  overrides: [
    {
      // Os testes rodam em Node com os globais do Jest, não no runtime do RN.
      files: ['**/*.test.ts', '**/*.test.tsx'],
      env: { jest: true, node: true },
    },
  ],
};
