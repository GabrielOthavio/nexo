/**
 * Esquema SQLite local do dispositivo (Offline-First).
 *
 * `operacoes_pendentes` guarda toda mutação capturada em campo antes da
 * sincronização — achado_criar, etapa_criar, etapa_editar, etapa_excluir —
 * numa fila ÚNICA, não uma por tipo. `hash_anterior`/`hash_atual`
 * implementam o encadeamento criptográfico (hash chaining, TCC seção 2.5/4):
 * cada registro referencia o hash do registro imediatamente anterior na
 * sequência de inserção local, de QUALQUER tipo, tornando qualquer
 * reordenação, remoção ou inserção retroativa detectável no momento da
 * sincronização — inclusive entre tipos diferentes (uma cadeia por tipo não
 * provaria nada sobre adulteração/reordenação entre elas).
 *
 * O hash é sempre calculado sobre o `payload` em TEXTO PLANO — a coluna
 * `payload_cifrado` guarda esse mesmo conteúdo (JSON inteiro, não campo a
 * campo) cifrado (AES-256-CTR + HMAC, ver crypto.ts) só para proteção em
 * repouso no arquivo do SQLite. O `tipo` da operação vive DENTRO do payload
 * hasheado (não é só a coluna `tipo`, que é uma cópia redundante só para
 * filtro barato) — adulterar o tipo de uma operação já enviável precisa ser
 * detectável pela cadeia, não só uma edição de coluna solta.
 *
 * `abandonada` marca uma operação DESCARTADA pelo auditor — rejeitada em
 * definitivo pelo servidor (RBAC negado, alvo inexistente etc.: um erro real,
 * não um conflito) e portanto sem chance de sincronizar nunca. A linha
 * PERMANECE na tabela: esta é uma trilha append-only encadeada por hash, e
 * apagar qualquer elo quebraria a cadeia inteira (verificarIntegridadeLocal
 * passaria a acusar corrupção). A operação abandonada também continua sendo
 * ENVIADA ao servidor (a cadeia não tem conceito de elo pulado — omiti-la
 * abriria uma lacuna que invalidaria todo o resto do lote); ela só vai marcada
 * para que o servidor valide o hash, avance a âncora e não aplique nada (ver
 * listarOperacoesPendentes e `abandonados` em sync.service.ts).
 *
 * `erro_definitivo` qualifica `erro_sincronizacao`: 1 quando o servidor
 * RESPONDEU recusando o item (RBAC negado, alvo inexistente — reenviar dá
 * sempre no mesmo), 0 quando nem houve resposta (sem sinal, timeout, conexão
 * caída — a próxima tentativa provavelmente passa). Só a primeira situação
 * habilita o descarte destrutivo na interface; sem essa coluna, uma queda de
 * sinal era apresentada ao auditor como "recusado pelo servidor".
 */
