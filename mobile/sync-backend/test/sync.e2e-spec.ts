import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { calcularProximoHash } from '../src/sync/hash-chain.util';
import { ConflitoEtapaError, DjangoBridgeService } from '../src/sync/django-bridge.service';
import { SyncService } from '../src/sync/sync.service';
import { UsuarioAutenticado } from '../src/auth/jwt.strategy';

/**
 * Suíte E2E do protocolo de sincronização (POST /sync/push, GET /sync/auditorias,
 * GET /sync/auditorias/:uuid/etapas) — espelha em Jest o mesmo roteiro que um
 * arquivo .http do REST Client cobriria manualmente, mas de ponta a ponta
 * automatizado: sobe o Nest de verdade (`npm run test:e2e`), fala com o
 * Postgres real do sync-backend (mesmo `controladoria_sync` do .env), e só
 * troca por um dublê o único vizinho que não faz sentido chamar de verdade
 * aqui — o `DjangoBridgeService` (HTTP para o núcleo Django) — porque o que
 * este arquivo testa é o PROTOCOLO de sincronização (cadeia de hashes,
 * âncora, conflito, abandono, corrida), não o Django em si.
 *
 * Cada bloco segue o padrão [CORRETO]/[INCORRETO] do roteiro de referência:
 * o rótulo diz se o fluxo deveria ou não ser aceito, e o `it()` já é a
 * verificação automática do resultado esperado — nada de copiar token do
 * terminal à mão.
 */

const HASH_GENESIS = '0'.repeat(64);
const USERNAME_TESTE = 'sync.e2e.teste';
const SENHA_TESTE = 'SenhaForte123!';

interface EloConstruido {
  uuid: string;
  payload: string;
  criadoEm: string;
  hashAnterior: string;
  hashAtual: string;
  abandonada?: boolean;
}

/** Constrói uma cadeia de itens válida, encadeando hashAnterior/hashAtual a
 * partir de `hashInicial` — exatamente como o app mobile faz localmente
 * antes de enviar (ver mobile/app/src/db/hashChain.ts). */
function construirCadeia(
  hashInicial: string,
  itens: Array<{ payload: Record<string, unknown>; abandonada?: boolean }>,
): EloConstruido[] {
  let hashAnterior = hashInicial;
  const cadeia: EloConstruido[] = [];
  for (const item of itens) {
    const uuid = randomUUID();
    const payload = JSON.stringify(item.payload);
    const criadoEm = new Date().toISOString();
    const hashAtual = calcularProximoHash(hashAnterior, uuid, payload, criadoEm);
    cadeia.push({ uuid, payload, criadoEm, hashAnterior, hashAtual, abandonada: item.abandonada });
    hashAnterior = hashAtual;
  }
  return cadeia;
}

