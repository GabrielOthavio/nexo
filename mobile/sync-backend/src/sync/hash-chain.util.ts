import { createHash } from 'crypto';

/**
 * Espelho, em Node.js, do algoritmo usado no app móvel
 * (mobile/app/src/db/hashChain.ts): SHA-256(hash_anterior|uuid|payload|criado_em).
 * As duas implementações precisam permanecer idênticas — qualquer mudança
 * em uma exige a mesma mudança na outra.
 */
export function calcularProximoHash(
  hashAnterior: string,
  uuid: string,
  payload: string,
  criadoEm: string,
): string {
  const entrada = `${hashAnterior}|${uuid}|${payload}|${criadoEm}`;
  return createHash('sha256').update(entrada).digest('hex');
}

export interface ItemDaCadeia {
  uuid: string;
  payload: string;
  criadoEm: string;
  hashAnterior: string;
  hashAtual: string;
}

export interface ResultadoValidacaoCadeia {
  ok: boolean;
  indiceInvalido: number | null;
  motivo: string | null;
}

/**
 * Revalida, de forma independente, a cadeia de hashes recebida do
 * dispositivo — o servidor nunca confia apenas nos hashes que o cliente
 * enviou. `hashInicialEsperado` é o hash_atual do último item já persistido
 * para este usuário em lotes anteriores (ou o hash gênesis, se for o
 * primeiro lote), garantindo continuidade entre sincronizações.
 */
export function validarCadeia(
  itens: ItemDaCadeia[],
  hashInicialEsperado: string,
): ResultadoValidacaoCadeia {
  let hashEsperado = hashInicialEsperado;

  for (let i = 0; i < itens.length; i++) {
    const item = itens[i];

    if (item.hashAnterior !== hashEsperado) {
      return { ok: false, indiceInvalido: i, motivo: 'hash_anterior não corresponde à continuidade da cadeia' };
    }

    const recalculado = calcularProximoHash(item.hashAnterior, item.uuid, item.payload, item.criadoEm);
    if (recalculado !== item.hashAtual) {
      return { ok: false, indiceInvalido: i, motivo: 'hash_atual não bate com o conteúdo do item' };
    }

    hashEsperado = item.hashAtual;
  }

  return { ok: true, indiceInvalido: null, motivo: null };
}
