import axios from 'axios';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as SecureStore from './armazenamentoSeguro';

const SYNC_API_PORT = 3333;

/**
 * Descobre a URL do sync-backend automaticamente a partir do host que o
 * Expo Go usou para carregar o próprio bundle (`hostUri`) — o mesmo host
 * que roda o Metro também roda o sync-backend em dev. Isso evita fixar um
 * IP no `app.json`, que quebra toda vez que o celular ou o PC trocam de
 * rede Wi-Fi.
 *
 * Dois formatos de `hostUri` possíveis:
 * - LAN (ex.: "192.168.0.115:8081") — tem porta explícita; o backend está
 *   na mesma máquina, só numa porta diferente (3333), alcançável direto.
 * - Túnel (ex.: "xxxx.ngrok-free.dev") — sem porta (HTTPS na 443, terminado
 *   pelo ngrok); só o Metro é exposto publicamente por esse domínio, então
 *   o backend é alcançado via PROXY dentro do próprio Metro (ver
 *   metro.config.js `/api-proxy`), não numa porta separada que o túnel não
 *   expõe.
 *
 * `extra.syncApiUrl` continua funcionando como override manual.
 */
function resolverSyncApiUrl(): string {
  const override = Constants.expoConfig?.extra?.syncApiUrl;
  if (typeof override === 'string' && override.length > 0) {
    return override;
  }

  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    if (hostUri.includes(':')) {
      // LAN: host:porta explícitos — backend na mesma máquina, porta própria.
      const host = hostUri.split(':')[0];
      if (host) {
        return `http://${host}:${SYNC_API_PORT}`;
      }
    } else {
      // Túnel: só o domínio, sem porta — backend via proxy do próprio Metro.
      return `https://${hostUri}/api-proxy`;
    }
  }

  // Na web, hostUri pode não vir preenchido pelo bundler — o próprio host
  // da página do navegador (mesma máquina que roda o Metro/backend em dev)
  // é a fonte mais direta.
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.hostname) {
    return `http://${window.location.hostname}:${SYNC_API_PORT}`;
  }

  return `http://localhost:${SYNC_API_PORT}`;
}

export const SYNC_API_URL = resolverSyncApiUrl();

export const api = axios.create({
  baseURL: SYNC_API_URL,
  timeout: 15000,
});

api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export async function salvarToken(token: string): Promise<void> {
  await SecureStore.setItemAsync('access_token', token);
}

export async function limparToken(): Promise<void> {
  await SecureStore.deleteItemAsync('access_token');
}
