import uuid
from decimal import Decimal
from uuid import UUID as _UUID
from datetime import date, datetime, timezone as dt_timezone

from django.db import models
from django.utils import timezone
from django.db.models import Value
from django.db.models.functions import Coalesce
from django.contrib.auth.models import AbstractUser
from django.core.validators import MinValueValidator, MaxValueValidator
from django.db.models.signals import pre_save, post_save, post_delete, m2m_changed
from django.dispatch import receiver
from django.conf import settings
from django.utils.functional import cached_property
from encrypted_model_fields.fields import EncryptedCharField, EncryptedTextField, EncryptedMixin


# ---------------------------------------------------------------------------
# RBAC — Perfis e Permissões
# ---------------------------------------------------------------------------

TELA_CHOICES = [
    ('dashboard',     'Dashboard'),
    ('acoes',         'Ações'),
    ('indices',       'Índices'),
    ('tipos_acao',    'Tipos de Ação'),
    ('tipos_indice',  'Tipos de Índice'),
    ('grupos_indice', 'Grupos de Índice'),
    ('auditorias',    'Auditorias'),
    ('matrizes',      'Matrizes de Auditoria'),
    ('entidades',     'Entidades de Auditoria'),
    ('usuarios',      'Usuários'),
    ('perfis',        'Perfis'),
]

UNIDADE_CHOICES = [
    ('SEFAZ',  'SEFAZ'),
    ('SESAU',  'SESAU'),
    ('SEINFRA','SEINFRA'),
    ('SEMA',   'SEMA'),
    ('SEAD',   'SEAD'),
    ('SEDUC',  'SEDUC'),
    ('SESP',   'SESP'),
    ('SEAG',   'SEAG'),
    ('SEJEL',  'SEJEL'),
    ('SEDU',   'SEDU'),
    ('OUTRO',  'Outro'),
]


class Perfil(models.Model):
    id_unico  = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    nome      = models.CharField(max_length=100, unique=True, verbose_name='Nome')
    descricao = models.TextField(blank=True, default='', verbose_name='Descrição')
    parent    = models.ForeignKey(
        'self', null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name='filhos',
        verbose_name='Perfil Pai',
    )

    class Meta:
        verbose_name = 'Perfil'
        verbose_name_plural = 'Perfis'
        ordering = ['nome']

    def __str__(self):
        return self.nome

    @cached_property
    def _permissoes_dict(self):
        return {p.tela: p for p in self.permissoes.all()}

    def tem_permissao(self, tela, acao='ver'):
        perm = self._permissoes_dict.get(tela)
        return bool(getattr(perm, f'pode_{acao}', False)) if perm else False

    def profundidade(self):
        depth, current, visitados = 0, self, {self.pk}
        while current.parent_id and current.parent_id not in visitados:
            depth += 1
            visitados.add(current.parent_id)
            current = current.parent
        return depth


class PerfilPermissao(models.Model):
    perfil       = models.ForeignKey(Perfil, on_delete=models.CASCADE, related_name='permissoes')
    tela         = models.CharField(max_length=30, choices=TELA_CHOICES, verbose_name='Tela')
    pode_ver     = models.BooleanField(default=False, verbose_name='Ver')
    pode_criar   = models.BooleanField(default=False, verbose_name='Criar')
    pode_editar  = models.BooleanField(default=False, verbose_name='Editar')
    pode_excluir = models.BooleanField(default=False, verbose_name='Excluir')

    class Meta:
        verbose_name = 'Permissão'
        verbose_name_plural = 'Permissões'
        unique_together = ('perfil', 'tela')

    def __str__(self):
        return f'{self.perfil.nome} → {self.get_tela_display()}'


# ---------------------------------------------------------------------------
# Modelos
# ---------------------------------------------------------------------------

