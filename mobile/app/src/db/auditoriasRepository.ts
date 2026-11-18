import { getDatabase } from './database';
import { cifrar, decifrar, ConteudoCifrado } from './crypto';
import { CHAVE_AUDITORIA_SELECIONADA } from './schema';
import { AuditoriaCache, CamposEtapa, EtapaCache } from '../models/Achado';

interface LinhaAuditoriaCache {
  uuid: string;
  nome_auditoria: string;
  orgao: string | null;
  status: string;
}

interface LinhaEtapaCache {
  uuid: string;
  auditoria_uuid: string;
  dados_cifrados: string;
  iv: string;
  hmac: string;
  pendente: number;
  excluida_local: number;
}

function paraAuditoria(linha: LinhaAuditoriaCache): AuditoriaCache {
  return { uuid: linha.uuid, nomeAuditoria: linha.nome_auditoria, orgao: linha.orgao, status: linha.status };
}

/** Serializa os campos de negócio de uma Etapa e cifra o blob — mesma cifra usada em operacoes_pendentes. */
export async function cifrarCamposEtapaCache(campos: CamposEtapa): Promise<ConteudoCifrado> {
  return cifrar(
    JSON.stringify({
      orientacao: campos.orientacao,
      documentos: campos.documentos,
      atividade: campos.atividade,
      situacao: campos.situacao,
      prazo: campos.prazo,
      metodo: campos.metodo,
    })
  );
}

/** Inverso de cifrarCamposEtapaCache — lança se o HMAC não bater (linha corrompida/adulterada). */
export async function decifrarCamposEtapaCache(conteudo: ConteudoCifrado): Promise<CamposEtapa> {
  const texto = await decifrar(conteudo);
  return JSON.parse(texto) as CamposEtapa;
}

/** Decifra uma linha — retorna null (e loga) em vez de derrubar a tela toda numa linha corrompida. */
async function paraEtapa(linha: LinhaEtapaCache): Promise<EtapaCache | null> {
  try {
    const campos = await decifrarCamposEtapaCache({ cifrado: linha.dados_cifrados, iv: linha.iv, hmac: linha.hmac });
    return {
      uuid: linha.uuid,
      auditoriaUuid: linha.auditoria_uuid,
      ...campos,
      pendente: !!linha.pendente,
      excluidaLocal: !!linha.excluida_local,
    };
  } catch {
    console.warn(`[db] etapa_cache ilegível/corrompida, uuid: ${linha.uuid}`);
    return null;
  }
}

/** Substitui a lista inteira (é sempre um pull completo, lista leve o suficiente para isso). */
export async function salvarAuditoriasCache(auditorias: AuditoriaCache[]): Promise<void> {
  const db = await getDatabase();
  const agora = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM auditorias_cache');
    for (const a of auditorias) {
      await db.runAsync(
        'INSERT INTO auditorias_cache (uuid, nome_auditoria, orgao, status, atualizado_em) VALUES (?, ?, ?, ?, ?)',
        [a.uuid, a.nomeAuditoria, a.orgao, a.status, agora]
      );
    }
  });
}

export async function listarAuditoriasCache(): Promise<AuditoriaCache[]> {
  const db = await getDatabase();
  const linhas = await db.getAllAsync<LinhaAuditoriaCache>('SELECT * FROM auditorias_cache ORDER BY nome_auditoria ASC');
  return linhas.map(paraAuditoria);
}

/**
 * Etapas só da auditoria selecionada — apaga o que havia da auditoria
 * anterior antes de repovoar (ver decisão "tamanho do banco offline" no
 * plano de integração). Para a auditoria ATUAL, só substitui linhas
 * `pendente = 0` (já confirmadas pelo servidor) — uma criação/edição/
 * exclusão local ainda não sincronizada não pode ser apagada por um pull
 * concorrente, senão a mudança do auditor em campo desapareceria antes de
 * ter chance de sincronizar.
 */
export async function salvarEtapasCache(auditoriaUuid: string, etapas: EtapaCache[]): Promise<void> {
  const db = await getDatabase();
  const agora = new Date().toISOString();
  // Cifra fora da transação — withTransactionAsync não deveria segurar o
  // lock do banco pela duração de chamadas assíncronas de crypto.
  const linhas = await Promise.all(
    etapas.map(async (e) => ({ etapa: e, cifrado: await cifrarCamposEtapaCache(e) }))
  );
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM etapas_cache WHERE auditoria_uuid != ? AND pendente = 0', [auditoriaUuid]);
    await db.runAsync('DELETE FROM etapas_cache WHERE auditoria_uuid = ? AND pendente = 0', [auditoriaUuid]);
    for (const { etapa: e, cifrado } of linhas) {
      await db.runAsync(
        `INSERT INTO etapas_cache
          (uuid, auditoria_uuid, dados_cifrados, iv, hmac, pendente, excluida_local, atualizado_em)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?)
         ON CONFLICT(uuid) DO UPDATE SET
           dados_cifrados = excluded.dados_cifrados, iv = excluded.iv, hmac = excluded.hmac,
           atualizado_em = excluded.atualizado_em
         WHERE etapas_cache.pendente = 0`,
        [e.uuid, e.auditoriaUuid, cifrado.cifrado, cifrado.iv, cifrado.hmac, agora]
      );
    }
  });
}

/** Ordem por prazo agora é feita em memória — não dá pra ORDER BY numa coluna cifrada; volume por auditoria é pequeno. */
export async function listarEtapasCache(auditoriaUuid: string): Promise<EtapaCache[]> {
  const db = await getDatabase();
  const linhas = await db.getAllAsync<LinhaEtapaCache>(
    'SELECT * FROM etapas_cache WHERE auditoria_uuid = ? AND excluida_local = 0',
    [auditoriaUuid]
  );
  const etapas = await Promise.all(linhas.map(paraEtapa));
  return etapas
    .filter((e): e is EtapaCache => e !== null)
    .sort((a, b) => {
      if (a.prazo === b.prazo) return 0;
      if (a.prazo === null) return -1;
      if (b.prazo === null) return 1;
      return a.prazo < b.prazo ? -1 : 1;
    });
}

export async function obterEtapaCache(uuid: string): Promise<EtapaCache | null> {
  const db = await getDatabase();
  const linha = await db.getFirstAsync<LinhaEtapaCache>(
    'SELECT * FROM etapas_cache WHERE uuid = ?',
    [uuid]
  );
  return linha ? paraEtapa(linha) : null;
}

/** Achados locais pendentes (não sincronizados) registrados contra uma Etapa — usado pro aviso ao excluir. */
export async function contarAchadosPendentesDaEtapa(etapaUuid: string): Promise<number> {
  const db = await getDatabase();
  const linha = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) as total FROM operacoes_pendentes
     WHERE tipo = 'achado_criar' AND alvo_uuid = ? AND sincronizado = 0
       AND conflito_id IS NULL AND abandonada = 0`,
    [etapaUuid]
  );
  return linha?.total ?? 0;
}

export async function definirAuditoriaSelecionada(uuid: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO sessao (chave, valor) VALUES (?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
    [CHAVE_AUDITORIA_SELECIONADA, uuid]
  );
}

export async function obterAuditoriaSelecionada(): Promise<string | null> {
  const db = await getDatabase();
  const linha = await db.getFirstAsync<{ valor: string }>(
    'SELECT valor FROM sessao WHERE chave = ?',
    [CHAVE_AUDITORIA_SELECIONADA]
  );
  return linha?.valor ?? null;
}
