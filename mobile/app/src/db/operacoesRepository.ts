import * as Crypto from 'expo-crypto';
import { getDatabase } from './database';
import { calcularProximoHash, verificarCadeia, EloDaCadeia } from './hashChain';
import { cifrar, decifrar, ConteudoCifrado } from './crypto';
import { cifrarCamposEtapaCache, decifrarCamposEtapaCache } from './auditoriasRepository';
import { HASH_GENESIS } from './schema';
import {
  AchadoLocal,
  CamposEtapa,
  NovoAchadoInput,
  NovaEtapaInput,
  OperacaoLocal,
  TipoOperacao,
} from '../models/Achado';

interface LinhaOperacaoPendente {
  id: number;
  uuid: string;
  tipo: TipoOperacao;
  auditoria_uuid: string;
  alvo_uuid: string | null;
  payload_cifrado: string;
  iv: string;
  hmac: string;
  criado_em: string;
  hash_anterior: string;
  hash_atual: string;
  sincronizado: number;
  sincronizado_em: string | null;
  entidade_django_uuid: string | null;
  conflito_id: string | null;
  erro_sincronizacao: string | null;
  erro_definitivo: number;
  abandonada: number;
}

async function paraModelo(linha: LinhaOperacaoPendente): Promise<OperacaoLocal> {
  const payload = await decifrar({ cifrado: linha.payload_cifrado, iv: linha.iv, hmac: linha.hmac });
  return {
    id: linha.id,
    uuid: linha.uuid,
    tipo: linha.tipo,
    auditoriaUuid: linha.auditoria_uuid,
    alvoUuid: linha.alvo_uuid,
    payload,
    criadoEm: linha.criado_em,
    hashAnterior: linha.hash_anterior,
    hashAtual: linha.hash_atual,
    sincronizado: !!linha.sincronizado,
    sincronizadoEm: linha.sincronizado_em,
    entidadeDjangoUuid: linha.entidade_django_uuid,
    conflitoId: linha.conflito_id,
    erroSincronizacao: linha.erro_sincronizacao,
    erroDefinitivo: !!linha.erro_definitivo,
    abandonada: !!linha.abandonada,
  };
}

/** Retorna o hash_atual do último registro inserido (de QUALQUER tipo), ou o hash gênesis se a cadeia estiver vazia. */
async function obterUltimoHash(): Promise<string> {
  const db = await getDatabase();
  const ultimo = await db.getFirstAsync<{ hash_atual: string }>(
    'SELECT hash_atual FROM operacoes_pendentes ORDER BY id DESC LIMIT 1'
  );
  return ultimo?.hash_atual ?? HASH_GENESIS;
}

/**
 * Serializa as inserções na cadeia: ler o último hash e inserir o novo elo
 * precisa ser atômico entre chamadas concorrentes — duas inserções lendo o
 * mesmo hash_anterior criariam um "garfo" na cadeia, que verificarCadeia
 * reportaria como corrupção e bloquearia a sincronização permanentemente.
 */
let filaInsercao: Promise<unknown> = Promise.resolve();

/**
 * Insere uma operação na fila unificada — usada pelos 4 tipos
 * (achado_criar, etapa_criar, etapa_editar, etapa_excluir). O hash é
 * calculado sobre o `payload` em TEXTO PLANO (hashChain.ts é genérico e não
 * muda); só depois disso o payload inteiro é cifrado como um blob único
 * (cifrar()/decifrar() já são agnósticas ao formato do texto — não há
 * necessidade de decidir campo a campo o que é "sensível" por tipo).
 */
function inserirOperacaoLocal(
  tipo: TipoOperacao,
  payloadObjeto: Record<string, unknown>,
  auditoriaUuid: string,
  alvoUuid: string | null
): Promise<{ uuid: string; criadoEm: string }> {
  const resultado = filaInsercao.then(
    () => executarInsercaoOperacaoLocal(tipo, payloadObjeto, auditoriaUuid, alvoUuid),
    () => executarInsercaoOperacaoLocal(tipo, payloadObjeto, auditoriaUuid, alvoUuid)
  );
  filaInsercao = resultado.catch(() => {});
  return resultado;
}

