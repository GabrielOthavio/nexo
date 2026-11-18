import { api, salvarToken, limparToken } from './api';

export interface Sessao {
  usuarioId: number;
  username: string;
  unidade: string | null;
  perfil: string;
}

interface LoginResponse {
  accessToken: string;
  usuario: Sessao;
}

/**
 * Autentica contra o backend de sincronização (JWT). O RBAC por perfil e o
 * escopo por unidade orçamentária do usuário (ver Auth/models.py no backend
 * Django) são espelhados aqui via claims do token, e reaplicados no push
 * (o backend nunca confia apenas no que o app envia sobre o próprio escopo).
 */
export async function login(username: string, password: string): Promise<Sessao> {
  const { data } = await api.post<LoginResponse>('/auth/login', { username, password });
  await salvarToken(data.accessToken);
  return data.usuario;
}

export async function logout(): Promise<void> {
  await limparToken();
}
