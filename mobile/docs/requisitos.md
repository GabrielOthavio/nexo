# Requisitos — Extensão Móvel do Ecossistema Controladoria

Este documento descreve os requisitos da extensão de campo do ecossistema
Controladoria, conforme a arquitetura proposta no TCC (seção 3.4 —
Desenvolvimento do artefato). É composta por três partes, duas neste
repositório e o núcleo administrativo num repositório irmão:

- **`app/`** — aplicativo móvel React Native + Expo, Offline-First, usado
  pelo auditor em campo para selecionar uma Auditoria em andamento e
  registrar Achados contra as Etapas dela, mesmo sem conectividade.
- **`sync-backend/`** — serviço NestJS + Prisma + PostgreSQL responsável
  pelo protocolo de sincronização bidirecional (autenticação do
  dispositivo, validação da cadeia de hashes, RBAC de primeira camada) —
  não persiste o conteúdo do Achado, apenas metadados do protocolo.
- **`Controladoria/`** (repositório irmão, núcleo Django) — expõe uma API
  interna (`Auth/views/api_mobile_views.py`) consumida exclusivamente pelo
  `sync-backend`, que é quem efetivamente cria o Achado via ORM — o único
  caminho que preserva o signal de auditoria automática (Audit by Design,
  TCC seção 2.2): qualquer escrita que não passasse pelo Django ORM não
  geraria a trilha em `HistoricoAlteracoes`.

## 1. Requisitos funcionais

| ID | Requisito |
|----|-----------|
| RF01 | O usuário deve poder autenticar-se no aplicativo móvel com usuário e senha. |
| RF02 | Após o login, o auditor deve escolher qual Auditoria (dentre as que está envolvido, com status Planejada/Em Andamento) vai trabalhar em campo. |
| RF03 | O aplicativo deve listar as Etapas da Auditoria selecionada e permitir registrar um Achado (descrição) contra uma Etapa mesmo sem conexão com a internet. |
| RF04 | Todo Achado criado offline deve ser persistido no banco SQLite local do dispositivo antes de qualquer tentativa de rede, com a descrição cifrada em repouso (ver RNF08). |
| RF05 | Cada Achado deve incorporar um elo de uma cadeia de hashes SHA-256, calculado sobre o conteúdo em texto plano e referenciando o hash do registro imediatamente anterior criado no mesmo dispositivo. |
| RF06 | O aplicativo deve listar os Achados registrados localmente para a Auditoria selecionada, indicando quais já foram sincronizados e quais estão pendentes. |
| RF07 | Ao haver conectividade, o usuário deve poder disparar manualmente a sincronização dos Achados pendentes; a sincronização também deve ser tentada automaticamente ao detectar volta de conectividade. |
| RF08 | O backend de sincronização deve recalcular e validar de forma independente a cadeia de hashes recebida — usando como âncora o último hash já confirmado numa sincronização anterior — e delegar a criação de cada Achado ao núcleo Django. |
| RF09 | Falha parcial num lote é semântica esperada: se um item falhar (RBAC negado, Etapa inexistente etc.), o processamento para naquele ponto; os itens anteriores já confirmados permanecem válidos e a resposta informa exatamente onde e por quê parou, para o app manter só os itens não confirmados como pendentes. |
| RF10 | O núcleo Django deve aplicar controle de acesso por perfil (RBAC) — apenas usuários com permissão de editar Auditorias, envolvidos na Auditoria da Etapa em questão, podem ter Achados criados em seu nome. |
| RF11 | A criação de Achado deve ser idempotente por um identificador de origem gerado no dispositivo (`origem_mobile_uuid`) — um retry de rede após sucesso não deve duplicar o Achado. |
| RF12 | O aplicativo deve manter um cache local (só neste dispositivo) da lista de Auditorias do auditor e das Etapas da Auditoria selecionada, atualizado via sincronização de leitura (pull). |
| RF13 | Se a verificação local da cadeia de hashes detectar corrupção, a sincronização deve ser bloqueada e o usuário avisado, sem enviar dados ao servidor. |

## 2. Requisitos não funcionais

