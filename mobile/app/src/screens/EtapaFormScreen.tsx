import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Alert, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { criarEtapaLocal, editarEtapaLocal } from '../db/operacoesRepository';
import { obterEtapaCache } from '../db/auditoriasRepository';
import { sincronizar } from '../services/syncService';
import { CamposEtapa } from '../models/Achado';
import type { RootStackParamList } from '../navigation';
import { SITUACOES_ETAPA as SITUACOES } from '../models/rotulos';

type Props = NativeStackScreenProps<RootStackParamList, 'EtapaForm'>;

const CAMPOS_VAZIOS: CamposEtapa = {
  orientacao: '',
  documentos: '',
  atividade: '',
  prazo: null,
  situacao: 'PENDENTE',
  metodo: '',
};

type CampoObrigatorio = 'orientacao' | 'atividade' | 'prazo';

/** Rótulo de campo; `obrigatorio` acrescenta o asterisco — o mesmo `.req` do formulário web. */
function Rotulo({ texto, obrigatorio }: { texto: string; obrigatorio?: boolean }) {
  return (
    <Text style={styles.label}>
      {texto}
      {obrigatorio && <Text style={styles.req}> *</Text>}
    </Text>
  );
}

/**
 * Formulário de criar/editar Etapa em campo — espelha o EtapaForm do
 * Django (orientacao, documentos, atividade, prazo, situacao, metodo), com
 * uma omissão deliberada: sem seletor de "responsável" (Etapa.usuario).
 * O responsável é sempre o próprio auditor logado — construir um seletor
 * offline exigiria cachear uma lista separada de usuários candidatos,
 * escopo extra desproporcional ao pedido (ver plano de integração fase 2).
 * Salva local, sem chamada de rede — sincroniza depois, como o Achado.
 */
