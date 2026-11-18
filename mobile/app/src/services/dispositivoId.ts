import * as Crypto from 'expo-crypto';
import * as SecureStore from './armazenamentoSeguro';

/**
 * Identificador estável do DISPOSITIVO (mais precisamente, desta instalação
 * do app neste aparelho) — não da sessão nem do usuário.
 *
 * Existe porque a cadeia de hashes de `operacoes_pendentes` vive inteiramente
 * no SQLite local e recomeça do gênesis a cada instalação. A âncora de
 * continuidade no servidor precisa, portanto, ser por (usuário, dispositivo):
 * a mesma conta usada em dois aparelhos (segundo celular, troca de aparelho,
 * reinstalação enquanto o app antigo ainda existe em outro lugar) empurra
 * DUAS cadeias independentes, e uma âncora única por usuário faria uma
 * invalidar a outra a cada push — falhas de continuidade falsas, "resgatadas"
 * pela reconciliação do primeiro item sem prova real de continuidade, o que
 * degrada exatamente a garantia que a cadeia deveria dar.
 *
 * Persistido via `armazenamentoSeguro` (mesmo wrapper de `api.ts`/`crypto.ts`,
 * mantendo o fallback de localStorage no ambiente web de desenvolvimento).
 * NUNCA é apagado no logout (ver authService.logout) — identifica o aparelho,
 * não a sessão; apagá-lo faria a cadeia local sobreviver ao logout enquanto a
 * âncora do servidor viraria órfã, recriando o bug em um único aparelho.
 */
const CHAVE_DISPOSITIVO_ID = 'dispositivo_id_v1';

/**
 * Memoiza a obtenção/criação (mesmo motivo de `obterOuCriarChave` em
 * crypto.ts): duas chamadas concorrentes no primeiro uso gerariam dois uuids,
 * um sobrescrevendo o outro no armazenamento — o app passaria a se apresentar
 * como dois dispositivos diferentes para a mesma cadeia local.
 */
let idEmObtencao: Promise<string> | null = null;

export function obterDispositivoId(): Promise<string> {
  if (!idEmObtencao) {
    idEmObtencao = (async () => {
      const armazenado = await SecureStore.getItemAsync(CHAVE_DISPOSITIVO_ID);
      if (armazenado) {
        return armazenado;
      }
      const novo = Crypto.randomUUID();
      await SecureStore.setItemAsync(CHAVE_DISPOSITIVO_ID, novo);
      return novo;
    })();
    idEmObtencao.catch(() => {
      idEmObtencao = null;
    });
  }
  return idEmObtencao;
}
