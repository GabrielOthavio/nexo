# Controladoria — App de Campo (React Native + Expo)

Aplicativo **offline-first** para o auditor em campo: escolhe uma auditoria,
vê as etapas dela e registra **achados** e **etapas** (criar, editar,
excluir) sem depender de rede. Tudo é gravado primeiro no SQLite do aparelho,
encadeado por hash, cifrado em repouso, e sincronizado depois com o
`sync-backend`.

Expo SDK 57 · React Native 0.86 · React 19.2 · TypeScript 6.

## Setup

```bash
npm install
npx expo start --offline
```

Escaneie o QR com o **Expo Go** (versão com suporte a SDK 57). `--offline`
pula as chamadas aos servidores da Expo (telemetria, login), que falham em
redes restritas — o Metro local não precisa delas.

### Como o app acha o `sync-backend`

Não há IP fixo no `app.json`. Em [`src/services/api.ts`](src/services/api.ts)
a URL é derivada do `hostUri` que o próprio Expo Go usou para carregar o
bundle:

- **LAN** (`192.168.0.10:8081`) → backend em `http://192.168.0.10:3333`
  (mesma máquina que roda o Metro, porta própria).
- **Túnel** (`xxxx.ngrok-free.dev`) → backend em `https://xxxx.ngrok-free.dev/api-proxy`
  — o Metro faz proxy para `localhost:3333` (ver `metro.config.js`), porque o
  túnel só expõe uma porta.

`expo.extra.syncApiUrl` no `app.json` continua funcionando como override manual.

Para subir Django + sync-backend + Expo em túnel de uma vez, com QR no
terminal: [`../tools/iniciar_ambiente.ps1`](../tools/iniciar_ambiente.ps1)
(Windows).

## Como funciona o offline-first

1. Toda operação (`achado_criar`, `etapa_criar`, `etapa_editar`,
   `etapa_excluir`) entra numa **fila única** em `operacoes_pendentes`
   ([`src/db/operacoesRepository.ts`](src/db/operacoesRepository.ts)).
2. Antes de gravar, o app calcula
   `SHA-256(hash_anterior | uuid | payload | criado_em)` sobre o payload em
   **texto plano** ([`src/db/hashChain.ts`](src/db/hashChain.ts)) — cada
   registro referencia o hash do anterior. As inserções são serializadas para
   nunca haver dois elos com o mesmo `hash_anterior`.
3. Só depois o payload é **cifrado** — AES-256-CTR + HMAC-SHA256
   (Encrypt-then-MAC), chave gerada no primeiro uso e guardada no
   Keychain/Keystore via `expo-secure-store`
   ([`src/db/crypto.ts`](src/db/crypto.ts)). A cifra nunca participa do hash.
4. A tela mostra o estado local imediatamente (otimista); etapas criadas
   offline ganham um uuid temporário que o servidor troca pelo real na
   confirmação.
5. **Sincronizar** ([`src/services/syncService.ts`](src/services/syncService.ts)),
   manual ou ao detectar rede:
   - verifica a integridade de **toda** a cadeia local (decifra com HMAC +
     recalcula os hashes); se estiver corrompida, bloqueia e avisa, sem enviar;
   - envia os pendentes em lotes de até 2 MB, em ordem, para `POST /sync/push`;
   - marca como sincronizado **só** o que o servidor confirmar; conflitos
     saem da fila e ficam para resolução no sistema web; itens "abandonados"
     pelo auditor continuam viajando no lote (a cadeia não admite buraco) até
     o servidor reconhecê-los.
6. Se o servidor recusou um item de vez (`paradaDefinitiva`), a UI oferece
   **descartar** — a linha nunca é apagada (a trilha é append-only), só
   marcada `abandonada`, e o estado otimista local é revertido.

Limitação assumida: a cadeia prova a **ordem relativa** dos registros, não o
horário absoluto — o relógio é do aparelho.

## Testes

```bash
npx jest              # 32 testes
npm run typecheck
```

| Arquivo | Cobre |
|---|---|
| `src/db/hashChain.test.ts` | determinismo, sensibilidade a cada campo, detecção de adulteração/reordenação/remoção, e **paridade** — importa o `hash-chain.util.ts` real do sync-backend e exige hash idêntico |
| `src/db/crypto.test.ts` | round-trip (inclusive emoji fora do BMP, que o codec do `aes-js` corrompe), **paridade com OpenSSL** (o Node decifra o que o `aes-js` cifrou; `createHmac` bate com o HMAC manual), IV único, e rejeição de qualquer adulteração antes de decifrar |

Os testes rodam em Node puro: `expo-crypto` e `expo-secure-store` são
substituídos por mocks que chamam o `crypto` real do Node — o que se testa é
o algoritmo, não o binding nativo.

## Scripts

| | |
|---|---|
| `npm start` / `npx expo start --offline` | Metro |
| `npm run android` / `npm run ios` / `npm run web` | abre num emulador/navegador |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npx jest` | testes |

## Estrutura

```
src/
├── context/AuthContext.tsx          # sessão (token no SecureStore), bloqueio do app
├── db/
│   ├── schema.ts                    # DDL do SQLite; HASH_GENESIS
│   ├── database.ts                  # abertura/migração do banco
│   ├── crypto.ts                    # AES-256-CTR + HMAC-SHA256, codec UTF-8
│   ├── hashChain.ts                 # cálculo e verificação da cadeia
│   ├── operacoesRepository.ts       # fila unificada: inserir, abandonar, marcar sincronizado/conflito
│   └── auditoriasRepository.ts      # cache de auditorias/etapas (cifrado)
├── models/Achado.ts                 # tipos de domínio (OperacaoLocal, EtapaCache, ...)
├── navigation/index.tsx             # React Navigation (stack)
├── screens/
│   ├── LoginScreen.tsx
│   ├── SelecionarAuditoriaScreen.tsx
│   ├── EtapasScreen.tsx             # lista + botão sincronizar + descarte de item recusado
│   ├── EtapaFormScreen.tsx          # criar/editar etapa
│   ├── NovoAchadoScreen.tsx
│   ├── AchadosListScreen.tsx
│   ├── BloqueioScreen.tsx           # desbloqueio biométrico
│   └── DiagnosticoScreen.tsx        # estado da fila e da cadeia
└── services/
    ├── api.ts                       # axios + descoberta da URL do backend
    ├── authService.ts
    ├── syncService.ts               # push/pull, lotes, guarda de concorrência
    ├── armazenamentoSeguro.ts       # wrapper do expo-secure-store (localStorage na web)
    └── dispositivoId.ts             # X-Device-Id por instalação
```