| ID | Requisito |
|----|-----------|
| RNF01 | **Offline-first**: nenhuma operação de escrita do formulário de campo deve depender de conectividade de rede. |
| RNF02 | **Integridade**: a implementação do hash chaining no app e no backend deve usar exatamente o mesmo algoritmo (`SHA-256(hash_anterior\|uuid\|payload\|criado_em)`) sobre o payload em TEXTO PLANO, documentado em `app/src/db/hashChain.ts` e `sync-backend/src/sync/hash-chain.util.ts`. A cifra em repouso (RNF08) nunca participa do cálculo do hash. |
| RNF03 | **Isolamento do protocolo**: o `sync-backend` não persiste o conteúdo do Achado nem depende do schema do banco Django — valida a cadeia em memória durante a requisição e delega a criação real a uma API interna do Django, mantendo o protocolo de sincronização desacoplado da lógica administrativa. |
| RNF04 | **Autenticação do dispositivo**: tokens JWT com expiração (12h) e revalidação do usuário contra o banco a cada requisição (perfil/unidade/permissões podem mudar entre o login e uma sincronização posterior). |
| RNF05 | **Autenticação serviço-a-serviço**: a API interna do Django é protegida por segredo compartilhado (`X-Internal-Api-Key`) + allowlist de IP de origem — nunca exposta a sessões de browser, e o segredo nunca é embutido no app mobile. |
| RNF06 | **Armazenamento seguro no dispositivo**: o token de acesso é armazenado via `expo-secure-store` (keychain/keystore nativos), nunca em `AsyncStorage` puro. |
| RNF07 | **Confidencialidade em repouso no dispositivo**: a descrição do Achado é cifrada com AES-256-CTR (`aes-js`, sem módulo nativo) + HMAC-SHA256 próprio (Encrypt-then-MAC, via `expo-crypto`) antes de gravar no SQLite local — chave simétrica gerada no primeiro uso e guardada em `expo-secure-store`. |
| RNF08 | **Confidencialidade em repouso no Django**: `Achado.descricao` é um `EncryptedTextField` (mesma lib `django-encrypted-model-fields` usada para CPF/telefone/endereço do Usuario), com migration incluindo recriptografia dos registros pré-existentes. |
| RNF09 | **Auditoria automática preservada (Audit by Design)**: a criação de Achado pela API interna acontece via `Achado.objects.get_or_create()` sob impersonação do usuário real (`set_current_user`), garantindo que o signal `HistoricoAlteracoes` seja disparado com o autor correto — e que o campo protegido apareça redigido (`[PROTEGIDO]`), nunca em texto plano, na trilha de auditoria. |
| RNF10 | **Limitação reconhecida (TCC seção 2.5)**: o hash chaining garante a integridade relativa da sequência local, não a veracidade do timestamp absoluto do dispositivo — o relógio permanece sob controle do usuário/SO. Ancoragem temporal externa (ex.: ICP-Brasil RFC 3161) está fora do escopo. |
| RNF11 | **Rate limiting**: os endpoints do `sync-backend` têm limitação de taxa para mitigar força bruta (`@nestjs/throttler`). |
| RNF12 | **Tamanho do banco offline**: o pull de Auditorias/Etapas é feito em duas etapas (lista leve, depois etapas só da selecionada) para manter o SQLite do dispositivo proporcional a "uma auditoria em campo por vez", não ao portfólio inteiro do auditor. |

## 3. Estrutura de pastas

```
mobile/
├── app/                    # React Native + Expo (offline-first)
│   ├── App.tsx
│   ├── app.json
│   ├── package.json
│   └── src/
│       ├── context/        # estado de sessão (AuthContext)
│       ├── db/              # SQLite: schema, conexão, cripto, hash chaining, repositórios
│       ├── models/          # tipos de domínio compartilhados (Achado, AuditoriaCache, EtapaCache)
│       ├── navigation/      # React Navigation
│       ├── screens/         # Login, Selecionar Auditoria, Etapas, Novo Achado, Lista de Achados
│       └── services/        # cliente HTTP, auth, sincronização
│
├── sync-backend/            # NestJS + Prisma + PostgreSQL
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/
│   │   └── seed.ts
│   └── src/
│       ├── auth/            # JWT strategy, guard, service, controller
│       ├── common/          # guards e decorators de RBAC
│       ├── prisma/           # PrismaService/PrismaModule
│       └── sync/             # controller, service, ponte com o Django, validação de hash chain
│
└── docs/
    └── requisitos.md         # este arquivo
```

O núcleo Django (`Controladoria/`, repositório irmão) ganhou, para esta
integração: `Auth/views/api_mobile_views.py` (API interna), `Auth/urls/api_mobile.py`,
`Auth/decorators.py::requer_chave_interna`, `Auth/middleware.py::set_current_user`,
`Auth/management/commands/vincular_usuario_mobile.py`, e a migration
`0016_encrypt_achado_descricao.py`.

## 4. Dependências principais