class Usuario(AbstractUser):
    id_unico  = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    cpf       = EncryptedCharField(max_length=14, unique=True, verbose_name="CPF")
    telefone  = EncryptedCharField(max_length=15, blank=True, null=True)
    rua       = EncryptedCharField(max_length=255, blank=True, null=True)
    bairro    = EncryptedCharField(max_length=100, blank=True, null=True)
    numero    = EncryptedCharField(max_length=10, blank=True, null=True)
    cep       = EncryptedCharField(max_length=9, blank=True, null=True)
    unidade   = models.CharField(
        max_length=20, choices=UNIDADE_CHOICES,
        null=True, blank=True, verbose_name="Unidade",
        help_text="Se definida, restringe o acesso às Ações desta unidade. Deixe em branco para acesso irrestrito (ex.: controladoria)."
    )
    perfil    = models.ForeignKey(
        'Perfil', on_delete=models.PROTECT,
        null=True, blank=True,
        verbose_name='Perfil', related_name='usuarios'
    )

    def tem_permissao(self, tela, acao='ver'):
        if not self.perfil_id:
            return False
        return self.perfil.tem_permissao(tela, acao)

    class Meta:
        verbose_name = "Usuário"
        verbose_name_plural = "Usuários"
        ordering = ['first_name', 'last_name']

    def __str__(self):
        return self.get_full_name() or self.username

    @property
    def iniciais(self):
        nome = self.get_full_name()
        if nome:
            partes = nome.split()
            if len(partes) >= 2:
                return (partes[0][0] + partes[-1][0]).upper()
            return partes[0][:2].upper()
        return self.username[:2].upper()


class TipoAcao(models.Model):
    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    nome_acao = models.CharField(max_length=255, verbose_name="Nome da Ação", unique=True)
    motivo_acao = models.TextField(verbose_name="Motivo da Ação")
    mensagem_padrao_avaliacao = models.TextField(verbose_name="Mensagem Padrão para Avaliação", blank=True, null=True)
    mensagem_padrao_conclusao = models.TextField(verbose_name="Mensagem Padrão para Conclusão", blank=True, null=True)

    class Meta:
        verbose_name = "Tipo de Ação"
        verbose_name_plural = "Tipos de Ação"
        ordering = ['nome_acao']

    def __str__(self):
        return self.nome_acao


class GrupoIndice(models.Model):
    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    nome = models.CharField(max_length=150, unique=True, verbose_name="Nome do Grupo", help_text="Nome único para o grupo de índice.")
    observacao = models.TextField(blank=True, null=True, verbose_name="Observação")

    class Meta:
        verbose_name = "Grupo de Índice"
        verbose_name_plural = "Grupos de Índices"
        ordering = ['nome']

    def __str__(self):
        return self.nome


class TipoIndice(models.Model):
    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    descricao = models.CharField(max_length=255, verbose_name="Descrição")
    indice_grupo = models.ForeignKey(GrupoIndice, on_delete=models.PROTECT, verbose_name="Grupo do Índice")
    observacao = models.TextField(blank=True, null=True, verbose_name="Observação")

    class Meta:
        verbose_name = "Tipo de Índice"
        verbose_name_plural = "Tipos de Índice"
        ordering = ['descricao']
        unique_together = ('descricao', 'indice_grupo')

    def __str__(self):
        return self.descricao


class Acao(models.Model):
    STATUS_CHOICES = [
        ('EM_ANDAMENTO',      'Em andamento'),
        ('AGUARDANDO_REVISAO','Aguardando revisão'),
        ('HOMOLOGADA',        'Homologada'),
        ('ATRASADA',          'Atrasada'),
    ]
    UNIDADE_CHOICES = UNIDADE_CHOICES

    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    id_por_tipo_acao = models.PositiveIntegerField(editable=False, verbose_name="Ref. Categoria")
    data_execucao = models.DateField(verbose_name="Data de Execução")
    tipo_acao = models.ForeignKey('TipoAcao', on_delete=models.PROTECT, verbose_name="Tipo de Ação")
    usuario = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="Responsável")
    avaliacao = models.TextField(verbose_name="Avaliação")
    conclusao = models.TextField(verbose_name="Conclusão")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='EM_ANDAMENTO', verbose_name="Status")
    unidade = models.CharField(max_length=20, choices=UNIDADE_CHOICES, default='SEFAZ', verbose_name="Unidade")
    is_paint = models.BooleanField(default=False, verbose_name="PAINT")

    class Meta:
        unique_together = ['tipo_acao', 'id_por_tipo_acao']
        verbose_name = "Ação"
        verbose_name_plural = "Ações"

    def save(self, *args, **kwargs):
        if not self.id_por_tipo_acao:
            from django.db import transaction
            with transaction.atomic():
                TipoAcao.objects.select_for_update().get(pk=self.tipo_acao_id)
                ultimo = (
                    Acao.objects.select_for_update()
                    .filter(tipo_acao=self.tipo_acao)
                    .order_by('-id_por_tipo_acao')
                    .first()
                )
                self.id_por_tipo_acao = (ultimo.id_por_tipo_acao + 1) if ultimo else 1
                super().save(*args, **kwargs)
        else:
            super().save(*args, **kwargs)

    @property
    def identificacao_semantica(self):
        meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
        mes_nome = meses[self.data_execucao.month - 1]
        return f"{self.tipo_acao.nome_acao} - {mes_nome}/{self.data_execucao.year} (Ref: {self.id_por_tipo_acao:03d})"

    def __str__(self):
        return self.identificacao_semantica


