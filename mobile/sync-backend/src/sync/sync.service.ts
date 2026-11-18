import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsuarioAutenticado } from '../auth/jwt.strategy';
import { SyncPushDto, ItemPushDto } from './dto/sync-push.dto';
import { calcularProximoHash, validarCadeia } from './hash-chain.util';
import {
  AuditoriaDjango,
  CamposEtapa,
  ConflitoEtapaError,
  DjangoBridgeService,
  EtapaDjango,
} from './django-bridge.service';

export const HASH_GENESIS = '0'.repeat(64);

interface PayloadAchadoCriar {
  tipo: 'achado_criar';
  etapaUuid: string;
  descricao: string;
}

interface PayloadEtapaCriar {
  tipo: 'etapa_criar';
  auditoriaUuid: string;
  campos: CamposEtapa;
}

interface PayloadEtapaEditar {
  tipo: 'etapa_editar';
  etapaUuid: string;
  baseline: CamposEtapa;
  campos: CamposEtapa;
}

interface PayloadEtapaExcluir {
  tipo: 'etapa_excluir';
  etapaUuid: string;
}

type Payload = PayloadAchadoCriar | PayloadEtapaCriar | PayloadEtapaEditar | PayloadEtapaExcluir;

/** Sinal interno: o compare-and-swap da âncora perdeu a corrida (desfaz a transação dos elos). */
class AncoraMudouError extends Error {}

export interface ItemConfirmado {
  uuid: string;
  entidadeDjangoUuid: string;
}

export interface ItemComConflito {
  uuid: string;
  conflitoId: string;
}