async function executarInsercaoOperacaoLocal(
  tipo: TipoOperacao,
  payloadObjeto: Record<string, unknown>,
  auditoriaUuid: string,
  alvoUuid: string | null
): Promise<{ uuid: string; criadoEm: string }> {
  const db = await getDatabase();
  const uuid = Crypto.randomUUID();
  const criadoEm = new Date().toISOString();
  const payload = JSON.stringify({ tipo, ...payloadObjeto });

  const hashAnterior = await obterUltimoHash();
  const hashAtual = await calcularProximoHash(hashAnterior, { uuid, payload, criadoEm });

  const { cifrado, iv, hmac } = await cifrar(payload);

  await db.runAsync(
    `INSERT INTO operacoes_pendentes
      (uuid, tipo, auditoria_uuid, alvo_uuid, payload_cifrado, iv, hmac,
       criado_em, hash_anterior, hash_atual, sincronizado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [uuid, tipo, auditoriaUuid, alvoUuid, cifrado, iv, hmac, criadoEm, hashAnterior, hashAtual]
  );

  return { uuid, criadoEm };
}

export async function criarAchadoLocal(input: NovoAchadoInput, auditoriaUuid: string): Promise<void> {
  await inserirOperacaoLocal(
    'achado_criar',
    { etapaUuid: input.etapaUuid, descricao: input.descricao },
    auditoriaUuid,
    input.etapaUuid
  );
}

/**
 * Cria uma Etapa offline. O uuid da própria operação vira o uuid TEMPORÁRIO
 * da Etapa no cache local (etapas_cache) — até a sincronização confirmar e
 * reescrever pelo id_unico real do Django (ver marcarOperacaoComoSincronizada
 * em syncService.ts). Um Achado pode ser registrado contra essa Etapa antes
 * mesmo dela sincronizar (referenciando esse mesmo uuid temporário) — o
 * NestJS resolve isso corretamente na hora do push (ver sync.service.ts).
 */
export async function criarEtapaLocal(input: NovaEtapaInput, auditoriaUuid: string): Promise<string> {
  const db = await getDatabase();
  const { uuid, criadoEm } = await inserirOperacaoLocal(
    'etapa_criar',
    { auditoriaUuid, campos: input },
    auditoriaUuid,
    null
  );

  const cifrado = await cifrarCamposEtapaCache(input);
  await db.runAsync(
    `INSERT INTO etapas_cache
      (uuid, auditoria_uuid, dados_cifrados, iv, hmac, pendente, excluida_local, atualizado_em)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
    [uuid, auditoriaUuid, cifrado.cifrado, cifrado.iv, cifrado.hmac, criadoEm]
  );

  return uuid;
}

/**
 * Edita uma Etapa offline. O `baseline` é lido do cache local NO MOMENTO da
 * edição (o estado que o dispositivo achava ser verdade) — o Django compara
 * isso contra o estado real no servidor na hora do push; se divergir
 * (alguém mudou a Etapa nesse meio-tempo, de onde for), vira conflito, não
 * é aplicado silenciosamente (ver plano de integração fase 2).
 */
export async function editarEtapaLocal(etapaUuid: string, novosCampos: CamposEtapa): Promise<void> {
  const db = await getDatabase();
  const atual = await db.getFirstAsync<{
    dados_cifrados: string; iv: string; hmac: string; auditoria_uuid: string;
  }>(
    'SELECT dados_cifrados, iv, hmac, auditoria_uuid FROM etapas_cache WHERE uuid = ?',
    [etapaUuid]
  );
  if (!atual) throw new Error('Etapa não encontrada no cache local.');

  const baseline = await decifrarCamposEtapaCache({ cifrado: atual.dados_cifrados, iv: atual.iv, hmac: atual.hmac });

  await inserirOperacaoLocal(
    'etapa_editar',
    { etapaUuid, baseline, campos: novosCampos },
    atual.auditoria_uuid,
    etapaUuid
  );

  const cifradoNovo = await cifrarCamposEtapaCache(novosCampos);
  await db.runAsync(
    `UPDATE etapas_cache SET dados_cifrados = ?, iv = ?, hmac = ?, pendente = 1, atualizado_em = ? WHERE uuid = ?`,
    [cifradoNovo.cifrado, cifradoNovo.iv, cifradoNovo.hmac, new Date().toISOString(), etapaUuid]
  );
}

