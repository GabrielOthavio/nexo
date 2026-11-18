import NetInfo from '@react-native-community/netinfo';
import { api } from './api';
import { obterDispositivoId } from './dispositivoId';
import {
  listarOperacoesPendentes,
  marcarOperacaoComoSincronizada,
  marcarOperacaoComoConflito,
  marcarOperacaoComoAbandonadaConfirmada,
  registrarErroSincronizacao,
  verificarIntegridadeLocal,
} from '../db/operacoesRepository';
import { salvarAuditoriasCache, salvarEtapasCache } from '../db/auditoriasRepository';
import { AuditoriaCache, EtapaCache, OperacaoLocal } from '../models/Achado';

export interface ResultadoSincronizacao {
  enviados: number;
  conflitos: number;
  falhas: number;
  cadeiaCorrompida: boolean;
  indiceCorrompido: number | null;
  /**
   * O item em que o lote parou. `definitivo` diz se o servidor RECUSOU o item
   * (4xx do Django, cadeia inválida — reenviar para sempre no mesmo ponto) ou
   * se só tropeçou (5xx/infra, corrida na âncora — o próximo envio tende a
   * passar). Só o primeiro caso justifica oferecer o descarte destrutivo.
   */
  paradoEm: { uuid: string; motivo: string; definitivo: boolean } | null;
  /** A fila pendente não coube num único envio (ver TAMANHO_MAXIMO_LOTE_BYTES) e foi dividida. */
  filaGrande: boolean;
  /**
   * Não havia rede para tentar. Separado do "nada pendente" porque os dois
   * pediam mensagens opostas ao auditor: num caso a fila está vazia, no outro
   * há registros esperando no aparelho.
   */
  semConexao: boolean;
}

interface PushPayloadItem {
  uuid: string;
  /** JSON serializado dos campos de negócio — exatamente o que foi hasheado no dispositivo. */
  payload: string;
  criadoEm: string;
  hashAnterior: string;
  hashAtual: string;
  /**
   * Descartada pelo auditor (ver abandonarOperacao). O elo VAI no lote mesmo
   * assim — a cadeia é contígua e não admite buraco: omiti-lo faria o
   * `hashAnterior` do item seguinte não bater com o esperado e o servidor
   * rejeitaria o lote inteiro nesse ponto, em toda tentativa, para sempre. A
   * marca diz ao servidor para validar o hash, avançar a âncora e não aplicar
   * nada (ver `abandonados` em sync.service.ts).
   */
  abandonada: boolean;
}

interface RespostaPush {
  /** null quando o lote não foi registrado — ver corrida de âncora em sync.service.ts. */
  loteUuid: string | null;
  confirmados: Array<{ uuid: string; entidadeDjangoUuid: string }>;
  conflitos: Array<{ uuid: string; conflitoId: string }>;
  /** uuids que o servidor recebeu e deliberadamente não aplicou (vinham marcados `abandonada`). */
  abandonados: string[];
  paradoNoIndice: number | null;
  motivoParada: string | null;
  /**
   * Qualifica a parada: `true` = recusa real do servidor (4xx do Django,
   * cadeia inválida, payload corrompido) — reenviar vai parar sempre no mesmo
   * ponto; `false` = falha transitória (5xx/infra, conexão do servidor com o
   * Django, corrida na âncora) que o próximo envio provavelmente resolve;
   * `null`/ausente = sem parada, ou servidor anterior a este campo.
   *
   * Só o `true` autoriza oferecer o descarte destrutivo ao auditor. Opcional
   * de propósito, para o app continuar funcionando contra um sync-backend
   * mais antigo — nesse caso vale o padrão conservador (não definitivo).
   */
  paradaDefinitiva?: boolean | null;
}

