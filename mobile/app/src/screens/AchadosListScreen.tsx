import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { listarAchadosLocais, abandonarOperacao } from '../db/operacoesRepository';
import { sincronizar } from '../services/syncService';
import { AchadoLocal } from '../models/Achado';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Achados'>;

export default function AchadosListScreen({ route }: Props) {
  const { auditoriaUuid, nomeAuditoria } = route.params;
  const [achados, setAchados] = useState<AchadoLocal[]>([]);
  const [descartando, setDescartando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const dados = await listarAchadosLocais(false, auditoriaUuid);
      setAchados(dados.reverse());
    } catch (erro) {
      // Cada linha é decifrada com verificação de HMAC: uma única linha que não
      // confere derruba a leitura inteira. Sem este catch a rejeição ficava sem
      // tratamento e a lista simplesmente não aparecia, sem nenhum aviso — e um
      // HMAC que não bate não é um contratempo qualquer, é o sinal de que o
      // conteúdo local foi alterado fora do app.
      console.warn('[achados] falha ao ler os registros locais:', erro);
      Alert.alert(
        'Falha ao ler os registros locais',
        'Não foi possível ler os achados guardados neste aparelho. Isso indica que os dados ' +
        'locais estão corrompidos ou foram adulterados. Não descarte nada e procure a ' +
        'Controladoria antes de continuar registrando em campo.'
      );
    }
  }, [auditoriaUuid]);

  useFocusEffect(
    useCallback(() => {
      carregar();
    }, [carregar])
  );

  /**
   * Saída para um achado rejeitado em definitivo pelo servidor: enquanto ele
   * fica na fila, TODOS os registros enfileirados atrás dele também param de
   * sincronizar. Descartar é destrutivo (o achado nunca chegará ao sistema) —
   * daí a confirmação explícita. Só é oferecido quando a recusa foi do próprio
   * servidor (`erroDefinitivo`); uma falha de conexão não recusou nada e se
   * resolve sozinha no próximo envio.
   */
  function handleDescartar(achado: AchadoLocal) {
    Alert.alert(
      'Descartar registro',
      'Este achado foi recusado pelo servidor e não pode ser enviado. Descartá-lo ' +
      'APAGA a descrição registrada em campo em definitivo — ela não será recuperável ' +
      'nem aparecerá no sistema. Em compensação, os registros presos atrás dele na ' +
      'fila voltam a sincronizar. Deseja continuar?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Descartar',
          style: 'destructive',
          onPress: async () => {
            setDescartando(achado.uuid);
            try {
              await abandonarOperacao(achado.uuid);
              // Duas chamadas de propósito: `sincronizar()` devolve a execução
              // JÁ em andamento, se houver — e essa leu a fila ANTES do
              // descarte, então não reflete nada disto. A primeira só espera
              // essa execução antiga terminar (quando termina, a guarda de
              // concorrência é liberada); a segunda é garantidamente uma
              // execução nova, lendo a fila já destravada.
              await sincronizar().catch(() => {});
              sincronizar().catch(() => {});
              await carregar();
            } catch {
              Alert.alert('Erro', 'Não foi possível descartar o registro.');
            } finally {
              setDescartando(null);
            }
          },
        },
      ]
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.titulo} numberOfLines={1}>{nomeAuditoria}</Text>
      </View>

      <FlatList
        data={achados}
        keyExtractor={(item) => item.uuid}
        refreshControl={<RefreshControl refreshing={false} onRefresh={carregar} />}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardTexto} numberOfLines={3}>{item.descricao}</Text>
            {/* `abandonada` é testada ANTES de `sincronizado`: uma operação
                descartada também termina com `sincronizado = 1` (é assim que
                ela sai da fila depois que o servidor reconhece o elo dela sem
                aplicar nada — ver marcarOperacaoComoAbandonadaConfirmada), e
                exibi-la como "Sincronizado" diria ao auditor exatamente o
                oposto do que aconteceu com o registro. */}
            <Text
              style={[
                styles.badge,
                item.abandonada
                  ? styles.badgeDescartado
                  : item.sincronizado
                    ? styles.badgeOk
                    : styles.badgePendente,
              ]}
            >
              {item.abandonada ? 'Descartado' : item.sincronizado ? 'Sincronizado' : 'Pendente'}
            </Text>
            {item.erroSincronizacao && !item.sincronizado && (
              <Text style={styles.erro} numberOfLines={2}>
                {item.erroDefinitivo
                  ? item.erroSincronizacao
                  : `Ainda não enviado (${item.erroSincronizacao}). Será tentado novamente.`}
              </Text>
            )}
            {/* Só uma recusa DO SERVIDOR (erroDefinitivo) justifica o descarte:
                reenviar depois de uma falha de conexão costuma resolver, e
                oferecer aqui um botão destrutivo afirmando que o servidor
                recusou seria falso — além de empurrar o auditor a apagar em
                campo registros que nunca foram rejeitados. */}
            {item.erroDefinitivo && !item.sincronizado && !item.abandonada && (
              <Pressable
                style={styles.botaoDescartar}
                onPress={() => handleDescartar(item)}
                disabled={descartando === item.uuid}
              >
                <Text style={styles.botaoDescartarTexto}>
                  {descartando === item.uuid ? 'Descartando…' : 'Descartar registro'}
                </Text>
              </Pressable>
            )}
          </View>
        )}
        ListEmptyComponent={<Text style={styles.vazio}>Nenhum achado registrado ainda para esta auditoria.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E18' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, gap: 8 },
  titulo: { fontSize: 16, fontWeight: '700', color: '#C9D1E9', flexShrink: 1 },
  card: { backgroundColor: '#131725', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#252D44' },
  cardTexto: { color: '#C9D1E9', fontSize: 13, marginBottom: 8 },
  badge: { alignSelf: 'flex-start', fontSize: 10, fontWeight: '700', paddingVertical: 2, paddingHorizontal: 8, borderRadius: 4 },
  badgeOk: { color: '#4ADE80', backgroundColor: '#082515' },
  badgePendente: { color: '#FBBF24', backgroundColor: '#261F00' },
  badgeDescartado: { color: '#64718F', backgroundColor: '#1B2136' },
  erro: { color: '#FF6B7A', fontSize: 11, marginTop: 6 },
  botaoDescartar: {
    alignSelf: 'flex-start', marginTop: 8, paddingVertical: 6, paddingHorizontal: 10,
    borderRadius: 6, borderWidth: 1, borderColor: '#3A1D24', backgroundColor: '#1F1218',
  },
  botaoDescartarTexto: { color: '#FF6B7A', fontSize: 12, fontWeight: '600' },
  vazio: { color: '#64718F', textAlign: 'center', marginTop: 40 },
});
