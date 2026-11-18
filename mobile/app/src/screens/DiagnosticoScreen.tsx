import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as aesjs from 'aes-js';
import { cifrar, decifrar, ConteudoCifrado } from '../db/crypto';
import { calcularProximoHash, verificarCadeia, EloDaCadeia, ConteudoEncadeavel } from '../db/hashChain';
import { HASH_GENESIS } from '../db/schema';

interface Props {
  onFechar: () => void;
}

interface ResultadoTeste {
  nome: string;
  ok: boolean;
  detalhe?: string;
}

/**
 * Roda a cadeia de hash (hashChain.ts) e a criptografia em repouso
 * (crypto.ts) contra a implementação NATIVA de verdade do aparelho —
 * expo-crypto/aes-js/expo-secure-store — em vez do `crypto` do Node que os
 * testes de Jest usam (ver hashChain.test.ts). Os dois se complementam: o
 * Jest prova que o ALGORITMO está certo de forma rápida e determinística; esta
 * tela prova que o BINDING nativo deste aparelho específico calcula os
 * mesmos valores — SO/arquitetura/versão do Hermes já causaram divergência
 * de biblioteca de cripto em outros projetos, e isso só se descobre rodando
 * no aparelho real.
 *
 * Não escreve nada na fila real (`operacoes_pendentes`) nem em nenhuma
 * tabela do app — só chama `cifrar`/`decifrar`/`calcularProximoHash` com
 * dados sintéticos descartáveis. A ÚNICA pegada real é a chave AES-256 em
 * SecureStore (`achado_chave_simetrica_v1`, ver crypto.ts): se o aparelho
 * ainda não tem uma, esta tela cria — a mesma que o app usaria de qualquer
 * forma no primeiro uso real. Rodar aqui não corrompe nem troca uma chave
 * já existente.
 */
