"""
Fixtures compartilhadas pelos testes do núcleo Django.

Tudo aqui é criado por ORM direto, fora de qualquer request — então
`get_current_user()` devolve None durante o setUp e as linhas de
HistoricoAlteracoes geradas pela montagem do cenário ficam com usuario=None.
Os testes que verificam a trilha de auditoria contam a partir do que ELES
mesmos disparam, nunca do total.
"""
import json
import uuid
from datetime import date, timedelta

from django.test import TestCase, override_settings
from django.urls import reverse

from ..models import (
    Achado,
    Auditoria,
    Etapa,
    Perfil,
    PerfilPermissao,
    Usuario,
)

# Chave da API interna usada pelos testes — sobrescreve a do .env para a suíte
# não depender do ambiente. A allowlist de IP fica VAZIA (= desligada) por
# padrão; o teste do decorator liga de propósito.
CHAVE_INTERNA_TESTE = 'chave-interna-de-teste'

PERM_TOTAL = (True, True, True, True)
PERM_SO_VER = (True, False, False, False)
PERM_NADA = (False, False, False, False)

# PBKDF2 nos ~10 usuários criados por teste dominava o tempo da suíte (mais de
# 1 s por teste só em hashing). MD5 aqui não afeta nada do que se testa.
hasher_rapido = override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])


def criar_perfil(nome, telas, parent=None):
    """
    `telas` = {tela: (ver, criar, editar, excluir)}.

    `nome` é único no banco e a migration 0010 já semeia "Chefe" e
    "Funcionário" — os fixtures usam nomes próprios ("Chefe teste" etc.) para
    não colidir nem depender do que a migration deixou.
    """
    perfil = Perfil.objects.create(nome=nome, parent=parent)
    for tela, (v, c, e, d) in telas.items():
        PerfilPermissao.objects.create(
            perfil=perfil, tela=tela,
            pode_ver=v, pode_criar=c, pode_editar=e, pode_excluir=d,
        )
    return perfil


_contador_cpf = 0


def criar_usuario(username, perfil=None, senha='senha-forte-123', **extra):
    """CPF é obrigatório e único (cifrado) — gera um sequencial por chamada."""
    global _contador_cpf
    _contador_cpf += 1
    return Usuario.objects.create_user(
        username=username,
        password=senha,
        cpf=f'{_contador_cpf:011d}',
        perfil=perfil,
        **extra,
    )


def criar_etapa(auditoria, usuario, **campos):
    dados = {
        'orientacao': 'Orientação padrão',
        'documentos': '',
        'atividade': 'Atividade padrão',
        'prazo': date.today() + timedelta(days=7),
        'situacao': 'PENDENTE',
        'metodo': '',
    }
    dados.update(campos)
    return Etapa.objects.create(auditoria=auditoria, usuario=usuario, **dados)


def campos_etapa(etapa):
    """Mesmo formato que a API devolve/espera como baseline (sem id_unico)."""
    return {
        'orientacao': etapa.orientacao,
        'documentos': etapa.documentos,
        'atividade': etapa.atividade,
        'prazo': etapa.prazo.isoformat() if etapa.prazo else None,
        'situacao': etapa.situacao,
        'metodo': etapa.metodo,
    }