export interface ResultadoPush {
  /**
   * null quando NENHUM lote foi registrado — hoje só no caso de corrida na
   * âncora (ver push()), em que o lote é deliberadamente descartado em vez
   * de registrado como se tivesse valido.
   */
  loteUuid: string | null;
  confirmados: ItemConfirmado[];
  conflitos: ItemComConflito[];
  /**
   * uuids que o servidor recebeu, validou na cadeia e deliberadamente NÃO
   * aplicou (vieram marcados `abandonada` pelo dispositivo). O app usa esta
   * lista para parar de reenviá-los — ver
   * marcarOperacaoComoAbandonadaConfirmada no app.
   */
  abandonados: string[];
  paradoNoIndice: number | null;
  motivoParada: string | null;
  /**
   * Qualifica a parada acima: `true` = o lote foi RECUSADO de verdade
   * (cadeia inválida, payload corrompido, 4xx do Django — RBAC negado, alvo
   * inexistente...); reenviar o mesmo item para sempre no mesmo ponto.
   * `false` = a parada foi transitória (5xx/infra do Django, queda de
   * conexão sem resposta, corrida na âncora) e o reenvio provavelmente passa.
   * `null` quando não houve parada nenhuma.
   *
   * O app usa isto para decidir se pode oferecer o DESCARTE destrutivo da
   * operação ao auditor — ver registrarErroSincronizacao(definitivo) no app.
   * Sem esta distinção, toda falha de infraestrutura era apresentada em campo
   * como "o servidor recusou este registro".
   */
  paradaDefinitiva: boolean | null;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly djangoBridge: DjangoBridgeService,
  ) {}

  /**
   * Resolve um uuid de Etapa que pode ser temporário (gerado localmente no
   * dispositivo, ainda sem id_unico real do Django) ou já real. Checa o mapa
   * em memória desta chamada primeiro (cobre o caso comum: etapa_criar e um
   * achado_criar que depende dela no MESMO lote); se não achar, cai para o
   * banco (cobre falha parcial num lote anterior, ou o app reiniciar entre
   * tentativas — o mapa em memória de uma chamada anterior já não existe
   * mais). Se não achar em lugar nenhum, assume que já é um uuid real.
   */
  private async resolverEtapaUuid(
    usuarioId: number,
    uuid: string,
    mapaEmMemoria: Map<string, string>,
  ): Promise<string> {
    const doMapa = mapaEmMemoria.get(uuid);
    if (doMapa) return doMapa;

    const registro = await this.prisma.mapeamentoUuidTemporario.findUnique({
      where: { usuarioId_uuidTemporario: { usuarioId, uuidTemporario: uuid } },
    });
    return registro?.uuidDjango ?? uuid;
  }

  private async registrarMapeamento(
    usuarioId: number,
    uuidTemporario: string,
    uuidDjango: string,
    mapaEmMemoria: Map<string, string>,
  ): Promise<void> {
    mapaEmMemoria.set(uuidTemporario, uuidDjango);
    await this.prisma.mapeamentoUuidTemporario.upsert({
      where: { usuarioId_uuidTemporario: { usuarioId, uuidTemporario } },
      create: { usuarioId, uuidTemporario, uuidDjango },
      update: { uuidDjango },
    });
  }

  /**
   * Despacha um item da fila pro método certo do Django-bridge, de acordo
   * com `payload.tipo`. Único ponto onde os 4 tipos de operação offline
   * (achado_criar, etapa_criar, etapa_editar, etapa_excluir) viram uma
   * chamada real ao núcleo Django — nunca escrita direta no Postgres do
   * sync-backend, pro signal de Audit by Design continuar disparando.
   *
   * Lança ConflitoEtapaError especificamente pra etapa_editar quando o
   * Django detecta baseline desatualizado — o chamador (push loop) trata
   * isso como um resultado terminal válido pro item, não como falha de lote.
   */
  private async processarItem(
    usuario: UsuarioAutenticado,
    item: ItemPushDto,
    mapaEmMemoria: Map<string, string>,
  ): Promise<ItemConfirmado> {
    const payload: Payload = JSON.parse(item.payload);

    switch (payload.tipo) {
      case 'achado_criar': {
        const etapaUuid = await this.resolverEtapaUuid(usuario.id, payload.etapaUuid, mapaEmMemoria);
        const achado = await this.djangoBridge.criarAchado({
          djangoUsuarioUuid: usuario.djangoUsuarioUuid,
          etapaUuid,
          descricao: payload.descricao,
          origemMobileUuid: item.uuid,
        });
        return { uuid: item.uuid, entidadeDjangoUuid: achado.id_unico };
      }
      case 'etapa_criar': {
        const etapa = await this.djangoBridge.criarEtapa({
          djangoUsuarioUuid: usuario.djangoUsuarioUuid,
          auditoriaUuid: payload.auditoriaUuid,
          campos: payload.campos,
          origemMobileUuid: item.uuid,
        });
        await this.registrarMapeamento(usuario.id, item.uuid, etapa.id_unico, mapaEmMemoria);
        return { uuid: item.uuid, entidadeDjangoUuid: etapa.id_unico };
      }
      case 'etapa_editar': {
        const etapaUuid = await this.resolverEtapaUuid(usuario.id, payload.etapaUuid, mapaEmMemoria);
        const etapa = await this.djangoBridge.editarEtapa({
          djangoUsuarioUuid: usuario.djangoUsuarioUuid,
          etapaUuid,
          baseline: payload.baseline,
          campos: payload.campos,
        });
        return { uuid: item.uuid, entidadeDjangoUuid: etapa.id_unico };
      }
      case 'etapa_excluir': {
        const etapaUuid = await this.resolverEtapaUuid(usuario.id, payload.etapaUuid, mapaEmMemoria);
        await this.djangoBridge.excluirEtapa({
          djangoUsuarioUuid: usuario.djangoUsuarioUuid,
          etapaUuid,
        });
        return { uuid: item.uuid, entidadeDjangoUuid: etapaUuid };
      }
      default: {
        const tipoDesconhecido: never = payload;
        throw new Error(`tipo de operação desconhecido: ${JSON.stringify(tipoDesconhecido)}`);
      }
    }
  }

  /**
   * O sync-backend não persiste o conteúdo de nenhuma operação em nenhum
   * momento — valida a cadeia de hashes em memória, sobre o payload em
   * texto plano recebido do app (que já decifrou localmente antes de
   * enviar), e delega item a item o efeito real ao núcleo Django, único
   * lugar onde o signal de Audit by Design (HistoricoAlteracoes) dispara.
   *
   * A validação usa como âncora o `ultimoHashConfirmado` persistido em
   * `AncoraDispositivo` (só um hash, não conteúdo) — necessário porque um
   * dispositivo sincroniza apenas os itens pendentes a cada chamada, não o
   * histórico inteiro; sem essa âncora, cada push validaria a cadeia isolada
   * a partir do gênesis, quebrando a continuidade entre sincronizações
   * separadas no tempo.
   *
   * A âncora é por (usuário, DISPOSITIVO), nunca só por usuário: a cadeia
   * vive no SQLite do aparelho e recomeça do gênesis a cada instalação, então
   * a mesma conta em dois aparelhos são duas cadeias independentes. Linha
   * ausente = âncora nula = gênesis, exatamente o comportamento de um
   * primeiro push.
   *
   * Falha parcial é semântica esperada, não uma exceção: os itens são
   * processados em ordem e, se um deles falhar de verdade (cadeia inválida,
   * RBAC negado pelo Django, timeout, etc.), o lote para nesse ponto. Um
   * CONFLITO (409 do Django numa etapa_editar) é tratado à parte — não é
   * uma falha de lote, é um resultado de negócio válido pra aquele item
   * específico: a cadeia avança normalmente (o item foi legitimamente
   * processado), o item entra em `conflitos` em vez de `confirmados`, e o
   * loop CONTINUA processando os itens seguintes.
   *
   * Itens marcados `abandonada` (descartados pelo auditor no dispositivo) são
   * o terceiro desfecho: chegam justamente porque a cadeia não admite lacuna —
   * o app não pode omitir um elo do envio sem invalidar todos os posteriores —
   * e aqui têm o hash validado e a âncora avançada, mas NENHUMA chamada ao
   * Django. Voltam em `abandonados`, e é isso que autoriza o app a pará-los de
   * vez (ver marcarOperacaoComoAbandonadaConfirmada).
   *
   * Reconciliação de resposta perdida: se o Django confirma um item e avança
   * a âncora, mas a resposta HTTP não chega ao app (timeout/conexão caída), o
   * app reenvia o mesmo item pendente com o `hashAnterior` antigo — que não
   * bate mais com a âncora já avançada, travando a cadeia permanentemente. Se
   * o primeiro item do lote for exatamente esse caso, tentamos reprocessá-lo
   * (idempotente por tipo — get_or_create pra criação, reaplicação segura
   * pra edição, "já excluída" pra exclusão) antes de rejeitar o lote inteiro.
   * Essa confiança em aplicar o primeiro item sem prova criptográfica extra
   * (se ele não lançar erro) é uma característica já aceita do desenho
   * original — agora com raio de ação maior, cobrindo os 4 tipos, não só
   * achado.
   *
   * Para um item ABANDONADO, porém, essa reconciliação não tem freio nenhum:
   * aceitá-lo não produz efeito algum (é o próprio sentido de `abandonada`),
   * então não há chamada ao Django que possa falhar e barrar um item forjado —
   * um aparelho comprometido reescreveria o SQLite local e re-ancoraria a
   * cadeia do servidor num valor arbitrário auto-consistente, sem deixar
   * rastro, esvaziando justamente a evidência de adulteração que o
   * encadeamento existe para dar. Por isso o caminho abandonado só é aceito
   * quando o servidor LEMBRA de já ter pulado aquele uuid exato: a âncora
   * guarda, junto do hash, o uuid do abandono que produziu o valor atual
   * (`ultimoAbandonadoUuid`). Sem correspondência, o item cai na validação
   * normal de cadeia e é corretamente rejeitado.
   */
  async push(
    usuario: UsuarioAutenticado,
    dto: SyncPushDto,
    dispositivoId: string,
  ): Promise<ResultadoPush> {
    const ancora = await this.prisma.ancoraDispositivo.findUnique({
      where: { usuarioId_dispositivoId: { usuarioId: usuario.id, dispositivoId } },
    });
    // Guardado à parte de `hashEsperado` (que avança durante o lote) porque é
    // o valor "esperado" do compare-and-swap no final — o que provamos não ter
    // mudado sob nossos pés enquanto processávamos o lote.
    const ancoraNoInicio = ancora?.ultimoHashConfirmado ?? null;
    /**
     * uuid do item ABANDONADO que produziu o `ancoraNoInicio` acima, se a
     * última posição da âncora foi alcançada por um abandono (null se veio de
     * um item confirmado/conflitado, ou se ainda não houve item nenhum). É a
     * única prova de que ESTE servidor já pulou ESTE uuid antes — usada na
     * reconciliação de resposta perdida logo abaixo. Fica à parte da variável
     * que avança durante o lote, porque a pergunta ali é "um push ANTERIOR já
     * pulou este uuid?", nunca algo produzido dentro desta mesma chamada.
     */
    const ultimoAbandonadoNoInicio = ancora?.ultimoAbandonadoUuid ?? null;

    let hashEsperado = ancoraNoInicio ?? HASH_GENESIS;
    // Anda SEMPRE em par com `hashEsperado`: toda atribuição de hashEsperado
    // tem ao lado a atribuição correspondente aqui, para que este valor
    // descreva o item que a posição atual da âncora representa.
    let ultimoAbandonadoUuid: string | null = ultimoAbandonadoNoInicio;
    const confirmados: ItemConfirmado[] = [];
    const conflitos: ItemComConflito[] = [];
    const abandonados: string[] = [];
    const mapaEmMemoria = new Map<string, string>();
    let indiceInicial = 0;

    const primeiro = dto.itens[0];
    if (
      primeiro &&
      hashEsperado !== HASH_GENESIS &&
      primeiro.hashAnterior !== hashEsperado &&
      // O item precisa, no mínimo, ser internamente consistente (hashAtual
      // bate com o próprio conteúdo) — sem isso, aceitaríamos conteúdo
      // arbitrário E re-ancoraríamos a cadeia num hashAtual inventado.
      calcularProximoHash(primeiro.hashAnterior, primeiro.uuid, primeiro.payload, primeiro.criadoEm) ===
        primeiro.hashAtual
    ) {
      if (primeiro.abandonada) {
        // Item abandonado cuja confirmação de "pulei este" se perdeu no
        // caminho (resposta caiu): a âncora aqui já avançou por cima dele, mas
        // o app não soube e reenviou. Nada a reprocessar — ele nunca foi
        // aplicado, por definição —, só reconhecer de novo e destravar o resto
        // do lote.
        //
        // Só que "nada a reprocessar" é exatamente o que torna este caminho
        // perigoso: sem nenhuma chamada ao Django que possa recusar o item,
        // auto-consistência do hash seria a única barreira, e ela é trivial de
        // produzir num aparelho comprometido. Exigimos, então, que a âncora
        // atual tenha sido de fato produzida pelo abandono DESTE uuid — quer
        // dizer, que um push anterior já tenha pulado exatamente este item e
        // gravado isso. Se não bate, não reconciliamos: a execução segue para
        // validarCadeia, que rejeita o lote neste ponto (o hashAnterior não
        // corresponde à âncora), que é o desfecho correto.
        if (primeiro.uuid === ultimoAbandonadoNoInicio) {
          abandonados.push(primeiro.uuid);
          hashEsperado = primeiro.hashAtual;
          ultimoAbandonadoUuid = primeiro.abandonada ? primeiro.uuid : null;
          indiceInicial = 1;
        }
      } else if (await this.eloJaAceito(usuario.id, dispositivoId, primeiro)) {
        // Prova exigida antes de reprocessar: este servidor já aceitou
        // EXATAMENTE este elo (mesmo uuid, mesmo hash) num push anterior. Sem
        // ela, a única barreira seria o Django recusar o item — e uma criação
        // nova, forjada com hash auto-consistente, o Django aceita: a cadeia
        // seria re-ancorada num valor arbitrário, sem rastro.
        try {
          confirmados.push(await this.processarItem(usuario, primeiro, mapaEmMemoria));
          hashEsperado = primeiro.hashAtual;
          ultimoAbandonadoUuid = primeiro.abandonada ? primeiro.uuid : null;
          indiceInicial = 1;
        } catch (erro) {
          if (erro instanceof ConflitoEtapaError) {
            // Retry de uma etapa_editar já aplicada: reaplicar gera 409 no
            // Django (o baseline antigo não bate mais com o estado atual).
            // É o mesmo resultado terminal válido do loop normal — sem isso,
            // o item ficaria preso pra sempre (cada retry rejeitado pela
            // âncora já avançada) e cada tentativa criaria um novo
            // ConflitoEtapa espúrio no Django.
            conflitos.push({ uuid: primeiro.uuid, conflitoId: erro.conflitoId });
            hashEsperado = primeiro.hashAtual;
            ultimoAbandonadoUuid = primeiro.abandonada ? primeiro.uuid : null;
            indiceInicial = 1;
          }
          // Senão: não era reconciliável (não é o mesmo item já confirmado
          // antes) — segue para a validação normal, que vai rejeitar corretamente.
        }
      }
    }

    const itensRestantes = dto.itens.slice(indiceInicial);
    const validacao = validarCadeia(
      itensRestantes.map((item) => ({
        uuid: item.uuid,
        payload: item.payload,
        criadoEm: item.criadoEm,
        hashAnterior: item.hashAnterior,
        hashAtual: item.hashAtual,
      })),
      hashEsperado,
    );

    let paradoNoIndice: number | null = null;
    let motivoParada: string | null = null;
    let paradaDefinitiva: boolean | null = null;

    if (!validacao.ok) {
      paradoNoIndice = (validacao.indiceInvalido ?? 0) + indiceInicial;
      motivoParada = `Cadeia de hashes inválida: ${validacao.motivo}`;
      // Uma cadeia que não fecha não passa a fechar por si só num retry — é
      // um problema real do que está gravado no aparelho, não algo transitório.
      paradaDefinitiva = true;
    } else {
      for (let i = 0; i < itensRestantes.length; i++) {
        const item = itensRestantes[i];
        if (item.abandonada) {
          // Descartada pelo auditor: o elo veio junto só para a cadeia seguir
          // contígua (omiti-lo quebraria o hashAnterior do item seguinte e
          // invalidaria o lote inteiro, para sempre). Nada é aplicado no
          // Django — a âncora simplesmente passa por cima, como um no-op.
          abandonados.push(item.uuid);
          hashEsperado = item.hashAtual;
          ultimoAbandonadoUuid = item.abandonada ? item.uuid : null;
          continue;
        }
        try {
          confirmados.push(await this.processarItem(usuario, item, mapaEmMemoria));
          hashEsperado = item.hashAtual;
          ultimoAbandonadoUuid = item.abandonada ? item.uuid : null;
        } catch (erro) {
          if (erro instanceof ConflitoEtapaError) {
            conflitos.push({ uuid: item.uuid, conflitoId: erro.conflitoId });
            hashEsperado = item.hashAtual;
            ultimoAbandonadoUuid = item.abandonada ? item.uuid : null;
            continue;
          }
          paradoNoIndice = i + indiceInicial;
          // Classificar a parada é o que permite ao app não chamar de "recusa
          // do servidor" o que foi só infraestrutura tropeçando — ver
          // paradaDefinitiva em ResultadoPush.
          if (erro instanceof HttpException) {
            const status = erro.getStatus();
            // 4xx = o Django avaliou e recusou (RBAC, alvo inexistente, dado
            // inválido); 5xx = o Django caiu/errou por dentro, o mesmo envio
            // pode passar na próxima.
            paradaDefinitiva = status >= 400 && status < 500;
            motivoParada = JSON.stringify(erro.getResponse());
          } else if (erro instanceof SyntaxError) {
            // Payload que não é JSON válido nunca vai virar JSON válido num retry.
            paradaDefinitiva = true;
            motivoParada = 'payload inválido (JSON malformado).';
          } else {
            // Tipicamente rede/conexão com o Django (sem resposta HTTP alguma):
            // não houve recusa de nada, pode ser transitório.
            paradaDefinitiva = false;
            motivoParada = 'Erro desconhecido ao processar item.';
          }
          break;
        }
      }
    }

    // Avanço da âncora com compare-and-swap: só grava se ela ainda estiver
    // exatamente no valor lido no início desta requisição. Duas requisições
    // sobrepostas do MESMO dispositivo (tipicamente um retry disparado antes
    // da primeira resposta chegar) liam a âncora antiga e gravavam no final —
    // a última a terminar vencia, podendo inclusive puxar a âncora para trás.
    // Se o swap falhar, o lote NÃO é dado como bem-sucedido: nada de
    // `confirmados` nem de LoteSincronizacao registrado, e o app trata o lote
    // como parado (paradoNoIndice/motivoParada) e reenvia. Itens que já
    // chegaram a ser aplicados no Django nesse meio-tempo são reprocessados
    // de forma idempotente no reenvio (get_or_create/reaplicação/"já
    // excluída"), pela mesma via da reconciliação de resposta perdida acima.
    const corridaDeAncora: ResultadoPush = {
      loteUuid: null,
      confirmados: [],
      conflitos: [],
      abandonados: [],
      paradoNoIndice: 0,
      motivoParada:
        'Sincronização concorrente detectada para este dispositivo — nenhum item foi confirmado neste lote, tente novamente.',
      // Nada foi recusado: é uma corrida entre dois envios do mesmo aparelho, e
      // o próprio texto acima manda tentar de novo. Marcar como definitiva
      // faria o app oferecer o descarte destrutivo de um item perfeitamente bom.
      paradaDefinitiva: false,
    };

    // Elos que fizeram a âncora avançar neste push — gravados na MESMA
    // transação do avanço, para que a prova usada pela reconciliação nunca
    // exista sem o avanço correspondente (nem o contrário).
    const avancaram = new Set<string>([
      ...confirmados.map((c) => c.uuid),
      ...conflitos.map((c) => c.uuid),
      ...abandonados,
    ]);
    const elos = dto.itens
      .filter((item) => avancaram.has(item.uuid))
      .map((item) => ({ usuarioId: usuario.id, dispositivoId, uuidOperacao: item.uuid, hashAtual: item.hashAtual }));

    if (ancora) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.ancoraDispositivo.updateMany({
            where: {
              usuarioId: usuario.id,
              dispositivoId,
              ultimoHashConfirmado: ancoraNoInicio,
            },
            // Os dois avançam juntos: o hash diz ONDE a âncora está, o uuid diz se
            // essa posição foi alcançada por um abandono (e por qual item) — é o
            // que autoriza a reconciliação de um abandonado reenviado no próximo push.
            data: { ultimoHashConfirmado: hashEsperado, ultimoAbandonadoUuid },
          });
          if (count === 0) {
            throw new AncoraMudouError();
          }
          // skipDuplicates: o primeiro item reconciliado já tem o seu elo.
          await tx.eloAceito.createMany({ data: elos, skipDuplicates: true });
        });
      } catch (erro) {
        if (erro instanceof AncoraMudouError) {
          return corridaDeAncora;
        }
        throw erro;
      }
    } else {
      // Primeiro push deste dispositivo: não há linha para o CAS proteger. O
      // @@unique([usuarioId, dispositivoId]) faz o próprio create ser o CAS —
      // se outra requisição concorrente criou a linha primeiro, ele falha e
      // caímos no mesmo tratamento de corrida.
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.ancoraDispositivo.create({
            data: {
              usuarioId: usuario.id,
              dispositivoId,
              ultimoHashConfirmado: hashEsperado,
              ultimoAbandonadoUuid,
            },
          });
          await tx.eloAceito.createMany({ data: elos, skipDuplicates: true });
        });
      } catch (erro) {
        // SÓ a violação de unicidade (P2002) é o sinal de corrida que este
        // caminho trata — é o @@unique([usuarioId, dispositivoId]) fazendo as
        // vezes do CAS. Qualquer outra falha (banco fora do ar, esquema
        // divergente) não é corrida nenhuma: engoli-la aqui devolveria ao
        // dispositivo um "sincronização concorrente, tente de novo" que
        // esconderia um problema real de infraestrutura atrás de um retry
        // eterno. Essas sobem e viram 500, como devem.
        if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002') {
          return corridaDeAncora;
        }
        throw erro;
      }
    }

    // `itensConfirmados` conta só o que de fato virou efeito no Django —
    // abandonados (deliberadamente não aplicados) ficam de fora, pela mesma
    // razão que os conflitos já ficavam: é um diagnóstico de quanto do lote
    // produziu escrita, não de quantos elos foram aceitos na cadeia.
    const lote = await this.prisma.loteSincronizacao.create({
      data: {
        usuarioId: usuario.id,
        totalItens: dto.itens.length,
        itensConfirmados: confirmados.length,
        hashChainOk: validacao.ok,
      },
    });

    return {
      loteUuid: lote.uuid,
      confirmados,
      conflitos,
      abandonados,
      paradoNoIndice,
      motivoParada,
      paradaDefinitiva,
    };
  }

  /** O servidor já aceitou este elo exato (uuid + hash) deste dispositivo? Ver EloAceito no schema. */
  private async eloJaAceito(usuarioId: number, dispositivoId: string, item: ItemPushDto): Promise<boolean> {
    const elo = await this.prisma.eloAceito.findUnique({
      where: { usuarioId_dispositivoId_uuidOperacao: { usuarioId, dispositivoId, uuidOperacao: item.uuid } },
    });
    return elo?.hashAtual === item.hashAtual;
  }

  async listarAuditorias(usuario: UsuarioAutenticado): Promise<AuditoriaDjango[]> {
    return this.djangoBridge.listarAuditorias(usuario.djangoUsuarioUuid);
  }

  async listarEtapas(usuario: UsuarioAutenticado, auditoriaUuid: string): Promise<EtapaDjango[]> {
    return this.djangoBridge.listarEtapas(usuario.djangoUsuarioUuid, auditoriaUuid);
  }
}
