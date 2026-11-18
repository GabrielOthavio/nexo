/* eslint-disable import/first -- os mocks e a chave de teste precisam ser
   semeados ANTES do import do módulo sob teste (a chave é memoizada nele). */
import { createHash } from 'crypto';

/**
 * `expo-crypto` precisa de módulo nativo — indisponível no ambiente Jest
 * (Node puro, sem device/simulador). O mock abaixo NÃO é um stub bobo: chama
 * o `crypto` real do Node para calcular o SHA-256 de verdade, então os
 * hashes aqui são criptograficamente corretos, só a origem da implementação
 * (nativa vs. Node) muda — o que se testa é o ALGORITMO de encadeamento
 * (hashChain.ts), não o binding nativo do expo-crypto em si.
 */
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: jest.fn(async (_algoritmo: string, dados: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('crypto').createHash('sha256').update(dados, 'utf8').digest('hex'),
  ),
}));

import { calcularProximoHash, verificarCadeia, EloDaCadeia, ConteudoEncadeavel } from './hashChain';
import { HASH_GENESIS } from './schema';
// Espelho Node.js do MESMO algoritmo, do lado do sync-backend (ver
// mobile/sync-backend/src/sync/hash-chain.util.ts) — os comentários dos dois
// arquivos são explícitos: "as duas implementações precisam permanecer
// idênticas". Importar direto o código real do backend (não uma cópia
// colada aqui) é o que torna esta suíte um teste de PARIDADE de verdade —
// se um dos dois lados mudar o formato da serialização sem replicar no
// outro, este arquivo quebra imediatamente, em vez de o problema só
// aparecer como cadeia corrompida em produção meses depois.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const backendHashChain = require('../../../sync-backend/src/sync/hash-chain.util.ts');

function eloDe(conteudo: ConteudoEncadeavel, hashAnterior: string, hashAtual: string): EloDaCadeia {
  return { ...conteudo, hashAnterior, hashAtual };
}

/** Constrói uma cadeia válida de N elos, cada um encadeado ao hashAtual do anterior. */
async function construirCadeiaValida(conteudos: ConteudoEncadeavel[]): Promise<EloDaCadeia[]> {
  const elos: EloDaCadeia[] = [];
  let hashAnterior = HASH_GENESIS;
  for (const conteudo of conteudos) {
    const hashAtual = await calcularProximoHash(hashAnterior, conteudo);
    elos.push(eloDe(conteudo, hashAnterior, hashAtual));
    hashAnterior = hashAtual;
  }
  return elos;
}