function paraPayload(operacao: OperacaoLocal): PushPayloadItem {
  return {
    uuid: operacao.uuid,
    payload: operacao.payload,
    criadoEm: operacao.criadoEm,
    hashAnterior: operacao.hashAnterior,
    hashAtual: operacao.hashAtual,
    abandonada: operacao.abandonada,
  };
}

/**
 * Corte por tamanho do corpo enviado por requisição. O teto do servidor (10MB,
 * ver LIMITE_BODY_JSON em sync-backend/src/main.ts) não é o limite que importa
 * aqui: o que aperta é o TEMPO. Em rede celular de campo, um corpo de vários
 * megabytes passa fácil dos segundos do timeout do cliente (TIMEOUT_PUSH_MS
 * abaixo) — e um push abortado por timeout enquanto o servidor segue
 * processando é exatamente o cenário de "resposta perdida" que obriga a
 * reconciliação por âncora no próximo envio. 2MB sobe dentro do timeout mesmo
 * numa conexão ruim, e ainda fica com folga larga sob o limite do servidor;
 * o custo é só mais requisições, que já são tratadas em sequência.
 */
const TAMANHO_MAXIMO_LOTE_BYTES = 2 * 1024 * 1024;

/**
 * Timeout específico do POST /sync/push, bem acima do padrão de 15s da
 * instância `api` — este é o único request que sobe um lote inteiro e ainda
 * espera o servidor repassar item a item ao Django. O padrão continua curto
 * para os demais (login, listagens), que devem falhar rápido.
 */
const TIMEOUT_PUSH_MS = 30000;

/**
 * Estimativa conservadora (não exata) de bytes UTF-8 de uma string — evita
 * depender de TextEncoder, que não está polyfillado neste projeto. O dobro
 * do tamanho em caracteres já cobre com folga o pior caso realista (texto
 * majoritariamente ASCII/Latin-1, no máximo 2 bytes por caractere em UTF-8).
 */
function tamanhoAproximadoBytes(texto: string): number {
  return texto.length * 2;
}

/** Agrupa os itens pendentes em lotes que caibam em TAMANHO_MAXIMO_LOTE_BYTES cada. */
function dividirEmLotes(itens: PushPayloadItem[]): PushPayloadItem[][] {
  const lotes: PushPayloadItem[][] = [];
  let loteAtual: PushPayloadItem[] = [];
  let tamanhoAtual = 0;
  for (const item of itens) {
    const tamanhoItem = tamanhoAproximadoBytes(JSON.stringify(item));
    if (loteAtual.length > 0 && tamanhoAtual + tamanhoItem > TAMANHO_MAXIMO_LOTE_BYTES) {
      lotes.push(loteAtual);
      loteAtual = [];
      tamanhoAtual = 0;
    }
    loteAtual.push(item);
    tamanhoAtual += tamanhoItem;
  }
  if (loteAtual.length > 0) {
    lotes.push(loteAtual);
  }
  return lotes;
}

/**
 * Guarda de concorrência: o auto-sync (`iniciarSincronizacaoAutomatica`, ao
 * voltar a conectividade), o botão manual (`EtapasScreen`) e os gatilhos de
 * criação (`EtapaFormScreen`, `NovoAchadoScreen`) podem disparar
 * `sincronizar()` ao mesmo tempo. Em vez de deixar duas chamadas
 * concorrentes baterem no mesmo lote pendente (chamadas redundantes ao
 * backend, updates de âncora concorrentes), uma chamada em andamento é
 * compartilhada — a segunda chamada só aguarda o resultado da primeira.
 *
 * Mas `executarSincronizacao` tira uma "foto" da fila pendente só no início
 * (ver `listarOperacoesPendentes` abaixo) — se um item novo for inserido
 * DEPOIS dessa foto (ex.: etapa criada offline dispara sync, e segundos
 * depois um achado é criado na mesma etapa/lote), esse item não entra no
 * envio em andamento e ficaria pendente indefinidamente, sem nenhum gatilho
 * automático para reenviá-lo depois.
 *
 * `reexecutarAposCiclo` resolve isso: toda chamada que chega enquanto já há
 * um ciclo em voo marca a flag; ao terminar uma rodada, se a flag estiver
 * marcada, o PRÓPRIO ciclo roda de novo (loop) em vez de encerrar. Crucial:
 * `cicloAtual` é uma promise ÚNICA que só se resolve quando o loop inteiro
 * termina (nenhuma rodada pendente) — toda chamada concorrente recebe essa
 * MESMA referência e portanto o resultado da ÚLTIMA rodada, nunca de uma
 * rodada intermediária que ainda não viu o item recém-criado. (Uma versão
 * anterior devolvia a promise da primeira rodada para quem chegasse depois
 * dela mas antes do rerun — o chamador via o resultado velho e recarregava a
 * tela cedo demais, antes do rerun em segundo plano confirmar o item.)
 */
