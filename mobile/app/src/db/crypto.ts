import * as Crypto from 'expo-crypto';
import * as SecureStore from '../services/armazenamentoSeguro';
import * as aesjs from 'aes-js';

/**
 * Criptografia em repouso do conteúdo do Achado no SQLite local — proteção
 * de confidencialidade contra acesso físico ao arquivo do banco, camada
 * SEPARADA do hash chaining (que prova integridade da sequência, não
 * confidencialidade — ver hashChain.ts). O hash sempre é calculado sobre o
 * payload em TEXTO PLANO antes de chegar aqui; esta cifra nunca participa
 * do cálculo do hash.
 *
 * AES-256-CTR (não GCM): `aes-js` é uma lib pura JS, sem módulo nativo,
 * compatível com o Expo managed workflow, e só implementa CTR/CBC/CFB/OFB —
 * não AEAD. Como CTR não autentica por si só, aplicamos Encrypt-then-MAC
 * com um HMAC-SHA256 implementado manualmente (RFC 2104) sobre
 * `expo-crypto`, já que a lib não expõe uma primitiva "keyed hash" pronta.
 */

const CHAVE_STORE_ID = 'achado_chave_simetrica_v1';
const SHA256_BLOCK_SIZE = 64;

export interface ConteudoCifrado {
  cifrado: string; // hex
  iv: string; // hex
  hmac: string; // hex
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((soma, a) => soma + a.length, 0);
  const saida = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    saida.set(a, offset);
    offset += a.length;
  }
  return saida;
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const saida = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) saida[i] = a[i] ^ b[i];
  return saida;
}

/**
 * Codec UTF-8 próprio — `aesjs.utils.utf8` NÃO é usado para o texto plano:
 * seu `toBytes` codifica o range completo de Unicode corretamente (via
 * `encodeURI`), mas o `fromBytes` correspondente só decodifica sequências de
 * até 3 bytes (plano básico multilíngue). Qualquer caractere fora do BMP —
 * a maioria dos emojis modernos, que ocupam 4 bytes em UTF-8 — cifra certo e
 * decifra corrompido (não lança erro; produz uma string diferente da
 * original, silenciosamente). Não é falha de HMAC: os bytes cifrados/MAC
 * estão corretos, o bug está inteiramente na reconstrução de string a partir
 * dos bytes decifrados, fora da cadeia de integridade.
 */