@hasher_rapido
@override_settings(MOBILE_SYNC_API_KEY=CHAVE_INTERNA_TESTE, MOBILE_SYNC_ALLOWED_IPS=[])
class BaseMobileApiTest(TestCase):
    """
    Cenário mínimo que cobre os três eixos de autorização da API interna:
    perfil (RBAC), envolvimento na auditoria, e status da auditoria.

      chefe   — tudo liberado, envolvido em nenhuma auditoria
      auditor — auditorias: ver/criar/editar/excluir; envolvido na `aberta`
      leitor  — auditorias: só ver; envolvido na `aberta`
      editor_sem_excluir — auditorias: ver/criar/editar (NÃO excluir); envolvido
      fora    — perfil de auditor, mas NÃO envolvido em nada
    """

    def setUp(self):
        self.perfil_chefe = criar_perfil('Chefe teste', {t: PERM_TOTAL for t in ('dashboard', 'auditorias', 'usuarios')})
        self.perfil_auditor = criar_perfil('Auditor teste', {'auditorias': PERM_TOTAL}, parent=self.perfil_chefe)
        self.perfil_leitor = criar_perfil('Leitor teste', {'auditorias': PERM_SO_VER}, parent=self.perfil_chefe)
        self.perfil_editor = criar_perfil('Editor teste', {'auditorias': (True, True, True, False)}, parent=self.perfil_chefe)

        self.chefe = criar_usuario('chefe', self.perfil_chefe)
        self.auditor = criar_usuario('auditor', self.perfil_auditor)
        self.leitor = criar_usuario('leitor', self.perfil_leitor)
        self.editor_sem_excluir = criar_usuario('editor', self.perfil_editor)
        self.fora = criar_usuario('fora', self.perfil_auditor)

        self.aberta = Auditoria.objects.create(nome_auditoria='Aberta', status='EM_ANDAMENTO', orgao='SEFAZ')
        self.aberta.usuarios_envolvidos.set([self.auditor, self.leitor, self.editor_sem_excluir])

        self.planejada = Auditoria.objects.create(nome_auditoria='Planejada', status='PLANEJADA', orgao='SESAU')
        self.planejada.usuarios_envolvidos.set([self.auditor])

        self.fechada = Auditoria.objects.create(nome_auditoria='Fechada', status='CONCLUIDA', orgao='SEFAZ')
        self.fechada.usuarios_envolvidos.set([self.auditor])

        self.etapa = criar_etapa(self.aberta, self.auditor, atividade='Etapa da aberta')
        self.etapa_fechada = criar_etapa(self.fechada, self.auditor, atividade='Etapa da fechada')

    # --- helpers HTTP ------------------------------------------------------

    def api_get(self, url, usuario=None, **params):
        if usuario is not None:
            params.setdefault('usuario_uuid', str(usuario.id_unico))
        return self.client.get(url, params, HTTP_X_INTERNAL_API_KEY=CHAVE_INTERNA_TESTE)

    def api_post(self, url, body, chave=CHAVE_INTERNA_TESTE):
        extra = {'HTTP_X_INTERNAL_API_KEY': chave} if chave is not None else {}
        return self.client.post(url, json.dumps(body), content_type='application/json', **extra)

    # --- payloads prontos -----------------------------------------------------

    def body_achado(self, usuario=None, etapa=None, **override):
        body = {
            'usuario_uuid': str((usuario or self.auditor).id_unico),
            'etapa_uuid': str((etapa or self.etapa).id_unico),
            'descricao': 'Achado de teste',
            'origem_mobile_uuid': str(uuid.uuid4()),
        }
        body.update(override)
        return body

    def body_etapa_criar(self, usuario=None, auditoria=None, **override):
        body = {
            'usuario_uuid': str((usuario or self.auditor).id_unico),
            'auditoria_uuid': str((auditoria or self.aberta).id_unico),
            'origem_mobile_uuid': str(uuid.uuid4()),
            'orientacao': 'Nova orientação',
            'atividade': 'Nova atividade',
            'prazo': (date.today() + timedelta(days=3)).isoformat(),
        }
        body.update(override)
        return body

    def body_etapa_editar(self, usuario=None, etapa=None, **novos):
        etapa = etapa or self.etapa
        body = {'usuario_uuid': str((usuario or self.auditor).id_unico), 'baseline': campos_etapa(etapa)}
        body.update(campos_etapa(etapa))
        body.update(novos)
        return body

    # --- urls -------------------------------------------------------------

    @staticmethod
    def url_auditorias():
        return reverse('Auth:api_mobile_auditorias')

    @staticmethod
    def url_etapas(auditoria):
        return reverse('Auth:api_mobile_etapas', kwargs={'id_unico': auditoria.id_unico})

    @staticmethod
    def url_criar_achado():
        return reverse('Auth:api_mobile_criar_achado')

    @staticmethod
    def url_criar_etapa():
        return reverse('Auth:api_mobile_criar_etapa')

    @staticmethod
    def url_editar_etapa(etapa):
        return reverse('Auth:api_mobile_editar_etapa', kwargs={'id_unico': etapa.id_unico})

    @staticmethod
    def url_excluir_etapa(etapa):
        return reverse('Auth:api_mobile_excluir_etapa', kwargs={'id_unico': etapa.id_unico})