export default function EtapaFormScreen({ route, navigation }: Props) {
  const { auditoriaUuid, etapaUuid } = route.params;
  const modoEdicao = !!etapaUuid;

  const [campos, setCampos] = useState<CamposEtapa>(CAMPOS_VAZIOS);
  const [mostrarDatePicker, setMostrarDatePicker] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [carregando, setCarregando] = useState(modoEdicao);
  // Campos obrigatórios que estavam vazios na última tentativa de salvar.
  // Marcados no próprio campo (borda + "Obrigatório") e limpos ao digitar —
  // o Alert de antes dizia só "preencha orientação, atividade e prazo",
  // sem apontar qual dos três faltava.
  const [erros, setErros] = useState<Set<CampoObrigatorio>>(new Set());

  useEffect(() => {
    if (!etapaUuid) return;
    (async () => {
      const etapa = await obterEtapaCache(etapaUuid);
      if (etapa) {
        setCampos({
          orientacao: etapa.orientacao,
          documentos: etapa.documentos,
          atividade: etapa.atividade,
          prazo: etapa.prazo,
          situacao: etapa.situacao,
          metodo: etapa.metodo,
        });
      }
      setCarregando(false);
    })();
  }, [etapaUuid]);

  function atualizarCampo<K extends keyof CamposEtapa>(campo: K, valor: CamposEtapa[K]) {
    setCampos((atual) => ({ ...atual, [campo]: valor }));
    if (erros.has(campo as CampoObrigatorio)) {
      setErros((atual) => {
        const proximo = new Set(atual);
        proximo.delete(campo as CampoObrigatorio);
        return proximo;
      });
    }
  }

  async function handleSalvar() {
    const faltando = new Set<CampoObrigatorio>();
    if (!campos.orientacao.trim()) faltando.add('orientacao');
    if (!campos.atividade.trim()) faltando.add('atividade');
    if (!campos.prazo) faltando.add('prazo');
    if (faltando.size > 0) {
      setErros(faltando);
      return;
    }
    setSalvando(true);
    try {
      if (modoEdicao && etapaUuid) {
        await editarEtapaLocal(etapaUuid, campos);
      } else {
        await criarEtapaLocal(campos, auditoriaUuid);
      }
      // Ver comentário equivalente em NovoAchadoScreen: dispara o envio já
      // aqui porque o auto-sync só reage a uma MUDANÇA de conectividade, não
      // ao fato de já estar online.
      sincronizar().catch(() => {});
      navigation.goBack();
      // Gravar no aparelho não é registrar no sistema: o auditor precisa saber
      // que a etapa só passa a existir para os demais depois que o servidor
      // aceitar o envio (até lá ela aparece com a etiqueta de pendente).
      Alert.alert(
        'Etapa salva no aparelho',
        'A etapa foi gravada neste aparelho e aparece como "Pendente de sincronização" ' +
        'até o servidor confirmar o recebimento. O envio acontece assim que houver conexão.'
      );
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      Alert.alert('Erro ao salvar', `Não foi possível salvar a etapa localmente: ${mensagem}`);
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) {
    return (
      <View style={styles.container}>
        <Text style={styles.label}>Carregando…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.legenda}><Text style={styles.req}>*</Text> campo obrigatório</Text>

      <Rotulo texto="Orientação" obrigatorio />
      <TextInput
        style={[styles.input, styles.textarea, erros.has('orientacao') && styles.inputErro]}
        value={campos.orientacao}
        onChangeText={(v) => atualizarCampo('orientacao', v)}
        multiline
        placeholder="Instruções ou orientações para execução desta etapa…"
        placeholderTextColor="#64718F"
      />
      {erros.has('orientacao') && <Text style={styles.erroCampo}>Obrigatório</Text>}

      <Rotulo texto="Documentos" />
      <TextInput
        style={[styles.input, styles.textarea]}
        value={campos.documentos}
        onChangeText={(v) => atualizarCampo('documentos', v)}
        multiline
        placeholder="Documentos a serem analisados ou solicitados…"
        placeholderTextColor="#64718F"
      />

      <Rotulo texto="Atividade" obrigatorio />
      <TextInput
        style={[styles.input, erros.has('atividade') && styles.inputErro]}
        value={campos.atividade}
        onChangeText={(v) => atualizarCampo('atividade', v)}
        placeholder="Descreva a atividade a ser executada…"
        placeholderTextColor="#64718F"
      />
      {erros.has('atividade') && <Text style={styles.erroCampo}>Obrigatório</Text>}

      <Rotulo texto="Prazo" obrigatorio />
      <Pressable
        style={[styles.input, erros.has('prazo') && styles.inputErro]}
        onPress={() => setMostrarDatePicker(true)}
      >
        <Text style={{ color: campos.prazo ? '#C9D1E9' : '#64718F' }}>
          {campos.prazo ?? 'Selecionar data…'}
        </Text>
      </Pressable>
      {erros.has('prazo') && <Text style={styles.erroCampo}>Obrigatório</Text>}
      {mostrarDatePicker && (
        <DateTimePicker
          value={campos.prazo ? new Date(`${campos.prazo}T00:00:00`) : new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(_evento, data) => {
            setMostrarDatePicker(Platform.OS === 'ios');
            if (data) {
              // Formata com os componentes LOCAIS da data — toISOString()
              // converteria para UTC e mudaria o dia perto da meia-noite.
              const iso = [
                data.getFullYear(),
                String(data.getMonth() + 1).padStart(2, '0'),
                String(data.getDate()).padStart(2, '0'),
              ].join('-');
              atualizarCampo('prazo', iso);
            }
          }}
        />
      )}

      <Rotulo texto="Situação" />
      <View style={styles.input}>
        <Picker
          selectedValue={campos.situacao}
          onValueChange={(v) => atualizarCampo('situacao', v)}
          style={{ color: '#C9D1E9' }}
          dropdownIconColor="#C9D1E9"
        >
          {SITUACOES.map((s) => (
            <Picker.Item key={s.valor} label={s.rotulo} value={s.valor} />
          ))}
        </Picker>
      </View>

      <Rotulo texto="Método" />
      <TextInput
        style={styles.input}
        value={campos.metodo}
        onChangeText={(v) => atualizarCampo('metodo', v)}
        placeholder="Ex: Análise documental, Entrevista, Observação direta…"
        placeholderTextColor="#64718F"
      />

      <Pressable style={styles.botao} onPress={handleSalvar} disabled={salvando}>
        <Text style={styles.botaoTexto}>{salvando ? 'Salvando…' : 'Salvar'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E18' },
  label: { color: '#64718F', fontSize: 12, textTransform: 'uppercase', marginBottom: 6, marginTop: 16 },
  legenda: { color: '#64718F', fontSize: 11 },
  req: { color: '#FF6B7A' },
  input: {
    backgroundColor: '#131725', borderColor: '#252D44', borderWidth: 1,
    borderRadius: 8, padding: 12, color: '#C9D1E9', justifyContent: 'center',
  },
  inputErro: { borderColor: '#FF6B7A' },
  erroCampo: { color: '#FF6B7A', fontSize: 11, marginTop: 4 },
  textarea: { minHeight: 90, textAlignVertical: 'top' },
  botao: { backgroundColor: '#5B8FFF', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 24, marginBottom: 40 },
  botaoTexto: { color: '#fff', fontWeight: '700' },
});