### App móvel (`app/`)
- **expo** 57 (SDK 57, React Native 0.86) — runtime e ferramentas de build
- **expo-sqlite** — persistência local (Offline-First)
- **expo-crypto** — SHA-256 para o hash chaining e HMAC; geração de bytes aleatórios
- **aes-js** — AES-256-CTR puro JS (cifra em repouso da descrição do Achado)
- **expo-secure-store** — armazenamento seguro do token JWT e da chave simétrica local
- **@react-navigation/native** + **native-stack** — navegação
- **@react-native-community/netinfo** — detecção de conectividade (sincronização automática)
- **axios** — cliente HTTP para o `sync-backend`

### Backend de sincronização (`sync-backend/`)
- **@nestjs/core**, **@nestjs/common**, **@nestjs/platform-express** — framework
- **@nestjs/jwt**, **@nestjs/passport**, **passport-jwt** — autenticação JWT
- **@nestjs/throttler** — rate limiting
- **@prisma/client** + **prisma** — ORM e migrations
- **axios** — client HTTP para a API interna do Django
- **bcrypt** — hashing de senha
- **class-validator**, **class-transformer** — validação de DTOs

## 5. Fora de escopo deste repositório

- **Operação offline do sistema web de sede.** O caminho offline-first é
  exclusivamente o app de campo (RNF01); o núcleo Django continua dependente
  de conectividade. O que o web faz sem rede é apenas *não falhar em
  silêncio*: bloqueia o envio dos formulários, explica o motivo e preserva o
  que foi digitado (ver `initRede`/`initForms` em `Auth/static/Auth/js/app.js`).
- Testes com usuários reais e auditoria de segurança independente (ver
  seção 3.7 do TCC — limitações metodológicas).
- Ancoragem de tempo confiável (RFC 3161 / ICP-Brasil).
- Provisionamento self-service do vínculo entre o Usuario do Django e o
  Usuario do sync-backend — hoje é manual, via
  `python manage.py vincular_usuario_mobile <username>` (Django) + um
  `UPDATE` no Postgres do sync-backend.
- Cifra de disco completo (SQLCipher) no SQLite do dispositivo — só o
  conteúdo do Achado é cifrado, não o arquivo inteiro (ver RNF07).

## 6. Rastreabilidade requisito → teste

Cada requisito abaixo tem verificação automatizada; o comando de cada suíte
está no README da raiz. "e2e" = `mobile/sync-backend/test/sync.e2e-spec.ts`.

| Requisito | Onde é verificado |
|---|---|
| RF05, RNF02 — mesmo algoritmo de hash nos dois lados | `app/src/db/hashChain.test.ts` (o caso 1.3 importa o `hash-chain.util.ts` **real** do sync-backend e exige hash idêntico); `sync-backend/src/sync/hash-chain.util.spec.ts` |
| RF08 — servidor revalida a cadeia a partir da âncora | e2e Cenários 3, 4, 10, 11, 13 |
| RF09 — falha parcial; parada definitiva × transitória | e2e Cenários 7, 14 |
| RF10 — RBAC no núcleo Django | `Controladoria/Auth/tests/test_api_mobile.py` (perfil, envolvimento, status em cada endpoint), `test_rbac.py` |
| RF11 — idempotência por `origem_mobile_uuid` | `test_api_mobile.py` (`CriarAchadoTest`, `CriarEtapaTest`); e2e Cenário 10 |
| RF13 — cadeia local corrompida bloqueia o envio | `hashChain.test.ts` Cenário 3 |
| RNF04 — JWT revalidado contra o banco | e2e Cenário 1 (1.4: usuário inativado depois do login é barrado) |
| RNF05 — chave interna + allowlist de IP | `Controladoria/Auth/tests/test_chave_interna.py` |
| RNF07 — AES-256-CTR + HMAC-SHA256 em repouso | `app/src/db/crypto.test.ts` — paridade com OpenSSL, round-trip com caracteres fora do BMP, rejeição de qualquer adulteração |
| RNF08, RNF09 — campo cifrado, `[PROTEGIDO]` na trilha, autor impersonado | `test_api_mobile.py::CriarAchadoTest::test_audit_by_design_*` |
| RNF11 — rate limiting | **sem teste automatizado**. Existe throttle global (100/min); não há limite específico para `/auth/login` — lacuna conhecida |
| Conflito de edição concorrente (baseline) | `test_api_mobile.py::EditarEtapaTest`, `test_determinar_resolvedor.py`; e2e Cenários 5, 10.3 |
| Abandono de item (elo sem efeito, não forjável) | e2e Cenários 6, 11 |
| Âncora por dispositivo; corrida de âncora | e2e Cenários 8, 13 |
| Senhas em Argon2id no Django, migração de PBKDF2 | `test_rbac.py::HashDeSenhaTest` |
