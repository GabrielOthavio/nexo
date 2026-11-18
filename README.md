# Nexo

Código-fonte do artefato descrito no artigo **"Nexo: Sistema Auditável Desenvolvido a partir de Falhas Sistêmicas no Controle Interno Municipal"** (Trabalho de Conclusão de Curso, Tecnologia em Análise e Desenvolvimento de Sistemas, IFPR Campus Cascavel, 2026).

O Nexo tem três componentes:

| Componente | Pasta | Tecnologia |
|---|---|---|
| Núcleo administrativo | [`Controladoria/`](Controladoria/) | Django + PostgreSQL |
| Serviço de sincronização | [`mobile/sync-backend/`](mobile/sync-backend/) | NestJS + PostgreSQL |
| Extensão de campo | [`mobile/app/`](mobile/app/) | React Native (Expo) + SQLite |

## Onde está cada mecanismo do artigo

| Falha | Mecanismo | Onde conferir |
|---|---|---|
| F1 | Identificador Semântico, ordinal por órgão | `Controladoria/Auth/models.py` (`Auditoria`) |
| F2 | UUID como chave externa e verificação de escopo | `Controladoria/Auth/views/crud_Auditoria_views.py` (`_pode_acessar_auditoria`) |
| F3 | Trilha automática por *signals*, encadeada e protegida por gatilho no banco | `Controladoria/Auth/models.py` (`HistoricoAlteracoes`), migration `0018_trilha_encadeada_e_ordinal_unico.py` |
| F4 | Fila local cifrada (Encrypt-then-MAC) | `mobile/app/src/db/crypto.ts`, `mobile/app/src/db/operacoesRepository.ts` |
| F5 | Cadeia de *hashes* com âncora no servidor | `mobile/app/src/db/hashChain.ts`, `mobile/sync-backend/src/sync/` |
| F6 | Operação pendente até a confirmação do servidor | `mobile/app/src/services/syncService.ts`, `mobile/sync-backend/src/sync/` |

## Testes

```bash
# Núcleo administrativo
cd Controladoria && python manage.py test Auth

# Serviço de sincronização (unitários e ponta a ponta; exigem PostgreSQL)
cd mobile/sync-backend && npm test && npm run test:e2e

# Extensão de campo
cd mobile/app && npm test
```

Instruções de instalação em [`Controladoria/README_INSTALL.md`](Controladoria/README_INSTALL.md) e [`mobile/README.md`](mobile/README.md). Os arquivos `.env` não são versionados; use os `.env.example` como modelo.

## Observação

Este repositório contém apenas o código do artefato. Os relatórios de inspeção dos sistemas analisados e as capturas de tela estão nos apêndices do artigo, já tarjados. Os dados usados pelos comandos de demonstração (`seed_demo`) são fictícios.
