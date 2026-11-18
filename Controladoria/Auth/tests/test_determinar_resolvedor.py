"""
`determinar_resolvedor` — decide quem julga um conflito de edição. A regra
tem cinco ramos e um desempate com preferência; cada um ganha um caso.

Árvore de perfis usada:  Raiz(0) > Gerente(1) > Auditor(2)
"""
from django.test import TestCase

from ..models import Auditoria
from ..views.api_mobile_views import determinar_resolvedor
from .base import PERM_SO_VER, PERM_TOTAL, criar_perfil, criar_usuario, hasher_rapido


@hasher_rapido
class DeterminarResolvedorTest(TestCase):

    def setUp(self):
        self.raiz = criar_perfil('Raiz', {'auditorias': PERM_TOTAL})
        self.gerente = criar_perfil('Gerente', {'auditorias': PERM_TOTAL}, parent=self.raiz)
        self.auditor = criar_perfil('Auditor', {'auditorias': PERM_TOTAL}, parent=self.gerente)
        # Mesma profundidade de Gerente, mas SEM permissão de editar auditorias.
        self.gerente_leitor = criar_perfil('Gerente leitor', {'auditorias': PERM_SO_VER}, parent=self.raiz)

        self.chefe = criar_usuario('chefe', self.raiz)
        self.g1 = criar_usuario('g1', self.gerente)
        self.g2 = criar_usuario('g2', self.gerente)
        self.a1 = criar_usuario('a1', self.auditor)
        self.a2 = criar_usuario('a2', self.auditor)

        self.auditoria = Auditoria.objects.create(nome_auditoria='X', status='EM_ANDAMENTO')

    def test_sem_usuario_atual_resolve_o_originador(self):
        self.assertEqual(determinar_resolvedor(self.auditoria, self.a1, None), self.a1)

    def test_mesmo_usuario_dos_dois_lados_resolve_ele_mesmo(self):
        self.assertEqual(determinar_resolvedor(self.auditoria, self.a1, self.a1), self.a1)

    def test_mais_raso_vence_originador(self):
        self.assertEqual(determinar_resolvedor(self.auditoria, self.g1, self.a1), self.g1)

    def test_mais_raso_vence_atual(self):
        self.assertEqual(determinar_resolvedor(self.auditoria, self.a1, self.g1), self.g1)

    def test_originador_sem_perfil_perde_para_quem_tem(self):
        sem = criar_usuario('sem', None)
        self.assertEqual(determinar_resolvedor(self.auditoria, sem, self.a1), self.a1)

    def test_atual_sem_perfil_perde_para_quem_tem(self):
        sem = criar_usuario('sem', None)
        self.assertEqual(determinar_resolvedor(self.auditoria, self.a1, sem), self.a1)

    def test_ambos_sem_perfil_fica_sem_atribuicao(self):
        s1 = criar_usuario('s1', None)
        s2 = criar_usuario('s2', None)
        self.assertIsNone(determinar_resolvedor(self.auditoria, s1, s2))

    def test_empate_escala_para_o_mais_senior_disponivel(self):
        # a1 x a2 (ambos prof. 2): sobem para quem for mais raso e não estiver
        # envolvido — sem ninguém na auditoria, o mais sênior de todos (chefe).
        self.assertEqual(determinar_resolvedor(self.auditoria, self.a1, self.a2), self.chefe)

    def test_empate_prefere_quem_esta_envolvido_na_auditoria(self):
        # g1 está na auditoria; chefe é mais sênior mas está de fora.
        # Entre os candidatos, o envolvido ganha mesmo sendo menos raso.
        self.auditoria.usuarios_envolvidos.set([self.g1])
        self.assertEqual(determinar_resolvedor(self.auditoria, self.a1, self.a2), self.g1)

    def test_empate_exclui_os_dois_envolvidos_na_edicao(self):
        # g1 x g2 (prof. 1) só podem escalar para prof. 0. Mesmo com g1 na
        # auditoria, ele é parte da disputa e não pode julgar a si mesmo.
        self.auditoria.usuarios_envolvidos.set([self.g1])
        self.assertEqual(determinar_resolvedor(self.auditoria, self.g1, self.g2), self.chefe)

    def test_empate_ignora_quem_nao_pode_editar_auditorias(self):
        # gerente_leitor tem profundidade 1 (mais raso que a1/a2) mas não tem
        # 'editar' — resolver grava a Etapa, então ele não é elegível.
        leitor = criar_usuario('gl', self.gerente_leitor)
        self.auditoria.usuarios_envolvidos.set([leitor])
        resolvedor = determinar_resolvedor(self.auditoria, self.a1, self.a2)
        self.assertNotEqual(resolvedor, leitor)
        self.assertEqual(resolvedor, self.chefe)

    def test_empate_no_topo_sem_ninguem_acima_fica_sem_atribuicao(self):
        c2 = criar_usuario('chefe2', self.raiz)
        self.assertIsNone(determinar_resolvedor(self.auditoria, self.chefe, c2))

    def test_empate_com_candidato_da_mesma_profundidade_nao_escala_para_ele(self):
        # a1 x a2, e existe a3 também de prof. 2: "estritamente menor" exclui
        # a3 — mesmo nível não julga mesmo nível.
        criar_usuario('a3', self.auditor)
        self.assertEqual(determinar_resolvedor(self.auditoria, self.a1, self.a2), self.chefe)
