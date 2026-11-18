import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { listarAuditoriasCache, definirAuditoriaSelecionada } from '../db/auditoriasRepository';
import { sincronizarAuditorias, sincronizarEtapas } from '../services/syncService';
import { AuditoriaCache } from '../models/Achado';
import { rotuloStatusAuditoria } from '../models/rotulos';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'SelecionarAuditoria'>;

/**
 * Tela pós-login: o auditor escolhe qual Auditoria vai trabalhar em campo.
 * Só a LISTA leve (sem etapas) é puxada aqui — as etapas da auditoria
 * escolhida só são buscadas depois da seleção (ver sincronizarEtapas), para
 * não inchar o banco offline do celular com dados de auditorias que o
 * auditor não vai atender agora.
 */
export default function SelecionarAuditoriaScreen({ navigation }: Props) {
  const { sair } = useAuth();
  const [auditorias, setAuditorias] = useState<AuditoriaCache[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [selecionando, setSelecionando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const dados = await sincronizarAuditorias();
      setAuditorias(dados);
    } catch {
      const dadosCache = await listarAuditoriasCache();
      setAuditorias(dadosCache);
      if (dadosCache.length === 0) {
        setErro('Sem conexão e sem auditorias em cache. Conecte-se ao menos uma vez para listar as auditorias.');
      }
    } finally {
      setCarregando(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      carregar();
    }, [carregar])
  );

  async function selecionar(auditoria: AuditoriaCache) {
    setSelecionando(auditoria.uuid);
    try {
      try {
        await sincronizarEtapas(auditoria.uuid);
      } catch {
        // Sem conexão para puxar as etapas agora — segue com o que já estiver em cache local, se houver.
      }
      await definirAuditoriaSelecionada(auditoria.uuid);
      navigation.navigate('Etapas', { auditoriaUuid: auditoria.uuid, nomeAuditoria: auditoria.nomeAuditoria });
    } finally {
      setSelecionando(null);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.titulo}>Selecione a auditoria</Text>
        <Pressable onPress={sair}><Text style={styles.sair}>Sair</Text></Pressable>
      </View>

      {carregando && auditorias.length === 0 ? (
        <ActivityIndicator color="#5B8FFF" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={auditorias}
          keyExtractor={(item) => item.uuid}
          refreshControl={<RefreshControl refreshing={carregando} onRefresh={carregar} />}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => selecionar(item)}
              disabled={selecionando !== null}
            >
              <Text style={styles.cardTitulo}>{item.nomeAuditoria}</Text>
              {item.orgao && <Text style={styles.cardTexto}>{item.orgao}</Text>}
              <Text style={styles.badge}>{rotuloStatusAuditoria(item.status)}</Text>
              {selecionando === item.uuid && <ActivityIndicator color="#5B8FFF" style={{ marginTop: 8 }} />}
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.vazio}>{erro ?? 'Nenhuma auditoria em andamento para você.'}</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E18' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  titulo: { fontSize: 18, fontWeight: '700', color: '#C9D1E9' },
  sair: { color: '#FF6B7A', fontSize: 13 },
  card: { backgroundColor: '#131725', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#252D44' },
  cardTitulo: { color: '#C9D1E9', fontWeight: '600', marginBottom: 4 },
  cardTexto: { color: '#64718F', fontSize: 13, marginBottom: 8 },
  badge: {
    alignSelf: 'flex-start', fontSize: 10, fontWeight: '700', paddingVertical: 2, paddingHorizontal: 8,
    borderRadius: 4, color: '#5B8FFF', backgroundColor: '#131A2E',
  },
  vazio: { color: '#64718F', textAlign: 'center', marginTop: 40, paddingHorizontal: 24 },
});