async function rodarDiagnostico(): Promise<ResultadoTeste[]> {
  const resultados: ResultadoTeste[] = [];

  async function testar(nome: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      resultados.push({ nome, ok: true });
    } catch (erro) {
      resultados.push({ nome, ok: false, detalhe: erro instanceof Error ? erro.message : String(erro) });
    }
  }

  function assert(condicao: boolean, mensagem: string): void {
    if (!condicao) throw new Error(mensagem);
  }

  // --- SHA-256 nativo contra vetores de teste conhecidos (NIST) ---------
  await testar('SHA-256 nativo — vetor conhecido (entrada vazia)', async () => {
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, '', {
      encoding: Crypto.CryptoEncoding.HEX,
    });
    assert(
      hash === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      `esperado e3b0c442..., obtido ${hash}`,
    );
  });

  await testar('SHA-256 nativo — vetor conhecido ("abc")', async () => {
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, 'abc', {
      encoding: Crypto.CryptoEncoding.HEX,
    });
    assert(
      hash === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      `esperado ba7816bf..., obtido ${hash}`,
    );
  });

  await testar('getRandomBytesAsync — duas chamadas geram valores distintos', async () => {
    const a = await Crypto.getRandomBytesAsync(16);
    const b = await Crypto.getRandomBytesAsync(16);
    assert(aesjs.utils.hex.fromBytes(a) !== aesjs.utils.hex.fromBytes(b), 'duas chamadas produziram o mesmo valor — gerador de aleatoriedade suspeito');
  });

  // --- Criptografia em repouso (crypto.ts): round-trip ------------------
  let cifradoTeste: ConteudoCifrado | null = null;
  await testar('cifrar/decifrar — round-trip com texto simples', async () => {
    const original = 'auditoria-teste-diagnostico';
    const cifrado = await cifrar(original);
    const decifrado = await decifrar(cifrado);
    assert(decifrado === original, `esperado "${original}", obtido "${decifrado}"`);
    cifradoTeste = cifrado;
  });

  await testar('cifrar/decifrar — round-trip com acentos e emoji', async () => {
    const original = 'Não conformidade encontrada 🚨 — pátio de veículos, seção nº 3';
    const decifrado = await decifrar(await cifrar(original));
    assert(decifrado === original, `esperado "${original}", obtido "${decifrado}"`);
  });

  await testar('cifrar/decifrar — round-trip com JSON grande', async () => {
    const original = JSON.stringify({
      orientacao: 'Verificar documentação fiscal',
      documentos: Array.from({ length: 20 }, (_, i) => `doc-${i}.pdf`),
      atividade: 'Vistoria de veículos oficiais',
      situacao: 'EM_ANDAMENTO',
    });
    const decifrado = await decifrar(await cifrar(original));
    assert(decifrado === original, 'JSON não sobreviveu ao round-trip idêntico');
  });

  await testar('cifrar — duas cifragens do mesmo texto produzem IV e texto cifrado diferentes', async () => {
    const original = 'mesmo-texto-duas-vezes';
    const c1 = await cifrar(original);
    const c2 = await cifrar(original);
    assert(c1.iv !== c2.iv, 'o IV se repetiu entre duas cifragens — reuso de IV quebra a segurança do AES-CTR');
    assert(c1.cifrado !== c2.cifrado, 'o texto cifrado se repetiu entre duas cifragens');
  });

  // --- Detecção de adulteração (HMAC) ------------------------------------
  await testar('decifrar — detecta HMAC adulterado', async () => {
    if (!cifradoTeste) throw new Error('pré-requisito (round-trip simples) não rodou');
    const adulterado: ConteudoCifrado = {
      ...cifradoTeste,
      hmac: (cifradoTeste.hmac[0] === '0' ? '1' : '0') + cifradoTeste.hmac.slice(1),
    };
    let lancou = false;
    try {
      await decifrar(adulterado);
    } catch {
      lancou = true;
    }
    assert(lancou, 'decifrar() aceitou um HMAC adulterado sem lançar — falha de integridade não detectada');
  });

  await testar('decifrar — detecta texto cifrado adulterado', async () => {
    if (!cifradoTeste) throw new Error('pré-requisito (round-trip simples) não rodou');
    const adulterado: ConteudoCifrado = {
      ...cifradoTeste,
      cifrado: (cifradoTeste.cifrado[0] === '0' ? '1' : '0') + cifradoTeste.cifrado.slice(1),
    };
    let lancou = false;
    try {
      await decifrar(adulterado);
    } catch {
      lancou = true;
    }
    assert(lancou, 'decifrar() aceitou um texto cifrado adulterado sem lançar — falha de integridade não detectada');
  });

  // --- Cadeia de hash (hashChain.ts) contra o binding nativo -------------
  await testar('hashChain — cadeia de 5 elos válida (nativo)', async () => {
    let hashAnterior = HASH_GENESIS;
    const elos: EloDaCadeia[] = [];
    for (let i = 0; i < 5; i++) {
      const conteudo: ConteudoEncadeavel = { uuid: `diag-${i}`, payload: `{"indice":${i}}`, criadoEm: new Date(2026, 0, 1, 0, 0, i).toISOString() };
      // eslint-disable-next-line no-await-in-loop
      const hashAtual = await calcularProximoHash(hashAnterior, conteudo);
      elos.push({ ...conteudo, hashAnterior, hashAtual });
      hashAnterior = hashAtual;
    }
    const indiceCorrompido = await verificarCadeia(elos);
    assert(indiceCorrompido === null, `cadeia válida foi acusada de corrompida no índice ${indiceCorrompido}`);
  });

  await testar('hashChain — adulteração pós-criação é detectada (nativo)', async () => {
    const conteudo1: ConteudoEncadeavel = { uuid: 'diag-a', payload: '{"v":1}', criadoEm: '2026-01-01T00:00:00.000Z' };
    const hash1 = await calcularProximoHash(HASH_GENESIS, conteudo1);
    const conteudo2: ConteudoEncadeavel = { uuid: 'diag-b', payload: '{"v":2}', criadoEm: '2026-01-01T00:00:01.000Z' };
    const hash2 = await calcularProximoHash(hash1, conteudo2);

    const elos: EloDaCadeia[] = [
      { ...conteudo1, hashAnterior: HASH_GENESIS, hashAtual: hash1 },
      { ...conteudo2, hashAnterior: hash1, hashAtual: hash2 },
    ];
    elos[0].payload = '{"v":999}'; // adulterado depois de calcular o hash

    const indiceCorrompido = await verificarCadeia(elos);
    assert(indiceCorrompido === 0, `esperava detectar corrupção no índice 0, obteve ${indiceCorrompido}`);
  });

  await testar('hashChain — formato de serialização bate com SHA-256 nativo direto', async () => {
    const hashAnterior = 'b'.repeat(64);
    const conteudo: ConteudoEncadeavel = { uuid: 'diag-formato', payload: '{"x":true}', criadoEm: '2026-05-01T09:00:00.000Z' };
    const viaHashChain = await calcularProximoHash(hashAnterior, conteudo);
    const viaShaDireto = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      `${hashAnterior}|${conteudo.uuid}|${conteudo.payload}|${conteudo.criadoEm}`,
      { encoding: Crypto.CryptoEncoding.HEX },
    );
    assert(viaHashChain === viaShaDireto, 'a serialização de hashChain.ts divergiu do SHA-256 calculado direto sobre a string esperada');
  });

  return resultados;
}