class Indice(models.Model):
    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    tipo_indice = models.ForeignKey(TipoIndice, on_delete=models.PROTECT, verbose_name="Tipo de Índice")
    mes = models.IntegerField(verbose_name="Mês", validators=[MinValueValidator(1), MaxValueValidator(12)])
    ano = models.IntegerField(verbose_name="Ano", validators=[MinValueValidator(2000)])
    valor = models.DecimalField(max_digits=10, decimal_places=4, verbose_name="Valor (%)", default=0)
    observacao = models.TextField(blank=True, null=True, verbose_name="Observação")

    class Meta:
        verbose_name = "Índice"
        verbose_name_plural = "Índices"
        ordering = ['-ano', '-mes']
        unique_together = ('tipo_indice', 'mes', 'ano')

    def __str__(self):
        return f"{self.tipo_indice.descricao} - {self.mes}/{self.ano}"


class EntidadeAuditoria(models.Model):
    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    nome = models.CharField(max_length=255, unique=True, verbose_name="Nome da Entidade")

    class Meta:
        verbose_name = "Entidade de Auditoria"
        verbose_name_plural = "Entidades de Auditoria"
        ordering = ['nome']

    def __str__(self):
        return self.nome


class MatrizAuditoria(models.Model):
    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    descricao = models.CharField(max_length=255, default='', verbose_name="Descrição/Nome da matriz de auditoria")
    objetivo = models.TextField(default='', verbose_name="Objetivo da matriz de auditoria")
    base_legal = models.CharField(max_length=500, default='', verbose_name="Base da matriz de auditoria")
    riscos = models.CharField(max_length=500, default='', verbose_name="Riscos da matriz de auditoria")
    criterios_indicadores = models.CharField(max_length=500, default='', verbose_name="Critérios Indicadores da matriz de auditoria")
    procedimentos = models.CharField(max_length=500, default='', verbose_name="Procedimentos da matriz de auditoria")
    conclusoes_esperadas = models.CharField(max_length=500, default='', verbose_name="Conclusões da matriz de auditoria")
    entidade = models.ForeignKey(
        EntidadeAuditoria, on_delete=models.PROTECT,
        null=True, blank=True, verbose_name="Entidade da matriz de auditoria"
    )
    observacoes = models.TextField(blank=True, default='', verbose_name="Observações adicionais da matriz de auditoria")
    class Meta:
        verbose_name = "Matriz de Auditoria"
        verbose_name_plural = "Matrizes de Auditoria"
        ordering = ['descricao']

    def __str__(self):
        return self.descricao
