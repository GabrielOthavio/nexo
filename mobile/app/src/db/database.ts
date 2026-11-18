import * as SQLite from 'expo-sqlite';
import {
  ALL_MIGRATIONS,
  CREATE_TABLE_ETAPAS_CACHE,
  CREATE_TABLE_SESSAO,
  CHAVE_ESQUEMA_V2_MIGRADO,
  CHAVE_ESQUEMA_V3_ETAPAS_CIFRADAS,
  CHAVE_ESQUEMA_V4_ABANDONO,
  CHAVE_ESQUEMA_V5_ERRO_DEFINITIVO,
} from './schema';
import { cifrar } from './crypto';

/**
 * Memoiza a ABERTURA+migração, não só o resultado dela. Antes, o handle só
 * era guardado depois que todas as migrações terminavam, então duas chamadas
 * concorrentes no primeiro uso (ex.: o efeito de inicialização do App e a
 * primeira tela) passavam as duas pela guarda e rodavam a sequência de
 * migrações em paralelo sobre o mesmo arquivo. Guardando a PROMESSA em voo,
 * a segunda chamada só espera a primeira — mesmo padrão de
 * `obterOuCriarChave` (crypto.ts) e `obterDispositivoId` (dispositivoId.ts).
 */
let dbEmAbertura: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Migração destrutiva, não preservacionista: `achados_locais` (fila só de
 * Achado) e o `etapas_cache` antigo (sem orientacao/documentos/metodo/
 * pendente/excluida_local) são de uma versão anterior do esquema, anterior
 * à fila unificada `operacoes_pendentes`. Os dados ali são de teste/
 * desenvolvimento (pré-lançamento, sem usuário real em campo ainda) —
 * preservar hashes antigos copiando linhas criaria um formato de payload
 * legado vivendo pra sempre no código de reconstrução, para proteger dado
 * que ninguém precisa. Roda uma vez só (guardado por uma flag em `sessao`,
 * checada ANTES do loop normal de `ALL_MIGRATIONS` — `CREATE TABLE IF NOT
 * EXISTS` não alteraria uma tabela já existente com o esquema antigo).
 */
