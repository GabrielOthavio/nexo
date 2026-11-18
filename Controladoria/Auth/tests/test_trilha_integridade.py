"""
Integridade da trilha central e do Identificador Semântico — as correções que
a revisão do TCC (seções 4.2 e 4.3) apontou:

  - ordinal por órgão único também na PRIMEIRA auditoria, sob concorrência;
  - gravação do registro e do histórico na mesma transação;
  - alteração da equipe (muitos-para-muitos) entrando na trilha;
  - histórico só por acréscimo: nem ORM, nem SQL direto, nem admin alteram
    ou apagam entradas (gatilho da migration 0018);
  - trilha encadeada por hash, verificável;
  - exclusão de etapa visível na aba de histórico da auditoria.
"""
from io import StringIO
from unittest import mock

from django.contrib.admin.sites import site
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.test import RequestFactory, TestCase
from django.urls import reverse

from ..middleware import set_current_user
from ..models import Auditoria, Etapa, HistoricoAlteracoes
from ..views.historico import historico_da_auditoria
from .base import PERM_TOTAL, campos_etapa, criar_etapa, criar_perfil, criar_usuario, hasher_rapido


class OrdinalPorOrgaoTest(TestCase):

    def test_ordinal_e_contado_por_orgao(self):
        a = Auditoria.objects.create(nome_auditoria='A', orgao='SEFAZ')
        b = Auditoria.objects.create(nome_auditoria='B', orgao='SESAU')
        c = Auditoria.objects.create(nome_auditoria='C', orgao='SEFAZ')
        self.assertEqual((a.id_por_orgao, b.id_por_orgao, c.id_por_orgao), (1, 1, 2))

    def test_banco_recusa_ordinal_repetido_no_mesmo_orgao(self):
        Auditoria.objects.create(nome_auditoria='A', orgao='SEFAZ')
        with self.assertRaises(IntegrityError), transaction.atomic():
            Auditoria.objects.create(nome_auditoria='B', orgao='SEFAZ', id_por_orgao=1)

    def test_sem_orgao_vazio_e_nulo_sao_o_mesmo_grupo(self):
        a = Auditoria.objects.create(nome_auditoria='A', orgao=None)
        b = Auditoria.objects.create(nome_auditoria='B', orgao='')
        self.assertEqual((a.id_por_orgao, b.id_por_orgao), (1, 2))

    def test_corrida_na_primeira_auditoria_do_orgao_e_refeita(self):
        """
        Reproduz a corrida: a outra transação gravou o ordinal 1 depois que
        esta já tinha lido "não há nenhuma" — o select_for_update não trava o
        que ainda não existe. A restrição recusa o 1 repetido e o save() refaz
        a conta, chegando a 2.
        """
        Auditoria.objects.create(nome_auditoria='Concorrente', orgao='SEINFRA')
        real = Auditoria.objects.select_for_update
        leituras = []

        def leitura_defasada(*args, **kwargs):
            leituras.append(1)
            if len(leituras) == 1:
                return Auditoria.objects.none()
            return real(*args, **kwargs)

        with mock.patch.object(Auditoria.objects, 'select_for_update', side_effect=leitura_defasada):
            nova = Auditoria.objects.create(nome_auditoria='Nova', orgao='SEINFRA')
        self.assertEqual(nova.id_por_orgao, 2)
        self.assertEqual(len(leituras), 2)


