import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

type Estado = 'verificando' | 'sem_bloqueio_no_aparelho' | 'aguardando' | 'falhou';

interface Props {
  onDesbloquear: () => void;
}

/**
 * Gate de PIN/biometria antes de qualquer tela do app — cobre tanto a
 * abertura fria quanto o retorno do background (ver App.tsx), já que os
 * dados em cache local (etapas, achados) ficam visíveis sem precisar de
 * login de novo enquanto o processo do app continua vivo. Se o aparelho não
 * tem bloqueio de tela configurado, o uso é bloqueado por completo — decisão
 * de segurança acima de comodidade, não é um aviso opcional.
 */
export default function BloqueioScreen({ onDesbloquear }: Props) {
  const [estado, setEstado] = useState<Estado>('verificando');

  const tentar = useCallback(async () => {
    setEstado('verificando');
    const [temHardware, estaCadastrado] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!temHardware || !estaCadastrado) {
      setEstado('sem_bloqueio_no_aparelho');
      return;
    }

    setEstado('aguardando');
    const resultado = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Desbloqueie para acessar a Controladoria',
      cancelLabel: 'Cancelar',
      disableDeviceFallback: false,
    });
    if (resultado.success) {
      onDesbloquear();
    } else {
      setEstado('falhou');
    }
  }, [onDesbloquear]);

  useEffect(() => {
    tentar();
  }, [tentar]);

  return (
    <View style={styles.container}>
      {(estado === 'verificando' || estado === 'aguardando') && <ActivityIndicator color="#5B8FFF" />}

      {estado === 'sem_bloqueio_no_aparelho' && (
        <>
          <Text style={styles.titulo}>Bloqueio de tela necessário</Text>
          <Text style={styles.texto}>
            Este aparelho não tem PIN, senha ou biometria configurados no sistema. Por
            política de segurança, configure um bloqueio de tela antes de usar este app —
            os dados de auditoria salvos localmente dependem dessa proteção.
          </Text>
          <Pressable style={styles.botao} onPress={tentar}>
            <Text style={styles.botaoTexto}>Já configurei, tentar de novo</Text>
          </Pressable>
        </>
      )}

      {estado === 'falhou' && (
        <>
          <Text style={styles.titulo}>Não foi possível desbloquear</Text>
          <Pressable style={styles.botao} onPress={tentar}>
            <Text style={styles.botaoTexto}>Tentar novamente</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Absoluto cobrindo os quatro lados porque esta tela é uma SOBREPOSIÇÃO
    // sobre a navegação já montada (ver App.tsx), não um irmão em fluxo
    // normal: sem isso ela dividiria espaço com o RootNavigation em vez de
    // tapá-lo, e o conteúdo protegido continuaria visível por baixo.
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    // `elevation` é o que garante a mesma sobreposição no Android: lá a ordem
    // de pintura entre irmãos é decidida pela elevação quando ela existe, e o
    // cabeçalho do native-stack tem a sua. `zIndex` cobre o iOS/web.
    zIndex: 1000, elevation: 1000,
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0B0E18', padding: 24, gap: 16,
  },
  titulo: { fontSize: 18, fontWeight: '700', color: '#C9D1E9', textAlign: 'center' },
  texto: { fontSize: 13, color: '#64718F', textAlign: 'center', lineHeight: 20 },
  botao: { backgroundColor: '#5B8FFF', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, marginTop: 8 },
  botaoTexto: { color: '#fff', fontWeight: '600' },
});
