import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { iniciarSincronizacaoAutomatica } from '../services/syncService';
import LoginScreen from '../screens/LoginScreen';
import SelecionarAuditoriaScreen from '../screens/SelecionarAuditoriaScreen';
import EtapasScreen from '../screens/EtapasScreen';
import NovoAchadoScreen from '../screens/NovoAchadoScreen';
import AchadosListScreen from '../screens/AchadosListScreen';
import EtapaFormScreen from '../screens/EtapaFormScreen';

export type RootStackParamList = {
  SelecionarAuditoria: undefined;
  Etapas: { auditoriaUuid: string; nomeAuditoria: string };
  Achados: { auditoriaUuid: string; nomeAuditoria: string };
  NovoAchado: { etapaUuid: string; auditoriaUuid: string; atividade: string };
  EtapaForm: { auditoriaUuid: string; etapaUuid?: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const screenOptions = {
  headerStyle: { backgroundColor: '#131725' },
  headerTintColor: '#C9D1E9',
  contentStyle: { backgroundColor: '#0B0E18' },
};

export default function RootNavigation() {
  const { sessao } = useAuth();

  useEffect(() => {
    if (!sessao) return;
    const parar = iniciarSincronizacaoAutomatica();
    return parar;
  }, [sessao]);

  return (
    <NavigationContainer>
      {sessao ? (
        <Stack.Navigator screenOptions={screenOptions}>
          <Stack.Screen
            name="SelecionarAuditoria"
            component={SelecionarAuditoriaScreen}
            options={{ title: 'Auditorias', headerShown: false }}
          />
          <Stack.Screen name="Etapas" component={EtapasScreen} options={{ title: 'Etapas' }} />
          <Stack.Screen name="Achados" component={AchadosListScreen} options={{ title: 'Achados' }} />
          <Stack.Screen name="NovoAchado" component={NovoAchadoScreen} options={{ title: 'Novo Achado' }} />
          <Stack.Screen name="EtapaForm" component={EtapaFormScreen} options={{ title: 'Etapa' }} />
        </Stack.Navigator>
      ) : (
        <LoginScreen />
      )}
    </NavigationContainer>
  );
}