@hasher_rapido
class TrilhaNaMesmaTransacaoTest(TestCase):
    SENHA = 'senha-forte-123'

    def setUp(self):
        perfil = criar_perfil('Auditor teste', {'auditorias': PERM_TOTAL})
        self.auditor = criar_usuario('auditor', perfil, senha=self.SENHA)
        self.auditoria = Auditoria.objects.create(nome_auditoria='Aud', status='EM_ANDAMENTO', orgao='SEFAZ')
        self.auditoria.usuarios_envolvidos.set([self.auditor])
        self.etapa = criar_etapa(self.auditoria, self.auditor, atividade='Antes')
        self.client.login(username='auditor', password=self.SENHA)
        self.url = reverse('Auth:editar_etapa', kwargs={'id_unico': self.auditoria.id_unico,
                                                        'etapa_id': self.etapa.id_unico})

    def post_edicao(self):
        dados = campos_etapa(self.etapa)
        dados['atividade'] = 'Depois'
        dados['usuario'] = self.auditor.pk
        resposta = self.client.post(self.url, {k: v or '' for k, v in dados.items()})
        # 302 = formulário aceito; um 200 aqui seria formulário inválido, e o
        # teste passaria a não provar nada.
        self.assertEqual(resposta.status_code, 302)
        return resposta

    def test_edicao_normal_grava_registro_e_historico(self):
        antes = HistoricoAlteracoes.objects.count()
        self.post_edicao()
        self.etapa.refresh_from_db()
        self.assertEqual(self.etapa.atividade, 'Depois')
        self.assertEqual(HistoricoAlteracoes.objects.count(), antes + 1)

    def test_falha_ao_gravar_historico_desfaz_a_alteracao(self):
        with mock.patch.object(HistoricoAlteracoes.objects, 'create', side_effect=RuntimeError('disco cheio')):
            with self.assertRaises(RuntimeError):
                self.post_edicao()
        self.etapa.refresh_from_db()
        self.assertEqual(self.etapa.atividade, 'Antes')


@hasher_rapido
class EquipeNaTrilhaTest(TestCase):

    def setUp(self):
        perfil = criar_perfil('Auditor teste', {'auditorias': PERM_TOTAL})
        self.a = criar_usuario('a', perfil)
        self.b = criar_usuario('b', perfil)
        self.chefe = criar_usuario('chefe', perfil)
        self.auditoria = Auditoria.objects.create(nome_auditoria='Aud', orgao='SEFAZ')
        self.auditoria.usuarios_envolvidos.set([self.a])

    def ultima(self):
        return HistoricoAlteracoes.objects.filter(
            tipo_objeto='Auditoria', uuid_objeto=self.auditoria.id_unico).order_by('-id').first()

    def test_entrada_na_equipe_gera_entrada_com_antes_e_depois(self):
        with set_current_user(self.chefe):
            self.auditoria.usuarios_envolvidos.add(self.b)
        h = self.ultima()
        self.assertEqual(h.operacao, 'ATUALIZADO')
        self.assertEqual(h.usuario, self.chefe)
        self.assertEqual(h.estado_anterior['usuarios_envolvidos'], [str(self.a.id_unico)])
        self.assertEqual(sorted(h.estado_posterior['usuarios_envolvidos']),
                         sorted([str(self.a.id_unico), str(self.b.id_unico)]))

    def test_saida_da_equipe_gera_entrada(self):
        self.auditoria.usuarios_envolvidos.remove(self.a)
        h = self.ultima()
        self.assertEqual(h.estado_anterior['usuarios_envolvidos'], [str(self.a.id_unico)])
        self.assertEqual(h.estado_posterior['usuarios_envolvidos'], [])

    def test_alteracao_pelo_lado_do_usuario_tambem_entra(self):
        self.b.auditoria_set.add(self.auditoria)
        h = self.ultima()
        self.assertIn(str(self.b.id_unico), h.estado_posterior['usuarios_envolvidos'])
        self.assertNotIn(str(self.b.id_unico), h.estado_anterior['usuarios_envolvidos'])

    def test_set_sem_mudanca_nao_gera_entrada(self):
        antes = HistoricoAlteracoes.objects.count()
        self.auditoria.usuarios_envolvidos.set([self.a])
        self.assertEqual(HistoricoAlteracoes.objects.count(), antes)


