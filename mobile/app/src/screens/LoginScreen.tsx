import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { isAxiosError } from 'axios';
import { useAuth } from '../context/AuthContext';
import { SYNC_API_URL } from '../services/api';
import DiagnosticoScreen from './DiagnosticoScreen';

export default function LoginScreen() {
  const { entrar, carregando } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [mostrarDiagnostico, setMostrarDiagnostico] = useState(false);

  if (mostrarDiagnostico) {
    return <DiagnosticoScreen onFechar={() => setMostrarDiagnostico(false)} />;
  }

  async function handleEntrar() {
    setErro(null);
    try {
      await entrar(username.trim(), password.trim());
    } catch (e) {
      console.error('Erro no login:', e);
      if (isAxiosError(e) && e.response?.status === 401) {
        setErro('Usuário ou senha inválidos.');
      } else if (isAxiosError(e) && !e.response) {
        // Sem resposta do servidor = falha de rede/conexão, não credenciais erradas
        // (URL errada, backend fora do ar, celular fora da mesma rede Wi-Fi).
        setErro('Não foi possível conectar ao servidor. Verifique a conexão e se o backend está no ar.');
      } else {
        const detalhe = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        setErro(`Erro inesperado ao entrar: ${detalhe}`);
      }
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.titulo}>Controladoria — Campo</Text>
      <Text style={styles.subtitulo}>Entre para registrar ações mesmo sem conexão.</Text>

      <TextInput
        style={styles.input}
        placeholder="Usuário"
        placeholderTextColor="#64718F"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        textContentType="username"
        value={username}
        onChangeText={setUsername}
      />
      <TextInput
        style={styles.input}
        placeholder="Senha"
        placeholderTextColor="#64718F"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="password"
        textContentType="password"
        value={password}
        onChangeText={setPassword}
      />

      {erro && <Text style={styles.erro}>{erro}</Text>}

      <Pressable style={styles.botao} onPress={handleEntrar} disabled={carregando}>
        {carregando ? <ActivityIndicator color="#fff" /> : <Text style={styles.botaoTexto}>Entrar</Text>}
      </Pressable>

      <Text style={styles.debugUrl}>Servidor: {SYNC_API_URL}</Text>
      <Pressable onPress={() => setMostrarDiagnostico(true)}>
        <Text style={styles.linkDiagnostico}>Diagnóstico do aparelho</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#0B0E18' },
  titulo: { fontSize: 22, fontWeight: '700', color: '#C9D1E9', marginBottom: 4 },
  subtitulo: { fontSize: 13, color: '#64718F', marginBottom: 24 },
  input: {
    backgroundColor: '#131725', borderColor: '#252D44', borderWidth: 1,
    borderRadius: 8, padding: 12, color: '#C9D1E9', marginBottom: 12,
  },
  botao: { backgroundColor: '#5B8FFF', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 8 },
  botaoTexto: { color: '#fff', fontWeight: '600' },
  erro: { color: '#FF6B7A', marginBottom: 12, fontSize: 13 },
  debugUrl: { color: '#3A4661', fontSize: 11, marginTop: 24, textAlign: 'center' },
  linkDiagnostico: { color: '#5B8FFF', fontSize: 12, marginTop: 12, textAlign: 'center' },
});