class Auditoria(models.Model):
    STATUS_CHOICES = [
        ('PLANEJADA',    'Planejada'),
        ('EM_ANDAMENTO', 'Em andamento'),
        ('CONCLUIDA',    'Concluída'),
        ('CANCELADA',    'Cancelada'),
    ]

    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    id_por_orgao = models.PositiveIntegerField(editable=False, null=True, blank=True, verbose_name="Ref. Órgão")
    nome_auditoria = models.CharField(max_length=255, verbose_name="Nome da Auditoria")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='PLANEJADA', verbose_name="Status")
    matriz = models.ForeignKey(
        MatrizAuditoria, on_delete=models.PROTECT,
        null=True, blank=True, verbose_name="Matriz de Auditoria"
    )
    orgao = models.CharField(max_length=255, blank=True, null=True, verbose_name="Órgão")
    responsavel_orgao = models.CharField(max_length=255, blank=True, null=True, verbose_name="Responsável do Órgão")
    usuarios_envolvidos = models.ManyToManyField(Usuario, blank=True, verbose_name="Usuários Envolvidos")
    informacoes_campos_texto = models.TextField(blank=True, default='', verbose_name="Informações dos Campos de Texto")

    data_criacao = models.DateTimeField(auto_now_add=True)
    data_inicio = models.DateField(null=True, blank=True, verbose_name="Data de Início")
    data_conclusao = models.DateField(null=True, blank=True, verbose_name="Data de Conclusão")

    apuracao_inicial = models.DecimalField(
        max_digits=15, decimal_places=2,
        null=True, blank=True, verbose_name="Apuração Inicial (R$)"
    )
    apuracao_final = models.DecimalField(
        max_digits=15, decimal_places=2,
        null=True, blank=True, verbose_name="Apuração Final (R$)"
    )

    class Meta:
        verbose_name = "Auditoria"
        verbose_name_plural = "Auditorias"
        ordering = ['-data_criacao']
        constraints = [
            # O select_for_update do save() não cobre a PRIMEIRA auditoria de
            # um órgão (não há linha a travar): duas criações simultâneas
            # calculavam ambas o ordinal 1. Quem garante a unicidade é o banco;
            # o save() só refaz a conta quando colide.
            # COALESCE: auditorias sem órgão formam um grupo só ("Geral" na
            # identificação semântica) e também não podem repetir o ordinal.
            models.UniqueConstraint(
                Coalesce('orgao', Value('')), 'id_por_orgao',
                name='auditoria_ordinal_unico_por_orgao',
            ),
        ]

    TENTATIVAS_ORDINAL = 5

    def save(self, *args, **kwargs):
        if self.id_por_orgao:
            return super().save(*args, **kwargs)
        from django.db import IntegrityError, transaction
        for tentativa in range(self.TENTATIVAS_ORDINAL):
            try:
                # Savepoint próprio: a colisão desfaz só esta tentativa, não a
                # transação da requisição (ATOMIC_REQUESTS) inteira.
                with transaction.atomic():
                    # Mesmo agrupamento da restrição: sem órgão ('' ou NULL) é um grupo só.
                    mesmo_orgao = (
                        models.Q(orgao=self.orgao) if self.orgao
                        else models.Q(orgao__isnull=True) | models.Q(orgao='')
                    )
                    ultimo = (
                        Auditoria.objects.select_for_update()
                        .filter(mesmo_orgao)
                        .order_by('-id_por_orgao')
                        .first()
                    )
                    self.id_por_orgao = (ultimo.id_por_orgao + 1) if ultimo and ultimo.id_por_orgao else 1
                    return super().save(*args, **kwargs)
            except IntegrityError:
                self.id_por_orgao = None
                if tentativa == self.TENTATIVAS_ORDINAL - 1:
                    raise

    @property
    def resultado_calculado(self):
        if self.apuracao_inicial is not None and self.apuracao_final is not None:
            return self.apuracao_final - self.apuracao_inicial
        return None

    @property
    def identificacao_semantica(self):
        categoria = self.orgao or 'Geral'
        return f"Auditoria {categoria} {self.id_por_orgao:02d}"

    def __str__(self):
        return self.nome_auditoria


class Etapa(models.Model):
    SITUACAO_CHOICES = [
        ('PENDENTE',     'Pendente'),
        ('EM_ANDAMENTO', 'Em andamento'),
        ('CONCLUIDA',    'Concluída'),
        ('REABERTA',     'Reaberta'),
    ]
    id_unico   = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    auditoria  = models.ForeignKey(Auditoria, on_delete=models.CASCADE, related_name='etapas_list', verbose_name="Auditoria")
    orientacao = models.TextField(verbose_name="Orientação")
    documentos = models.TextField(blank=True, default='', verbose_name="Documentos")
    usuario    = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="Usuário")
    atividade  = models.CharField(max_length=500, verbose_name="Atividade")
    prazo      = models.DateField(verbose_name="Prazo")
    situacao   = models.CharField(max_length=20, choices=SITUACAO_CHOICES, default='PENDENTE', verbose_name="Situação")
    metodo     = models.CharField(max_length=255, blank=True, default='', verbose_name="Método")
    data_criacao = models.DateTimeField(auto_now_add=True)
    # Chave de idempotência do app de campo (mobile), mesmo padrão de
    # Achado.origem_mobile_uuid: um retry de sincronização após falha de
    # rede reutiliza o get_or_create em vez de duplicar a Etapa.
    origem_mobile_uuid = models.UUIDField(null=True, blank=True, unique=True, verbose_name="UUID de Origem (Mobile)")

    class Meta:
        verbose_name = "Etapa"
        verbose_name_plural = "Etapas"
        ordering = ['prazo']

    def __str__(self):
        return f"{self.auditoria.nome_auditoria} — {self.atividade[:50]}"