@hasher_rapido
class HistoricoSomenteAcrescimoTest(TestCase):

    def setUp(self):
        perfil = criar_perfil('Auditor teste', {'auditorias': PERM_TOTAL})
        self.autor = criar_usuario('autor', perfil)
        with set_current_user(self.autor):
            self.auditoria = Auditoria.objects.create(nome_auditoria='Aud', orgao='SEFAZ')
        self.entrada = HistoricoAlteracoes.objects.filter(uuid_objeto=self.auditoria.id_unico).latest('id')
        self.tabela = connection.ops.quote_name(HistoricoAlteracoes._meta.db_table)

    def test_save_de_entrada_existente_e_recusado(self):
        self.entrada.operacao = 'EXCLUIDO'
        with self.assertRaises(ValueError):
            self.entrada.save()

    def test_delete_pelo_orm_e_recusado(self):
        with self.assertRaises(ValueError):
            self.entrada.delete()

    def test_update_em_massa_e_recusado_pelo_banco(self):
        with self.assertRaises(DatabaseError), transaction.atomic():
            HistoricoAlteracoes.objects.filter(pk=self.entrada.pk).update(operacao='EXCLUIDO')

    def test_delete_em_massa_e_recusado_pelo_banco(self):
        with self.assertRaises(DatabaseError), transaction.atomic():
            HistoricoAlteracoes.objects.filter(pk=self.entrada.pk).delete()

    def test_sql_direto_e_recusado_pelo_banco(self):
        with self.assertRaises(DatabaseError), transaction.atomic():
            with connection.cursor() as c:
                c.execute(f'UPDATE {self.tabela} SET estado_posterior = %s WHERE id = %s',
                          ['{"nome_auditoria": "forjado"}', self.entrada.pk])
        with self.assertRaises(DatabaseError), transaction.atomic():
            with connection.cursor() as c:
                c.execute(f'DELETE FROM {self.tabela} WHERE id = %s', [self.entrada.pk])

    def test_exclusao_do_usuario_preserva_o_autor_e_a_cadeia(self):
        """Único UPDATE admitido: o SET NULL da FK quando o autor é excluído."""
        uuid_autor = self.autor.id_unico
        self.autor.delete()
        self.entrada.refresh_from_db()
        self.assertIsNone(self.entrada.usuario_id)
        self.assertEqual(self.entrada.autor_uuid, uuid_autor)
        self.assertTrue(HistoricoAlteracoes.verificar_cadeia()[0])

    def test_admin_nao_oferece_exclusao(self):
        admin = site._registry[HistoricoAlteracoes]
        pedido = RequestFactory().get('/')
        self.assertFalse(admin.has_delete_permission(pedido))
        self.assertFalse(admin.has_change_permission(pedido))
        self.assertFalse(admin.has_add_permission(pedido))


class TrilhaEncadeadaTest(TestCase):

    def setUp(self):
        self.auditoria = Auditoria.objects.create(nome_auditoria='Aud', orgao='SEFAZ')
        self.auditoria.nome_auditoria = 'Aud renomeada'
        self.auditoria.save()
        self.tabela = connection.ops.quote_name(HistoricoAlteracoes._meta.db_table)

    def test_cada_entrada_aponta_para_a_anterior(self):
        entradas = list(HistoricoAlteracoes.objects.order_by('id'))
        self.assertGreaterEqual(len(entradas), 2)
        self.assertEqual(entradas[0].hash_anterior, HistoricoAlteracoes.HASH_GENESIS)
        for anterior, atual in zip(entradas, entradas[1:]):
            self.assertEqual(atual.hash_anterior, anterior.hash_atual)
        self.assertEqual(HistoricoAlteracoes.verificar_cadeia()[:2], (True, len(entradas)))

    def _sem_gatilho(self, sql, params):
        """Simula quem tem privilégio de dono do banco: desliga o gatilho e edita."""
        with connection.cursor() as c:
            if connection.vendor == 'sqlite':
                c.execute('DROP TRIGGER historico_sem_update')
                c.execute('DROP TRIGGER historico_sem_delete')
            else:
                # O dono da tabela (o usuário da aplicação, no servidor) pode
                # desligar o gatilho — é exatamente o limite que o texto declara.
                # SET CONSTRAINTS dispara antes as FKs adiadas da transação do
                # teste, sem o que o ALTER TABLE recusa por "eventos pendentes".
                c.execute('SET CONSTRAINTS ALL IMMEDIATE')
                c.execute(f'ALTER TABLE {self.tabela} DISABLE TRIGGER historico_somente_acrescimo')
            c.execute(sql, params)

    def test_adulteracao_direta_no_banco_e_detectada(self):
        alvo = HistoricoAlteracoes.objects.order_by('id').first()
        self._sem_gatilho(f'UPDATE {self.tabela} SET estado_posterior = %s WHERE id = %s',
                          ['{"nome_auditoria": "forjado"}', alvo.pk])
        ok, _, _, quebrada = HistoricoAlteracoes.verificar_cadeia()
        self.assertFalse(ok)
        self.assertEqual(quebrada, alvo.pk)

    def test_remocao_direta_no_banco_e_detectada(self):
        alvo = HistoricoAlteracoes.objects.order_by('id').first()
        self._sem_gatilho(f'DELETE FROM {self.tabela} WHERE id = %s', [alvo.pk])
        self.assertFalse(HistoricoAlteracoes.verificar_cadeia()[0])

    def test_comando_verificar_trilha(self):
        saida = StringIO()
        call_command('verificar_trilha', stdout=saida)
        self.assertIn('Cadeia íntegra', saida.getvalue())
        ultimo = HistoricoAlteracoes.objects.order_by('-id').first().hash_atual
        self.assertIn(ultimo, saida.getvalue())
        call_command('verificar_trilha', esperado=ultimo, stdout=StringIO())
        with self.assertRaises(CommandError):
            call_command('verificar_trilha', esperado='f' * 64, stdout=StringIO())


