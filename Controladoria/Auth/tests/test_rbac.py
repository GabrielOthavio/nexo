"""RBAC: Perfil.tem_permissao / Usuario.tem_permissao / Perfil.profundidade / hash de senha."""
from django.contrib.auth.hashers import get_hasher, make_password
from django.test import TestCase

from ..models import Perfil
from .base import PERM_SO_VER, PERM_TOTAL, criar_perfil, criar_usuario, hasher_rapido


class HashDeSenhaTest(TestCase):
    """
    SEM o `hasher_rapido` de propósito: aqui o que se testa É o
    PASSWORD_HASHERS real. Cobre a troca PBKDF2 → Argon2id e, principalmente,
    o caminho de migração — um usuário com hash antigo não pode ficar trancado
    para fora nem precisar de reset.
    """
    SENHA = 'senha-forte-123'

    def usuario_com_hash_legado(self):
        u = criar_usuario('legado', perfil=None)
        u.password = make_password(self.SENHA, hasher='pbkdf2_sha256')
        u.save(update_fields=['password'])
        self.assertTrue(u.password.startswith('pbkdf2_sha256$'))
        return u

    def test_hasher_preferido_e_argon2(self):
        self.assertEqual(get_hasher().algorithm, 'argon2')

    def test_senha_nova_sai_como_argon2id_e_nao_argon2i(self):
        # O Django usa a variante `id` (híbrida) desde o 3.2 — é a que a RFC
        # 9106 recomenda. O prefixo do hash torna isso verificável.
        self.assertTrue(make_password(self.SENHA).startswith('argon2$argon2id$'))

    def test_hash_pbkdf2_legado_continua_validando(self):
        u = self.usuario_com_hash_legado()
        self.assertTrue(u.check_password(self.SENHA))

    def test_login_bem_sucedido_migra_o_hash_para_argon2id(self):
        u = self.usuario_com_hash_legado()
        self.assertTrue(u.check_password(self.SENHA))  # dispara o setter de upgrade
        u.refresh_from_db()
        self.assertTrue(u.password.startswith('argon2$argon2id$'))
        self.assertTrue(u.check_password(self.SENHA))  # e continua válida depois

    def test_senha_errada_nao_migra_nada(self):
        u = self.usuario_com_hash_legado()
        self.assertFalse(u.check_password('errada'))
        u.refresh_from_db()
        self.assertTrue(u.password.startswith('pbkdf2_sha256$'))

    def test_login_pelo_site_migra_pelo_caminho_real(self):
        # client.login → authenticate → ModelBackend → check_password com setter.
        u = self.usuario_com_hash_legado()
        self.assertTrue(self.client.login(username='legado', password=self.SENHA))
        u.refresh_from_db()
        self.assertTrue(u.password.startswith('argon2$argon2id$'))

    def test_hash_argon2_nao_e_migrado_de_novo(self):
        # Já está no preferido: check_password não deve regravar (nem mudar o salt).
        u = criar_usuario('novo', perfil=None, senha=self.SENHA)
        antes = u.password
        self.assertTrue(antes.startswith('argon2$argon2id$'))
        self.assertTrue(u.check_password(self.SENHA))
        u.refresh_from_db()
        self.assertEqual(u.password, antes)


@hasher_rapido
class TemPermissaoTest(TestCase):

    def setUp(self):
        self.perfil = criar_perfil('P', {'auditorias': (True, False, True, False), 'acoes': PERM_TOTAL})

    def test_usuario_sem_perfil_nao_tem_nada(self):
        u = criar_usuario('sem-perfil', perfil=None)
        self.assertFalse(u.tem_permissao('auditorias', 'ver'))
        self.assertFalse(u.tem_permissao('dashboard', 'ver'))

    def test_acoes_individuais_por_tela(self):
        u = criar_usuario('u', self.perfil)
        self.assertTrue(u.tem_permissao('auditorias', 'ver'))
        self.assertFalse(u.tem_permissao('auditorias', 'criar'))
        self.assertTrue(u.tem_permissao('auditorias', 'editar'))
        self.assertFalse(u.tem_permissao('auditorias', 'excluir'))

    def test_tela_sem_linha_de_permissao_e_negada(self):
        u = criar_usuario('u', self.perfil)
        self.assertFalse(u.tem_permissao('usuarios', 'ver'))

    def test_acao_inexistente_e_negada_sem_levantar(self):
        u = criar_usuario('u', self.perfil)
        self.assertFalse(u.tem_permissao('auditorias', 'voar'))

    def test_acao_padrao_e_ver(self):
        u = criar_usuario('u', self.perfil)
        self.assertTrue(u.tem_permissao('auditorias'))

    def test_permissao_nao_e_herdada_do_perfil_pai(self):
        # `parent` existe para hierarquia de resolução de conflitos, não para
        # herança de permissão — filho com PERM_SO_VER não ganha editar do pai.
        pai = criar_perfil('Pai', {'auditorias': PERM_TOTAL})
        filho = criar_perfil('Filho', {'auditorias': PERM_SO_VER}, parent=pai)
        u = criar_usuario('u', filho)
        self.assertTrue(u.tem_permissao('auditorias', 'ver'))
        self.assertFalse(u.tem_permissao('auditorias', 'editar'))


class ProfundidadeTest(TestCase):

    def test_raiz_e_zero(self):
        self.assertEqual(Perfil.objects.create(nome='Raiz').profundidade(), 0)

    def test_conta_niveis_ate_a_raiz(self):
        raiz = Perfil.objects.create(nome='Raiz')
        filho = Perfil.objects.create(nome='Filho', parent=raiz)
        neto = Perfil.objects.create(nome='Neto', parent=filho)
        self.assertEqual(filho.profundidade(), 1)
        self.assertEqual(neto.profundidade(), 2)

    def test_ciclo_nao_trava(self):
        # parent é FK livre — nada impede A→B→A. profundidade() precisa
        # terminar, não entrar em loop.
        a = Perfil.objects.create(nome='A')
        b = Perfil.objects.create(nome='B', parent=a)
        a.parent = b
        a.save()
        self.assertIsInstance(a.profundidade(), int)
        self.assertIsInstance(b.profundidade(), int)

    def test_auto_referencia_nao_trava(self):
        a = Perfil.objects.create(nome='A')
        a.parent = a
        a.save()
        self.assertEqual(a.profundidade(), 0)