class ConflitoEtapa(models.Model):
    """
    Registrado quando uma edição de Etapa vinda do app mobile chega com um
    `baseline` (estado que o dispositivo achava ser verdade antes de editar)
    que não bate mais com o estado atual da Etapa — ou seja, alguém mudou
    o dado nesse meio-tempo (outro dispositivo, ou o próprio sistema web).
    A resolução não é automática: fica pendente até alguém com nível de
    acesso suficiente escolher qual dos dois conjuntos de campos prevalece.
    """
    STATUS_CHOICES = [
        ('PENDENTE', 'Pendente'),
        ('RESOLVIDO', 'Resolvido'),
    ]

    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    etapa = models.ForeignKey(Etapa, on_delete=models.CASCADE, related_name='conflitos', verbose_name="Etapa")

    usuario_originador = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT,
        related_name='conflitos_originados', verbose_name="Usuário Originador",
    )
    dados_originador = models.JSONField(verbose_name="Dados do Originador")

    usuario_atual = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='conflitos_como_atual', verbose_name="Usuário da Versão Atual",
    )
    dados_atuais = models.JSONField(verbose_name="Dados Atuais no Momento do Conflito")

    atribuido_a = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='conflitos_atribuidos', verbose_name="Atribuído A",
    )
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='PENDENTE', verbose_name="Status")
    resolvido_por = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='conflitos_resolvidos', verbose_name="Resolvido Por",
    )
    resolvido_em = models.DateTimeField(null=True, blank=True, verbose_name="Resolvido Em")
    criado_em = models.DateTimeField(auto_now_add=True, verbose_name="Criado Em")

    class Meta:
        verbose_name = "Conflito de Etapa"
        verbose_name_plural = "Conflitos de Etapa"
        ordering = ['-criado_em']

    def __str__(self):
        return f"Conflito — {self.etapa.atividade[:40]} ({self.status})"


class Achado(models.Model):
    id_unico     = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    etapa        = models.ForeignKey(Etapa, on_delete=models.CASCADE, related_name='achados', verbose_name="Etapa")
    descricao    = EncryptedTextField(verbose_name="Descrição do Achado")
    data_achado  = models.DateField(auto_now_add=True, verbose_name="Data do Achado")
    usuario      = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="Usuário")
    # Chave de idempotência do app de campo (mobile): permite que um retry de
    # sincronização após falha de rede reutilize o get_or_create em vez de
    # duplicar o Achado.
    origem_mobile_uuid = models.UUIDField(null=True, blank=True, unique=True, verbose_name="UUID de Origem (Mobile)")

    class Meta:
        verbose_name = "Achado"
        verbose_name_plural = "Achados"
        ordering = ['-data_achado']

    def __str__(self):
        return f"Achado — {self.etapa.atividade[:40]}"