export async function excluirEtapaLocal(etapaUuid: string): Promise<void> {
  const db = await getDatabase();
  const atual = await db.getFirstAsync<{ auditoria_uuid: string }>(
    'SELECT auditoria_uuid FROM etapas_cache WHERE uuid = ?', [etapaUuid]
  );
  if (!atual) throw new Error('Etapa não encontrada no cache local.');

  await inserirOperacaoLocal('etapa_excluir', { etapaUuid }, atual.auditoria_uuid, etapaUuid);

  // pendente=1 protege a linha de ser "ressuscitada" por um pull concorrente
  // antes da exclusão sincronizar (salvarEtapasCache só substitui linhas
  // não-pendentes) — excluida_local=1 já esconde da listagem imediatamente.
  await db.runAsync(
    'UPDATE etapas_cache SET excluida_local = 1, pendente = 1 WHERE uuid = ?',
    [etapaUuid]
  );
}

export async function listarOperacoesPendentes(apenasNaoSincronizadas = false): Promise<OperacaoLocal[]> {
  const db = await getDatabase();
  // Operações já marcadas com conflito não são reenviadas (reenviar o mesmo
  // baseline defasado só geraria o mesmo conflito de novo) — ficam de fora
  // mesmo estando "não sincronizadas" no sentido estrito.
  //
  // As ABANDONADAS (descartadas pelo auditor, ver abandonarOperacao) NÃO são
  // excluídas aqui, de propósito: a cadeia de hashes é estritamente contígua e
  // não tem conceito de "pular" um elo — omitir uma operação abandonada do
  // envio faria o `hashAnterior` da operação SEGUINTE não bater com o que o
  // servidor espera, e validarCadeia rejeitaria o lote inteiro nesse índice,
  // para sempre (todo retry reproduz a mesma lacuna). Elas seguem no fio, mas
  // marcadas com `abandonada: true` no wire — o servidor valida o hash, avança
  // a âncora e NÃO aplica nada (ver sync.service.ts push()), devolvendo o uuid
  // em `abandonados`; o app então grava `sincronizado = 1` nelas (ver
  // marcarOperacaoComoAbandonadaConfirmada), que é o que de fato as tira dos
  // lotes futuros.
  const where = apenasNaoSincronizadas
    ? 'WHERE sincronizado = 0 AND conflito_id IS NULL'
    : '';
  const linhas = await db.getAllAsync<LinhaOperacaoPendente>(
    `SELECT * FROM operacoes_pendentes ${where} ORDER BY id ASC`
  );
  return Promise.all(linhas.map(paraModelo));
}

/** Compat com telas existentes — acha só as operações do tipo achado_criar de uma auditoria. */
export async function listarAchadosLocais(apenasNaoSincronizados = false, auditoriaUuid?: string): Promise<AchadoLocal[]> {
  const operacoes = await listarOperacoesPendentes(false);
  return operacoes
    .filter((op) => op.tipo === 'achado_criar' && (!auditoriaUuid || op.auditoriaUuid === auditoriaUuid) && (!apenasNaoSincronizados || !op.sincronizado))
    .flatMap((op) => {
      let payload: { etapaUuid: string; descricao: string };
      try {
        payload = JSON.parse(op.payload) as { etapaUuid: string; descricao: string };
      } catch {
        // Payload corrompido não pode derrubar a listagem inteira — pula só este item.
        console.warn(`[db] payload ilegível em operacoes_pendentes, uuid: ${op.uuid}`);
        return [];
      }
      return [{
        id: op.id,
        uuid: op.uuid,
        etapaUuid: payload.etapaUuid,
        auditoriaUuid: op.auditoriaUuid,
        descricao: payload.descricao,
        criadoEm: op.criadoEm,
        sincronizado: op.sincronizado,
        sincronizadoEm: op.sincronizadoEm,
        achadoDjangoUuid: op.entidadeDjangoUuid,
        erroSincronizacao: op.erroSincronizacao,
        erroDefinitivo: op.erroDefinitivo,
        abandonada: op.abandonada,
      }];
    });
}

