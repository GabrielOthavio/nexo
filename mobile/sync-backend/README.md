# Controladoria — Backend de Sincronização (NestJS + Prisma)

Serviço que fica entre o app de campo e o núcleo Django. Faz três coisas, e
deliberadamente **só** essas três:

1. **Autentica o dispositivo** — login por usuário/senha, JWT de 12 h,
   revalidado contra o banco a cada requisição.
2. **Revalida a cadeia de hashes** de cada lote recebido, a partir da âncora
   daquele (usuário, dispositivo), antes de aceitar qualquer item.
3. **Delega cada escrita ao Django** pela API interna
   (`Auth/views/api_mobile_views.py`), item a item — é o único caminho que
   dispara os signals de auditoria do núcleo.

Ele **não persiste o conteúdo** de nenhum achado ou etapa: o payload passa em
memória durante a requisição. O banco próprio guarda só metadados do
protocolo (ver *Persistência*).

## Setup

```bash
cp .env.example .env         # preencha SYNC_DATABASE_URL, SYNC_JWT_SECRET, MOBILE_SYNC_API_KEY
npm install
npx prisma migrate deploy    # cria as tabelas (uma migration: 20260810001226_inicial)
npx prisma db seed           # usuário de teste: auditor.campo / mudar123
npm run start:dev            # http://localhost:3333
```

### Vínculo com o Django (uma vez por usuário)

O seed cria `auditor.campo` com um `django_usuario_uuid` placeholder. O
sync-backend precisa saber **qual** `Usuario` do Django ele representa — é
esse uuid que vai em toda chamada à API interna, nunca um valor vindo do app
(decisão *confused deputy*, ver `jwt.strategy.ts`).

```bash
# no Django — imprime o UPDATE pronto
python manage.py vincular_usuario_mobile auditor.campo
# no Postgres do sync-backend
psql -d controladoria_sync -c "UPDATE usuarios SET django_usuario_uuid = '<uuid impresso>' WHERE username = 'auditor.campo';"
```

O usuário no Django precisa ter permissão `auditorias: editar` (para
achados/etapas) ou `excluir` (para exclusão) e estar em
`usuarios_envolvidos` da auditoria — o RBAC é aplicado **lá**, não aqui.

### Variáveis de ambiente

| Variável | O que é |
|---|---|
| `SYNC_DATABASE_URL` | PostgreSQL próprio (`controladoria_sync`), separado do banco do Django |
| `SYNC_JWT_SECRET` | segredo de assinatura do JWT — gere com `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `DJANGO_API_BASE_URL` | onde o Django está (ex.: `http://127.0.0.1:8000`) |
| `MOBILE_SYNC_API_KEY` | segredo da API interna; **idêntico** ao `Controladoria/config/.env` |
| `PORT` | padrão `3333` |

## Endpoints

