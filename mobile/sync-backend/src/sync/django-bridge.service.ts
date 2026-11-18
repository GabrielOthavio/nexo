import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, isAxiosError } from 'axios';

export interface AuditoriaDjango {
  id_unico: string;
  nome_auditoria: string;
  orgao: string | null;
  status: string;
}

export interface EtapaDjango {
  id_unico: string;
  orientacao: string;
  documentos: string;
  atividade: string;
  prazo: string | null;
  situacao: string;
  metodo: string;
}

export interface AchadoCriadoDjango {
  id_unico: string;
  data_achado: string;
}

export interface EtapaCompletaDjango {
  id_unico: string;
  orientacao: string;
  documentos: string;
  atividade: string;
  prazo: string | null;
  situacao: string;
  metodo: string;
}

export interface CamposEtapa {
  orientacao: string;
  documentos: string;
  atividade: string;
  /** Nullable, espelhando CamposEtapa do app (mobile/app/src/models/Achado.ts) — etapa sem prazo definido. */
  prazo: string | null;
  situacao: string;
  metodo: string;
}

/** Lançada quando o Django detecta que o `baseline` enviado não bate mais
 * com o estado atual da Etapa — resultado de negócio válido (não é uma
 * falha de infraestrutura), tratado à parte do resto dos erros HTTP. */
export class ConflitoEtapaError extends Error {
  constructor(public readonly conflitoId: string) {
    super('conflito_pendente');
    this.name = 'ConflitoEtapaError';
  }
}

/**
 * Client fino para a API interna do núcleo Django (Auth/views/api_mobile_views.py).
 * É o único caminho de escrita de Achados — nunca escrevemos direto no
 * Postgres do Django, para que o signal de Audit by Design
 * (HistoricoAlteracoes) continue disparando (ver plano de integração).
 * Autenticado por segredo compartilhado (X-Internal-Api-Key), chamado só
 * servidor-a-servidor a partir daqui — a chave nunca chega ao app mobile.
 */
@Injectable()
export class DjangoBridgeService {
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: this.config.getOrThrow<string>('DJANGO_API_BASE_URL'),
      timeout: 10_000,
      headers: {
        'X-Internal-Api-Key': this.config.getOrThrow<string>('MOBILE_SYNC_API_KEY'),
      },
    });
  }

  async listarAuditorias(djangoUsuarioUuid: string): Promise<AuditoriaDjango[]> {
    const { data } = await this.http.get<{ results: AuditoriaDjango[] }>('/api/mobile/auditorias/', {
      params: { usuario_uuid: djangoUsuarioUuid },
    });
    return data.results;
  }

  async listarEtapas(djangoUsuarioUuid: string, auditoriaUuid: string): Promise<EtapaDjango[]> {
    const { data } = await this.http.get<{ results: EtapaDjango[] }>(
      `/api/mobile/auditorias/${encodeURIComponent(auditoriaUuid)}/etapas/`,
      { params: { usuario_uuid: djangoUsuarioUuid } },
    );
    return data.results;
  }

  /**
   * Lança HttpException com o status/detail que o Django retornou (403 de
   * RBAC, 404 de etapa inexistente, etc.) — o SyncService usa isso para
   * decidir onde parar o lote (ver semântica de falha parcial no plano).
   */
  async criarAchado(params: {
    djangoUsuarioUuid: string;
    etapaUuid: string;
    descricao: string;
    origemMobileUuid: string;
  }): Promise<AchadoCriadoDjango> {
    try {
      const { data } = await this.http.post<AchadoCriadoDjango>('/api/mobile/achados/', {
        usuario_uuid: params.djangoUsuarioUuid,
        etapa_uuid: params.etapaUuid,
        descricao: params.descricao,
        origem_mobile_uuid: params.origemMobileUuid,
      });
      return data;
    } catch (erro) {
      if (isAxiosError(erro) && erro.response) {
        throw new HttpException(erro.response.data, erro.response.status);
      }
      throw erro;
    }
  }

  async criarEtapa(params: {
    djangoUsuarioUuid: string;
    auditoriaUuid: string;
    campos: CamposEtapa;
    origemMobileUuid: string;
  }): Promise<EtapaCompletaDjango> {
    try {
      const { data } = await this.http.post<EtapaCompletaDjango>('/api/mobile/etapas/', {
        usuario_uuid: params.djangoUsuarioUuid,
        auditoria_uuid: params.auditoriaUuid,
        origem_mobile_uuid: params.origemMobileUuid,
        ...params.campos,
      });
      return data;
    } catch (erro) {
      if (isAxiosError(erro) && erro.response) {
        throw new HttpException(erro.response.data, erro.response.status);
      }
      throw erro;
    }
  }

  /**
   * Lança ConflitoEtapaError especificamente no 409 (baseline desatualizado
   * — outro lado mudou a Etapa nesse meio-tempo, não importa a origem da
   * mudança). O SyncService trata isso como um resultado terminal válido
   * pro item, não como falha que para o lote inteiro.
   */
  async editarEtapa(params: {
    djangoUsuarioUuid: string;
    etapaUuid: string;
    baseline: CamposEtapa;
    campos: CamposEtapa;
  }): Promise<EtapaCompletaDjango> {
    try {
      const { data } = await this.http.post<EtapaCompletaDjango>(
        `/api/mobile/etapas/${encodeURIComponent(params.etapaUuid)}/editar/`,
        {
          usuario_uuid: params.djangoUsuarioUuid,
          baseline: params.baseline,
          ...params.campos,
        },
      );
      return data;
    } catch (erro) {
      if (isAxiosError(erro) && erro.response) {
        // 409 não é sempre um conflito de baseline — o Django também usa 409
        // pra "auditoria fechada" (ver _STATUS_AUDITORIA_ABERTA em
        // api_mobile_views.py), que precisa parar o lote como erro real, não
        // virar um ConflitoEtapa fantasma. O token 'conflito_pendente' é o
        // único caso que deve reconciliar como conflito.
        if (erro.response.status === 409 && erro.response.data?.detail === 'conflito_pendente') {
          // Fallback: um 409 sem conflito_id (ex.: vindo de um proxy) não
          // pode virar conflitoId undefined — o app gravaria NULL e
          // reenviaria o item para sempre.
          throw new ConflitoEtapaError(erro.response.data?.conflito_id ?? 'desconhecido');
        }
        throw new HttpException(erro.response.data, erro.response.status);
      }
      throw erro;
    }
  }

  async excluirEtapa(params: {
    djangoUsuarioUuid: string;
    etapaUuid: string;
  }): Promise<{ id_unico: string; ja_excluida: boolean }> {
    try {
      const { data } = await this.http.post<{ id_unico: string; ja_excluida: boolean }>(
        `/api/mobile/etapas/${encodeURIComponent(params.etapaUuid)}/excluir/`,
        { usuario_uuid: params.djangoUsuarioUuid },
      );
      return data;
    } catch (erro) {
      if (isAxiosError(erro) && erro.response) {
        throw new HttpException(erro.response.data, erro.response.status);
      }
      throw erro;
    }
  }
}