/**
 * Reconcilia `etapas_cache` de acordo com o tipo da operação confirmada:
 * `etapa_criar` reescreve o uuid temporário local pelo id_unico real do
 * Django diretamente (não espera o próximo pull resolver — evitaria linha
 * órfã duplicada); `etapa_editar` só limpa a flag `pendente`; `etapa_excluir`
 * remove a linha de vez; `achado_criar` não mexe em `etapas_cache`.
 *
 * Se a operação já tiver sido ABANDONADA pelo auditor antes desta resposta
 * chegar (o descarte aconteceu com um envio em voo, ver abandonarOperacao),
 * os efeitos em `etapas_cache` são PULADOS: abandonarOperacao já reverteu o
 * estado local de forma síncrona e reaplicar aqui ressuscitaria exatamente o
 * que o auditor acabou de desfazer. A escrituração em `operacoes_pendentes`
 * (sincronizado/entidade_django_uuid) é gravada de qualquer forma — é
 * inofensiva e mantém a linha fora dos lotes futuros.
 */
export async function marcarOperacaoComoSincronizada(
  uuid: string,
  tipo: TipoOperacao,
  entidadeDjangoUuid: string
): Promise<void> {
  const db = await getDatabase();

  const linha = await db.getFirstAsync<{ abandonada: number }>(
    'SELECT abandonada FROM operacoes_pendentes WHERE uuid = ?',
    [uuid]
  );
  const foiAbandonada = !!linha?.abandonada;

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE operacoes_pendentes SET sincronizado = 1, sincronizado_em = ?, entidade_django_uuid = ?, erro_sincronizacao = NULL WHERE uuid = ?',
      [new Date().toISOString(), entidadeDjangoUuid, uuid]
    );
    if (tipo === 'etapa_criar') {
      if (!foiAbandonada) {
        // etapas_cache.uuid é PRIMARY KEY: se um pull (salvarEtapasCache) já
        // trouxe a Etapa recém-criada do servidor sob o uuid REAL enquanto a
        // linha temporária ainda esperava confirmação, o rename abaixo violaria
        // a chave primária, lançaria, e o withTransactionAsync inteiro faria
        // rollback — inclusive do `sincronizado = 1` acima, repetindo o mesmo
        // erro em todo retry, para sempre. A linha TEMPORÁRIA é a autoritativa
        // (pode carregar edições locais pendentes que a cópia puxada não tem),
        // então a duplicata puxada é removida antes do rename. O `uuid != ?` é
        // defensivo, para o caso (que não deveria ocorrer) dos dois uuids serem
        // iguais — aí não há duplicata a apagar.
        await db.runAsync('DELETE FROM etapas_cache WHERE uuid = ? AND uuid != ?', [entidadeDjangoUuid, uuid]);
        await db.runAsync('UPDATE etapas_cache SET uuid = ?, pendente = 0 WHERE uuid = ?', [entidadeDjangoUuid, uuid]);
      }
      // Outras operações já enfileiradas podem apontar para o uuid TEMPORÁRIO
      // desta Etapa (ex.: um achado_criar registrado antes dela sincronizar).
      // Repontar alvo_uuid para o uuid real mantém consultas por Etapa
      // corretas (ver contarAchadosPendentesDaEtapa), que passam a usar o uuid
      // novo. Só UPDATE de coluna — a cadeia de hash cobre payload/criado_em,
      // nunca alvo_uuid, então a integridade da trilha não é afetada.
      await db.runAsync('UPDATE operacoes_pendentes SET alvo_uuid = ? WHERE alvo_uuid = ?', [entidadeDjangoUuid, uuid]);
    } else if (tipo === 'etapa_editar' && !foiAbandonada) {
      const resultado = await db.runAsync('UPDATE etapas_cache SET pendente = 0 WHERE uuid = ?', [entidadeDjangoUuid]);
      if (resultado.changes === 0) {
        // Cache local (etapas_cache) fora de sincronia com a ordem de confirmação —
        // não afeta a trilha de auditoria (operacoes_pendentes, já gravada acima).
        console.warn(`[sync] etapa_editar confirmada mas não encontrada em etapas_cache: ${entidadeDjangoUuid}`);
      }
    } else if (tipo === 'etapa_excluir' && !foiAbandonada) {
      const resultado = await db.runAsync('DELETE FROM etapas_cache WHERE uuid = ?', [entidadeDjangoUuid]);
      if (resultado.changes === 0) {
        console.warn(`[sync] etapa_excluir confirmada mas não encontrada em etapas_cache: ${entidadeDjangoUuid}`);
      }
    }
  });
}