async function migrarParaEsquemaV2(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(CREATE_TABLE_SESSAO);

  const flag = await db.getFirstAsync<{ valor: string }>(
    'SELECT valor FROM sessao WHERE chave = ?',
    [CHAVE_ESQUEMA_V2_MIGRADO]
  );
  if (flag) return;

  await db.withTransactionAsync(async () => {
    await db.execAsync('DROP TABLE IF EXISTS achados_locais;');
    await db.execAsync('DROP TABLE IF EXISTS etapas_cache;');
    await db.runAsync(
      `INSERT INTO sessao (chave, valor) VALUES (?, '1')
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      [CHAVE_ESQUEMA_V2_MIGRADO]
    );
  });
}

interface LinhaEtapaCacheV2 {
  uuid: string;
  auditoria_uuid: string;
  orientacao: string;
  documentos: string;
  atividade: string;
  situacao: string;
  prazo: string | null;
  metodo: string;
  pendente: number;
  excluida_local: number;
  atualizado_em: string;
}

/**
 * Passa os campos de negócio de `etapas_cache` (orientacao, documentos,
 * atividade, situacao, prazo, metodo — antes em colunas de texto puro) para
 * um único blob cifrado (`dados_cifrados`/`iv`/`hmac`, ver schema.ts). Roda
 * uma vez só, guardada pela flag `esquema_v3_etapas_cifradas` em `sessao`.
 * Preserva as linhas existentes (inclusive `pendente = 1`, trabalho local
 * ainda não sincronizado) em vez de uma migração destrutiva — diferente da
 * v2, aqui pode haver edição de campo real em andamento.
 */
async function migrarParaEsquemaV3EtapasCifradas(db: SQLite.SQLiteDatabase): Promise<void> {
  const flag = await db.getFirstAsync<{ valor: string }>(
    'SELECT valor FROM sessao WHERE chave = ?',
    [CHAVE_ESQUEMA_V3_ETAPAS_CIFRADAS]
  );
  if (flag) return;

  const marcarMigrado = () =>
    db.runAsync(
      `INSERT INTO sessao (chave, valor) VALUES (?, '1')
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      [CHAVE_ESQUEMA_V3_ETAPAS_CIFRADAS]
    );

  const tabela = await db.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'etapas_cache'"
  );
  if (!tabela) {
    // Instalação nova — ALL_MIGRATIONS já cria etapas_cache no formato cifrado atual.
    await marcarMigrado();
    return;
  }

  const colunas = await db.getAllAsync<{ name: string }>('PRAGMA table_info(etapas_cache)');
  if (colunas.some((c) => c.name === 'dados_cifrados')) {
    await marcarMigrado();
    return;
  }

  const linhasAntigas = await db.getAllAsync<LinhaEtapaCacheV2>('SELECT * FROM etapas_cache');
  const linhasCifradas = await Promise.all(
    linhasAntigas.map(async (linha) => ({
      linha,
      cifrado: await cifrar(
        JSON.stringify({
          orientacao: linha.orientacao,
          documentos: linha.documentos,
          atividade: linha.atividade,
          situacao: linha.situacao,
          prazo: linha.prazo,
          metodo: linha.metodo,
        })
      ),
    }))
  );

  await db.withTransactionAsync(async () => {
    await db.execAsync('ALTER TABLE etapas_cache RENAME TO etapas_cache_v2_antiga;');
    await db.execAsync(CREATE_TABLE_ETAPAS_CACHE);
    for (const { linha, cifrado } of linhasCifradas) {
      await db.runAsync(
        `INSERT INTO etapas_cache (uuid, auditoria_uuid, dados_cifrados, iv, hmac, pendente, excluida_local, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          linha.uuid,
          linha.auditoria_uuid,
          cifrado.cifrado,
          cifrado.iv,
          cifrado.hmac,
          linha.pendente,
          linha.excluida_local,
          linha.atualizado_em,
        ]
      );
    }
    await db.execAsync('DROP TABLE etapas_cache_v2_antiga;');
    await marcarMigrado();
  });
}

/**
 * Adiciona `operacoes_pendentes.abandonada` (ver schema.ts) — a flag que
 * permite DESCARTAR uma operação rejeitada em definitivo pelo servidor sem
 * apagar a linha (a cadeia de hashes é append-only), destravando a fila FIFO
 * que ela bloqueava. Roda uma vez só, guardada pela flag `esquema_v4_abandono`
 * em `sessao`. Puramente aditiva: `ALTER TABLE ... ADD COLUMN` com DEFAULT 0
 * preserva todas as linhas e não toca em hash algum — diferente da v3, não há
 * recriação de tabela.
 */
async function migrarParaEsquemaV4Abandono(db: SQLite.SQLiteDatabase): Promise<void> {
  const flag = await db.getFirstAsync<{ valor: string }>(
    'SELECT valor FROM sessao WHERE chave = ?',
    [CHAVE_ESQUEMA_V4_ABANDONO]
  );
  if (flag) return;

  const marcarMigrado = () =>
    db.runAsync(
      `INSERT INTO sessao (chave, valor) VALUES (?, '1')
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      [CHAVE_ESQUEMA_V4_ABANDONO]
    );

  const tabela = await db.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operacoes_pendentes'"
  );
  if (!tabela) {
    // Instalação nova — ALL_MIGRATIONS já cria a tabela com a coluna.
    await marcarMigrado();
    return;
  }

  const colunas = await db.getAllAsync<{ name: string }>('PRAGMA table_info(operacoes_pendentes)');
  if (colunas.some((c) => c.name === 'abandonada')) {
    await marcarMigrado();
    return;
  }

  await db.withTransactionAsync(async () => {
    await db.execAsync(
      'ALTER TABLE operacoes_pendentes ADD COLUMN abandonada INTEGER NOT NULL DEFAULT 0;'
    );
    await marcarMigrado();
  });
}

/**
 * Adiciona `operacoes_pendentes.erro_definitivo` (ver schema.ts) — o
 * qualificador que separa uma RECUSA do servidor de uma falha de transporte,
 * hoje indistinguíveis em `erro_sincronizacao`. Sem ele, uma queda de sinal
 * levava a interface a afirmar que o servidor recusou o registro e a oferecer
 * o descarte destrutivo. Roda uma vez só, guardada pela flag
 * `esquema_v5_erro_definitivo` em `sessao`. Puramente aditiva, como a v4:
 * `ALTER TABLE ... ADD COLUMN` com DEFAULT 0 preserva todas as linhas (as
 * antigas passam a valer como "não definitivo", que é o padrão conservador —
 * na dúvida, não oferecer descarte) e não toca em hash algum.
 */
async function migrarParaEsquemaV5ErroDefinitivo(db: SQLite.SQLiteDatabase): Promise<void> {
  const flag = await db.getFirstAsync<{ valor: string }>(
    'SELECT valor FROM sessao WHERE chave = ?',
    [CHAVE_ESQUEMA_V5_ERRO_DEFINITIVO]
  );
  if (flag) return;

  const marcarMigrado = () =>
    db.runAsync(
      `INSERT INTO sessao (chave, valor) VALUES (?, '1')
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      [CHAVE_ESQUEMA_V5_ERRO_DEFINITIVO]
    );

  const tabela = await db.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operacoes_pendentes'"
  );
  if (!tabela) {
    // Instalação nova — ALL_MIGRATIONS já cria a tabela com a coluna.
    await marcarMigrado();
    return;
  }

  const colunas = await db.getAllAsync<{ name: string }>('PRAGMA table_info(operacoes_pendentes)');
  if (colunas.some((c) => c.name === 'erro_definitivo')) {
    await marcarMigrado();
    return;
  }

  await db.withTransactionAsync(async () => {
    await db.execAsync(
      'ALTER TABLE operacoes_pendentes ADD COLUMN erro_definitivo INTEGER NOT NULL DEFAULT 0;'
    );
    await marcarMigrado();
  });
}

/**
 * Abre (ou reaproveita) a conexão com o banco SQLite local do dispositivo
 * e garante que o esquema esteja criado. Chamado uma vez na inicialização
 * do app, antes de qualquer tela que leia/grave dados offline.
 */
export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbEmAbertura) {
    dbEmAbertura = (async () => {
      const db = await SQLite.openDatabaseAsync('controladoria_campo.db');
      await db.execAsync('PRAGMA journal_mode = WAL;');
      await db.execAsync('PRAGMA foreign_keys = ON;');

      await migrarParaEsquemaV2(db);
      await migrarParaEsquemaV3EtapasCifradas(db);
      await migrarParaEsquemaV4Abandono(db);
      await migrarParaEsquemaV5ErroDefinitivo(db);
      for (const migration of ALL_MIGRATIONS) {
        await db.execAsync(migration);
      }

      return db;
    })();
    // Uma falha não pode ficar memoizada para sempre — solta a promessa para
    // que a próxima chamada tente abrir de novo (mesmo tratamento de crypto.ts).
    dbEmAbertura.catch(() => {
      dbEmAbertura = null;
    });
  }
  return dbEmAbertura;
}

/** Uso exclusivo de testes — força reabertura do banco. */
export function _resetDatabaseHandle(): void {
  dbEmAbertura = null;
}