let cicloAtual: Promise<ResultadoSincronizacao> | null = null;
let reexecutarAposCiclo = false;

async function cicloDeSincronizacao(): Promise<ResultadoSincronizacao> {
  let resultado: ResultadoSincronizacao;
  do {
    reexecutarAposCiclo = false;
    resultado = await executarSincronizacao();
  } while (reexecutarAposCiclo);
  return resultado;
}

export function sincronizar(): Promise<ResultadoSincronizacao> {
  if (cicloAtual) {
    reexecutarAposCiclo = true;
    return cicloAtual;
  }
  cicloAtual = cicloDeSincronizacao().finally(() => {
    cicloAtual = null;
  });
  return cicloAtual;
}

/**
 * Sincronização bidirecional (push): envia ao backend NestJS o lote de
 * operações pendentes (achado_criar, etapa_criar, etapa_editar,
 * etapa_excluir — mesma fila unificada, ver operacoesRepository.ts), na
 * ordem original da cadeia. O endpoint POST /sync/push recalcula e valida
 * a cadeia de hashes recebida e delega item a item o efeito real ao Django.
 *
 * Falha parcial é o caso esperado, não uma exceção: a resposta traz a lista
 * de uuids confirmados e, à parte, os que terminaram em CONFLITO (baseline
 * desatualizado — outro lado mudou o mesmo dado nesse meio-tempo) — esses
 * não são reenviados (ver marcarOperacaoComoConflito), ficam visíveis só
 * no sistema web pra resolução manual. Se parou de vez no meio (falha real,
 * não conflito), o restante continua pendente com a cadeia local intacta.
 */