/**
 * Marca uma operação como terminada em conflito — não será reenviada (ver
 * listarOperacoesPendentes).
 *
 * Para `etapa_editar` (único tipo que pode conflitar: achado_criar/etapa_criar
 * são idempotentes via get_or_create no Django e etapa_excluir trata "já
 * excluída" como sucesso), reverte também `etapas_cache` para o `baseline` da
 * própria operação — o último estado conhecido-bom, anterior à edição
 * rejeitada. Sem isso o cache ficaria envenenado: continuaria exibindo valores
 * que o servidor recusou, `pendente = 1` bloquearia todo pull futuro de
 * atualizar a linha (salvarEtapasCache só substitui linhas não-pendentes), e
 * uma nova edição leria o baseline envenenado — gerando o mesmo conflito
 * indefinidamente. Limpar `pendente` reabre a linha para os pulls seguintes,
 * inclusive para trazer a resolução feita no sistema web.
 *
 * O alvo em `etapas_cache` é resolvido por `alvo_uuid`, com queda para o
 * `etapaUuid` do payload — mesma ordem de abandonarOperacao, e pelo mesmo
 * motivo: `alvo_uuid` é repontado para o id_unico real quando uma Etapa criada
 * offline sincroniza (ver marcarOperacaoComoSincronizada), enquanto o payload
 * guarda o uuid TEMPORÁRIO congelado no momento da captura — reverter pelo
 * payload erraria o alvo para toda Etapa nascida offline.
 *
 * Duas operações conflitadas sobre a MESMA Etapa no mesmo push (A mais antiga,
 * B mais nova) reverteriam o cache uma por cima da outra, e a última a rodar
 * (B) deixaria como estado "limpo" o baseline de B — que é exatamente o
 * `campos` que o servidor recusou em A. Por isso a reversão só é escrita se a
 * linha alvo ainda estiver com `pendente = 1`: a reversão da PRIMEIRA operação
 * conflitada (a mais antiga, a única cujo baseline o servidor de fato já
 * conheceu) zera `pendente` e passa a valer; as seguintes só registram o
 * `conflito_id` e não tocam mais no cache.
 */
