"""
Leitura da trilha de auditoria — `api_historico` (card do dashboard) e a aba
"Histórico" de Gerenciar Auditoria. As duas passam por views/historico.py:
chefia (quem vê usuários) enxerga tudo; auditor enxerga a história das
auditorias em que está envolvido; quem não vê auditorias, nada.

Os fixtures da base já criam etapas em três auditorias — `aberta` (auditor,
leitor e editor envolvidos), `planejada` e `fechada` (só o auditor). `fora`
tem perfil de auditor mas não está em nenhuma.
"""
import uuid

from django.urls import reverse

from ..middleware import set_current_user
from ..models import Achado, Perfil
from .base import BaseMobileApiTest, criar_etapa, criar_usuario


class HistoricoBase(BaseMobileApiTest):

    def setUp(self):
        super().setUp()
        self.url = reverse('Auth:api_historico')

    def editar(self, etapa, usuario, **campos):
        with set_current_user(usuario):
            for campo, valor in campos.items():
                setattr(etapa, campo, valor)
            etapa.save()

    def historico(self, usuario, **params):
        self.client.force_login(usuario)
        resp = self.client.get(self.url, params)
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()['results']

    def uuids(self, resultados):
        return {r['uuid_objeto'] for r in resultados}


class PermissaoApiHistoricoTest(HistoricoBase):

    def test_chefe_ve_alteracao_em_qualquer_auditoria(self):
        # chefe não está envolvido em nenhuma auditoria — vê por perfil.
        self.editar(self.etapa_fechada, self.auditor, situacao='CONCLUIDA')
        self.assertIn(str(self.etapa_fechada.id_unico), self.uuids(self.historico(self.chefe)))

    def test_auditor_ve_a_propria_alteracao(self):
        self.editar(self.etapa, self.auditor, situacao='CONCLUIDA')
        resultados = self.historico(self.auditor)
        self.assertIn(str(self.etapa.id_unico), self.uuids(resultados))
        entrada = next(r for r in resultados if r['uuid_objeto'] == str(self.etapa.id_unico))
        self.assertEqual(entrada['operacao'], 'ATUALIZADO')
        self.assertEqual(entrada['usuario'], 'auditor')

    def test_leitor_envolvido_ve_mesmo_sem_poder_editar(self):
        self.editar(self.etapa, self.auditor, situacao='CONCLUIDA')
        self.assertIn(str(self.etapa.id_unico), self.uuids(self.historico(self.leitor)))

    def test_nao_envolvido_recebe_lista_vazia_e_nao_403(self):
        self.editar(self.etapa, self.auditor, situacao='CONCLUIDA')
        self.assertEqual(self.historico(self.fora), [])

    def test_envolvido_nao_ve_auditoria_de_que_nao_participa(self):
        # leitor está só na `aberta`; a edição é na `fechada`.
        self.editar(self.etapa_fechada, self.auditor, situacao='CONCLUIDA')
        self.assertNotIn(str(self.etapa_fechada.id_unico), self.uuids(self.historico(self.leitor)))

    def test_auditor_nao_ve_alteracoes_de_usuario(self):
        # Trilha de Usuario carrega cargo/unidade — só chefia.
        with set_current_user(self.chefe):
            self.fora.first_name = 'Renomeado'
            self.fora.save()
        tipos_auditor = {r['tipo_objeto'] for r in self.historico(self.auditor)}
        self.assertNotIn('Usuario', tipos_auditor)
        tipos_chefe = {r['tipo_objeto'] for r in self.historico(self.chefe)}
        self.assertIn('Usuario', tipos_chefe)

    def test_achado_da_auditoria_envolvida_aparece(self):
        with set_current_user(self.auditor):
            achado = Achado.objects.create(etapa=self.etapa, usuario=self.auditor, descricao='segredo')
        resultados = self.historico(self.leitor)
        entrada = next(r for r in resultados if r['uuid_objeto'] == str(achado.id_unico))
        self.assertEqual(entrada['operacao'], 'CRIADO')
        # A descrição do achado é cifrada → redigida na trilha, nunca em texto plano.
        self.assertEqual(entrada['estado_posterior']['descricao'], '[PROTEGIDO]')

    def test_sem_permissao_de_auditorias_e_403(self):
        perfil = Perfil.objects.create(nome='Sem nada teste')
        ninguem = criar_usuario('ninguem', perfil)
        self.client.force_login(ninguem)
        self.assertEqual(self.client.get(self.url).status_code, 403)

    def test_sem_perfil_e_403(self):
        semperfil = criar_usuario('semperfil', None)
        self.client.force_login(semperfil)
        self.assertEqual(self.client.get(self.url).status_code, 403)