class HistoricoAlteracoes(models.Model):
    OPERACAO_CHOICES = [
        ('CRIADO',      'Criado'),
        ('ATUALIZADO',  'Atualizado'),
        ('EXCLUIDO',    'Excluído'),
    ]

    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    usuario = models.ForeignKey(
        'Usuario', on_delete=models.SET_NULL, null=True, blank=True,
        verbose_name="Usuário"
    )
    
    # Fotografia do autor no momento da gravação. A FK acima vira NULL se o
    # usuário for excluído (único UPDATE que o gatilho do banco admite nesta
    # tabela — ver migration 0018); é este campo, e não a FK, que entra no hash.
    autor_uuid = models.UUIDField(null=True, blank=True, editable=False, verbose_name="UUID do Autor")
    # default em vez de auto_now_add: o instante precisa estar definido ANTES
    # do INSERT, porque entra no hash calculado em save().
    data_hora_alteracao = models.DateTimeField(default=timezone.now, editable=False, verbose_name="Data e Hora da Alteração")
    operacao = models.CharField(max_length=10, choices=OPERACAO_CHOICES, default='ATUALIZADO', verbose_name="Operação")
    tipo_objeto = models.CharField(max_length=100, verbose_name="Tipo do Objeto")
    uuid_objeto = models.UUIDField(null=True, blank=True, verbose_name="UUID do Objeto")
    estado_anterior = models.JSONField(null=True, blank=True, verbose_name="Estado Anterior")
    estado_posterior = models.JSONField(null=True, blank=True, verbose_name="Estado Posterior")
    # Encadeamento da trilha central, mesmo princípio da cadeia do app de
    # campo: cada entrada carrega o hash da anterior (ordem de inserção, `id`).
    hash_anterior = models.CharField(max_length=64, editable=False, default='', verbose_name="Hash Anterior")
    hash_atual = models.CharField(max_length=64, editable=False, default='', verbose_name="Hash")

    HASH_GENESIS = '0' * 64
    # Chave do pg_advisory_xact_lock que serializa a inserção: sem ela, duas
    # gravações simultâneas leriam o mesmo "último hash" e bifurcariam a cadeia.
    _TRAVA_CADEIA = 7_401_826_013

    class Meta:
        verbose_name = "Histórico de Alteração"
        verbose_name_plural = "Histórico de Alterações"
        ordering = ['-data_hora_alteracao']

    def __str__(self):
        user_display = self.usuario.username if self.usuario else 'Sistema'
        ts = timezone.localtime(self.data_hora_alteracao).strftime('%d/%m/%Y %H:%M')
        return f"[{user_display}] {self.operacao} [{self.tipo_objeto}] em {ts}"

    @staticmethod
    def calcular_hash(hash_anterior, id_unico, operacao, tipo_objeto, uuid_objeto,
                      autor_uuid, data_hora, estado_anterior, estado_posterior):
        """
        SHA-256 de todos os campos que dão sentido à entrada, separados por "|".
        Os estados vão em JSON canônico (chaves ordenadas, sem espaços) porque
        o PostgreSQL (jsonb) não preserva a ordem das chaves na leitura.
        """
        import hashlib
        import json

        def canonico(estado):
            return json.dumps(estado, sort_keys=True, ensure_ascii=False, separators=(',', ':'))

        instante = data_hora.astimezone(dt_timezone.utc).isoformat(timespec='microseconds')
        partes = [
            hash_anterior, str(id_unico), operacao, tipo_objeto,
            str(uuid_objeto or ''), str(autor_uuid or ''), instante,
            canonico(estado_anterior), canonico(estado_posterior),
        ]
        return hashlib.sha256('|'.join(partes).encode('utf-8')).hexdigest()

    def _hash_esperado(self, hash_anterior):
        return self.calcular_hash(
            hash_anterior, self.id_unico, self.operacao, self.tipo_objeto, self.uuid_objeto,
            self.autor_uuid, self.data_hora_alteracao, self.estado_anterior, self.estado_posterior,
        )

    def save(self, *args, **kwargs):
        if not self._state.adding:
            # A trilha só cresce por acréscimo. O banco recusa de qualquer
            # forma (gatilho da migration 0018); aqui o erro fica mais claro.
            raise ValueError('Entradas do histórico não podem ser alteradas.')
        from django.db import connection, transaction
        with transaction.atomic():
            if connection.vendor == 'postgresql':
                with connection.cursor() as cursor:
                    cursor.execute('SELECT pg_advisory_xact_lock(%s)', [self._TRAVA_CADEIA])
            ultimo = HistoricoAlteracoes.objects.order_by('-id').values_list('hash_atual', flat=True).first()
            if self.usuario_id and not self.autor_uuid:
                self.autor_uuid = self.usuario.id_unico
            # Microssegundos fixados aqui e relidos do banco iguais: o hash
            # depende do instante exato que fica gravado.
            self.data_hora_alteracao = self.data_hora_alteracao or timezone.now()
            self.hash_anterior = ultimo or self.HASH_GENESIS
            self.hash_atual = self._hash_esperado(self.hash_anterior)
            super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError('Entradas do histórico não podem ser excluídas.')

    @classmethod
    def verificar_cadeia(cls):
        """
        Percorre a trilha inteira na ordem de inserção. Devolve
        (ok, total, ultimo_hash, id_da_primeira_entrada_quebrada).
        Detecta entrada alterada, removida, inserida ou reordenada sem que a
        cadeia tenha sido recalculada a partir dali. Quem recalcula a cadeia
        inteira só é pego comparando o `ultimo_hash` com um valor registrado
        fora do banco (ver o comando verificar_trilha).
        """
        esperado = cls.HASH_GENESIS
        total = 0
        for entrada in cls.objects.order_by('id').iterator():
            total += 1
            if entrada.hash_anterior != esperado or entrada.hash_atual != entrada._hash_esperado(esperado):
                return False, total, esperado, entrada.id
            esperado = entrada.hash_atual
        return True, total, esperado, None


