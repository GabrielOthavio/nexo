"""
Autorização das telas web — os três defeitos que a varredura exploratória de
2026-09-23 encontrou. Cada teste falha no código anterior à correção.

O fio comum: ter a permissão no perfil diz O QUE a pessoa pode fazer, nunca
EM QUAL registro. As views de Etapa e a API do mobile já separavam as duas
perguntas; as de Auditoria e de Ação, não.
"""
from datetime import date

from django.test import TestCase
from django.urls import reverse

from ..models import Acao, Auditoria, TipoAcao
from .base import PERM_TOTAL, criar_etapa, criar_perfil, criar_usuario, hasher_rapido


@hasher_rapido
class AcessoAuditoriaAlheiaTest(TestCase):
    """
    Um auditor com permissão TOTAL em `auditorias`, mas fora da equipe da
    auditoria, não pode lê-la nem alterá-la. Antes da correção ele conseguia
    editar e até APAGAR a auditoria de outra equipe, levando etapas e achados
    junto por cascata.
    """
    SENHA = 'senha-forte-123'

    def setUp(self):
        # Sem 'usuarios' no perfil: é auditor, não chefia.
        self.perfil_auditor = criar_perfil('Auditor teste', {'auditorias': PERM_TOTAL})
        # Com 'usuarios.ver': é chefia, e chefia alcança qualquer auditoria.
        self.perfil_chefia = criar_perfil('Chefia teste', {'auditorias': PERM_TOTAL, 'usuarios': PERM_TOTAL})

        self.dono = criar_usuario('dono', self.perfil_auditor, senha=self.SENHA)
        self.intruso = criar_usuario('intruso', self.perfil_auditor, senha=self.SENHA)
        self.chefe = criar_usuario('chefe', self.perfil_chefia, senha=self.SENHA)

        self.auditoria = Auditoria.objects.create(
            nome_auditoria='Auditoria da outra equipe', status='EM_ANDAMENTO', orgao='SEFAZ')
        self.auditoria.usuarios_envolvidos.set([self.dono])
        self.etapa = criar_etapa(self.auditoria, self.dono, atividade='Conferir contratos')

    def entrar(self, usuario):
        self.assertTrue(self.client.login(username=usuario.username, password=self.SENHA))

    def url(self, nome):
        return reverse(f'Auth:{nome}', kwargs={'id_unico': self.auditoria.id_unico})

    # --- quem está de fora não entra ---------------------------------------

    def test_intruso_nao_ve_gerenciar(self):
        self.entrar(self.intruso)
        resp = self.client.get(self.url('gerenciar_auditoria'))
        self.assertEqual(resp.status_code, 302)

    def test_intruso_nao_ve_atividade_da_etapa(self):
        # Não basta redirecionar: o conteúdo não pode vazar pelo caminho nenhum.
        self.entrar(self.intruso)
        resp = self.client.get(self.url('gerenciar_auditoria'), follow=True)
        self.assertNotIn('Conferir contratos', resp.content.decode())

    def test_intruso_nao_abre_form_de_edicao(self):
        self.entrar(self.intruso)
        self.assertEqual(self.client.get(self.url('editar_auditoria')).status_code, 302)

    def test_intruso_nao_altera_auditoria(self):
        self.entrar(self.intruso)
        self.client.post(self.url('editar_auditoria'), {
            'nome_auditoria': 'SEQUESTRADA', 'status': 'CANCELADA',
            'orgao': 'X', 'responsavel_orgao': 'X', 'informacoes_campos_texto': ''})
        self.auditoria.refresh_from_db()
        self.assertEqual(self.auditoria.nome_auditoria, 'Auditoria da outra equipe')
        self.assertEqual(self.auditoria.status, 'EM_ANDAMENTO')

    def test_intruso_nao_apaga_auditoria(self):
        self.entrar(self.intruso)
        self.client.post(self.url('excluir_auditoria'))
        self.assertTrue(Auditoria.objects.filter(pk=self.auditoria.pk).exists())

    def test_intruso_nao_ve_a_trilha(self):
        self.entrar(self.intruso)
        resp = self.client.get(self.url('gerenciar_auditoria') + '?tab=historico')
        self.assertEqual(resp.status_code, 302)

    # --- quem está dentro continua entrando (a correção não pode barrar demais) ---

    def test_envolvido_gerencia(self):
        self.entrar(self.dono)
        self.assertEqual(self.client.get(self.url('gerenciar_auditoria')).status_code, 200)

    def test_envolvido_altera(self):
        self.entrar(self.dono)
        self.client.post(self.url('editar_auditoria'), {
            'nome_auditoria': 'Renomeada pelo dono', 'status': 'EM_ANDAMENTO',
            'orgao': 'SEFAZ', 'responsavel_orgao': '', 'informacoes_campos_texto': '',
            'usuarios_envolvidos': [self.dono.id]})
        self.auditoria.refresh_from_db()
        self.assertEqual(self.auditoria.nome_auditoria, 'Renomeada pelo dono')

    def test_chefia_alcanca_auditoria_de_qualquer_equipe(self):
        self.entrar(self.chefe)
        for nome in ('gerenciar_auditoria', 'editar_auditoria', 'excluir_auditoria'):
            self.assertEqual(self.client.get(self.url(nome)).status_code, 200, nome)