class FiltroApiHistoricoTest(HistoricoBase):

    def test_objeto_restringe_a_um_registro(self):
        outra = criar_etapa(self.aberta, self.auditor, atividade='outra')
        self.editar(self.etapa, self.auditor, situacao='CONCLUIDA')
        self.editar(outra, self.auditor, situacao='CONCLUIDA')
        resultados = self.historico(self.auditor, objeto=str(self.etapa.id_unico))
        self.assertTrue(resultados)
        self.assertEqual(self.uuids(resultados), {str(self.etapa.id_unico)})

    def test_objeto_malformado_e_400(self):
        self.client.force_login(self.auditor)
        self.assertEqual(self.client.get(self.url, {'objeto': 'lixo'}).status_code, 400)

    def test_objeto_inexistente_e_lista_vazia(self):
        self.assertEqual(self.historico(self.auditor, objeto=str(uuid.uuid4())), [])

    def test_descricao_vem_da_atividade_da_etapa(self):
        self.editar(self.etapa, self.auditor, situacao='CONCLUIDA')
        entrada = self.historico(self.auditor, objeto=str(self.etapa.id_unico))[0]
        self.assertEqual(entrada['descricao'], 'Etapa da aberta')

    def test_limit_e_respeitado(self):
        for i in range(3):
            self.editar(self.etapa, self.auditor, atividade=f'v{i}')
        self.assertEqual(len(self.historico(self.chefe, limit=2)), 2)


class AbaHistoricoGerenciarTest(HistoricoBase):

    def url_aba(self, auditoria):
        return reverse('Auth:gerenciar_auditoria', kwargs={'id_unico': auditoria.id_unico}) + '?tab=historico'

    def test_auditor_envolvido_ve_a_alteracao_com_diff(self):
        self.editar(self.etapa, self.auditor, situacao='CONCLUIDA')
        self.client.force_login(self.auditor)
        resp = self.client.get(self.url_aba(self.aberta))
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        self.assertIn('Etapa da aberta', html)
        self.assertIn(f'hist-{self.etapa.id_unico}', html)
        # Só o campo alterado aparece na tabela principal, com os dois valores,
        # na linguagem do formulário (rótulo do campo e da opção), não o nome
        # da coluna nem o código guardado na trilha.
        self.assertIn('Situação', html)
        self.assertIn('Pendente', html)
        self.assertIn('Concluída', html)
        self.assertNotIn('>CONCLUIDA<', html)

    def test_aba_mostra_so_esta_auditoria(self):
        self.editar(self.etapa_fechada, self.auditor, situacao='CONCLUIDA')
        self.client.force_login(self.auditor)
        html = self.client.get(self.url_aba(self.aberta)).content.decode()
        self.assertNotIn(f'hist-{self.etapa_fechada.id_unico}', html)

    def test_nao_envolvido_e_redirecionado_com_aviso(self):
        self.client.force_login(self.fora)
        resp = self.client.get(self.url_aba(self.aberta), follow=True)
        self.assertEqual(resp.status_code, 200)
        self.assertIn('não está envolvido', resp.content.decode())

    def test_chefe_ve_sem_estar_envolvido(self):
        self.editar(self.etapa, self.auditor, situacao='CONCLUIDA')
        self.client.force_login(self.chefe)
        html = self.client.get(self.url_aba(self.aberta)).content.decode()
        self.assertIn(f'hist-{self.etapa.id_unico}', html)

    def test_link_para_o_historico_no_formulario_da_etapa(self):
        self.client.force_login(self.auditor)
        url = reverse('Auth:editar_etapa', kwargs={'id_unico': self.aberta.id_unico, 'etapa_id': self.etapa.id_unico})
        html = self.client.get(url).content.decode()
        self.assertIn(f'?tab=historico#hist-{self.etapa.id_unico}', html)