@hasher_rapido
class ExclusaoNaAbaDeHistoricoTest(TestCase):
    SENHA = 'senha-forte-123'

    def setUp(self):
        perfil = criar_perfil('Auditor teste', {'auditorias': PERM_TOTAL})
        self.auditor = criar_usuario('auditor', perfil, senha=self.SENHA)
        self.auditoria = Auditoria.objects.create(nome_auditoria='Aud', status='EM_ANDAMENTO', orgao='SEFAZ')
        self.auditoria.usuarios_envolvidos.set([self.auditor])
        self.outra = Auditoria.objects.create(nome_auditoria='Outra', status='EM_ANDAMENTO', orgao='SEFAZ')
        self.outra.usuarios_envolvidos.set([self.auditor])
        self.etapa = criar_etapa(self.auditoria, self.auditor, atividade='Etapa que será excluída')
        self.etapa_da_outra = criar_etapa(self.outra, self.auditor, atividade='Etapa da outra')
        self.client.login(username='auditor', password=self.SENHA)

    def test_etapa_excluida_continua_na_trilha_da_sua_auditoria(self):
        uuid_etapa = self.etapa.id_unico
        self.client.post(reverse('Auth:excluir_etapa', kwargs={
            'id_unico': self.auditoria.id_unico, 'etapa_id': uuid_etapa}))
        self.assertFalse(Etapa.objects.filter(id_unico=uuid_etapa).exists())

        trilha = list(historico_da_auditoria(self.auditor, self.auditoria))
        excluidas = [h for h in trilha if h.operacao == 'EXCLUIDO' and h.uuid_objeto == uuid_etapa]
        self.assertEqual(len(excluidas), 1)
        self.assertEqual(excluidas[0].usuario, self.auditor)
        # E não vaza para a trilha de outra auditoria.
        da_outra = historico_da_auditoria(self.auditor, self.outra)
        self.assertFalse(any(h.uuid_objeto == uuid_etapa for h in da_outra))

    def test_aba_de_historico_mostra_a_exclusao(self):
        self.client.post(reverse('Auth:excluir_etapa', kwargs={
            'id_unico': self.auditoria.id_unico, 'etapa_id': self.etapa.id_unico}))
        r = self.client.get(reverse('Auth:gerenciar_auditoria', kwargs={'id_unico': self.auditoria.id_unico}),
                            {'tab': 'historico'})
        self.assertContains(r, 'Etapa que será excluída')
        self.assertNotContains(r, 'Etapa da outra')
