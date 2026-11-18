import React, { createContext, useCallback, useContext, useState } from 'react';
import * as authService from '../services/authService';
import { Sessao } from '../services/authService';

interface AuthContextValue {
  sessao: Sessao | null;
  carregando: boolean;
  entrar: (username: string, password: string) => Promise<void>;
  sair: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [sessao, setSessao] = useState<Sessao | null>(null);
  const [carregando, setCarregando] = useState(false);

  const entrar = useCallback(async (username: string, password: string) => {
    setCarregando(true);
    try {
      const dados = await authService.login(username, password);
      setSessao(dados);
    } finally {
      setCarregando(false);
    }
  }, []);

  const sair = useCallback(async () => {
    await authService.logout();
    setSessao(null);
  }, []);

  return (
    <AuthContext.Provider value={{ sessao, carregando, entrar, sair }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>.');
  return ctx;
}
