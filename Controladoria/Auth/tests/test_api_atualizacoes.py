"""
`api_atualizacoes` — o carimbo de versão que alimenta a faixa "chegou dado
novo do campo" no web. Endpoint de SESSÃO (browser), não da chave interna.

O contrato é: a string `versao` muda se, e só se, algo que a tela mostra
mudou. Os testes cobrem os três tipos de mudança (criação, edição, exclusão)
e o caso em que NADA deve mudar (edição no-op).
"""
import uuid

from django.urls import reverse

from ..middleware import set_current_user
from ..models import Achado, ConflitoEtapa, Etapa
from .base import BaseMobileApiTest, criar_etapa


class ApiAtualizacoesBase(BaseMobileApiTest):

    def setUp(self):
        super().setUp()
        self.url = reverse('Auth:api_atualizacoes')

    def versao(self, usuario, **params):
        self.client.force_login(usuario)
        resp = self.client.get(self.url, params)
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()


class EscopoConflitosTest(ApiAtualizacoesBase):

    def conflito(self, atribuido_a):
        return ConflitoEtapa.objects.create(
            etapa=self.etapa, usuario_originador=self.auditor,
            dados_originador={}, dados_atuais={}, atribuido_a=atribuido_a,
        )

    def test_sem_conflitos_versao_base(self):
        self.assertEqual(self.versao(self.auditor, escopo='conflitos'), {'versao': '0:-', 'itens': 0})

    def test_conflito_atribuido_a_mim_muda_a_versao(self):
        antes = self.versao(self.auditor, escopo='conflitos')
        self.conflito(self.auditor)
        depois = self.versao(self.auditor, escopo='conflitos')
        self.assertNotEqual(antes['versao'], depois['versao'])
        self.assertEqual(depois['itens'], 1)

    def test_conflito_de_outra_pessoa_nao_muda_a_minha_versao(self):
        # leitor não pode excluir auditorias → só vê os atribuídos a ele
        antes = self.versao(self.leitor, escopo='conflitos')
        self.conflito(self.auditor)
        self.assertEqual(self.versao(self.leitor, escopo='conflitos'), antes)

    def test_quem_pode_excluir_ve_os_sem_atribuicao(self):
        antes = self.versao(self.auditor, escopo='conflitos')
        self.conflito(None)
        depois = self.versao(self.auditor, escopo='conflitos')
        self.assertNotEqual(antes['versao'], depois['versao'])

    def test_quem_nao_pode_excluir_nao_ve_os_sem_atribuicao(self):
        antes = self.versao(self.leitor, escopo='conflitos')
        self.conflito(None)
        self.assertEqual(self.versao(self.leitor, escopo='conflitos'), antes)

    def test_conflito_resolvido_sai_da_contagem(self):
        c = self.conflito(self.auditor)
        com = self.versao(self.auditor, escopo='conflitos')
        c.status = 'RESOLVIDO'
        c.save()
        sem = self.versao(self.auditor, escopo='conflitos')
        self.assertNotEqual(com['versao'], sem['versao'])
        self.assertEqual(sem['itens'], 0)


class EscopoAuditoriaTest(ApiAtualizacoesBase):

    def v(self, usuario=None):
        return self.versao(usuario or self.auditor, escopo='auditoria', id=str(self.aberta.id_unico))

    def test_achado_novo_muda_a_versao(self):
        antes = self.v()
        Achado.objects.create(etapa=self.etapa, usuario=self.auditor, descricao='x')
        depois = self.v()
        self.assertNotEqual(antes['versao'], depois['versao'])
        self.assertEqual(depois['itens'], antes['itens'] + 1)

    def test_etapa_nova_muda_a_versao(self):
        antes = self.v()
        criar_etapa(self.aberta, self.auditor, atividade='outra')
        self.assertNotEqual(antes['versao'], self.v()['versao'])

    def test_etapa_excluida_muda_a_versao(self):
        antes = self.v()
        self.etapa.delete()
        self.assertNotEqual(antes['versao'], self.v()['versao'])

    def test_edicao_de_etapa_muda_a_versao_via_historico(self):
        # Edição não altera contagem nem data_criacao — só o histórico
        # denuncia. É o caso que o carimbo precisa cobrir explicitamente.
        antes = self.v()
        with set_current_user(self.auditor):
            self.etapa.situacao = 'CONCLUIDA'
            self.etapa.save()
        self.assertNotEqual(antes['versao'], self.v()['versao'])

    def test_save_sem_mudanca_nao_muda_a_versao(self):
        # O signal só grava histórico se algo mudou — então um save no-op não
        # pode acender a faixa no web.
        antes = self.v()
        with set_current_user(self.auditor):
            self.etapa.save()
        self.assertEqual(antes, self.v())

    def test_mudanca_em_outra_auditoria_nao_muda_a_versao(self):
        antes = self.v()
        criar_etapa(self.planejada, self.auditor, atividade='em outra')
        Achado.objects.create(etapa=self.etapa_fechada, usuario=self.auditor, descricao='y')
        self.assertEqual(antes, self.v())

    def test_id_inexistente_e_404(self):
        self.client.force_login(self.auditor)
        resp = self.client.get(self.url, {'escopo': 'auditoria', 'id': str(uuid.uuid4())})
        self.assertEqual(resp.status_code, 404)

    def test_id_malformado_e_404_nao_500(self):
        self.client.force_login(self.auditor)
        resp = self.client.get(self.url, {'escopo': 'auditoria', 'id': 'lixo'})
        self.assertEqual(resp.status_code, 404)


class EscopoEAutorizacaoTest(ApiAtualizacoesBase):

    def test_sem_escopo_e_400(self):
        self.client.force_login(self.auditor)
        self.assertEqual(self.client.get(self.url).status_code, 400)

    def test_escopo_desconhecido_e_400(self):
        self.client.force_login(self.auditor)
        self.assertEqual(self.client.get(self.url, {'escopo': 'xyz'}).status_code, 400)

    def test_deslogado_redireciona_para_login(self):
        resp = self.client.get(self.url, {'escopo': 'conflitos'})
        self.assertEqual(resp.status_code, 302)
        self.assertIn(reverse('Auth:login'), resp['Location'])

    def test_sem_permissao_de_ver_auditorias_e_403(self):
        self.leitor.perfil.permissoes.filter(tela='auditorias').update(pode_ver=False)
        self.client.force_login(self.leitor)
        for params in ({'escopo': 'conflitos'}, {'escopo': 'auditoria', 'id': str(self.aberta.id_unico)}):
            self.assertEqual(self.client.get(self.url, params).status_code, 403, params)

    def test_resposta_nunca_carrega_conteudo(self):
        # O contrato de segurança: só versão e contagem — nada da descrição
        # do achado, nada do nome da etapa.
        Achado.objects.create(etapa=self.etapa, usuario=self.auditor, descricao='CONTEUDO SIGILOSO')
        dados = self.versao(self.auditor, escopo='auditoria', id=str(self.aberta.id_unico))
        self.assertEqual(set(dados), {'versao', 'itens'})
        self.assertNotIn('SIGILOSO', str(dados))
        self.assertNotIn(self.etapa.atividade, str(dados))
