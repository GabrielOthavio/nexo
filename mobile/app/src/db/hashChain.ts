import * as Crypto from 'expo-crypto';
import { HASH_GENESIS } from './schema';

/**
 * Encadeamento criptográfico de hashes (hash chaining) — TCC seção 2.5.
 *
 * Cada registro criado offline incorpora o SHA-256 do registro imediatamente
 * anterior na sequência de inserção local. Qualquer reinserção, remoção ou
 * reordenação dos registros no banco local após a criação original quebra
 * a cadeia, tornando a adulteração detectável no momento da sincronização
 * com o servidor. A garantia é sobre a integridade da sequência e a
 * imutabilidade pós-criação dos registros offline — não sobre a veracidade
 * do timestamp absoluto do dispositivo (limitação reconhecida no TCC).
 */

export interface ConteudoEncadeavel {
  uuid: string;
  payload: string;
  criadoEm: string;
}

/** Serializa o conteúdo de um registro de forma determinística para hashing. */
function serializarConteudo(conteudo: ConteudoEncadeavel): string {
  return `${conteudo.uuid}|${conteudo.payload}|${conteudo.criadoEm}`;
}

/**
 * Calcula o hash do próximo elo da cadeia:
 * SHA-256(hash_anterior || uuid || payload || criado_em)
 */
export async function calcularProximoHash(
  hashAnterior: string,
  conteudo: ConteudoEncadeavel
): Promise<string> {
  const entrada = `${hashAnterior}|${serializarConteudo(conteudo)}`;
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, entrada, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

export interface EloDaCadeia extends ConteudoEncadeavel {
  hashAnterior: string;
  hashAtual: string;
}

/**
 * Verifica a integridade de uma cadeia completa de registros, na ordem em
 * que foram inseridos localmente. Retorna o índice do primeiro elo corrompido
 * (ou null se a cadeia inteira for válida). Usado antes de cada tentativa de
 * sincronização — se a cadeia estiver quebrada, a sincronização é abortada
 * e o usuário é avisado, em vez de enviar dados potencialmente adulterados.
 */
export async function verificarCadeia(elos: EloDaCadeia[]): Promise<number | null> {
  let hashEsperado = HASH_GENESIS;

  for (let i = 0; i < elos.length; i++) {
    const elo = elos[i];
    if (elo.hashAnterior !== hashEsperado) {
      return i;
    }
    const hashRecalculado = await calcularProximoHash(elo.hashAnterior, elo);
    if (hashRecalculado !== elo.hashAtual) {
      return i;
    }
    hashEsperado = elo.hashAtual;
  }

  return null;
}