class LogAcesso(models.Model):
    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    usuario = models.ForeignKey(Usuario, on_delete=models.SET_NULL, null=True, blank=True, verbose_name="Usuário")
    data_hora_acesso = models.DateTimeField(auto_now_add=True, verbose_name="Data e Hora do Acesso")
    ip_acesso = models.GenericIPAddressField(verbose_name="IP de Acesso")

    class Meta:
        verbose_name = "Log de Acesso"
        verbose_name_plural = "Logs de Acesso"
        ordering = ['-data_hora_acesso']

    def __str__(self):
        user_display = self.usuario.username if self.usuario else 'Usuário removido'
        return f"{user_display} - {timezone.localtime(self.data_hora_acesso).strftime('%d/%m/%Y %H:%M:%S')}"


class ConfiguracaoSistema(models.Model):
    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    chave = models.CharField(max_length=100, unique=True, verbose_name="Chave de Configuração")
    valor = models.TextField(verbose_name="Valor da Configuração")
    descricao = models.TextField(blank=True, null=True, verbose_name="Descrição")

    class Meta:
        verbose_name = "Configuração do Sistema"
        verbose_name_plural = "Configurações do Sistema"

    def __str__(self):
        return self.chave


class Relatorio(models.Model):
    id_unico = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    nome_relatorio = models.CharField(max_length=255, verbose_name="Nome do Relatório")
    data_geracao = models.DateTimeField(auto_now_add=True, verbose_name="Data de Geração")
    conteudo = models.TextField(verbose_name="Conteúdo do Relatório")

    class Meta:
        verbose_name = "Relatório"
        verbose_name_plural = "Relatórios"
        ordering = ['-data_geracao']

    def __str__(self):
        return self.nome_relatorio


# ---------------------------------------------------------------------------
# Audit by Design — §4.3 do TCC
# ---------------------------------------------------------------------------

MODELOS_AUDITAVEIS = [
    Usuario, Perfil, PerfilPermissao,
    TipoAcao, GrupoIndice, TipoIndice, Acao, Indice,
    EntidadeAuditoria, MatrizAuditoria, Auditoria, ConfiguracaoSistema,
    Etapa, Achado,
]


CAMPOS_SENSIVEIS = {'password', 'last_login', 'email'}


def _serializar_instancia(instance):
    """
    Retorna um dict com os campos escalares do modelo.
    Campos cifrados (qualquer Encrypted*Field — EncryptedMixin é a base
    comum de EncryptedCharField, EncryptedTextField etc.) e CAMPOS_SENSIVEIS
    são marcados como [PROTEGIDO] para não expor dados sensíveis no log de
    auditoria. Checar só EncryptedCharField deixaria vazar em texto plano
    qualquer outro Encrypted*Field (ex.: EncryptedTextField do Achado).
    """
    resultado = {}
    for field in instance._meta.concrete_fields:
        if isinstance(field, EncryptedMixin) or field.name in CAMPOS_SENSIVEIS:
            resultado[field.name] = '[PROTEGIDO]'
            continue
        value = field.value_from_object(instance)
        if isinstance(value, (date, datetime)):
            value = value.isoformat()
        elif isinstance(value, Decimal):
            value = str(value)
        elif isinstance(value, _UUID):
            value = str(value)
        resultado[field.name] = value
    return resultado


@receiver(pre_save, dispatch_uid='auditoria_pre_save')
def _capturar_estado_anterior(sender, instance, **kwargs):
    if sender not in MODELOS_AUDITAVEIS:
        return
    if instance.pk:
        try:
            instance._auditoria_estado_anterior = _serializar_instancia(
                sender.objects.get(pk=instance.pk)
            )
        except sender.DoesNotExist:
            instance._auditoria_estado_anterior = None
    else:
        instance._auditoria_estado_anterior = None