async function executarSincronizacao(): Promise<ResultadoSincronizacao> {
  const rede = await NetInfo.fetch();
  if (!rede.isConnected) {
    return { enviados: 0, conflitos: 0, falhas: 0, cadeiaCorrompida: false, indiceCorrompido: null, paradoEm: null, filaGrande: false, semConexao: true };
  }

  // Um erro AQUI é corrupção também, só detectada por outro mecanismo: as
  // linhas são decifradas com verificação de HMAC antes de virar elos, então
  // uma linha adulterada/corrompida faz `verificarIntegridadeLocal` LANÇAR em
  // vez de devolver `{ ok: false }`. Os dois desfechos significam a mesma
  // coisa para o auditor — dado local não confiável, sincronização bloqueada —
  // e precisam sair pelo mesmo caminho de `cadeiaCorrompida`; deixar a exceção
  // subir a transformava numa rejeição não tratada, sem nada na tela.
  let integridade: { ok: boolean; indiceCorrompido: number | null };
  try {
    integridade = await verificarIntegridadeLocal();
  } catch (erro) {
    console.warn('[sync] falha ao verificar a integridade local:', erro);
    integridade = { ok: false, indiceCorrompido: null };
  }
  if (!integridade.ok) {
    return {
      enviados: 0,
      conflitos: 0,
      falhas: 0,
      cadeiaCorrompida: true,
      indiceCorrompido: integridade.indiceCorrompido,
      paradoEm: null,
      filaGrande: false,
      semConexao: false,
    };
  }

  const pendentes = await listarOperacoesPendentes(true);
  if (pendentes.length === 0) {
    return { enviados: 0, conflitos: 0, falhas: 0, cadeiaCorrompida: false, indiceCorrompido: null, paradoEm: null, filaGrande: false, semConexao: false };
  }

  const lotes = dividirEmLotes(pendentes.map(paraPayload));
  const filaGrande = lotes.length > 1;

  // Resolvido uma vez por sincronização (é o mesmo aparelho para todos os
  // lotes). Vai como header em vez de no corpo porque é metadado de
  // transporte/identidade, não conteúdo da cadeia — não entra em nenhum hash.
  const dispositivoId = await obterDispositivoId();

  let enviados = 0;
  let conflitosTotal = 0;
  let abandonadosTotal = 0;
  let paradoEm: ResultadoSincronizacao['paradoEm'] = null;
  let indiceBase = 0;

  // Lotes são processados em sequência, na ordem da cadeia. Segurança acima
  // de comodidade (decisão do time): se um lote parar ou falhar no meio, os
  // lotes seguintes NÃO são tentados — melhor reenviar tudo de novo depois
  // do que arriscar aplicar um lote fora de ordem em relação a um anterior
  // que não se sabe se foi de fato confirmado.
  for (const lote of lotes) {
    const operacoesDoLote = pendentes.slice(indiceBase, indiceBase + lote.length);
    indiceBase += lote.length;

    try {
      const { data } = await api.post<RespostaPush>(
        '/sync/push',
        { itens: lote },
        { headers: { 'X-Device-Id': dispositivoId }, timeout: TIMEOUT_PUSH_MS }
      );

      for (const item of data.confirmados) {
        const operacao = operacoesDoLote.find((p) => p.uuid === item.uuid);
        if (operacao) {
          await marcarOperacaoComoSincronizada(item.uuid, operacao.tipo, item.entidadeDjangoUuid);
        }
      }
      for (const item of data.conflitos) {
        await marcarOperacaoComoConflito(item.uuid, item.conflitoId);
      }
      // O servidor reconheceu o elo das operações descartadas (validou o hash e
      // avançou a âncora por cima delas) sem aplicar nada. Só agora elas podem
      // sair dos lotes futuros — antes disso, tirá-las do envio abriria a
      // lacuna que invalida a cadeia. `?? []` cobre um servidor mais antigo,
      // anterior a este campo.
      //
      // A lista é conferida contra o lote que ESTE aparelho acabou de enviar,
      // igual já se faz com `confirmados`: `marcarOperacaoComoAbandonadaConfirmada`
      // grava `sincronizado = 1`, então um uuid inventado (backend comprometido,
      // interceptação num transporte de desenvolvimento sem TLS) faria a
      // interface exibir "Sincronizado" para um registro que o Django nunca
      // recebeu — a pior falha possível aqui, porque é silenciosa.
      const abandonadosDoServidor = (data.abandonados ?? []).filter((uuid) => {
        if (operacoesDoLote.some((p) => p.uuid === uuid)) return true;
        console.warn(`[sync] uuid abandonado fora do lote enviado, ignorado: ${uuid}`);
        return false;
      });
      for (const uuid of abandonadosDoServidor) {
        await marcarOperacaoComoAbandonadaConfirmada(uuid);
      }

      enviados += data.confirmados.length;
      conflitosTotal += data.conflitos.length;
      abandonadosTotal += abandonadosDoServidor.length;

      if (data.paradoNoIndice !== null && data.motivoParada) {
        const item = operacoesDoLote[data.paradoNoIndice];
        if (item) {
          // Houve resposta do servidor, mas ela não diz por si só que o item
          // foi RECUSADO: o lote também para quando o Django devolve 5xx,
          // quando o sync-backend não conseguiu falar com ele, ou numa corrida
          // de âncora ("tente novamente"). Só `paradaDefinitiva` separa a
          // recusa real (4xx, cadeia inválida) do resto — e o padrão, quando o
          // campo não vem (servidor mais antigo), é o conservador: NÃO
          // definitivo, porque marcar por engano habilita na tela o descarte
          // destrutivo de um registro capturado em campo.
          const definitivo = data.paradaDefinitiva ?? false;
          await registrarErroSincronizacao(item.uuid, data.motivoParada, definitivo);
          paradoEm = { uuid: item.uuid, motivo: data.motivoParada, definitivo };
        }
        break;
      }
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : 'Erro desconhecido na sincronização.';
      for (const operacao of operacoesDoLote) {
        // Falha de TRANSPORTE: a requisição não chegou a receber uma resposta
        // de verdade (sem sinal, timeout, conexão caída). Não é recusa de nada
        // — a próxima tentativa provavelmente passa —, então não habilita o
        // descarte destrutivo na interface.
        await registrarErroSincronizacao(operacao.uuid, mensagem, false);
      }
      break;
    }
  }

  return {
    enviados,
    conflitos: conflitosTotal,
    // Abandonadas confirmadas saíram da fila com sucesso (o servidor as
    // reconheceu e nunca vai recebê-las de novo) — contá-las como falha
    // reportaria ao auditor um erro que não houve.
    falhas: pendentes.length - enviados - conflitosTotal - abandonadosTotal,
    cadeiaCorrompida: false,
    indiceCorrompido: null,
    paradoEm,
    filaGrande,
    semConexao: false,
  };
}

