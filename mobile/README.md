# Controladoria — Extensão Móvel

Extensão de campo do ecossistema Controladoria (TCC — IFPR Campus Cascavel),
implementando o paradigma **Offline-First** com **encadeamento criptográfico
de hashes (hash chaining)** para garantir a integridade da sequência de
registros criados sem conectividade.

Este diretório é independente do núcleo administrativo Django
(`../Controladoria`) e contém dois subprojetos:

| Pasta | Stack | Responsabilidade |
|-------|-------|-------------------|
| [`app/`](./app) | React Native 0.86 + Expo SDK 57 + SQLite | Captura de dados em campo, offline-first, cifra em repouso |
| [`sync-backend/`](./sync-backend) | NestJS 10 + Prisma 6 + PostgreSQL | Autenticação JWT, validação da cadeia de hashes por dispositivo, delegação das escritas ao Django |

Requisitos funcionais, não funcionais, justificativa arquitetural e a
**rastreabilidade requisito → teste** em [`docs/requisitos.md`](./docs/requisitos.md).
Diagramas em [`docs/diagramas/`](./docs/diagramas).

## Início rápido

O Django precisa estar no ar antes (ver [`../Controladoria/README_INSTALL.md`](../Controladoria/README_INSTALL.md)).

```bash
# 1. Backend de sincronização
cd sync-backend
cp .env.example .env        # SYNC_DATABASE_URL, SYNC_JWT_SECRET, MOBILE_SYNC_API_KEY (= o do Django)
npm install
npx prisma migrate deploy   # cria as tabelas no PostgreSQL
npx prisma db seed          # usuário de teste: auditor.campo / mudar123
npm run start:dev           # http://localhost:3333

# 2. App móvel (em outro terminal)
cd app
npm install
npx expo start --offline    # QR code para o Expo Go
```

Depois do seed, vincule o usuário do sync ao do Django — instruções no
[README do sync-backend](./sync-backend/README.md#vínculo-com-o-django-uma-vez-por-usuário).

No Windows, [`tools/iniciar_ambiente.ps1`](./tools/iniciar_ambiente.ps1) sobe
os três serviços em modo túnel e imprime o QR no terminal.

## Testes

```bash
cd sync-backend && npm test && npm run test:e2e   # 22 unitários + 39 e2e (e2e usa o Postgres do .env)
cd app && npx jest                                 # 32
```

## Arquitetura em uma frase

O app grava tudo localmente primeiro (SQLite, cifrado) e encadeia cada novo
registro ao hash do anterior; ao reconectar, envia o lote ao `sync-backend`,
que recalcula essa cadeia de forma independente a partir da âncora daquele
dispositivo antes de aceitar qualquer dado — se algo foi alterado, removido
ou reordenado depois de criado, o lote é rejeitado nesse ponto.
