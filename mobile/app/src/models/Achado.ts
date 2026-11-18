/** Payload de um Achado capturado em campo, antes da sincronização. */
export interface NovoAchadoInput {
  etapaUuid: string;
  descricao: string;
}

/** Registro local persistido em `operacoes_pendentes` (tipo achado_criar), já decifrado. */
export interface AchadoLocal {
  id: number;
  uuid: string;
  etapaUuid: string;
  auditoriaUuid: string;
  descricao: string;
  criadoEm: string;
  sincronizado: boolean;
  sincronizadoEm: string | null;
  achadoDjangoUuid: string | null;
  erroSincronizacao: string | null;
  /**
   * O erro acima é uma RECUSA do servidor (RBAC negado, alvo inexistente), não
   * uma falha de transporte (sem sinal, timeout) — só nesse caso reenviar é
   * inútil e faz sentido oferecer o descarte ao auditor.
   */
  erroDefinitivo: boolean;
  /** Descartada pelo auditor após rejeição definitiva — não será mais reenviada. */
  abandonada: boolean;
}

export interface AuditoriaCache {
  uuid: string;
  nomeAuditoria: string;
  orgao: string | null;
  status: string;
}

/** Conjunto completo de campos editáveis de Etapa — espelha o EtapaForm do Django. */
export interface CamposEtapa {
  orientacao: string;
  documentos: string;
  atividade: string;
  prazo: string | null;
  situacao: string;
  metodo: string;
}

export type NovaEtapaInput = CamposEtapa;

export interface EtapaCache extends CamposEtapa {
  uuid: string;
  auditoriaUuid: string;
  /** Ainda não confirmada pelo servidor — criação ou edição local pendente de sincronização. */
  pendente: boolean;
  /** Soft-delete client-side — exclusão local pendente de confirmação, já escondida da listagem. */
  excluidaLocal: boolean;
}

export type TipoOperacao = 'achado_criar' | 'etapa_criar' | 'etapa_editar' | 'etapa_excluir';

/** Linha genérica de `operacoes_pendentes`, já decifrada — base comum aos 4 tipos de operação offline. */
export interface OperacaoLocal {
  id: number;
  uuid: string;
  tipo: TipoOperacao;
  auditoriaUuid: string;
  alvoUuid: string | null;
  /** JSON serializado do payload de negócio EM TEXTO PLANO — é o que entra no hash. */
  payload: string;
  criadoEm: string;
  hashAnterior: string;
  hashAtual: string;
  sincronizado: boolean;
  sincronizadoEm: string | null;
  entidadeDjangoUuid: string | null;
  conflitoId: string | null;
  erroSincronizacao: string | null;
  /**
   * O erro acima veio de uma RECUSA explícita do servidor, não de uma falha de
   * transporte (ver registrarErroSincronizacao) — distinção que decide se o
   * descarte destrutivo deve sequer ser oferecido ao auditor.
   */
  erroDefinitivo: boolean;
  /**
   * Descartada em definitivo pelo auditor (ver abandonarOperacao) — a linha
   * continua na trilha encadeada, mas sai da fila de reenvio.
   */
  abandonada: boolean;
}