export async function marcarOperacaoComoConflito(uuid: string, conflitoId: string): Promise<void> {
  const db = await getDatabase();

  const linha = await db.getFirstAsync<{
    tipo: TipoOperacao; alvo_uuid: string | null;
    payload_cifrado: string; iv: string; hmac: string; abandonada: number;
  }>(
    'SELECT tipo, alvo_uuid, payload_cifrado, iv, hmac, abandonada FROM operacoes_pendentes WHERE uuid = ?',
    [uuid]
  );

  // Reversão do cache só se aplica a etapa_editar; qualquer outro tipo (ou
  // payload ilegível) cai no comportamento original de só marcar o conflito.
  // Se a operação já foi ABANDONADA pelo auditor antes desta resposta chegar
  // (descarte com um envio em voo), abandonarOperacao já reverteu o cache de
  // forma síncrona — reaplicar aqui reescreveria o que ele acabou de desfazer.
  let reversao: { etapaUuid: string; cifrado: ConteudoCifrado } | null = null;
  if (linha && linha.tipo === 'etapa_editar' && !linha.abandonada) {
    try {
      const texto = await decifrar({ cifrado: linha.payload_cifrado, iv: linha.iv, hmac: linha.hmac });
      const payload = JSON.parse(texto) as { etapaUuid: string; baseline: CamposEtapa; campos: CamposEtapa };
      const etapaAlvo = linha.alvo_uuid ?? payload.etapaUuid ?? null;
      if (etapaAlvo && payload.baseline) {
        // Cifra FORA da transação — não segurar o lock do banco durante crypto assíncrona.
        reversao = { etapaUuid: etapaAlvo, cifrado: await cifrarCamposEtapaCache(payload.baseline) };
      }
    } catch {
      console.warn(`[sync] payload ilegível ao reverter baseline do conflito, uuid: ${uuid}`);
    }
  }

  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE operacoes_pendentes SET conflito_id = ? WHERE uuid = ?', [conflitoId, uuid]);
    if (reversao) {
      const alvo = await db.getFirstAsync<{ pendente: number }>(
        'SELECT pendente FROM etapas_cache WHERE uuid = ?',
        [reversao.etapaUuid]
      );
      if (!alvo) {
        // Linha já não existe no cache local — não afeta a trilha de auditoria
        // (operacoes_pendentes, já gravada acima).
        console.warn(`[sync] conflito de etapa_editar mas etapa ausente em etapas_cache: ${reversao.etapaUuid}`);
        return;
      }
      if (!alvo.pendente) {
        // Já está num estado limpo — tipicamente a reversão de um conflito
        // ANTERIOR (mais antigo) sobre esta mesma Etapa, nesta mesma rodada.
        // Sobrescrever agora plantaria como "confirmado" um baseline que o
        // servidor recusou.
        return;
      }
      await db.runAsync(
        `UPDATE etapas_cache SET dados_cifrados = ?, iv = ?, hmac = ?, pendente = 0, atualizado_em = ? WHERE uuid = ?`,
        [
          reversao.cifrado.cifrado,
          reversao.cifrado.iv,
          reversao.cifrado.hmac,
          new Date().toISOString(),
          reversao.etapaUuid,
        ]
      );
    }
  });
}

/**
 * DESCARTA em definitivo uma operação que o servidor rejeitou com um erro
 * real (RBAC negado, alvo inexistente etc. — não um conflito, que tem
 * tratamento próprio em marcarOperacaoComoConflito). Sem isso, essa operação
 * fica eternamente na cabeça da fila FIFO: ela não é excluída do reenvio
 * (só `conflito_id` faz isso), então toda sincronização seguinte para nela e
 * TODOS os itens enfileirados atrás nunca sobem.
 *
 * A linha NUNCA é apagada de `operacoes_pendentes` — a trilha é append-only e
 * encadeada por hash; remover um elo faria `verificarIntegridadeLocal` acusar
 * corrupção e bloquear a sincronização de vez. Só a flag `abandonada` muda, e
 * a cadeia (hash_anterior/hash_atual/payload/criado_em) fica intocada.
 *
 * Reverte também o estado local otimista que a operação tinha criado, por
 * tipo — mesma responsabilidade (e mesmos helpers) de
 * marcarOperacaoComoConflito, senão `etapas_cache` ficaria mostrando para
 * sempre uma mudança que o servidor nunca aceitou, com `pendente = 1`
 * impedindo qualquer pull futuro de corrigir a linha.
 *
 * O alvo em `etapas_cache` é resolvido por `alvo_uuid` (e não pelo
 * `etapaUuid` de dentro do payload, como faz marcarOperacaoComoConflito):
 * `alvo_uuid` é repontado para o id_unico real quando a Etapa criada offline
 * sincroniza (ver marcarOperacaoComoSincronizada), então é o ponteiro atual;
 * o payload guarda o uuid temporário congelado no momento da captura. Cai
 * para o payload quando `alvo_uuid` é nulo.
 *
 * Se, quando o toque do usuário chega, a operação JÁ tiver sido resolvida por
 * uma resposta de sincronização em voo (`sincronizado = 1` ou `conflito_id`
 * preenchido), a função não faz nada: reverter agora desfaria no cache local
 * uma mudança que o servidor de fato aceitou, ou plantaria por cima da
 * reversão de conflito o baseline errado. Não é erro — é uma corrida benigna
 * cujo desfecho já é o "não está mais travando a fila" que o descarte
 * buscava —, então não lança (diferente de "operação não encontrada", que
 * indica estado impossível); a tela recarrega e mostra o estado real.
 */
