/* eslint-disable import/first -- os mocks e a chave de teste precisam ser
   semeados ANTES do import do módulo sob teste (a chave é memoizada nele). */
import { createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';

/**
 * A cifra em repouso (crypto.ts) é artesanal por necessidade: AES-256-CTR do
 * `aes-js` + HMAC-SHA256 implementado à mão (RFC 2104) + codec UTF-8 próprio,
 * tudo em JS puro porque o Expo managed não tem AEAD nativo. É exatamente o
 * tipo de código que "funciona" com um bug silencioso por meses.
 *
 * Por isso esta suíte NÃO testa só round-trip: ela confere cada primitiva
 * contra a implementação de referência do Node/OpenSSL. Se o CTR do aes-js,
 * o HMAC manual ou a derivação da chave de MAC desviarem do padrão em um
 * byte, quebra aqui — não no aparelho de um auditor.
 *
 * Os mocks abaixo são os mesmos do hashChain.test.ts em espírito: trocam o
 * binding nativo do expo-crypto pelo crypto do Node, sem simplificar nada.
 */

const mockArmazenamento = new Map<string, string>();
jest.mock('../services/armazenamentoSeguro', () => ({
  getItemAsync: jest.fn(async (k: string) => mockArmazenamento.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockArmazenamento.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockArmazenamento.delete(k); }),
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digest: jest.fn(async (_algo: string, dados: Uint8Array) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const buf: Buffer = require('crypto').createHash('sha256').update(dados).digest();
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }),
  getRandomBytesAsync: jest.fn(async (n: number) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    new Uint8Array(require('crypto').randomBytes(n)),
  ),
}));

// Chave fixa e conhecida, semeada ANTES do primeiro import de crypto.ts
// (a obtenção é memoizada no módulo): é o que permite recomputar tudo de
// forma independente nos testes de paridade abaixo.
const CHAVE = randomBytes(32);
mockArmazenamento.set('achado_chave_simetrica_v1', CHAVE.toString('hex'));

import { cifrar, decifrar, ConteudoCifrado } from './crypto';

/** Mesma derivação de crypto.ts::obterChaveMac — sha256(chave || "mac"). */
function chaveMacDeReferencia(): Buffer {
  return createHash('sha256').update(Buffer.concat([CHAVE, Buffer.from('mac', 'utf8')])).digest();
}

function decifrarComOpenSSL(c: ConteudoCifrado): string {
  const d = createDecipheriv('aes-256-ctr', CHAVE, Buffer.from(c.iv, 'hex'));
  return Buffer.concat([d.update(Buffer.from(c.cifrado, 'hex')), d.final()]).toString('utf8');
}

function hmacDeReferencia(c: ConteudoCifrado): string {
  return createHmac('sha256', chaveMacDeReferencia())
    .update(Buffer.concat([Buffer.from(c.iv, 'hex'), Buffer.from(c.cifrado, 'hex')]))
    .digest('hex');
}