@receiver(post_save, dispatch_uid='auditoria_post_save')
def _registrar_auditoria(sender, instance, created, **kwargs):
    if sender not in MODELOS_AUDITAVEIS:
        return
    estado_anterior = getattr(instance, '_auditoria_estado_anterior', None)
    estado_posterior = _serializar_instancia(instance)
    if not created and estado_anterior == estado_posterior:
        return
    from Auth.middleware import get_current_user
    usuario = get_current_user()
    HistoricoAlteracoes.objects.create(
        operacao='CRIADO' if created else 'ATUALIZADO',
        tipo_objeto=sender.__name__,
        uuid_objeto=getattr(instance, 'id_unico', None),
        estado_anterior=estado_anterior,
        estado_posterior=estado_posterior,
        usuario=usuario if usuario and getattr(usuario, 'is_authenticated', False) else None,
    )


def _usuario_corrente():
    from Auth.middleware import get_current_user
    usuario = get_current_user()
    return usuario if usuario and getattr(usuario, 'is_authenticated', False) else None


def _equipe(auditoria):
    return sorted(str(u) for u in auditoria.usuarios_envolvidos.values_list('id_unico', flat=True))


@receiver(m2m_changed, sender=Auditoria.usuarios_envolvidos.through, dispatch_uid='auditoria_equipe_m2m')
def _registrar_equipe(sender, instance, action, reverse, pk_set, **kwargs):
    """
    A equipe da auditoria é uma relação muitos-para-muitos: add/remove/clear
    não passam por save() e, portanto, escapavam de pre_save/post_save. Quem
    entra e quem sai da equipe decide quem pode ler e alterar a auditoria, e
    por isso precisa estar na trilha como qualquer outro campo.

    `reverse` = a mudança veio pelo lado do usuário (usuario.auditoria_set.add):
    aí `instance` é o Usuario e as auditorias afetadas estão em `pk_set`.
    """
    if action not in ('pre_add', 'pre_remove', 'pre_clear', 'post_add', 'post_remove', 'post_clear'):
        return
    if reverse:
        if action == 'pre_clear':
            pk_set = set(instance.auditoria_set.values_list('pk', flat=True))
            instance._auditoria_pks_clear = pk_set
        elif action == 'post_clear':
            pk_set = getattr(instance, '_auditoria_pks_clear', set())
        auditorias = list(Auditoria.objects.filter(pk__in=pk_set or ()))
    else:
        auditorias = [instance]

    for auditoria in auditorias:
        if action.startswith('pre_'):
            auditoria._equipe_anterior = _equipe(auditoria)
            if reverse:
                instance._equipes_anteriores = getattr(instance, '_equipes_anteriores', {})
                instance._equipes_anteriores[auditoria.pk] = auditoria._equipe_anterior
            continue
        if reverse:
            antes = getattr(instance, '_equipes_anteriores', {}).get(auditoria.pk)
        else:
            antes = getattr(auditoria, '_equipe_anterior', None)
        depois = _equipe(auditoria)
        if antes is None or antes == depois:
            continue
        estado = _serializar_instancia(auditoria)
        HistoricoAlteracoes.objects.create(
            operacao='ATUALIZADO',
            tipo_objeto='Auditoria',
            uuid_objeto=auditoria.id_unico,
            estado_anterior={**estado, 'usuarios_envolvidos': antes},
            estado_posterior={**estado, 'usuarios_envolvidos': depois},
            usuario=_usuario_corrente(),
        )


@receiver(post_delete, dispatch_uid='auditoria_post_delete')
def _registrar_exclusao(sender, instance, **kwargs):
    if sender not in MODELOS_AUDITAVEIS:
        return
    from Auth.middleware import get_current_user
    usuario = get_current_user()
    HistoricoAlteracoes.objects.create(
        operacao='EXCLUIDO',
        tipo_objeto=sender.__name__,
        uuid_objeto=getattr(instance, 'id_unico', None),
        estado_anterior=_serializar_instancia(instance),
        estado_posterior=None,
        usuario=usuario if usuario and getattr(usuario, 'is_authenticated', False) else None,
    )