export async function abandonarOperacao(uuid: string): Promise<void> {
  const db = await getDatabase();

  const linha = await db.getFirstAsync<{
    tipo: TipoOperacao; alvo_uuid: string | null;
    payload_cifrado: string; iv: string; hmac: string;
    sincronizado: number; conflito_id: string | null;
  }>(
    'SELECT tipo, alvo_uuid, payload_cifrado, iv, hmac, sincronizado, conflito_id FROM operacoes_pendentes WHERE uuid = ?',
    [uuid]
  );
  if (!linha) throw new Error('Operação não encontrada.');

  if (linha.sincronizado || linha.conflito_id) {
    console.warn(`[db] descarte ignorado: operação já resolvida pelo servidor, uuid: ${uuid}`);
    return;
  }

  let payload: { etapaUuid?: string; baseline?: CamposEtapa } = {};
  try {
    const texto = await decifrar({ cifrado: linha.payload_cifrado, iv: linha.iv, hmac: linha.hmac });
    payload = JSON.parse(texto) as { etapaUuid?: string; baseline?: CamposEtapa };
  } catch {
    // Payload ilegível não pode impedir o descarte — sem ele só não dá para
    // reverter o baseline de uma edição; a flag `abandonada` (o que de fato
    // destrava a fila) é aplicada de qualquer forma.
    console.warn(`[db] payload ilegível ao abandonar operação, uuid: ${uuid}`);
  }

  // Para etapa_criar o alvo é o uuid da PRÓPRIA operação (é ele que vira o
  // uuid temporário da Etapa em etapas_cache, ver criarEtapaLocal).
  const etapaAlvo =
    linha.tipo === 'etapa_criar' ? uuid : linha.alvo_uuid ?? payload.etapaUuid ?? null;

  // Cifra FORA da transação — não segurar o lock do banco durante crypto assíncrona.
  let baselineCifrado: ConteudoCifrado | null = null;
  if (linha.tipo === 'etapa_editar' && payload.baseline) {
    baselineCifrado = await cifrarCamposEtapaCache(payload.baseline);
  }

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE operacoes_pendentes SET abandonada = 1 WHERE uuid = ?',
      [uuid]
    );
    if (!etapaAlvo) return;

    if (linha.tipo === 'etapa_criar') {
      // Essa Etapa nunca existiu no servidor e agora nunca vai existir —
      // apagamos a linha do CACHE (nunca a de operacoes_pendentes). Mantê-la
      // deixaria na tela uma etapa fantasma marcada "Pendente de
      // sincronização" para sempre, e o `pendente = 1` bloquearia todo pull
      // futuro de tocar nesse uuid (ver salvarEtapasCache).
      await db.runAsync('DELETE FROM etapas_cache WHERE uuid = ?', [etapaAlvo]);
    } else if (linha.tipo === 'etapa_editar' && baselineCifrado) {
      // Volta ao último estado conhecido-bom, anterior à edição rejeitada.
      await db.runAsync(
        `UPDATE etapas_cache SET dados_cifrados = ?, iv = ?, hmac = ?, pendente = 0, atualizado_em = ? WHERE uuid = ?`,
        [
          baselineCifrado.cifrado,
          baselineCifrado.iv,
          baselineCifrado.hmac,
          new Date().toISOString(),
          etapaAlvo,
        ]
      );
    } else if (linha.tipo === 'etapa_excluir') {
      // A exclusão nunca chegou a ser aplicada no servidor — desfaz o
      // soft-delete local e devolve a linha para a listagem.
      await db.runAsync(
        'UPDATE etapas_cache SET excluida_local = 0, pendente = 0 WHERE uuid = ?',
        [etapaAlvo]
      );
    }
    // achado_criar não tem estado em etapas_cache para reverter — a flag
    // `abandonada` já basta para tirá-lo da fila e das visões de pendência.
  });
}