/**
 * Mitigação de "perda de chave = perda de registros pendentes": auto-sync ao
 * detectar volta de conectividade, além do botão manual — reduz a janela
 * em que mudanças ficam só no dispositivo.
 */
export function iniciarSincronizacaoAutomatica(): () => void {
  return NetInfo.addEventListener((estado) => {
    if (estado.isConnected) {
      sincronizar().catch(() => {
        // Silencioso: o usuário ainda pode disparar manualmente e ver o erro na tela.
      });
    }
  });
}

/** Formato bruto devolvido pelo proxy do sync-backend — espelha o JSON do Django (snake_case). */
interface AuditoriaDjangoDto {
  id_unico: string;
  nome_auditoria: string;
  orgao: string | null;
  status: string;
}

interface EtapaDjangoDto {
  id_unico: string;
  orientacao: string;
  documentos: string;
  atividade: string;
  prazo: string | null;
  situacao: string;
  metodo: string;
}

/** Lista leve (sem etapas) para a tela de seleção de auditoria. */
export async function sincronizarAuditorias(): Promise<AuditoriaCache[]> {
  const { data } = await api.get<AuditoriaDjangoDto[]>('/sync/auditorias');
  const auditorias: AuditoriaCache[] = data.map((a) => ({
    uuid: a.id_unico,
    nomeAuditoria: a.nome_auditoria,
    orgao: a.orgao,
    status: a.status,
  }));
  await salvarAuditoriasCache(auditorias);
  return auditorias;
}

/** Sob demanda, só depois que o auditor seleciona a auditoria. */
export async function sincronizarEtapas(auditoriaUuid: string): Promise<EtapaCache[]> {
  const { data } = await api.get<EtapaDjangoDto[]>(`/sync/auditorias/${auditoriaUuid}/etapas`);
  const etapas: EtapaCache[] = data.map((e) => ({
    uuid: e.id_unico,
    auditoriaUuid,
    orientacao: e.orientacao,
    documentos: e.documentos,
    atividade: e.atividade,
    prazo: e.prazo,
    situacao: e.situacao,
    metodo: e.metodo,
    pendente: false,
    excluidaLocal: false,
  }));
  await salvarEtapasCache(auditoriaUuid, etapas);
  return etapas;
}