describe('Sincronização (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let djangoBridge: {
    listarAuditorias: jest.Mock;
    listarEtapas: jest.Mock;
    criarAchado: jest.Mock;
    criarEtapa: jest.Mock;
    editarEtapa: jest.Mock;
    excluirEtapa: jest.Mock;
  };
  let usuarioId: number;
  let accessToken: string;
  let usuarioAutenticado: UsuarioAutenticado;

  beforeAll(async () => {
    djangoBridge = {
      listarAuditorias: jest.fn(),
      listarEtapas: jest.fn(),
      criarAchado: jest.fn(),
      criarEtapa: jest.fn(),
      editarEtapa: jest.fn(),
      excluirEtapa: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DjangoBridgeService)
      .useValue(djangoBridge)
      // O throttle de login (5/60s) e o global (100/60s) existem para o app
      // real, não fazem sentido limitando uma suíte que roda dezenas de
      // requisições em segundos — desligado só aqui, no processo de teste.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);

    // Usuário de teste isolado (não reaproveita auditor.campo nem nenhum
    // usuário real) — recriado do zero a cada execução da suíte, para o
    // resultado não depender de estado deixado por uma rodada anterior.
    await prisma.usuario.deleteMany({ where: { username: USERNAME_TESTE } });
    const senhaHash = await bcrypt.hash(SENHA_TESTE, 10);
    const usuario = await prisma.usuario.create({
      data: {
        username: USERNAME_TESTE,
        senhaHash,
        nomeCompleto: 'Usuário de Teste E2E',
        perfil: 'Funcionário',
        djangoUsuarioUuid: randomUUID(),
        ativo: true,
      },
    });
    usuarioId = usuario.id;
    usuarioAutenticado = {
      id: usuario.id,
      username: usuario.username,
      perfil: usuario.perfil,
      unidade: usuario.unidade,
      djangoUsuarioUuid: usuario.djangoUsuarioUuid,
    };
  });

  afterAll(async () => {
    // Limpa tudo que este usuário de teste possa ter gerado, na ordem que
    // respeita as FKs (âncoras/mapeamentos/lotes referenciam usuarioId).
    await prisma.ancoraDispositivo.deleteMany({ where: { usuarioId } });
    await prisma.eloAceito.deleteMany({ where: { usuarioId } });
    await prisma.mapeamentoUuidTemporario.deleteMany({ where: { usuarioId } });
    await prisma.loteSincronizacao.deleteMany({ where: { usuarioId } });
    await prisma.usuario.deleteMany({ where: { id: usuarioId } });
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // CENÁRIO 1 — Autenticação (POST /auth/login)
  // ===========================================================================
  describe('Cenário 1 — Autenticação', () => {
    it('[INCORRETO] 1.1 login com usuário inexistente -> 401', async () => {
      const resp = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'nao.existe.' + randomUUID(), password: 'qualquer' });
      expect(resp.status).toBe(401);
    });

    it('[INCORRETO] 1.2 login com senha errada -> 401', async () => {
      const resp = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: USERNAME_TESTE, password: 'senha-errada' });
      expect(resp.status).toBe(401);
    });

    it('[CORRETO] 1.3 login correto -> 200 + accessToken', async () => {
      const resp = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: USERNAME_TESTE, password: SENHA_TESTE });
      expect(resp.status).toBe(200);
      expect(typeof resp.body.accessToken).toBe('string');
      expect(resp.body.usuario.username).toBe(USERNAME_TESTE);
      accessToken = resp.body.accessToken;
    });

    it('[INCORRETO] 1.4 login em usuário inativo -> 401', async () => {
      await prisma.usuario.update({ where: { id: usuarioId }, data: { ativo: false } });
      const resp = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: USERNAME_TESTE, password: SENHA_TESTE });
      expect(resp.status).toBe(401);
      await prisma.usuario.update({ where: { id: usuarioId }, data: { ativo: true } });
    });

    it('[INCORRETO] 1.5 rota protegida sem token -> 401', async () => {
      const resp = await request(app.getHttpServer()).get('/sync/auditorias');
      expect(resp.status).toBe(401);
    });

    it('[INCORRETO] 1.6 rota protegida com token inventado -> 401', async () => {
      const resp = await request(app.getHttpServer())
        .get('/sync/auditorias')
        .set('Authorization', 'Bearer token-invalido-inventado');
      expect(resp.status).toBe(401);
    });

    it('[CORRETO] 1.7 rota protegida com token válido -> 200', async () => {
      djangoBridge.listarAuditorias.mockResolvedValueOnce([]);
      const resp = await request(app.getHttpServer())
        .get('/sync/auditorias')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(resp.status).toBe(200);
    });
  });

  // ===========================================================================
  // CENÁRIO 2 — POST /sync/push: validações de borda (antes de tocar na cadeia)
  // ===========================================================================
  describe('Cenário 2 — push: validações de borda', () => {
    it('[INCORRETO] 2.1 push sem header X-Device-Id -> 400', async () => {
      const [item] = construirCadeia(HASH_GENESIS, [{ payload: { tipo: 'etapa_criar' } }]);
      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ itens: [item] });
      expect(resp.status).toBe(400);
    });

    it('[INCORRETO] 2.2 push com itens=[] -> 400 (ArrayNotEmpty)', async () => {
      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: [] });
      expect(resp.status).toBe(400);
    });

    it('[INCORRETO] 2.3 push com hashAtual em formato inválido -> 400 (Matches SHA-256 hex)', async () => {
      const [item] = construirCadeia(HASH_GENESIS, [{ payload: { tipo: 'etapa_criar' } }]);
      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: [{ ...item, hashAtual: 'nao-e-um-sha256' }] });
      expect(resp.status).toBe(400);
    });

    it('[INCORRETO] 2.4 push sem autenticação -> 401 (guard roda antes do DTO)', async () => {
      const [item] = construirCadeia(HASH_GENESIS, [{ payload: { tipo: 'etapa_criar' } }]);
      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('X-Device-Id', randomUUID())
        .send({ itens: [item] });
      expect(resp.status).toBe(401);
    });
  });

  // ===========================================================================
  // CENÁRIO 3 — Fluxo feliz: etapa_criar + achado_criar no MESMO lote
  // (é justamente o caso "etapa offline + achado no mesmo lote" tratado nas
  // correções de concorrência do app mobile — aqui provado do lado servidor)
  // ===========================================================================
  describe('Cenário 3 — fluxo feliz: etapa + achado no mesmo lote, e continuação encadeada', () => {
    const dispositivoId = randomUUID();

    it('[CORRETO] 3.1 primeiro push (gênesis): etapa_criar seguida de achado_criar -> ambos confirmados', async () => {
      const etapaUuidTemp = randomUUID();
      djangoBridge.criarEtapa.mockResolvedValueOnce({
        id_unico: randomUUID(),
        orientacao: '', documentos: '', atividade: 'Vistoria', prazo: null, situacao: 'ABERTA', metodo: '',
      });
      djangoBridge.criarAchado.mockResolvedValueOnce({ id_unico: randomUUID(), data_achado: new Date().toISOString() });

      const cadeia = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'etapa_criar', auditoriaUuid: randomUUID(), campos: { orientacao: '', documentos: '', atividade: 'Vistoria', prazo: null, situacao: 'ABERTA', metodo: '' } } },
        { payload: { tipo: 'achado_criar', etapaUuid: etapaUuidTemp, descricao: 'Achado em campo' } },
      ]);
      // O uuid do 1º item da cadeia É o uuid temporário da etapa (ver
      // criarEtapaLocal no app) — corrige o payload do achado para apontar
      // para o mesmo uuid temporário que o item 0 representa.
      cadeia[1].payload = JSON.stringify({ tipo: 'achado_criar', etapaUuid: cadeia[0].uuid, descricao: 'Achado em campo' });
      cadeia[1].hashAtual = calcularProximoHash(cadeia[1].hashAnterior, cadeia[1].uuid, cadeia[1].payload, cadeia[1].criadoEm);

      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', dispositivoId)
        .send({ itens: cadeia });

      expect(resp.status).toBe(201);
      expect(resp.body.confirmados).toHaveLength(2);
      expect(resp.body.paradoNoIndice).toBeNull();
      expect(djangoBridge.criarEtapa).toHaveBeenCalledTimes(1);
      expect(djangoBridge.criarAchado).toHaveBeenCalledTimes(1);
      // O achado precisa ter resolvido o uuid TEMPORÁRIO da etapa para o
      // uuid REAL devolvido pelo Django — não o uuid local cru.
      const chamadaAchado = djangoBridge.criarAchado.mock.calls[0][0];
      expect(chamadaAchado.etapaUuid).not.toBe(cadeia[0].uuid);
    });

    it('[CORRETO] 3.2 segundo push do MESMO dispositivo, encadeado a partir da âncora -> confirmado', async () => {
      const ancora = await prisma.ancoraDispositivo.findUnique({
        where: { usuarioId_dispositivoId: { usuarioId, dispositivoId } },
      });
      expect(ancora?.ultimoHashConfirmado).not.toBeNull();

      djangoBridge.criarAchado.mockResolvedValueOnce({ id_unico: randomUUID(), data_achado: new Date().toISOString() });
      const cadeia = construirCadeia(ancora!.ultimoHashConfirmado!, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'Segundo achado' } },
      ]);

      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', dispositivoId)
        .send({ itens: cadeia });

      expect(resp.status).toBe(201);
      expect(resp.body.confirmados).toHaveLength(1);
    });
  });

  // ===========================================================================
  // CENÁRIO 4 — Cadeia corrompida/adulterada
  // ===========================================================================
  describe('Cenário 4 — cadeia inválida', () => {
    it('[INCORRETO] 4.1 hashAnterior não bate com a âncora esperada (gênesis) -> parada definitiva no índice 0', async () => {
      const cadeia = construirCadeia('f'.repeat(64), [
        { payload: { tipo: 'etapa_criar', auditoriaUuid: randomUUID(), campos: {} } },
      ]);
      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: cadeia });

      expect(resp.status).toBe(201); // a chamada em si é válida; a REJEIÇÃO vem no corpo
      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect(resp.body.paradaDefinitiva).toBe(true);
      expect(djangoBridge.criarEtapa).not.toHaveBeenCalled();
    });

    it('[INCORRETO] 4.2 hashAtual adulterado (não bate com o conteúdo do item) -> rejeitado no mesmo índice', async () => {
      const cadeia = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'etapa_criar', auditoriaUuid: randomUUID(), campos: {} } },
      ]);
      cadeia[0].hashAtual = calcularProximoHash(cadeia[0].hashAnterior, 'uuid-trocado', cadeia[0].payload, cadeia[0].criadoEm);

      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: cadeia });

      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect(resp.body.paradaDefinitiva).toBe(true);
    });

    it('[INCORRETO] 4.3 segundo item da cadeia com hashAnterior fora de ordem -> lote para no índice 1, item 0 fica confirmado', async () => {
      djangoBridge.criarEtapa.mockResolvedValueOnce({
        id_unico: randomUUID(), orientacao: '', documentos: '', atividade: '', prazo: null, situacao: 'ABERTA', metodo: '',
      });
      const cadeia = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'etapa_criar', auditoriaUuid: randomUUID(), campos: { orientacao: '', documentos: '', atividade: '', prazo: null, situacao: 'ABERTA', metodo: '' } } },
        { payload: { tipo: 'etapa_excluir', etapaUuid: randomUUID() } },
      ]);
      cadeia[1].hashAnterior = 'e'.repeat(64); // quebra a continuidade de propósito

      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: cadeia });

      // A validação da cadeia é feita para o LOTE INTEIRO antes de qualquer
      // item ser aplicado (ver validarCadeia + o `if (!validacao.ok)` em
      // SyncService.push) — não é "processa até onde dá": um item 1 inválido
      // barra até o item 0, que sozinho seria perfeitamente válido.
      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(1);
      expect(resp.body.paradaDefinitiva).toBe(true);
      expect(djangoBridge.criarEtapa).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // CENÁRIO 5 — Conflito de etapa_editar (baseline desatualizado)
  // ===========================================================================
  describe('Cenário 5 — conflito de etapa_editar', () => {
    it('[CORRETO] 5.1 Django sinaliza conflito_pendente -> item cai em `conflitos`, NÃO em falha, lote não para', async () => {
      djangoBridge.editarEtapa.mockRejectedValueOnce(new ConflitoEtapaError('conflito-123'));

      const cadeia = construirCadeia(HASH_GENESIS, [
        {
          payload: {
            tipo: 'etapa_editar',
            etapaUuid: randomUUID(),
            baseline: { situacao: 'ABERTA' },
            campos: { situacao: 'CONCLUIDA' },
          },
        },
      ]);

      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: cadeia });

      expect(resp.status).toBe(201);
      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.conflitos).toEqual([{ uuid: cadeia[0].uuid, conflitoId: 'conflito-123' }]);
      expect(resp.body.paradoNoIndice).toBeNull();
    });
  });

  // ===========================================================================
  // CENÁRIO 6 — Item abandonado (descartado pelo auditor no aparelho)
  // ===========================================================================
  describe('Cenário 6 — item abandonado', () => {
    it('[CORRETO] 6.1 item com abandonada=true -> hash validado, âncora avança, Django NUNCA é chamado', async () => {
      const cadeia = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'Vai ser descartado' }, abandonada: true },
      ]);

      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: cadeia });

      expect(resp.status).toBe(201);
      expect(resp.body.abandonados).toEqual([cadeia[0].uuid]);
      expect(resp.body.confirmados).toHaveLength(0);
      expect(djangoBridge.criarAchado).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // CENÁRIO 7 — Falhas vindas do Django: recusa definitiva vs. falha transitória
  // ===========================================================================
  describe('Cenário 7 — falha do Django', () => {
    it('[INCORRETO] 7.1 Django recusa com 403 (RBAC) -> parada DEFINITIVA, lote interrompido', async () => {
      const { HttpException } = require('@nestjs/common');
      djangoBridge.criarAchado.mockRejectedValueOnce(new HttpException({ detail: 'RBAC negado' }, 403));

      const cadeia = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'Sem permissão' } },
      ]);

      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: cadeia });

      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect(resp.body.paradaDefinitiva).toBe(true);
    });

    it('[INCORRETO] 7.2 Django cai com 5xx -> parada NÃO definitiva (reenvio deve funcionar depois)', async () => {
      const { HttpException } = require('@nestjs/common');
      djangoBridge.criarAchado.mockRejectedValueOnce(new HttpException({ detail: 'Erro interno' }, 502));

      const cadeia = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'Django fora do ar' } },
      ]);

      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: cadeia });

      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect(resp.body.paradaDefinitiva).toBe(false);
    });

    it('[INCORRETO] 7.3 falha de rede pura (sem resposta HTTP nenhuma) -> parada NÃO definitiva', async () => {
      djangoBridge.criarAchado.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const cadeia = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'Sem rede' } },
      ]);

      const resp = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Device-Id', randomUUID())
        .send({ itens: cadeia });

      expect(resp.body.paradoNoIndice).toBe(0);
      expect(resp.body.paradaDefinitiva).toBe(false);
    });
  });

  // ===========================================================================
  // CENÁRIO 8 — Corrida de âncora: dois pushes concorrentes do MESMO dispositivo
  // ===========================================================================
  describe('Cenário 8 — corrida de âncora', () => {
    /**
     * Duas requisições HTTP "concorrentes" via Promise.all, num processo Node
     * único falando com um Postgres local rápido, tendem a serializar sem
     * nunca colidir de verdade na janela crítica (findUnique -> create) — o
     * teste passaria "por sorte" sem provar nada sobre o compare-and-swap.
     * Para forçar a colisão de forma determinística, chamamos o SyncService
     * diretamente (pulando a camada HTTP só aqui) e atrasamos artificialmente
     * o `ancoraDispositivo.create` real, garantindo que as duas chamadas
     * cheguem ao INSERT do Postgres ao mesmo tempo.
     */
    it('[INCORRETO] 8.1 dois primeiros-pushes concorrentes do mesmo dispositivo -> um vence, o outro recebe aviso de corrida', async () => {
      const syncService = app.get(SyncService);
      const dispositivoId = randomUUID();
      djangoBridge.criarEtapa.mockResolvedValue({
        id_unico: randomUUID(), orientacao: '', documentos: '', atividade: '', prazo: null, situacao: 'ABERTA', metodo: '',
      });

      const criarOriginal = prisma.ancoraDispositivo.create.bind(prisma.ancoraDispositivo);
      const espiao = jest
        .spyOn(prisma.ancoraDispositivo, 'create')
        .mockImplementation(((args: unknown) =>
          new Promise((resolve) => setTimeout(resolve, 75)).then(() => criarOriginal(args as never))) as never);

      const cadeiaA = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'etapa_criar', auditoriaUuid: randomUUID(), campos: { orientacao: '', documentos: '', atividade: 'A', prazo: null, situacao: 'ABERTA', metodo: '' } } },
      ]);
      const cadeiaB = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'etapa_criar', auditoriaUuid: randomUUID(), campos: { orientacao: '', documentos: '', atividade: 'B', prazo: null, situacao: 'ABERTA', metodo: '' } } },
      ]);

      let resultados: Awaited<ReturnType<SyncService['push']>>[];
      try {
        resultados = await Promise.all([
          syncService.push(usuarioAutenticado, { itens: cadeiaA }, dispositivoId),
          syncService.push(usuarioAutenticado, { itens: cadeiaB }, dispositivoId),
        ]);
      } finally {
        // Se um dos pushes lançar, o espião não pode ficar instalado: todo
        // create() de âncora dos cenários seguintes ganharia 75ms de atraso
        // artificial — falha em cascata sem relação com o que quebrou aqui.
        espiao.mockRestore();
      }
      const vencedores = resultados.filter((r) => r.confirmados.length === 1);
      const perdedores = resultados.filter((r) => r.confirmados.length === 0);

      // @@unique([usuarioId, dispositivoId]) faz o próprio create() ser o CAS —
      // só UM dos dois cria a linha da âncora; o outro cai no catch de P2002.
      // Não afirmamos qual dos dois (A ou B) vence, só que exatamente um vence.
      expect(vencedores).toHaveLength(1);
      expect(perdedores).toHaveLength(1);
      expect(perdedores[0].motivoParada).toMatch(/concorrente/i);
      expect(perdedores[0].paradaDefinitiva).toBe(false);
    });
  });

  // ===========================================================================
  // CENÁRIO 9 — Listagem (repasse simples para o Django-bridge, mockado)
  // ===========================================================================
  describe('Cenário 9 — listagem de auditorias/etapas', () => {
    it('[CORRETO] 9.1 GET /sync/auditorias repassa a lista do Django-bridge', async () => {
      const auditorias = [{ id_unico: randomUUID(), nome_auditoria: 'veiculos', orgao: 'SEFAZ', status: 'EM_ANDAMENTO' }];
      djangoBridge.listarAuditorias.mockResolvedValueOnce(auditorias);

      const resp = await request(app.getHttpServer())
        .get('/sync/auditorias')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(resp.status).toBe(200);
      expect(resp.body).toEqual(auditorias);
    });

    it('[CORRETO] 9.2 GET /sync/auditorias/:uuid/etapas repassa a lista do Django-bridge', async () => {
      const auditoriaUuid = randomUUID();
      const etapas = [{ id_unico: randomUUID(), orientacao: '', documentos: '', atividade: 'Vistoria', prazo: null, situacao: 'ABERTA', metodo: '' }];
      djangoBridge.listarEtapas.mockResolvedValueOnce(etapas);

      const resp = await request(app.getHttpServer())
        .get(`/sync/auditorias/${auditoriaUuid}/etapas`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(resp.status).toBe(200);
      expect(resp.body).toEqual(etapas);
      expect(djangoBridge.listarEtapas).toHaveBeenCalledWith(expect.any(String), auditoriaUuid);
    });
  });

  // Atalho para os cenários abaixo — todos fazem a mesma chamada autenticada.
  function push(dispositivoId: string, itens: EloConstruido[]) {
    return request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Device-Id', dispositivoId)
      .send({ itens });
  }

  function ancoraDe(dispositivoId: string) {
    return prisma.ancoraDispositivo.findUnique({
      where: { usuarioId_dispositivoId: { usuarioId, dispositivoId } },
    });
  }

  const respostaAchado = () => ({ id_unico: randomUUID(), data_achado: new Date().toISOString() });
  const respostaEtapa = (id = randomUUID()) => ({
    id_unico: id, orientacao: '', documentos: '', atividade: '', prazo: null, situacao: 'PENDENTE', metodo: '',
  });

  // ===========================================================================
  // CENÁRIO 10 — Reconciliação de resposta perdida
  // O Django confirmou e a âncora avançou, mas a resposta HTTP não chegou ao
  // app. Ele reenvia o MESMO item com o hashAnterior antigo — que agora não
  // bate mais com a âncora. Sem reconciliação, esse aparelho travaria para
  // sempre. (Ver o bloco `primeiro` em SyncService.push.)
  // ===========================================================================
  describe('Cenário 10 — reconciliação de resposta perdida', () => {
    it('[CORRETO] 10.1 reenvio do item já confirmado (+ um novo) -> reprocessa o 1º de forma idempotente, confirma os dois, âncora avança', async () => {
      const dispositivoId = randomUUID();
      djangoBridge.criarAchado.mockResolvedValue(respostaAchado());

      const [item1] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'primeiro' } },
      ]);
      await push(dispositivoId, [item1]).expect(201);
      expect((await ancoraDe(dispositivoId))?.ultimoHashConfirmado).toBe(item1.hashAtual);

      // "Resposta perdida": o app ainda tem item1 pendente e encadeia item2 nele.
      const [item2] = construirCadeia(item1.hashAtual, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'segundo' } },
      ]);
      const resp = await push(dispositivoId, [item1, item2]);

      expect(resp.status).toBe(201);
      expect(resp.body.confirmados.map((c: { uuid: string }) => c.uuid)).toEqual([item1.uuid, item2.uuid]);
      expect(resp.body.paradoNoIndice).toBeNull();
      // item1 chega ao Django DUAS vezes (push 1 e reconciliação) — a
      // idempotência por origem_mobile_uuid é responsabilidade dele.
      const uuidsEnviados = djangoBridge.criarAchado.mock.calls.map((c) => c[0].origemMobileUuid);
      expect(uuidsEnviados).toEqual([item1.uuid, item1.uuid, item2.uuid]);
      expect((await ancoraDe(dispositivoId))?.ultimoHashConfirmado).toBe(item2.hashAtual);
    });

    it('[INCORRETO] 10.2 item auto-consistente nunca aceito antes NÃO é reconciliado, mesmo que o Django o aceitasse', async () => {
      // Antes, o único "freio" da reconciliação era o Django recusar o item.
      // Uma criação NOVA forjada com hash auto-consistente, partindo do
      // gênesis, o Django aceita — e a cadeia era re-ancorada nela. Agora a
      // prova exigida é o servidor já ter aceito este elo exato (EloAceito):
      // o item cai na validação normal, sem chegar ao Django.
      const dispositivoId = randomUUID();
      djangoBridge.criarAchado.mockResolvedValue(respostaAchado());
      const [legitimo] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'ok' } },
      ]);
      await push(dispositivoId, [legitimo]).expect(201);

      const [forjado] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'forjado' } },
      ]);
      const resp = await push(dispositivoId, [forjado]);

      expect(djangoBridge.criarAchado).toHaveBeenCalledTimes(1);
      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect(resp.body.paradaDefinitiva).toBe(true);
      expect(resp.body.motivoParada).toMatch(/Cadeia de hashes inválida/);
      expect((await ancoraDe(dispositivoId))?.ultimoHashConfirmado).toBe(legitimo.hashAtual);
    });

    it('[CORRETO] 10.3 reenvio de etapa_editar já aplicada vira conflito no Django -> reconciliado como `conflitos`, não como falha', async () => {
      const dispositivoId = randomUUID();
      djangoBridge.editarEtapa.mockResolvedValueOnce(respostaEtapa());
      const [edicao] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'etapa_editar', etapaUuid: randomUUID(), baseline: { situacao: 'PENDENTE' }, campos: { situacao: 'CONCLUIDA' } } },
      ]);
      await push(dispositivoId, [edicao]).expect(201);

      // Reaplicar a mesma edição: o baseline antigo não bate mais → o Django
      // devolve conflito_pendente. Sem este ramo, o item ficaria preso para
      // sempre e cada retry criaria um ConflitoEtapa espúrio.
      djangoBridge.editarEtapa.mockRejectedValueOnce(new ConflitoEtapaError('c-1'));
      const resp = await push(dispositivoId, [edicao]);

      expect(resp.body.conflitos).toEqual([{ uuid: edicao.uuid, conflitoId: 'c-1' }]);
      expect(resp.body.paradoNoIndice).toBeNull();
      expect((await ancoraDe(dispositivoId))?.ultimoHashConfirmado).toBe(edicao.hashAtual);
    });

    it('[INCORRETO] 10.4 elo com o MESMO uuid de um já aceito, mas conteúdo trocado, não é reconciliado', async () => {
      // O uuid sozinho não basta como prova: o hash registrado precisa bater.
      const dispositivoId = randomUUID();
      djangoBridge.criarAchado.mockResolvedValue(respostaAchado());
      const etapaUuid = randomUUID();
      const [original] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid, descricao: 'original' } },
      ]);
      await push(dispositivoId, [original]).expect(201);

      const [trocado] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid, descricao: 'trocado' } },
      ]).map((item) => ({ ...item, uuid: original.uuid }));
      // Recalcula o hash com o uuid original, para o item ser auto-consistente.
      trocado.hashAtual = calcularProximoHash(trocado.hashAnterior, trocado.uuid, trocado.payload, trocado.criadoEm);

      const resp = await push(dispositivoId, [trocado]);
      expect(djangoBridge.criarAchado).toHaveBeenCalledTimes(1);
      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect((await ancoraDe(dispositivoId))?.ultimoHashConfirmado).toBe(original.hashAtual);
    });

    it('[CORRETO] 10.5 cada elo que avança a âncora fica registrado, na mesma operação do avanço', async () => {
      const dispositivoId = randomUUID();
      djangoBridge.criarAchado.mockResolvedValue(respostaAchado());
      const itens = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'a' } },
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'b' } },
      ]);
      await push(dispositivoId, itens).expect(201);
      const elos = await prisma.eloAceito.findMany({ where: { usuarioId, dispositivoId }, orderBy: { id: 'asc' } });
      expect(elos.map((e) => [e.uuidOperacao, e.hashAtual])).toEqual(itens.map((i) => [i.uuid, i.hashAtual]));
    });
  });

  // ===========================================================================
  // CENÁRIO 11 — Abandonado reenviado: o único caso em que a reconciliação
  // não tem o Django como freio. A prova exigida é a memória do servidor
  // (`ultimoAbandonadoUuid`): "eu já pulei exatamente este uuid".
  // ===========================================================================
  describe('Cenário 11 — abandonado reenviado', () => {
    it('[CORRETO] 11.1 reenvio do abandonado que a âncora LEMBRA -> reconhecido de novo, Django nunca chamado, lote segue', async () => {
      const dispositivoId = randomUUID();
      const [abandonado] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'descartado' }, abandonada: true },
      ]);
      await push(dispositivoId, [abandonado]).expect(201);
      const ancora = await ancoraDe(dispositivoId);
      expect(ancora?.ultimoHashConfirmado).toBe(abandonado.hashAtual);
      expect(ancora?.ultimoAbandonadoUuid).toBe(abandonado.uuid);

      djangoBridge.criarAchado.mockResolvedValueOnce(respostaAchado());
      const [novo] = construirCadeia(abandonado.hashAtual, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'novo' } },
      ]);
      const resp = await push(dispositivoId, [abandonado, novo]);

      expect(resp.body.abandonados).toEqual([abandonado.uuid]);
      expect(resp.body.confirmados.map((c: { uuid: string }) => c.uuid)).toEqual([novo.uuid]);
      expect(djangoBridge.criarAchado).toHaveBeenCalledTimes(1);
      // A âncora avançou pelo item confirmado: a memória do abandono é limpa.
      const depois = await ancoraDe(dispositivoId);
      expect(depois?.ultimoHashConfirmado).toBe(novo.hashAtual);
      expect(depois?.ultimoAbandonadoUuid).toBeNull();
    });

    it('[INCORRETO] 11.2 abandonado forjado quando a âncora veio de item NORMAL -> rejeitado, âncora intacta', async () => {
      // Aparelho comprometido tenta re-ancorar a cadeia num valor arbitrário
      // mandando um "abandonado" auto-consistente que parte do gênesis.
      const dispositivoId = randomUUID();
      djangoBridge.criarAchado.mockResolvedValueOnce(respostaAchado());
      const [legitimo] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'ok' } },
      ]);
      await push(dispositivoId, [legitimo]).expect(201);
      djangoBridge.criarAchado.mockClear();

      const [forjado, carona] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'x' }, abandonada: true },
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'entra de carona' } },
      ]);
      const resp = await push(dispositivoId, [forjado, carona]);

      expect(resp.body.abandonados).toHaveLength(0);
      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect(resp.body.paradaDefinitiva).toBe(true);
      expect(djangoBridge.criarAchado).not.toHaveBeenCalled();
      expect((await ancoraDe(dispositivoId))?.ultimoHashConfirmado).toBe(legitimo.hashAtual);
    });

    it('[INCORRETO] 11.3 abandonado forjado com uuid DIFERENTE do que a âncora lembra -> rejeitado', async () => {
      // A âncora lembra de um abandono, mas não deste uuid — a checagem é por
      // igualdade exata, não por "houve algum abandono".
      const dispositivoId = randomUUID();
      const [lembrado] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'a' }, abandonada: true },
      ]);
      await push(dispositivoId, [lembrado]).expect(201);

      const [outro] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'b' }, abandonada: true },
      ]);
      const resp = await push(dispositivoId, [outro]);

      expect(resp.body.abandonados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect((await ancoraDe(dispositivoId))?.ultimoAbandonadoUuid).toBe(lembrado.uuid);
    });
  });

  // ===========================================================================
  // CENÁRIO 12 — etapa_excluir (único tipo sem cobertura até aqui)
  // ===========================================================================
  describe('Cenário 12 — etapa_excluir', () => {
    it('[CORRETO] 12.1 exclusão de etapa real -> confirmada com o próprio uuid como entidade', async () => {
      const etapaUuid = randomUUID();
      djangoBridge.excluirEtapa.mockResolvedValueOnce({ id_unico: etapaUuid, ja_excluida: false });
      const cadeia = construirCadeia(HASH_GENESIS, [{ payload: { tipo: 'etapa_excluir', etapaUuid } }]);

      const resp = await push(randomUUID(), cadeia);

      expect(resp.body.confirmados).toEqual([{ uuid: cadeia[0].uuid, entidadeDjangoUuid: etapaUuid }]);
      expect(djangoBridge.excluirEtapa).toHaveBeenCalledWith(expect.objectContaining({ etapaUuid }));
    });

    it('[CORRETO] 12.2 excluir etapa criada offline no MESMO lote -> Django recebe o uuid REAL, não o temporário', async () => {
      const idReal = randomUUID();
      djangoBridge.criarEtapa.mockResolvedValueOnce(respostaEtapa(idReal));
      djangoBridge.excluirEtapa.mockResolvedValueOnce({ id_unico: idReal, ja_excluida: false });

      const cadeia = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'etapa_criar', auditoriaUuid: randomUUID(), campos: respostaEtapa() } },
        { payload: { tipo: 'etapa_excluir', etapaUuid: 'placeholder' } },
      ]);
      cadeia[1].payload = JSON.stringify({ tipo: 'etapa_excluir', etapaUuid: cadeia[0].uuid });
      cadeia[1].hashAtual = calcularProximoHash(cadeia[1].hashAnterior, cadeia[1].uuid, cadeia[1].payload, cadeia[1].criadoEm);

      const resp = await push(randomUUID(), cadeia);

      expect(resp.body.confirmados).toHaveLength(2);
      expect(djangoBridge.excluirEtapa).toHaveBeenCalledWith(expect.objectContaining({ etapaUuid: idReal }));
    });
  });

  // ===========================================================================
  // CENÁRIO 13 — Multi-dispositivo: a âncora é por (usuário, DISPOSITIVO)
  // ===========================================================================
  describe('Cenário 13 — mesmo usuário em dois aparelhos', () => {
    it('[CORRETO] 13.1 dois aparelhos partem do gênesis de forma independente e cada um continua da SUA âncora', async () => {
      const d1 = randomUUID();
      const d2 = randomUUID();
      djangoBridge.criarAchado.mockResolvedValue(respostaAchado());

      const [a1] = construirCadeia(HASH_GENESIS, [{ payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'd1' } }]);
      const [b1] = construirCadeia(HASH_GENESIS, [{ payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'd2' } }]);
      expect((await push(d1, [a1])).body.confirmados).toHaveLength(1);
      // d2 também parte do gênesis — NÃO é barrado pela âncora de d1.
      expect((await push(d2, [b1])).body.confirmados).toHaveLength(1);

      const [a2] = construirCadeia(a1.hashAtual, [{ payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'd1-2' } }]);
      const [b2] = construirCadeia(b1.hashAtual, [{ payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'd2-2' } }]);
      expect((await push(d1, [a2])).body.confirmados).toHaveLength(1);
      expect((await push(d2, [b2])).body.confirmados).toHaveLength(1);

      expect((await ancoraDe(d1))?.ultimoHashConfirmado).toBe(a2.hashAtual);
      expect((await ancoraDe(d2))?.ultimoHashConfirmado).toBe(b2.hashAtual);
    });

    it('[INCORRETO] 13.2 aparelho que tenta continuar da âncora do OUTRO aparelho é rejeitado', async () => {
      const d1 = randomUUID();
      const d2 = randomUUID();
      djangoBridge.criarAchado.mockResolvedValue(respostaAchado());
      const [a1] = construirCadeia(HASH_GENESIS, [{ payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'd1' } }]);
      await push(d1, [a1]).expect(201);

      // d2 nunca sincronizou (âncora = gênesis), mas manda um elo encadeado no hash de d1.
      const [cruzado] = construirCadeia(a1.hashAtual, [{ payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'x' } }]);
      const resp = await push(d2, [cruzado]);

      expect(resp.body.confirmados).toHaveLength(0);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect(resp.body.paradaDefinitiva).toBe(true);
    });
  });

  // ===========================================================================
  // CENÁRIO 14 — Payload que não é JSON: hash bate, mas o conteúdo é lixo
  // ===========================================================================
  describe('Cenário 14 — payload malformado', () => {
    it('[INCORRETO] 14.1 payload não-JSON com hash consistente -> parada DEFINITIVA, Django nunca chamado', async () => {
      const uuid = randomUUID();
      const payload = '{"tipo":"achado_criar","etapaUuid":'; // truncado
      const criadoEm = new Date().toISOString();
      const item: EloConstruido = { uuid, payload, criadoEm, hashAnterior: HASH_GENESIS, hashAtual: calcularProximoHash(HASH_GENESIS, uuid, payload, criadoEm) };

      const resp = await push(randomUUID(), [item]);

      expect(resp.status).toBe(201);
      expect(resp.body.paradoNoIndice).toBe(0);
      expect(resp.body.paradaDefinitiva).toBe(true);
      expect(resp.body.motivoParada).toMatch(/JSON/);
      expect(djangoBridge.criarAchado).not.toHaveBeenCalled();
    });

    it('[INCORRETO] 14.2 tipo de operação desconhecido -> parada NÃO definitiva (erro do servidor, não recusa do Django)', async () => {
      const cadeia = construirCadeia(HASH_GENESIS, [{ payload: { tipo: 'tipo_inventado', x: 1 } }]);
      const resp = await push(randomUUID(), cadeia);
      expect(resp.body.paradoNoIndice).toBe(0);
      // Não é HttpException nem SyntaxError → cai no "erro desconhecido",
      // classificado como transitório: não pode habilitar o descarte
      // destrutivo no app por um bug do servidor.
      expect(resp.body.paradaDefinitiva).toBe(false);
    });
  });

  // ===========================================================================
  // CENÁRIO 15 — Mapeamento de uuid temporário PERSISTIDO entre pushes
  // ===========================================================================
  describe('Cenário 15 — uuid temporário resolvido a partir do banco', () => {
    it('[CORRETO] 15.1 achado num push posterior referenciando etapa criada num push anterior -> resolve pelo MapeamentoUuidTemporario', async () => {
      const dispositivoId = randomUUID();
      const idReal = randomUUID();
      djangoBridge.criarEtapa.mockResolvedValueOnce(respostaEtapa(idReal));

      const [etapa] = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'etapa_criar', auditoriaUuid: randomUUID(), campos: respostaEtapa() } },
      ]);
      await push(dispositivoId, [etapa]).expect(201);
      await expect(prisma.mapeamentoUuidTemporario.findUnique({
        where: { usuarioId_uuidTemporario: { usuarioId, uuidTemporario: etapa.uuid } },
      })).resolves.toMatchObject({ uuidDjango: idReal });

      // Push separado (mapa em memória do push anterior já não existe).
      djangoBridge.criarAchado.mockResolvedValueOnce(respostaAchado());
      const [achado] = construirCadeia(etapa.hashAtual, [
        { payload: { tipo: 'achado_criar', etapaUuid: etapa.uuid, descricao: 'contra a etapa offline' } },
      ]);
      const resp = await push(dispositivoId, [achado]);

      expect(resp.body.confirmados).toHaveLength(1);
      expect(djangoBridge.criarAchado).toHaveBeenCalledWith(expect.objectContaining({ etapaUuid: idReal }));
    });
  });

  // ===========================================================================
  // CENÁRIO 16 — LoteSincronizacao: o diagnóstico que fica no servidor
  // ===========================================================================
  describe('Cenário 16 — registro do lote', () => {
    it('[CORRETO] 16.1 itensConfirmados conta só o que virou escrita no Django (abandonado e conflito ficam de fora)', async () => {
      djangoBridge.criarAchado.mockResolvedValueOnce(respostaAchado());
      djangoBridge.editarEtapa.mockRejectedValueOnce(new ConflitoEtapaError('c-2'));
      const cadeia = construirCadeia(HASH_GENESIS, [
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'ok' } },
        { payload: { tipo: 'achado_criar', etapaUuid: randomUUID(), descricao: 'x' }, abandonada: true },
        { payload: { tipo: 'etapa_editar', etapaUuid: randomUUID(), baseline: {}, campos: {} } },
      ]);
      const resp = await push(randomUUID(), cadeia);

      const lote = await prisma.loteSincronizacao.findUnique({ where: { uuid: resp.body.loteUuid } });
      expect(lote).toMatchObject({ totalItens: 3, itensConfirmados: 1, hashChainOk: true });
    });

    it('[INCORRETO] 16.2 cadeia inválida fica registrada com hashChainOk=false', async () => {
      const cadeia = construirCadeia('d'.repeat(64), [{ payload: { tipo: 'etapa_excluir', etapaUuid: randomUUID() } }]);
      const resp = await push(randomUUID(), cadeia);
      const lote = await prisma.loteSincronizacao.findUnique({ where: { uuid: resp.body.loteUuid } });
      expect(lote).toMatchObject({ totalItens: 1, itensConfirmados: 0, hashChainOk: false });
    });
  });
});