export default function DiagnosticoScreen({ onFechar }: Props) {
  const [rodando, setRodando] = useState(true);
  const [resultados, setResultados] = useState<ResultadoTeste[]>([]);
  const [duracaoMs, setDuracaoMs] = useState<number | null>(null);

  const rodar = useCallback(async () => {
    setRodando(true);
    setResultados([]);
    const inicio = Date.now();
    const saida = await rodarDiagnostico();
    setDuracaoMs(Date.now() - inicio);
    setResultados(saida);
    setRodando(false);
  }, []);

  useEffect(() => {
    rodar();
  }, [rodar]);

  const total = resultados.length;
  const falhas = resultados.filter((r) => !r.ok).length;

  return (
    <View style={styles.container}>
      <Text style={styles.titulo}>Diagnóstico do aparelho</Text>
      <Text style={styles.subtitulo}>
        Verifica a cadeia de hash e a criptografia dos dados offline contra a implementação
        nativa DESTE aparelho — não mexe em nenhum dado real de auditoria.
      </Text>

      {rodando && (
        <View style={styles.carregando}>
          <ActivityIndicator color="#5B8FFF" />
          <Text style={styles.carregandoTexto}>Rodando testes…</Text>
        </View>
      )}

      {!rodando && (
        <View style={styles.resumo}>
          <Text style={[styles.resumoTexto, falhas > 0 ? styles.resumoFalha : styles.resumoOk]}>
            {falhas === 0 ? `✓ Todos os ${total} testes passaram` : `✗ ${falhas} de ${total} testes falharam`}
          </Text>
          {duracaoMs !== null && <Text style={styles.duracao}>{duracaoMs} ms</Text>}
        </View>
      )}

      <ScrollView style={styles.lista} contentContainerStyle={{ paddingBottom: 16 }}>
        {resultados.map((r) => (
          <View key={r.nome} style={[styles.item, r.ok ? styles.itemOk : styles.itemFalha]}>
            <Text style={styles.itemIcone}>{r.ok ? '✓' : '✗'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemNome}>{r.nome}</Text>
              {!r.ok && r.detalhe && <Text style={styles.itemDetalhe}>{r.detalhe}</Text>}
            </View>
          </View>
        ))}
      </ScrollView>

      <View style={styles.rodape}>
        <Pressable style={styles.botaoSecundario} onPress={rodar} disabled={rodando}>
          <Text style={styles.botaoSecundarioTexto}>Rodar novamente</Text>
        </Pressable>
        <Pressable style={styles.botao} onPress={onFechar}>
          <Text style={styles.botaoTexto}>Fechar</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E18', padding: 20, paddingTop: 48 },
  titulo: { fontSize: 20, fontWeight: '700', color: '#C9D1E9' },
  subtitulo: { fontSize: 13, color: '#64718F', marginTop: 6, marginBottom: 16, lineHeight: 18 },
  carregando: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  carregandoTexto: { color: '#64718F' },
  resumo: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  resumoTexto: { fontSize: 15, fontWeight: '700' },
  resumoOk: { color: '#4ADE80' },
  resumoFalha: { color: '#FF6B7A' },
  duracao: { color: '#3A4661', fontSize: 12 },
  lista: { flex: 1 },
  item: {
    flexDirection: 'row', gap: 10, padding: 12, borderRadius: 8, borderWidth: 1,
    marginBottom: 8, alignItems: 'flex-start',
  },
  itemOk: { backgroundColor: '#082515', borderColor: '#123A22' },
  itemFalha: { backgroundColor: '#1F1218', borderColor: '#3A1D24' },
  itemIcone: { fontSize: 15, fontWeight: '700', color: '#C9D1E9', width: 16 },
  itemNome: { color: '#C9D1E9', fontSize: 13 },
  itemDetalhe: { color: '#FF6B7A', fontSize: 12, marginTop: 4 },
  rodape: { flexDirection: 'row', gap: 12, marginTop: 8 },
  botaoSecundario: {
    flex: 1, backgroundColor: '#1B2136', borderRadius: 8, padding: 14, alignItems: 'center',
    borderWidth: 1, borderColor: '#252D44',
  },
  botaoSecundarioTexto: { color: '#C9D1E9', fontWeight: '600' },
  botao: { flex: 1, backgroundColor: '#5B8FFF', borderRadius: 8, padding: 14, alignItems: 'center' },
  botaoTexto: { color: '#fff', fontWeight: '600' },
});
