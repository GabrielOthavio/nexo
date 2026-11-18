import { createHash } from 'crypto';
import { calcularProximoHash, ItemDaCadeia, validarCadeia } from './hash-chain.util';

/**
 * Unitário puro do validador do servidor — sem Nest, sem banco. O e2e
 * (test/sync.e2e-spec.ts) já exercita isto pela borda HTTP, mas aqui cada
 * ramo de `validarCadeia` ganha um caso isolado e barato, e a semântica da
 * ÂNCORA (o parâmetro que o app não tem) fica testada explicitamente.
 */

const GENESIS = '0'.repeat(64);

function elo(hashAnterior: string, i: number, payload = `{"i":${i}}`): ItemDaCadeia {
  const uuid = `uuid-${i}`;
  const criadoEm = `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`;
  return { uuid, payload, criadoEm, hashAnterior, hashAtual: calcularProximoHash(hashAnterior, uuid, payload, criadoEm) };
}

function cadeia(desde: string, n: number): ItemDaCadeia[] {
  const itens: ItemDaCadeia[] = [];
  let anterior = desde;
  for (let i = 0; i < n; i++) {
    const e = elo(anterior, i);
    itens.push(e);
    anterior = e.hashAtual;
  }
  return itens;
}

describe('calcularProximoHash', () => {
  it('é SHA-256 hex de "hashAnterior|uuid|payload|criadoEm" — o formato é contrato com o app', () => {
    const esperado = createHash('sha256').update(`${GENESIS}|u|{"a":1}|2026-01-01T00:00:00.000Z`).digest('hex');
    expect(calcularProximoHash(GENESIS, 'u', '{"a":1}', '2026-01-01T00:00:00.000Z')).toBe(esperado);
  });

  it('devolve 64 hex minúsculos', () => {
    expect(calcularProximoHash(GENESIS, 'u', 'p', 'c')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('é determinístico', () => {
    expect(calcularProximoHash(GENESIS, 'u', 'p', 'c')).toBe(calcularProximoHash(GENESIS, 'u', 'p', 'c'));
  });

  it.each([
    ['hashAnterior', ['f'.repeat(64), 'u', 'p', 'c']],
    ['uuid', [GENESIS, 'u2', 'p', 'c']],
    ['payload', [GENESIS, 'u', 'p2', 'c']],
    ['criadoEm', [GENESIS, 'u', 'p', 'c2']],
  ])('muda quando %s muda', (_campo, args) => {
    const base = calcularProximoHash(GENESIS, 'u', 'p', 'c');
    expect(calcularProximoHash(...(args as [string, string, string, string]))).not.toBe(base);
  });

  it('o separador "|" faz parte do hash: mover um caractere entre campos muda o resultado', () => {
    // "ab" + "c" vs "a" + "bc" — sem separador dariam a mesma string concatenada.
    expect(calcularProximoHash(GENESIS, 'ab', 'c', 'x')).not.toBe(calcularProximoHash(GENESIS, 'a', 'bc', 'x'));
  });
});

describe('validarCadeia', () => {
  describe('cadeias válidas', () => {
    it('cadeia vazia é válida a partir de qualquer âncora', () => {
      expect(validarCadeia([], GENESIS)).toEqual({ ok: true, indiceInvalido: null, motivo: null });
      expect(validarCadeia([], 'a'.repeat(64))).toEqual({ ok: true, indiceInvalido: null, motivo: null });
    });

    it('um elo partindo do gênesis', () => {
      expect(validarCadeia(cadeia(GENESIS, 1), GENESIS).ok).toBe(true);
    });

    it('vários elos encadeados', () => {
      expect(validarCadeia(cadeia(GENESIS, 20), GENESIS).ok).toBe(true);
    });

    it('cadeia que continua de uma âncora não-gênesis (push seguinte do mesmo dispositivo)', () => {
      const ancora = cadeia(GENESIS, 3)[2].hashAtual;
      expect(validarCadeia(cadeia(ancora, 2), ancora).ok).toBe(true);
    });
  });

  describe('semântica da âncora', () => {
    it('cadeia partindo do gênesis é REJEITADA quando a âncora já avançou', () => {
      // É isto que impede um aparelho de "recomeçar do zero" e apagar a
      // continuidade com o que já foi confirmado.
      const ancora = cadeia(GENESIS, 1)[0].hashAtual;
      const r = validarCadeia(cadeia(GENESIS, 1), ancora);
      expect(r.ok).toBe(false);
      expect(r.indiceInvalido).toBe(0);
      expect(r.motivo).toMatch(/continuidade/);
    });

    it('cadeia partindo de uma âncora errada é rejeitada no índice 0', () => {
      const r = validarCadeia(cadeia('b'.repeat(64), 2), 'a'.repeat(64));
      expect(r).toEqual({ ok: false, indiceInvalido: 0, motivo: expect.stringMatching(/continuidade/) });
    });
  });

  describe('adulteração', () => {
    it('payload alterado depois do hash → índice do elo, motivo "conteúdo"', () => {
      const itens = cadeia(GENESIS, 3);
      itens[1].payload = '{"i":999}';
      const r = validarCadeia(itens, GENESIS);
      expect(r.ok).toBe(false);
      expect(r.indiceInvalido).toBe(1);
      expect(r.motivo).toMatch(/conteúdo/);
    });

    it('hashAtual forjado → mesmo índice', () => {
      const itens = cadeia(GENESIS, 2);
      itens[0].hashAtual = 'c'.repeat(64);
      expect(validarCadeia(itens, GENESIS).indiceInvalido).toBe(0);
    });

    it('elo do meio removido → índice do elo seguinte ao buraco', () => {
      const itens = cadeia(GENESIS, 3);
      const comBuraco = [itens[0], itens[2]];
      const r = validarCadeia(comBuraco, GENESIS);
      expect(r.indiceInvalido).toBe(1);
      expect(r.motivo).toMatch(/continuidade/);
    });

    it('elos trocados de posição → primeiro ponto de divergência', () => {
      const itens = cadeia(GENESIS, 3);
      expect(validarCadeia([itens[0], itens[2], itens[1]], GENESIS).indiceInvalido).toBe(1);
    });

    it('para no PRIMEIRO problema mesmo com vários elos ruins depois', () => {
      const itens = cadeia(GENESIS, 5);
      itens[2].payload = 'x';
      itens[4].payload = 'y';
      expect(validarCadeia(itens, GENESIS).indiceInvalido).toBe(2);
    });

    it('uuid trocado invalida o hashAtual (uuid faz parte do conteúdo hasheado)', () => {
      const itens = cadeia(GENESIS, 1);
      itens[0].uuid = 'outro';
      expect(validarCadeia(itens, GENESIS).indiceInvalido).toBe(0);
    });

    it('criadoEm trocado invalida o hashAtual', () => {
      const itens = cadeia(GENESIS, 1);
      itens[0].criadoEm = '1999-01-01T00:00:00.000Z';
      expect(validarCadeia(itens, GENESIS).indiceInvalido).toBe(0);
    });
  });

  it('não muta os itens recebidos', () => {
    const itens = cadeia(GENESIS, 2);
    const copia = JSON.parse(JSON.stringify(itens));
    validarCadeia(itens, GENESIS);
    expect(itens).toEqual(copia);
  });
});