describe('hashChain (app mobile)', () => {
  // ===========================================================================
  // CENÁRIO 1 — calcularProximoHash: propriedades do hash isoladamente
  // ===========================================================================
  describe('Cenário 1 — calcularProximoHash', () => {
    it('[CORRETO] 1.1 é determinístico: mesma entrada -> sempre o mesmo hash', async () => {
      const conteudo: ConteudoEncadeavel = { uuid: 'u1', payload: '{"a":1}', criadoEm: '2026-01-01T00:00:00.000Z' };
      const h1 = await calcularProximoHash(HASH_GENESIS, conteudo);
      const h2 = await calcularProximoHash(HASH_GENESIS, conteudo);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('[CORRETO] 1.2 bate byte a byte com um SHA-256 calculado de forma independente sobre "hashAnterior|uuid|payload|criadoEm"', async () => {
      const conteudo: ConteudoEncadeavel = { uuid: 'abc-123', payload: '{"tipo":"achado_criar"}', criadoEm: '2026-08-12T10:00:00.000Z' };
      const hashAnterior = HASH_GENESIS;
      const esperado = createHash('sha256')
        .update(`${hashAnterior}|${conteudo.uuid}|${conteudo.payload}|${conteudo.criadoEm}`, 'utf8')
        .digest('hex');
      const obtido = await calcularProximoHash(hashAnterior, conteudo);
      expect(obtido).toBe(esperado);
    });

    it('[CORRETO] 1.3 PARIDADE com o sync-backend: mesma entrada produz EXATAMENTE o mesmo hash nas duas implementações', async () => {
      const hashAnterior = 'a'.repeat(64);
      const conteudo: ConteudoEncadeavel = { uuid: 'uuid-paridade', payload: '{"tipo":"etapa_editar"}', criadoEm: '2026-03-05T12:34:56.000Z' };

      const hashMobile = await calcularProximoHash(hashAnterior, conteudo);
      const hashBackend = backendHashChain.calcularProximoHash(hashAnterior, conteudo.uuid, conteudo.payload, conteudo.criadoEm);

      expect(hashMobile).toBe(hashBackend);
    });

    it('[INCORRETO] 1.4 sensível a QUALQUER mudança no conteúdo: uuid, payload, criadoEm ou hashAnterior diferentes -> hash diferente', async () => {
      const base: ConteudoEncadeavel = { uuid: 'u1', payload: '{"x":1}', criadoEm: '2026-01-01T00:00:00.000Z' };
      const hashBase = await calcularProximoHash(HASH_GENESIS, base);

      const variantes: Array<[string, ConteudoEncadeavel, string]> = [
        ['uuid trocado', { ...base, uuid: 'u2' }, HASH_GENESIS],
        ['payload trocado', { ...base, payload: '{"x":2}' }, HASH_GENESIS],
        ['criadoEm trocado', { ...base, criadoEm: '2026-01-01T00:00:00.001Z' }, HASH_GENESIS],
      ];
      for (const [, conteudo, hashAnterior] of variantes) {
        // eslint-disable-next-line no-await-in-loop
        expect(await calcularProximoHash(hashAnterior, conteudo)).not.toBe(hashBase);
      }
      expect(await calcularProximoHash('f'.repeat(64), base)).not.toBe(hashBase);
    });
  });

  // ===========================================================================
  // CENÁRIO 2 — verificarCadeia: fluxo feliz
  // ===========================================================================
  describe('Cenário 2 — verificarCadeia: cadeias válidas', () => {
    it('[CORRETO] 2.1 cadeia vazia -> null (nada a verificar, nada corrompido)', async () => {
      expect(await verificarCadeia([])).toBeNull();
    });

    it('[CORRETO] 2.2 um único elo partindo do gênesis -> null', async () => {
      const cadeia = await construirCadeiaValida([{ uuid: 'u1', payload: '{}', criadoEm: '2026-01-01T00:00:00.000Z' }]);
      expect(await verificarCadeia(cadeia)).toBeNull();
    });

    it('[CORRETO] 2.3 cadeia longa (50 elos) encadeada corretamente -> null', async () => {
      const conteudos: ConteudoEncadeavel[] = Array.from({ length: 50 }, (_, i) => ({
        uuid: `u${i}`,
        payload: JSON.stringify({ indice: i }),
        criadoEm: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }));
      const cadeia = await construirCadeiaValida(conteudos);
      expect(await verificarCadeia(cadeia)).toBeNull();
    });
  });

  // ===========================================================================
  // CENÁRIO 3 — verificarCadeia: adulteração/corrupção detectada
  // ===========================================================================
  describe('Cenário 3 — verificarCadeia: cadeias corrompidas', () => {
    it('[INCORRETO] 3.1 primeiro elo não parte do gênesis -> índice 0', async () => {
      const cadeia = await construirCadeiaValida([{ uuid: 'u1', payload: '{}', criadoEm: '2026-01-01T00:00:00.000Z' }]);
      cadeia[0].hashAnterior = 'f'.repeat(64); // devia ser HASH_GENESIS
      expect(await verificarCadeia(cadeia)).toBe(0);
    });

    it('[INCORRETO] 3.2 payload adulterado DEPOIS da criação (hashAtual gravado não bate mais com o conteúdo) -> índice do elo adulterado', async () => {
      const cadeia = await construirCadeiaValida([
        { uuid: 'u1', payload: '{"valor":100}', criadoEm: '2026-01-01T00:00:00.000Z' },
        { uuid: 'u2', payload: '{"valor":200}', criadoEm: '2026-01-01T00:00:01.000Z' },
      ]);
      // Alguém edita o payload no SQLite diretamente, por fora do fluxo normal —
      // o hashAtual gravado continua sendo o do valor ORIGINAL (100).
      cadeia[0].payload = '{"valor":999}';
      expect(await verificarCadeia(cadeia)).toBe(0);
    });

    it('[INCORRETO] 3.3 elo do meio removido (reordenação/salto) quebra a continuidade a partir dali -> índice do elo seguinte ao removido', async () => {
      const cadeia = await construirCadeiaValida([
        { uuid: 'u1', payload: '{}', criadoEm: '2026-01-01T00:00:00.000Z' },
        { uuid: 'u2', payload: '{}', criadoEm: '2026-01-01T00:00:01.000Z' },
        { uuid: 'u3', payload: '{}', criadoEm: '2026-01-01T00:00:02.000Z' },
      ]);
      const cadeiaComBuraco = [cadeia[0], cadeia[2]]; // remove o elo do meio (u2)
      expect(await verificarCadeia(cadeiaComBuraco)).toBe(1);
    });

    it('[INCORRETO] 3.4 dois elos trocados de posição (reordenação) -> detectado no primeiro ponto de divergência', async () => {
      const cadeia = await construirCadeiaValida([
        { uuid: 'u1', payload: '{}', criadoEm: '2026-01-01T00:00:00.000Z' },
        { uuid: 'u2', payload: '{}', criadoEm: '2026-01-01T00:00:01.000Z' },
        { uuid: 'u3', payload: '{}', criadoEm: '2026-01-01T00:00:02.000Z' },
      ]);
      const cadeiaReordenada = [cadeia[0], cadeia[2], cadeia[1]];
      expect(await verificarCadeia(cadeiaReordenada)).toBe(1);
    });

    it('[INCORRETO] 3.5 hashAtual de um elo válido é copiado por cima de outro (item duplicado/forjado) -> detectado', async () => {
      const cadeia = await construirCadeiaValida([
        { uuid: 'u1', payload: '{}', criadoEm: '2026-01-01T00:00:00.000Z' },
        { uuid: 'u2', payload: '{}', criadoEm: '2026-01-01T00:00:01.000Z' },
      ]);
      cadeia[1].hashAtual = cadeia[0].hashAtual; // forja o segundo elo pra "parecer" o primeiro
      expect(await verificarCadeia(cadeia)).toBe(1);
    });

    it('[INCORRETO] 3.6 cadeia válida seguida de um elo cuja hashAnterior não referencia o hashAtual real do anterior -> índice do elo quebrado', async () => {
      const cadeia = await construirCadeiaValida([{ uuid: 'u1', payload: '{}', criadoEm: '2026-01-01T00:00:00.000Z' }]);
      const eloForjado = eloDe({ uuid: 'u2', payload: '{}', criadoEm: '2026-01-01T00:00:01.000Z' }, 'e'.repeat(64), 'e'.repeat(64));
      const cadeiaComForja = [...cadeia, eloForjado];
      expect(await verificarCadeia(cadeiaComForja)).toBe(1);
    });
  });
});