Todas as rotas `/sync/*` exigem `Authorization: Bearer <accessToken>`.
Throttle global de 100 req/min por IP.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/auth/login` | `{username, password}` → `{accessToken, usuario}` |
| `POST` | `/sync/push` | Recebe um lote e o processa (abaixo). Exige header **`X-Device-Id`**. |
| `GET` | `/sync/auditorias` | Auditorias abertas em que o usuário está envolvido (repasse do Django) |
| `GET` | `/sync/auditorias/:uuid/etapas` | Etapas de uma auditoria (repasse do Django) |

### `POST /sync/push` — o protocolo

**Requisição** — `{ itens: Item[] }`, na ordem da cadeia local:

```ts
{
  uuid: string;          // gerado no aparelho; vira origem_mobile_uuid no Django (idempotência)
  payload: string;       // JSON em TEXTO PLANO: { tipo, ...campos } — é o que foi hasheado
  criadoEm: string;      // ISO 8601
  hashAnterior: string;  // SHA-256 hex do elo anterior (ou 64 zeros = gênesis)
  hashAtual: string;     // SHA-256(hashAnterior|uuid|payload|criadoEm)
  abandonada?: boolean;  // descartado pelo auditor: valida o elo, não aplica nada
}
```

`payload.tipo` ∈ `achado_criar` · `etapa_criar` · `etapa_editar` · `etapa_excluir`.

**Resposta** — sempre `201`; o resultado do lote vem no corpo:

```ts
{
  loteUuid: string | null;              // null só na corrida de âncora (lote descartado)
  confirmados: { uuid, entidadeDjangoUuid }[];
  conflitos:   { uuid, conflitoId }[];  // etapa_editar com baseline defasado — ConflitoEtapa criado no Django
  abandonados: string[];                // uuids reconhecidos e deliberadamente não aplicados
  paradoNoIndice: number | null;        // onde o lote parou, se parou
  motivoParada: string | null;
  paradaDefinitiva: boolean | null;     // true = recusa real (cadeia inválida, 4xx do Django, JSON inválido)
                                        // false = transitório (5xx, rede, corrida de âncora) — reenviar
}
```

Regras que valem a pena saber:

- A cadeia inteira é validada **antes** de aplicar qualquer item. Um elo
  inválido no meio barra até os anteriores.
- **Conflito não para o lote**: o item vai para `conflitos`, a âncora avança,
  os seguintes continuam.
- **Falha real para o lote** naquele índice; os anteriores ficam confirmados.
- **Reconciliação de resposta perdida**: se o primeiro item do lote não bate
  com a âncora mas é auto-consistente, ele é reprocessado (o Django é
  idempotente por `origem_mobile_uuid`). Se o Django recusar, o lote cai na
  validação normal e é rejeitado — a chamada ao Django é o freio.
- Um item **abandonado** reenviado só é reconhecido se a âncora **lembra**
  daquele uuid (`ultimoAbandonadoUuid`); do contrário é rejeitado, porque
  seria a única forma de re-ancorar a cadeia sem nenhuma checagem externa.
- **Âncora por (usuário, dispositivo)**: a mesma conta em dois aparelhos são
  duas cadeias independentes. O avanço é compare-and-swap; duas requisições
  concorrentes do mesmo aparelho → uma vence, a outra recebe
  `paradaDefinitiva: false` e reenvia.

## Persistência (`prisma/schema.prisma`)

| Tabela | Guarda |
|---|---|
| `usuarios` | credenciais (bcrypt), `django_usuario_uuid`, `ativo` |
| `ancoras_dispositivo` | último hash confirmado por (usuário, dispositivo) + uuid do último abandono |
| `mapeamentos_uuid_temporario` | uuid local de etapa criada offline → `id_unico` real do Django (sobrevive entre pushes) |
| `lotes_sincronizacao` | diagnóstico por push: total, confirmados, cadeia ok? |

Nada de conteúdo. `itens_confirmados` conta só o que virou escrita no Django
(abandonados e conflitos ficam de fora).

## Testes

```bash
npm test            # 22 unitários — src/sync/hash-chain.util.spec.ts (sem banco)
npm run test:e2e    # 39 — test/sync.e2e-spec.ts (Postgres real do .env)
```

O e2e sobe o Nest em processo, cria e apaga o próprio usuário
(`sync.e2e.teste`) e substitui **só** o `DjangoBridgeService` por um dublê —
o que se testa é o protocolo, não o Django. Cobre: autenticação, validações
de borda, fluxo feliz, cadeia inválida, conflito, abandono (inclusive
forjado), falhas do Django (4xx × 5xx × rede), corrida de âncora,
reconciliação de resposta perdida, `etapa_excluir`, multi-dispositivo,
payload malformado e mapeamento de uuid temporário entre pushes.

## Scripts

| Script | |
|---|---|
| `npm run start:dev` | desenvolvimento com watch |
| `npm run build` + `npm run start:prod` | build sai em `dist/src/main.js` |
| `npm run prisma:studio` | inspeciona o banco |
| `npm run prisma:migrate` | `prisma migrate dev` — só para **criar** migration nova; em deploy use `npx prisma migrate deploy` |

## Estrutura

```
src/
├── auth/            # login, JwtStrategy (revalida contra o banco), guard
├── common/          # decorator @UsuarioAtual
├── prisma/          # PrismaService
└── sync/
    ├── sync.controller.ts        # rotas
    ├── sync.service.ts           # o protocolo (push, âncora, reconciliação)
    ├── django-bridge.service.ts  # client HTTP da API interna do Django
    ├── hash-chain.util.ts        # espelho Node do algoritmo do app
    └── dto/sync-push.dto.ts      # validação do corpo (class-validator)
```
