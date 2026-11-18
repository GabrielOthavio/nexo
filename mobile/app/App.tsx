import React, { useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, View, Text, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/context/AuthContext';
import RootNavigation from './src/navigation';
import BloqueioScreen from './src/screens/BloqueioScreen';
import { getDatabase } from './src/db/database';

export default function App() {
  const [pronto, setPronto] = useState(false);
  const [desbloqueado, setDesbloqueado] = useState(false);
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    getDatabase()
      .catch((erro) => {
        console.error('Falha ao inicializar o banco local:', erro);
      })
      .finally(() => setPronto(true));
  }, []);

  /**
   * Retrava ao voltar do background — o login (AuthContext) não protege esse
   * caso: `sessao` fica em memória e sobrevive enquanto o processo do app
   * continua vivo, então sem isso um aparelho desbloqueado por outra pessoa
   * reabriria direto nas telas com dados de auditoria, sem novo prompt.
   *
   * Só `background` → `active` conta como "o app foi guardado". O estado
   * intermediário `inactive` NÃO serve: no iOS ele dispara em situações em que
   * o app nunca saiu da mão do usuário — inclusive durante o próprio prompt
   * nativo de biometria do BloqueioScreen, além do preview do app-switcher e
   * de uma chamada entrando. Tratá-lo como retorno do background criava uma
   * corrida com a resolução do prompt: o desbloqueio recém-concedido era
   * desfeito no `active` seguinte, retravando em looping.
   */
  useEffect(() => {
    const assinatura = AppState.addEventListener('change', (proximoEstado: AppStateStatus) => {
      if (appState.current === 'background' && proximoEstado === 'active') {
        setDesbloqueado(false);
      }
      appState.current = proximoEstado;
    });
    return () => assinatura.remove();
  }, []);

  if (!pronto) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0B0E18', gap: 12 }}>
        <ActivityIndicator color="#5B8FFF" />
        {/* Um ícone girando sozinho não diz o que está acontecendo — o texto
            diz (abrindo o banco local e conferindo a sessão). */}
        <Text style={{ color: '#64718F', fontSize: 13 }}>Carregando… preparando os dados locais</Text>
      </View>
    );
  }

  /**
   * O bloqueio é uma SOBREPOSIÇÃO, nunca uma troca de árvore. Retornar
   * `<BloqueioScreen />` no lugar desta árvore desmontava o AuthProvider a
   * cada travamento — e como `sessao` é estado em memória (sem restauração a
   * partir do SecureStore), remontar significava voltar com `sessao === null`,
   * jogando o auditor no LoginScreen depois de simplesmente olhar uma
   * notificação. Junto ia embora todo estado de tela em andamento (ex.: a
   * descrição de um achado meio digitada). Montado permanentemente, o login
   * só é exigido de novo num início frio de verdade (processo morto).
   *
   * A sobreposição funciona por ordem de pintura: o React Native desenha os
   * irmãos posteriores por cima dos anteriores, então BloqueioScreen depois de
   * <RootNavigation /> — somado ao posicionamento absoluto cobrindo os quatro
   * lados no `styles.container` dele — tapa a navegação inteira, independente
   * do layout que ela use.
   */
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <RootNavigation />
        {!desbloqueado && <BloqueioScreen onDesbloquear={() => setDesbloqueado(true)} />}
      </AuthProvider>
    </SafeAreaProvider>
  );
}
