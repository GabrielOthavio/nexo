import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Wrapper sobre expo-secure-store — no nativo (Android/iOS) delega direto
 * pro Keychain/Keystore, sem mudança de comportamento. Na web, o módulo do
 * expo-secure-store é um stub vazio que lança erro (sem Keychain no
 * navegador) — usado aqui só para teste/desenvolvimento direto no PC via
 * `npx expo start --web`, caindo pro `localStorage` do navegador.
 *
 * Aviso de segurança: localStorage é acessível a qualquer script rodando na
 * página (sem isolamento de processo/hardware como o Keychain nativo) —
 * aceitável só como ambiente de teste local, nunca para uma build web de
 * produção real sem revisar essa troca.
 */
export async function getItemAsync(chave: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return window.localStorage.getItem(chave);
  }
  return SecureStore.getItemAsync(chave);
}

export async function setItemAsync(chave: string, valor: string): Promise<void> {
  if (Platform.OS === 'web') {
    window.localStorage.setItem(chave, valor);
    return;
  }
  await SecureStore.setItemAsync(chave, valor);
}

export async function deleteItemAsync(chave: string): Promise<void> {
  if (Platform.OS === 'web') {
    window.localStorage.removeItem(chave);
    return;
  }
  await SecureStore.deleteItemAsync(chave);
}
