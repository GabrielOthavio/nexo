import React, { useState } from 'react';
import { Text, TextInput, Pressable, StyleSheet, ScrollView, Alert } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { criarAchadoLocal } from '../db/operacoesRepository';
import { sincronizar } from '../services/syncService';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'NovoAchado'>;

/**
 * Formulário de captura em campo — espelha exatamente o AchadoForm do
 * Django (só o campo `descricao`; etapa e usuário são atribuídos
 * programaticamente). Salva direto no SQLite local, cifrado em repouso —
 * não há chamada de rede aqui. O registro entra na cadeia de hashes
 * imediatamente e fica pendente até a próxima sincronização bem-sucedida.
 */
export default function NovoAchadoScreen({ route, navigation }: Props) {
  const { etapaUuid, auditoriaUuid, atividade } = route.params;
  const [descricao, setDescricao] = useState('');
  const [salvando, setSalvando] = useState(false);
  // Marcação no próprio campo quando se tenta salvar vazio; some ao digitar.
  const [faltaDescricao, setFaltaDescricao] = useState(false);

  async function handleSalvar() {
    if (!descricao.trim()) {
      setFaltaDescricao(true);
      return;
    }
    setSalvando(true);
    try {
      await criarAchadoLocal({ etapaUuid, descricao }, auditoriaUuid);
      // Dispara o envio já aqui, sem esperar — se o dispositivo já estava
      // online desde antes de abrir esta tela, o listener de reconexão do
      // NetInfo (iniciarSincronizacaoAutomatica) nunca vai disparar sozinho,
      // porque não há transição de conectividade nenhuma. Sem isto, o
      // registro fica pendente indefinidamente até alguém tocar em
      // "Sincronizar" manualmente na tela de Achados.
      sincronizar().catch(() => {});
      navigation.goBack();
      // Mesma distinção da interface toda: salvo no aparelho ≠ aceito pelo
      // servidor. Sem este aviso, voltar à tela anterior em silêncio deixava o
      // auditor supor que o achado já estava no sistema.
      Alert.alert(
        'Achado salvo no aparelho',
        'O achado foi gravado neste aparelho e aparece como "Pendente" até o servidor ' +
        'confirmar o recebimento. O envio acontece assim que houver conexão.'
      );
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      Alert.alert('Erro ao salvar', `Não foi possível salvar o achado localmente: ${mensagem}`);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.label}>Etapa</Text>
      <Text style={styles.etapa}>{atividade}</Text>

      <Text style={styles.label}>
        Descrição do achado<Text style={styles.req}> *</Text>
      </Text>
      <TextInput
        style={[styles.input, styles.textarea, faltaDescricao && styles.inputErro]}
        value={descricao}
        onChangeText={(v) => {
          setDescricao(v);
          if (faltaDescricao) setFaltaDescricao(false);
        }}
        multiline
        placeholder="Descreva o achado constatado em campo…"
        placeholderTextColor="#64718F"
        autoFocus
      />
      {faltaDescricao && <Text style={styles.erroCampo}>Obrigatório — descreva o achado antes de salvar.</Text>}

      <Pressable style={styles.botao} onPress={handleSalvar} disabled={salvando}>
        <Text style={styles.botaoTexto}>{salvando ? 'Salvando…' : 'Salvar'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E18' },
  label: { color: '#64718F', fontSize: 12, textTransform: 'uppercase', marginBottom: 6, marginTop: 16 },
  etapa: { color: '#C9D1E9', fontSize: 15, fontWeight: '600' },
  req: { color: '#FF6B7A' },
  input: {
    backgroundColor: '#131725', borderColor: '#252D44', borderWidth: 1,
    borderRadius: 8, padding: 12, color: '#C9D1E9',
  },
  inputErro: { borderColor: '#FF6B7A' },
  erroCampo: { color: '#FF6B7A', fontSize: 11, marginTop: 4 },
  textarea: { minHeight: 140, textAlignVertical: 'top' },
  botao: { backgroundColor: '#5B8FFF', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 24, marginBottom: 40 },
  botaoTexto: { color: '#fff', fontWeight: '700' },
});