@hasher_rapido
class PermissaoDeAcaoTest(TestCase):
    """
    Ser autor do registro não substitui a permissão. Antes da correção,
    `if not is_owner and (...)` pulava a checagem inteira para o dono: alguém
    com `pode_editar=False` e `pode_excluir=False` ainda alterava e apagava as
    próprias Ações.
    """
    SENHA = 'senha-forte-123'

    def setUp(self):
        self.perfil_sem = criar_perfil('Sem acoes teste', {'acoes': (False, False, False, False)})
        self.perfil_com = criar_perfil('Com acoes teste', {'acoes': PERM_TOTAL})
        self.sem = criar_usuario('sem_perm', self.perfil_sem, senha=self.SENHA)
        self.com = criar_usuario('com_perm', self.perfil_com, senha=self.SENHA)
        self.tipo = TipoAcao.objects.create(nome_acao='Tipo teste', motivo_acao='x')

    def criar_acao(self, dono):
        return Acao.objects.create(data_execucao=date.today(), tipo_acao=self.tipo,
                                   usuario=dono, avaliacao='ORIGINAL', conclusao='ORIGINAL')

    def entrar(self, usuario):
        self.assertTrue(self.client.login(username=usuario.username, password=self.SENHA))

    def test_dono_sem_permissao_nao_abre_edicao(self):
        acao = self.criar_acao(self.sem)
        self.entrar(self.sem)
        resp = self.client.get(reverse('Auth:editar_acao', kwargs={'id_unico': acao.id_unico}))
        self.assertEqual(resp.status_code, 403)

    def test_dono_sem_permissao_nao_altera_a_propria_acao(self):
        acao = self.criar_acao(self.sem)
        self.entrar(self.sem)
        self.client.post(reverse('Auth:editar_acao', kwargs={'id_unico': acao.id_unico}), {
            'data_execucao': '2026-01-15', 'tipo_acao': self.tipo.id, 'usuario': self.sem.id,
            'avaliacao': 'ALTERADO', 'conclusao': 'ALTERADO',
            'status': 'EM_ANDAMENTO', 'unidade': 'SEFAZ'})
        acao.refresh_from_db()
        self.assertEqual(acao.avaliacao, 'ORIGINAL')

    def test_dono_sem_permissao_nao_apaga_a_propria_acao(self):
        acao = self.criar_acao(self.sem)
        self.entrar(self.sem)
        self.client.post(reverse('Auth:excluir_acao', kwargs={'id_unico': acao.id_unico}))
        self.assertTrue(Acao.objects.filter(pk=acao.pk).exists())

    def test_com_permissao_edita_a_propria_acao(self):
        acao = self.criar_acao(self.com)
        self.entrar(self.com)
        self.client.post(reverse('Auth:editar_acao', kwargs={'id_unico': acao.id_unico}), {
            'data_execucao': '2026-01-15', 'tipo_acao': self.tipo.id, 'usuario': self.com.id,
            'avaliacao': 'ATUALIZADO', 'conclusao': 'ok',
            'status': 'EM_ANDAMENTO', 'unidade': 'SEFAZ'})
        acao.refresh_from_db()
        self.assertEqual(acao.avaliacao, 'ATUALIZADO')

    def test_com_permissao_apaga_a_propria_acao(self):
        acao = self.criar_acao(self.com)
        self.entrar(self.com)
        self.client.post(reverse('Auth:excluir_acao', kwargs={'id_unico': acao.id_unico}))
        self.assertFalse(Acao.objects.filter(pk=acao.pk).exists())


@hasher_rapido
class ByteNuloTest(TestCase):
    """
    O PostgreSQL recusa NUL dentro de string e o psycopg2 levanta ValueError
    ao montar o SQL — um `?q=%00` derrubava com 500 toda tela com busca. O
    SQLite aceitava, então o defeito só apareceu na migração para PostgreSQL.
    """
    SENHA = 'senha-forte-123'
    NULO = chr(0)

    def setUp(self):
        perfil = criar_perfil('Tudo teste', {t: PERM_TOTAL for t in
                                             ('acoes', 'auditorias', 'usuarios', 'indices', 'matrizes', 'entidades')})
        u = criar_usuario('completo', perfil, senha=self.SENHA)
        self.client.login(username=u.username, password=self.SENHA)

    def test_byte_nulo_na_busca_e_400_e_nao_500(self):
        for rota in ('lista_acoes', 'lista_auditorias', 'lista_usuarios',
                     'lista_indices', 'lista_matrizes', 'lista_entidades'):
            resp = self.client.get(reverse(f'Auth:{rota}'), {'q': self.NULO})
            self.assertEqual(resp.status_code, 400, rota)

    def test_byte_nulo_em_outro_parametro_tambem(self):
        resp = self.client.get(reverse('Auth:lista_acoes'), {'unidade': self.NULO})
        self.assertEqual(resp.status_code, 400)

    def test_byte_nulo_no_corpo_do_post(self):
        resp = self.client.post(reverse('Auth:lista_acoes'), {'q': self.NULO})
        self.assertEqual(resp.status_code, 400)

    def test_busca_normal_continua_funcionando(self):
        resp = self.client.get(reverse('Auth:lista_acoes'), {'q': 'contrato 100%'})
        self.assertEqual(resp.status_code, 200)