/**
 * O servidor confirmou que RECEBEU uma operação abandonada, validou o elo dela
 * na cadeia, avançou a âncora e NÃO aplicou nada (ver `abandonados` em
 * sync.service.ts). A partir daqui ela não precisa mais ser reenviada:
 * `sincronizado = 1` a tira naturalmente do `WHERE sincronizado = 0` de
 * listarOperacoesPendentes, sem precisar de nenhuma exclusão especial (que,
 * essa sim, abriria a lacuna de hash que quebrava a cadeia).
 *
 * Mexe SÓ na linha de `operacoes_pendentes` — nada de `etapas_cache`: a
 * reversão do estado local otimista já aconteceu, de forma síncrona, quando o
 * auditor chamou abandonarOperacao.
 *
 * O `AND abandonada = 1` é a checagem local que fecha o outro lado: a resposta
 * do servidor é apenas uma AFIRMAÇÃO de que aquele uuid foi pulado, e aqui ela
 * grava `sincronizado = 1`. Sem exigir que a linha local esteja de fato
 * marcada como descartada, um `abandonados` errado ou forjado (backend
 * comprometido, transporte de desenvolvimento sem TLS) tiraria da fila uma
 * operação legítima — que a tela passaria a exibir como "Sincronizado" sem
 * nunca ter chegado ao Django. Com a condição, o caso vira um no-op ruidoso.
 */
export async function marcarOperacaoComoAbandonadaConfirmada(uuid: string): Promise<void> {
  const db = await getDatabase();
  const resultado = await db.runAsync(
    'UPDATE operacoes_pendentes SET sincronizado = 1, sincronizado_em = ? WHERE uuid = ? AND abandonada = 1',
    [new Date().toISOString(), uuid]
  );
  if (resultado.changes === 0) {
    console.warn(
      `[sync] servidor reportou como abandonada uma operação que não está descartada localmente (ou não existe), uuid: ${uuid}`
    );
  }
}

/**
 * Tipo de uma operação da fila, sem decifrar payload nenhum — serve só para a
 * interface adaptar avisos ao tipo (ver o alerta de descarte em EtapasScreen).
 * Retorna null se o uuid não existir.
 */
export async function obterTipoOperacao(uuid: string): Promise<TipoOperacao | null> {
  const db = await getDatabase();
  const linha = await db.getFirstAsync<{ tipo: TipoOperacao }>(
    'SELECT tipo FROM operacoes_pendentes WHERE uuid = ?',
    [uuid]
  );
  return linha?.tipo ?? null;
}

/**
 * `definitivo` separa os dois motivos, muito diferentes, de uma operação não
 * ter subido: uma RECUSA explícita do servidor (RBAC negado, alvo inexistente
 * — a requisição chegou, foi avaliada e respondida com erro) versus uma falha
 * de TRANSPORTE (sem sinal, timeout, conexão caída — nunca houve resposta). Só
 * a primeira justifica oferecer o descarte destrutivo ao auditor; a segunda se
 * resolve sozinha na próxima tentativa e não deve sugerir que o registro foi
 * rejeitado.
 */
export async function registrarErroSincronizacao(
  uuid: string,
  mensagem: string,
  definitivo: boolean
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE operacoes_pendentes SET erro_sincronizacao = ?, erro_definitivo = ? WHERE uuid = ?',
    [mensagem, definitivo ? 1 : 0, uuid]
  );
}

/**
 * Verifica a integridade de toda a cadeia local (de QUALQUER tipo) antes de
 * uma tentativa de sincronização. Se algum elo estiver corrompido (dado
 * adulterado ou reordenado após a criação), a sincronização não deve
 * prosseguir.
 */
export async function verificarIntegridadeLocal(): Promise<{ ok: boolean; indiceCorrompido: number | null }> {
  const operacoes = await listarOperacoesPendentes(false);
  const elos: EloDaCadeia[] = operacoes.map((op) => ({
    uuid: op.uuid,
    payload: op.payload,
    criadoEm: op.criadoEm,
    hashAnterior: op.hashAnterior,
    hashAtual: op.hashAtual,
  }));
  const indiceCorrompido = await verificarCadeia(elos);
  return { ok: indiceCorrompido === null, indiceCorrompido };
}