function codificarUtf8(texto: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < texto.length; i++) {
    const codigo = texto.codePointAt(i) as number;
    if (codigo > 0xffff) i++; // consumiu as duas metades do par substituto
    if (codigo < 0x80) {
      bytes.push(codigo);
    } else if (codigo < 0x800) {
      bytes.push(0xc0 | (codigo >> 6), 0x80 | (codigo & 0x3f));
    } else if (codigo < 0x10000) {
      bytes.push(0xe0 | (codigo >> 12), 0x80 | ((codigo >> 6) & 0x3f), 0x80 | (codigo & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codigo >> 18),
        0x80 | ((codigo >> 12) & 0x3f),
        0x80 | ((codigo >> 6) & 0x3f),
        0x80 | (codigo & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function decodificarUtf8(bytes: Uint8Array): string {
  let resultado = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      resultado += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      resultado += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      resultado += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else {
      resultado += String.fromCodePoint(
        ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f),
      );
      i += 4;
    }
  }
  return resultado;
}

async function sha256(dados: Uint8Array): Promise<Uint8Array> {
  // TS 5.7+ tipa TypedArrays como genéricos sobre o buffer (Uint8Array<ArrayBufferLike>
  // vs o Uint8Array<ArrayBuffer> exigido por BufferSource) — copiar garante um
  // ArrayBuffer concreto, satisfazendo o tipo independente da origem do array.
  const bytes = new Uint8Array(dados);
  const buffer = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return new Uint8Array(buffer);
}

/** HMAC-SHA256 (RFC 2104) — expo-crypto só expõe hash simples, sem variante keyed. */
async function hmacSha256(chave: Uint8Array, mensagem: Uint8Array): Promise<Uint8Array> {
  let chaveBloco = chave;
  if (chaveBloco.length > SHA256_BLOCK_SIZE) {
    chaveBloco = await sha256(chaveBloco);
  }
  if (chaveBloco.length < SHA256_BLOCK_SIZE) {
    const preenchida = new Uint8Array(SHA256_BLOCK_SIZE);
    preenchida.set(chaveBloco);
    chaveBloco = preenchida;
  }

  const opad = new Uint8Array(SHA256_BLOCK_SIZE).fill(0x5c);
  const ipad = new Uint8Array(SHA256_BLOCK_SIZE).fill(0x36);

  const oKeyPad = xorBytes(chaveBloco, opad);
  const iKeyPad = xorBytes(chaveBloco, ipad);

  const interno = await sha256(concatBytes(iKeyPad, mensagem));
  return sha256(concatBytes(oKeyPad, interno));
}

/**
 * Memoiza a obtenção/criação da chave: duas chamadas concorrentes no
 * primeiro uso gerariam duas chaves distintas, uma sobrescrevendo a outra
 * no SecureStore — tudo que foi cifrado com a chave perdedora ficaria
 * indecifrável (falha de HMAC) para sempre.
 */
let chaveEmObtencao: Promise<Uint8Array> | null = null;

/** Gerada no primeiro uso do app e guardada no keychain/keystore nativo — nunca transmitida. */
function obterOuCriarChave(): Promise<Uint8Array> {
  if (!chaveEmObtencao) {
    chaveEmObtencao = (async () => {
      const armazenada = await SecureStore.getItemAsync(CHAVE_STORE_ID);
      if (armazenada) {
        return aesjs.utils.hex.toBytes(armazenada);
      }
      const nova = await Crypto.getRandomBytesAsync(32); // AES-256
      await SecureStore.setItemAsync(CHAVE_STORE_ID, aesjs.utils.hex.fromBytes(nova));
      return nova;
    })();
    chaveEmObtencao.catch(() => {
      chaveEmObtencao = null;
    });
  }
  return chaveEmObtencao;
}

/** Chave de MAC derivada da chave de cifra por separação de domínio simples. */
async function obterChaveMac(chave: Uint8Array): Promise<Uint8Array> {
  const sufixo = aesjs.utils.utf8.toBytes('mac');
  return sha256(concatBytes(chave, sufixo));
}

export async function cifrar(textoPlano: string): Promise<ConteudoCifrado> {
  const chave = await obterOuCriarChave();
  const ivBytes = await Crypto.getRandomBytesAsync(16);

  const aesCtr = new aesjs.ModeOfOperation.ctr(chave, new aesjs.Counter(ivBytes));
  const cifradoBytes = aesCtr.encrypt(codificarUtf8(textoPlano));

  const chaveMac = await obterChaveMac(chave);
  const hmacBytes = await hmacSha256(chaveMac, concatBytes(ivBytes, cifradoBytes));

  return {
    cifrado: aesjs.utils.hex.fromBytes(cifradoBytes),
    iv: aesjs.utils.hex.fromBytes(ivBytes),
    hmac: aesjs.utils.hex.fromBytes(hmacBytes),
  };
}

/**
 * Recalcula o HMAC antes de decifrar — se não bater, a linha é tratada como
 * corrompida/adulterada (ver seção de Segurança do plano de integração).
 */
export async function decifrar(conteudo: ConteudoCifrado): Promise<string> {
  const chave = await obterOuCriarChave();
  const ivBytes = aesjs.utils.hex.toBytes(conteudo.iv);
  const cifradoBytes = aesjs.utils.hex.toBytes(conteudo.cifrado);

  const chaveMac = await obterChaveMac(chave);
  const hmacRecalculado = await hmacSha256(chaveMac, concatBytes(ivBytes, cifradoBytes));
  if (aesjs.utils.hex.fromBytes(hmacRecalculado) !== conteudo.hmac) {
    throw new Error('Falha de integridade: HMAC não confere — registro local possivelmente corrompido.');
  }

  const aesCtr = new aesjs.ModeOfOperation.ctr(chave, new aesjs.Counter(ivBytes));
  const textoBytes = aesCtr.decrypt(cifradoBytes);
  return decodificarUtf8(textoBytes);
}
