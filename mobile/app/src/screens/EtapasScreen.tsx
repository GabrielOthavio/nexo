import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { listarEtapasCache, contarAchadosPendentesDaEtapa } from '../db/auditoriasRepository';
import { excluirEtapaLocal, abandonarOperacao, obterTipoOperacao } from '../db/operacoesRepository';
import { sincronizarEtapas, sincronizar } from '../services/syncService';
import { EtapaCache } from '../models/Achado';
import { formatarData, rotuloSituacaoEtapa } from '../models/rotulos';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Etapas'>;

/** Etapas da auditoria selecionada — puxadas sob demanda ao entrar aqui (ou reaproveitadas do cache local se offline). */
export default function EtapasScreen({ route, navigation }: Props) {
  const { auditoriaUuid, nomeAuditoria } = route.params;
  const [etapas, setEtapas] = useState<EtapaCache[]>([]);
  const [atualizando, setAtualizando] = useState(false);
  const [excluindo, setExcluindo] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);

  const carregar = useCallback(async () => {
    setAtualizando(true);
    try {
      try {
        await sincronizarEtapas(auditoriaUuid);
      } catch {
        // Offline — segue com o que já estiver salvo localmente.
      }
      setEtapas(await listarEtapasCache(auditoriaUuid));
    } catch (erro) {
      // Ler o cache local só falha por problema no próprio banco do aparelho
      // (ver Alert equivalente em handleSincronizar) — sem este catch, a
      // rejeição ficava sem tratamento e a tela apenas parava de atualizar,
      // sem nada indicando que algo deu errado.
      console.warn('[etapas] falha ao ler os dados locais:', erro);
      Alert.alert(
        'Falha ao ler os dados locais',
        'Não foi possível carregar as etapas guardadas neste aparelho. Os dados locais podem ' +
        'estar corrompidos ou ter sido adulterados. Não descarte nada e procure a Controladoria ' +
        'antes de continuar registrando em campo.'
      );
    } finally {
      setAtualizando(false);
    }
  }, [auditoriaUuid]);

  useFocusEffect(
    useCallback(() => {
      carregar();
    }, [carregar])
  );

  async function handleSincronizar() {
    setSincronizando(true);
    try {
      const resultado = await sincronizar();
      if (resultado.cadeiaCorrompida) {
        const onde = resultado.indiceCorrompido !== null
          ? `a partir do item ${resultado.indiceCorrompido}`
          : 'e não foi possível nem lê-la por inteiro';
        Alert.alert(
          'Integridade comprometida',
          `A cadeia local de registros está corrompida ${onde}. ` +
          'A sincronização foi bloqueada para não propagar dados adulterados.'
        );
      } else if (resultado.paradoEm) {
        // O lote parou num item. `definitivo` separa os dois casos que chegam
        // aqui: uma RECUSA do servidor (4xx, cadeia inválida) vai parar sempre
        // no mesmo ponto e prende tudo que está atrás na fila — só nesse caso
        // a saída destrutiva de descartar é oferecida. Uma falha de
        // infraestrutura (5xx, servidor sem alcançar o Django, sincronização
        // concorrente) não recusou nada: oferecer descarte ali empurraria o
        // auditor a apagar em campo um registro perfeitamente válido.
        const parado = resultado.paradoEm;
        const botoes = parado.definitivo
          ? [
              { text: 'OK', style: 'cancel' as const },
              {
                text: 'Descartar item',
                style: 'destructive' as const,
                onPress: () => { handleDescartar(parado.uuid); },
              },
            ]
          : [{ text: 'OK', style: 'cancel' as const }];
        const fecho = parado.definitivo
          ? 'os demais continuam pendentes e serão reenviados na próxima tentativa.'
          : 'a falha não parece definitiva — os registros continuam guardados e serão tentados novamente.';
        Alert.alert(
          'Sincronização parcial',
          `${resultado.enviados} registro(s) confirmado(s). A sincronização parou em um item ` +
          `(${parado.motivo}) — ${fecho}`,
          botoes
        );
      } else if (resultado.enviados > 0 && resultado.falhas > 0) {
        // Sucesso parcial entre lotes (ex.: o primeiro lote subiu inteiro e o
        // seguinte caiu na rede). Reportar só a falha, como antes, apagava da
        // vista tudo que DE FATO foi enviado — e levava o auditor a achar que
        // nada tinha saído do aparelho.
        const nota = resultado.filaGrande
          ? ' A fila pendente estava grande e foi dividida em múltiplos envios.'
          : '';
        Alert.alert(
          'Sincronização parcial',
          `${resultado.enviados} registro(s) enviado(s) com sucesso, mas ${resultado.falhas} não ` +
          `puderam ser enviados — continuam guardados no aparelho e serão tentados novamente.${nota}`
        );
      } else if (resultado.falhas > 0) {
        Alert.alert('Falha na sincronização', 'Não foi possível enviar os registros pendentes. Tente novamente.');
      } else if (resultado.enviados > 0) {
        const nota = resultado.filaGrande
          ? ' A fila pendente estava grande e foi dividida em múltiplos envios — pode levar mais de uma sincronização para esvaziar.'
          : '';
        Alert.alert('Sincronizado', `${resultado.enviados} registro(s) enviado(s) com sucesso.${nota}`);
      } else if (resultado.conflitos > 0) {
        // Sem este branch, um conflito sozinho (enviados=0, falhas=0, paradoEm=null)
        // caía no "Nada a sincronizar" abaixo — escondendo do auditor que uma
        // edição sua foi REVERTIDA localmente porque alguém mudou a mesma etapa
        // no web nesse meio-tempo (ver marcarOperacaoComoConflito).
        Alert.alert(
          'Edição em conflito',
          `${resultado.conflitos} etapa(s) foram alteradas no sistema web ao mesmo tempo em que você ` +
          'editava offline. Sua edição local foi desfeita e a tela mostra agora a versão do servidor. ' +
          'Revise e refaça a alteração se ainda for necessária.'
        );
      } else if (resultado.semConexao) {
        // Antes, sem rede e sem rede-com-fila-vazia caíam na mesma mensagem
        // ("não há registros pendentes ou não há conexão"): com achados
        // esperando no aparelho, o auditor lia que não havia nada a enviar.
        Alert.alert(
          'Sem conexão',
          'Não há conexão com o servidor agora. Os registros pendentes continuam guardados ' +
          'neste aparelho e serão enviados automaticamente quando a conexão voltar.'
        );
      } else {
        Alert.alert('Nada a sincronizar', 'Não há registros pendentes neste aparelho.');
      }
    } catch (erro) {
      // A fila local é lida com verificação de HMAC linha a linha: uma linha
      // que não decifra derruba a leitura inteira, e sem este catch isso virava
      // uma rejeição não tratada — o indicador de "Sincronizando…" sumia e mais
      // nada acontecia, sem qualquer sinal para o auditor. Não é um "tente de
      // novo": HMAC que não bate significa dado local alterado fora do app.
      console.warn('[etapas] falha ao sincronizar:', erro);
      Alert.alert(
        'Falha ao ler os registros locais',
        'Não foi possível ler a fila de registros guardada neste aparelho, então nada foi ' +
        'enviado. Isso indica que os dados locais estão corrompidos ou foram adulterados. ' +
        'Não descarte nada e procure a Controladoria antes de continuar registrando em campo.'
      );
    } finally {
      setSincronizando(false);
      try {
        setEtapas(await listarEtapasCache(auditoriaUuid));
      } catch (erro) {
        console.warn('[etapas] falha ao recarregar o cache local:', erro);
      }
    }
  }

  /**
   * Descarta em definitivo a operação que travou a fila. Destrutivo: a
   * mudança capturada em campo é perdida e o estado local otimista que ela
   * criou é revertido (ver abandonarOperacao) — uma criação some da lista,
   * uma edição volta ao valor anterior, uma exclusão é desfeita.
   *
   * Caso especial de `etapa_criar`: descartar a criação de uma Etapa que nunca
   * chegou ao servidor deixa ÓRFÃ toda operação já enfileirada contra ela (um
   * achado registrado nessa etapa aponta para um uuid temporário que agora não
   * vai resolver nunca — o Django devolverá 404 em cada tentativa). O descarte
   * NÃO é bloqueado nem propagado em cascata (apagar achados que o auditor não
   * escolheu descartar seria pior), mas o aviso precisa ser explícito, senão o
   * auditor só descobre item a item, cada um pelo mesmo fluxo destrutivo.
   */
  async function handleDescartar(operacaoUuid: string) {
    let avisoDependentes = '';
    try {
      if ((await obterTipoOperacao(operacaoUuid)) === 'etapa_criar') {
        // Para etapa_criar o uuid da operação É o uuid temporário da Etapa no
        // cache local (ver criarEtapaLocal), então serve direto de alvo aqui.
        const dependentes = await contarAchadosPendentesDaEtapa(operacaoUuid);
        if (dependentes > 0) {
          avisoDependentes =
            `\n\nATENÇÃO: ${dependentes} achado(s) ainda não sincronizado(s) foram registrados ` +
            'nesta etapa. Como a etapa nunca chegará ao sistema, esses achados também não terão ' +
            'como ser enviados e ficarão presos — cada um precisará ser descartado ' +
            'individualmente na tela de achados.';
        }
      }
    } catch (erro) {
      // Não impede o descarte — é só o texto do aviso que fica menos completo.
      console.warn('[etapas] falha ao apurar dependências da operação descartada:', erro);
    }

    Alert.alert(
      'Descartar alteração',
      'Esta alteração foi recusada pelo servidor e não pode ser enviada. Descartá-la ' +
      'DESFAZ a mudança feita em campo em definitivo — ela não será recuperável nem ' +
      'chegará ao sistema. Em compensação, os registros presos atrás dela na fila ' +
      'voltam a sincronizar. Deseja continuar?' + avisoDependentes,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Descartar',
          style: 'destructive',
          onPress: async () => {
            try {
              await abandonarOperacao(operacaoUuid);
              // Duas chamadas de propósito: `sincronizar()` devolve a execução
              // JÁ em andamento, se houver — e essa leu a fila ANTES do
              // descarte, então não reflete nada disto. A primeira só espera
              // essa execução antiga terminar (quando termina, a guarda de
              // concorrência é liberada); a segunda é garantidamente uma
              // execução nova, lendo a fila já destravada.
              await sincronizar().catch(() => {});
              sincronizar().catch(() => {});
              setEtapas(await listarEtapasCache(auditoriaUuid));
            } catch {
              Alert.alert('Erro', 'Não foi possível descartar a alteração.');
            }
          },
        },
      ]
    );
  }

  async function handleExcluir(etapa: EtapaCache) {
    const pendentes = await contarAchadosPendentesDaEtapa(etapa.uuid);
    const aviso = pendentes > 0
      ? `Esta etapa tem ${pendentes} achado(s) ainda não sincronizado(s) que serão perdidos ao excluir. Continuar?`
      : 'Tem certeza que deseja excluir esta etapa?';

    Alert.alert('Excluir etapa', aviso, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: async () => {
          setExcluindo(etapa.uuid);
          try {
            await excluirEtapaLocal(etapa.uuid);
            // Ver comentário em NovoAchadoScreen/EtapaFormScreen: dispara o
            // envio já aqui, não dá pra contar só com o listener de
            // reconexão do NetInfo.
            sincronizar().catch(() => {});
            setEtapas(await listarEtapasCache(auditoriaUuid));
          } catch {
            Alert.alert('Erro', 'Não foi possível excluir a etapa localmente.');
          } finally {
            setExcluindo(null);
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.titulo} numberOfLines={1}>{nomeAuditoria}</Text>
        <View style={styles.acoesHeader}>
          <Pressable onPress={() => navigation.navigate('Achados', { auditoriaUuid, nomeAuditoria })}>
            <Text style={styles.link}>Ver achados</Text>
          </Pressable>
          <Pressable style={styles.botaoSync} onPress={handleSincronizar} disabled={sincronizando}>
            <Text style={styles.botaoSyncTexto}>{sincronizando ? 'Sincronizando…' : 'Sincronizar'}</Text>
          </Pressable>
        </View>
      </View>

      <Pressable
        style={styles.botaoAdicionar}
        onPress={() => navigation.navigate('EtapaForm', { auditoriaUuid })}
      >
        <Text style={styles.botaoAdicionarTexto}>+ Adicionar etapa</Text>
      </Pressable>

      <FlatList
        data={etapas}
        keyExtractor={(item) => item.uuid}
        refreshControl={<RefreshControl refreshing={atualizando} onRefresh={carregar} />}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Pressable
              onPress={() => navigation.navigate('NovoAchado', {
                etapaUuid: item.uuid,
                auditoriaUuid,
                atividade: item.atividade,
              })}
            >
              <Text style={styles.cardTitulo}>{item.atividade}</Text>
              {item.prazo && <Text style={styles.cardTexto}>Prazo: {formatarData(item.prazo)}</Text>}
              <View style={styles.badgesLinha}>
                <Text style={styles.badge}>{rotuloSituacaoEtapa(item.situacao)}</Text>
                {item.pendente && <Text style={styles.badgePendente}>Pendente de sincronização</Text>}
              </View>
            </Pressable>
            <View style={styles.acoesLinha}>
              <Pressable
                style={styles.botaoAcao}
                onPress={() => navigation.navigate('EtapaForm', { auditoriaUuid, etapaUuid: item.uuid })}
              >
                <Text style={styles.botaoAcaoTexto}>Editar</Text>
              </Pressable>
              <Pressable
                style={styles.botaoAcao}
                onPress={() => handleExcluir(item)}
                disabled={excluindo === item.uuid}
              >
                <Text style={styles.botaoAcaoTextoExcluir}>
                  {excluindo === item.uuid ? 'Excluindo…' : 'Excluir'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.vazio}>Nenhuma etapa cadastrada para esta auditoria.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E18' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingBottom: 0 },
  titulo: { fontSize: 16, fontWeight: '700', color: '#C9D1E9', flexShrink: 1 },
  link: { color: '#5B8FFF', fontSize: 13, fontWeight: '600' },
  acoesHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  botaoSync: { backgroundColor: '#1B2136', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: '#252D44' },
  botaoSyncTexto: { color: '#5B8FFF', fontSize: 12, fontWeight: '600' },
  botaoAdicionar: {
    marginHorizontal: 16, marginTop: 12, backgroundColor: '#1B2136', borderRadius: 8,
    paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: '#252D44',
  },
  botaoAdicionarTexto: { color: '#5B8FFF', fontWeight: '600', fontSize: 13 },
  card: { backgroundColor: '#131725', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#252D44' },
  cardTitulo: { color: '#C9D1E9', fontWeight: '600', marginBottom: 4 },
  cardTexto: { color: '#64718F', fontSize: 13, marginBottom: 8 },
  badgesLinha: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  badge: {
    alignSelf: 'flex-start', fontSize: 10, fontWeight: '700', paddingVertical: 2, paddingHorizontal: 8,
    borderRadius: 4, color: '#FBBF24', backgroundColor: '#261F00',
  },
  badgePendente: {
    alignSelf: 'flex-start', fontSize: 10, fontWeight: '700', paddingVertical: 2, paddingHorizontal: 8,
    borderRadius: 4, color: '#5B8FFF', backgroundColor: '#131A2E',
  },
  acoesLinha: { flexDirection: 'row', gap: 12, marginTop: 10, borderTopWidth: 1, borderTopColor: '#252D44', paddingTop: 10 },
  botaoAcao: { flex: 1, alignItems: 'center', paddingVertical: 6 },
  botaoAcaoTexto: { color: '#5B8FFF', fontSize: 12, fontWeight: '600' },
  botaoAcaoTextoExcluir: { color: '#FF6B7A', fontSize: 12, fontWeight: '600' },
  vazio: { color: '#64718F', textAlign: 'center', marginTop: 40 },
});