describe('crypto (cifra em repouso do app)', () => {
  // ===========================================================================
  // CENÁRIO 1 — round-trip: o que entra é o que sai
  // ===========================================================================
  describe('Cenário 1 — round-trip', () => {
    it.each([
      ['ASCII', 'Achado simples em campo.'],
      ['acentos (2 bytes UTF-8)', 'Não há comprovação da despesa — ação necessária.'],
      ['emoji fora do BMP (4 bytes UTF-8)', 'Item conferido 🔒 e ok ✅ 🇧🇷'],
      ['par substituto composto', '👨‍👩‍👧 família'],
      ['string vazia', ''],
      ['JSON como o payload real', JSON.stringify({ tipo: 'achado_criar', etapaUuid: 'x', descricao: 'ç' })],
      ['texto longo (muitos blocos AES)', 'Lorem ipsum çãõ 🔒 '.repeat(500)],
    ])('[CORRETO] 1.x %s', async (_rotulo, texto) => {
      expect(await decifrar(await cifrar(texto))).toBe(texto);
    });

    it('[CORRETO] 1.8 caracteres fora do BMP sobrevivem — o aes-js quebraria aqui', async () => {
      // O comentário em crypto.ts explica: aesjs.utils.utf8.fromBytes só
      // decodifica até 3 bytes. Este teste é o que impede alguém de "voltar
      // para o utils do aes-js" achando que é equivalente.
      const texto = '\u{1F512}\u{1F468}\u{1F469}\u{1F4A9}\u{10FFFF}';
      expect(await decifrar(await cifrar(texto))).toBe(texto);
    });
  });

  // ===========================================================================
  // CENÁRIO 2 — paridade com OpenSSL: as primitivas são as do padrão
  // ===========================================================================
  describe('Cenário 2 — paridade com a implementação de referência', () => {
    it('[CORRETO] 2.1 AES-256-CTR: o Node decifra o que o aes-js cifrou', async () => {
      const texto = 'Se o CTR do aes-js divergir do OpenSSL num bit, isto quebra. çãõ 🔒';
      const c = await cifrar(texto);
      expect(decifrarComOpenSSL(c)).toBe(texto);
    });

    it('[CORRETO] 2.2 HMAC-SHA256 manual (RFC 2104) bate com createHmac do Node', async () => {
      const c = await cifrar('qualquer coisa');
      expect(c.hmac).toBe(hmacDeReferencia(c));
    });

    it('[CORRETO] 2.3 HMAC cobre IV || cifrado (Encrypt-then-MAC), nesta ordem', async () => {
      const c = await cifrar('ordem importa');
      const invertido = createHmac('sha256', chaveMacDeReferencia())
        .update(Buffer.concat([Buffer.from(c.cifrado, 'hex'), Buffer.from(c.iv, 'hex')]))
        .digest('hex');
      expect(c.hmac).not.toBe(invertido);
    });

    it('[CORRETO] 2.4 formato de saída: iv 16 bytes, hmac 32 bytes, tudo hex minúsculo', async () => {
      const c = await cifrar('abc');
      expect(c.iv).toMatch(/^[0-9a-f]{32}$/);
      expect(c.hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(c.cifrado).toMatch(/^[0-9a-f]*$/);
      expect(c.cifrado.length).toBe(3 * 2); // CTR não tem padding: 3 bytes → 6 hex
    });
  });

  // ===========================================================================
  // CENÁRIO 3 — IV único por chamada
  // ===========================================================================
  describe('Cenário 3 — IV', () => {
    it('[CORRETO] 3.1 mesmo texto duas vezes → IVs e cifrados diferentes', async () => {
      const a = await cifrar('repetido');
      const b = await cifrar('repetido');
      expect(a.iv).not.toBe(b.iv);
      expect(a.cifrado).not.toBe(b.cifrado);
      expect(a.hmac).not.toBe(b.hmac);
    });
  });

  // ===========================================================================
  // CENÁRIO 4 — adulteração: qualquer bit alterado é rejeitado ANTES de decifrar
  // ===========================================================================
  describe('Cenário 4 — integridade', () => {
    function flipUltimoNibble(hex: string): string {
      const ultimo = parseInt(hex.slice(-1), 16);
      return hex.slice(0, -1) + ((ultimo ^ 1).toString(16));
    }

    it('[INCORRETO] 4.1 cifrado adulterado → lança falha de HMAC', async () => {
      const c = await cifrar('conteúdo íntegro');
      await expect(decifrar({ ...c, cifrado: flipUltimoNibble(c.cifrado) })).rejects.toThrow(/HMAC/);
    });

    it('[INCORRETO] 4.2 IV adulterado → lança', async () => {
      const c = await cifrar('conteúdo íntegro');
      await expect(decifrar({ ...c, iv: flipUltimoNibble(c.iv) })).rejects.toThrow(/HMAC/);
    });

    it('[INCORRETO] 4.3 HMAC adulterado → lança', async () => {
      const c = await cifrar('conteúdo íntegro');
      await expect(decifrar({ ...c, hmac: flipUltimoNibble(c.hmac) })).rejects.toThrow(/HMAC/);
    });

    it('[INCORRETO] 4.4 HMAC de outro registro (mix-and-match) → lança', async () => {
      const a = await cifrar('registro A');
      const b = await cifrar('registro B');
      await expect(decifrar({ ...a, hmac: b.hmac })).rejects.toThrow(/HMAC/);
    });

    it('[INCORRETO] 4.5 cifrado truncado → lança (não devolve texto parcial)', async () => {
      const c = await cifrar('não pode devolver metade disto');
      await expect(decifrar({ ...c, cifrado: c.cifrado.slice(0, 10) })).rejects.toThrow(/HMAC/);
    });

    it('[INCORRETO] 4.6 CTR é maleável — sem o MAC, um bit flip trocaria um caractere em silêncio', async () => {
      // Justifica a existência do HMAC: prova que o AES-CTR sozinho NÃO
      // detectaria a adulteração (o OpenSSL decifra o texto corrompido sem
      // reclamar), e que é o HMAC que barra.
      const c = await cifrar('valor: 100');
      const adulterado = { ...c, cifrado: flipUltimoNibble(c.cifrado) };
      const semMac = decifrarComOpenSSL(adulterado);
      expect(semMac).not.toBe('valor: 100');
      expect(semMac.length).toBe('valor: 100'.length); // decifrou "com sucesso", texto errado
      await expect(decifrar(adulterado)).rejects.toThrow(/HMAC/);
    });
  });
});