export const CREATE_TABLE_OPERACOES_PENDENTES = `
CREATE TABLE IF NOT EXISTS operacoes_pendentes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid                  TEXT NOT NULL UNIQUE,
  tipo                  TEXT NOT NULL,
  auditoria_uuid        TEXT NOT NULL,
  alvo_uuid             TEXT,
  payload_cifrado       TEXT NOT NULL,
  iv                    TEXT NOT NULL,
  hmac                  TEXT NOT NULL,
  criado_em             TEXT NOT NULL,
  hash_anterior         TEXT NOT NULL,
  hash_atual            TEXT NOT NULL UNIQUE,
  sincronizado          INTEGER NOT NULL DEFAULT 0,
  sincronizado_em       TEXT,
  entidade_django_uuid  TEXT,
  conflito_id           TEXT,
  erro_sincronizacao    TEXT,
  abandonada            INTEGER NOT NULL DEFAULT 0,
  erro_definitivo       INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Cache local (só neste dispositivo) das Auditorias em que o auditor está
 * envolvido — alimenta a tela de seleção. Não existe equivalente desta
 * tabela no servidor (o sync-backend não persiste nada disso, ver plano de
 * integração) — é puxada sob demanda via GET /sync/auditorias.
 */
export const CREATE_TABLE_AUDITORIAS_CACHE = `
CREATE TABLE IF NOT EXISTS auditorias_cache (
  uuid            TEXT PRIMARY KEY,
  nome_auditoria  TEXT NOT NULL,
  orgao           TEXT,
  status          TEXT NOT NULL,
  atualizado_em   TEXT NOT NULL
);
`;

/**
 * Cache local das etapas de UMA auditoria — só a atualmente selecionada.
 * `pendente` marca uma linha que reflete uma criação/edição LOCAL ainda não
 * confirmada pelo servidor — um pull (`salvarEtapasCache`) só substitui
 * linhas não-pendentes da auditoria atual, pra não apagar uma mudança local
 * ainda não sincronizada. `excluida_local` é soft-delete client-side: a
 * linha continua existindo até a exclusão ser confirmada pelo servidor, mas
 * some da listagem (`listarEtapasCache`).
 *
 * Os campos de negócio (orientacao, documentos, atividade, situacao, prazo,
 * metodo) vivem cifrados em `dados_cifrados` (mesma cifra AES-256-CTR +
 * HMAC de crypto.ts usada em `operacoes_pendentes`, JSON serializado antes
 * de cifrar) — sem isso, todo o conteúdo já sincronizado de uma auditoria
 * ficaria em texto puro no arquivo do SQLite, não só a fila pendente. `uuid`,
 * `auditoria_uuid`, `pendente`, `excluida_local` e `atualizado_em` ficam em
 * texto puro por serem metadados usados em `WHERE`/`ORDER BY` (não dá pra
 * indexar/filtrar em cima de uma coluna cifrada) e não serem sensíveis por
 * si só. Ver migração `migrarParaEsquemaV3EtapasCifradas` em database.ts.
 */
export const CREATE_TABLE_ETAPAS_CACHE = `
CREATE TABLE IF NOT EXISTS etapas_cache (
  uuid            TEXT PRIMARY KEY,
  auditoria_uuid  TEXT NOT NULL,
  dados_cifrados  TEXT NOT NULL,
  iv              TEXT NOT NULL,
  hmac            TEXT NOT NULL,
  pendente        INTEGER NOT NULL DEFAULT 0,
  excluida_local  INTEGER NOT NULL DEFAULT 0,
  atualizado_em   TEXT NOT NULL
);
`;

export const CREATE_TABLE_SESSAO = `
CREATE TABLE IF NOT EXISTS sessao (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

export const ALL_MIGRATIONS = [
  CREATE_TABLE_OPERACOES_PENDENTES,
  CREATE_TABLE_AUDITORIAS_CACHE,
  CREATE_TABLE_ETAPAS_CACHE,
  CREATE_TABLE_SESSAO,
];

/** Hash "gênesis" usado como hash_anterior do primeiro registro da cadeia local. */
export const HASH_GENESIS = '0'.repeat(64);

/** Chave usada na tabela `sessao` para guardar o uuid da auditoria selecionada. */
export const CHAVE_AUDITORIA_SELECIONADA = 'auditoria_selecionada_uuid';

/** Chave de controle da migração destrutiva de `achados_locais` para `operacoes_pendentes` (ver database.ts). */
export const CHAVE_ESQUEMA_V2_MIGRADO = 'esquema_v2_migrado';

/** Chave de controle da migração que passou a cifrar os campos de negócio de `etapas_cache` (ver database.ts). */
export const CHAVE_ESQUEMA_V3_ETAPAS_CIFRADAS = 'esquema_v3_etapas_cifradas';

/** Chave de controle da migração que adicionou `operacoes_pendentes.abandonada` (ver database.ts). */
export const CHAVE_ESQUEMA_V4_ABANDONO = 'esquema_v4_abandono';

/** Chave de controle da migração que adicionou `operacoes_pendentes.erro_definitivo` (ver database.ts). */
export const CHAVE_ESQUEMA_V5_ERRO_DEFINITIVO = 'esquema_v5_erro_definitivo';
