"""
Popula o banco com um conjunto coerente de dados de demonstração para
exercitar o fluxo do app de campo (mobile): auditores, auditorias abertas,
etapas com prazos variados e alguns achados.

Uso:
    python manage.py seed_demo            # cria o que faltar (idempotente)
    python manage.py seed_demo --flush    # apaga os dados de domínio antes

Não mexe em migrations nem nos perfis RBAC (semeados pela migration 0010).
"""
import datetime
from django.utils import timezone

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from Auth.middleware import set_current_user
from Auth.models import (
    Acao,
    Achado,
    Auditoria,
    EntidadeAuditoria,
    Etapa,
    MatrizAuditoria,
    Perfil,
    PerfilPermissao,
    TipoAcao,
)

Usuario = get_user_model()
HOJE = timezone.localdate()


def _dias(n):
    return HOJE + datetime.timedelta(days=n)


TIPOS_ACAO = [
    ("Auditoria Interna", "Verificação periódica dos processos internos.",
     "Analisar conformidade dos processos com as normas vigentes.",
     "Processos auditados e não conformidades registradas."),
    ("Fiscalização de Contratos", "Acompanhamento de execução contratual.",
     "Avaliar cumprimento das cláusulas contratuais.",
     "Contrato em conformidade / irregularidades identificadas."),
    ("Análise de Prestação de Contas", "Revisão de documentos de prestação de contas.",
     "Verificar regularidade das despesas apresentadas.",
     "Prestação de contas aprovada / reprovada com ressalvas."),
    ("Inspeção", "Inspeção presencial nas instalações.",
     "Verificar condições físicas e documentais in loco.",
     "Inspeção concluída com laudo emitido."),
]

ENTIDADES = [
    "Secretaria de Estado da Fazenda",
    "Secretaria de Estado da Saúde",
    "Secretaria de Estado da Infraestrutura",
]

# nome_auditoria, status, orgao, responsavel_orgao, dias_inicio, [etapas]
AUDITORIAS = [
    (
        "Auditoria de Contratos de TI 2026", "EM_ANDAMENTO", "SEFAZ",
        "João Pereira (Diretor de TI)", -20,
        [
            ("Levantar contratos de TI vigentes no exercício",
             "Solicitar à unidade a relação de contratos ativos com objeto de TI.",
             "Planilha de contratos; portarias de designação de fiscais.",
             "EM_ANDAMENTO", -2, "Análise documental"),
            ("Conferir designação formal de fiscais de contrato",
             "Verificar se cada contrato tem fiscal designado por portaria publicada.",
             "Portarias; Diário Oficial.",
             "PENDENTE", 5, "Checklist de conformidade"),
            ("Testar liquidação de despesas do maior contrato",
             "Amostrar notas fiscais e conferir ateste, medição e pagamento.",
             "Notas fiscais; boletins de medição; ordens bancárias.",
             "PENDENTE", 12, "Amostragem não estatística"),
            ("Avaliar aderência ao plano de contratações anual",
             "Cruzar contratos executados com o PCA aprovado.",
             "PCA 2026; sistema de compras.",
             "PENDENTE", 20, "Cruzamento de dados"),
        ],
    ),
    (
        "Prestação de Contas — Fundo Estadual de Saúde", "EM_ANDAMENTO", "SESAU",
        "Maria Santos (Coordenadora de Convênios)", -8,
        [
            ("Verificar regularidade da documentação de despesa",
             "Conferir se cada despesa tem nota fiscal, empenho e comprovante de pagamento.",
             "Processos de pagamento; extratos bancários.",
             "EM_ANDAMENTO", 1, "Análise documental"),
            ("Conciliar saldo bancário do fundo",
             "Bater o saldo contábil com o extrato na data de encerramento.",
             "Balancete; extrato bancário; conciliação anterior.",
             "PENDENTE", 7, "Conciliação"),
            ("Amostrar aquisições de medicamentos",
             "Selecionar itens e verificar pesquisa de preços e recebimento.",
             "Notas de empenho; atas de registro de preços.",
             "PENDENTE", 15, "Amostragem"),
        ],
    ),
    (
        "Auditoria de Obras Rodoviárias — Lote 3", "PLANEJADA", "SEINFRA",
        "Carlos Lima (Engenheiro-chefe)", 10,
        [
            ("Reunião de abertura com a unidade auditada",
             "Apresentar o escopo e o cronograma da auditoria à equipe da SEINFRA.",
             "Ordem de serviço; plano de auditoria.",
             "PENDENTE", 10, "Reunião"),
            ("Solicitar projeto executivo e cronograma físico-financeiro",
             "Requisitar a documentação técnica da obra do lote 3.",
             "Projeto executivo; cronograma; ART.",
             "PENDENTE", 14, "Requisição formal"),
        ],
    ),
    (
        "Auditoria de Almoxarifado 2025 (encerrada)", "CONCLUIDA", "SEFAZ",
        "Ana Costa", -180,
        [
            ("Inventário físico do estoque",
             "Contagem física e confronto com o saldo do sistema.",
             "Relatório de inventário; fichas de estoque.",
             "CONCLUIDA", -150, "Contagem física"),
        ],
    ),
]

ACHADOS = {
    # (nome_auditoria, prefixo_da_atividade): [descrições]
    ("Auditoria de Contratos de TI 2026", "Conferir designação"): [
        "Contrato 014/2025 (licenciamento de software) sem portaria de designação "
        "de fiscal publicada até a data-base da auditoria.",
    ],
    ("Prestação de Contas — Fundo Estadual de Saúde", "Verificar regularidade"): [
        "Despesa de R$ 12.480,00 sem comprovante de pagamento anexado ao processo.",
        "Nota fiscal 2231 emitida com CNPJ divergente do contrato — pendente de "
        "esclarecimento da unidade.",
    ],
}


class Command(BaseCommand):
    help = "Popula o banco com dados de demonstração (auditorias, etapas, achados)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--flush", action="store_true",
            help="Apaga Achado/Etapa/Auditoria/Matriz/Entidade/Acao antes de semear.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        if options["flush"]:
            Achado.objects.all().delete()
            Etapa.objects.all().delete()
            Auditoria.objects.all().delete()
            MatrizAuditoria.objects.all().delete()
            EntidadeAuditoria.objects.all().delete()
            Acao.objects.all().delete()
            self.stdout.write(self.style.WARNING("Dados de domínio apagados (--flush)."))

        chefe = self._perfil_chefe()
        auditor_perfil = self._perfil_auditor()

        admin = self._usuario(
            "admin", "Admin@123", "Administrador", "Geral",
            "000.000.000-00", chefe, superuser=True,
        )
        auditor = self._usuario(
            "auditor.campo", "mudar123", "Auditor", "de Campo",
            "111.111.111-11", auditor_perfil,
        )

        with set_current_user(admin):
            self._tipos_acao()
            entidades = self._entidades()
            self._auditorias(entidades, [admin, auditor], auditor)

        self.stdout.write(self.style.SUCCESS("\nResumo:"))
        self.stdout.write(f"  Usuários .......... {Usuario.objects.count()}")
        self.stdout.write(f"  Entidades ......... {EntidadeAuditoria.objects.count()}")
        self.stdout.write(f"  Auditorias ........ {Auditoria.objects.count()} "
                          f"(abertas: {Auditoria.objects.filter(status__in=['PLANEJADA', 'EM_ANDAMENTO']).count()})")
        self.stdout.write(f"  Etapas ............ {Etapa.objects.count()}")
        self.stdout.write(f"  Achados .......... {Achado.objects.count()}")
        self.stdout.write("")
        self.stdout.write("Logins:  admin / Admin@123   |   auditor.campo / mudar123")

    # ------------------------------------------------------------------ perfis
    def _perfil_chefe(self):
        return Perfil.objects.get(nome="Chefe")

    def _perfil_auditor(self):
        perfil, criado = Perfil.objects.get_or_create(
            nome="Auditor de Campo",
            defaults={"descricao": "Registra achados e etapas em campo pelo app mobile."},
        )
        if criado:
            perfil.parent = self._perfil_chefe()
            perfil.save(update_fields=["parent"])
        perms = {
            "dashboard": (True, False, False, False),
            "auditorias": (True, True, True, True),
            "acoes": (True, False, False, False),
        }
        for tela, (v, c, e, d) in perms.items():
            PerfilPermissao.objects.update_or_create(
                perfil=perfil, tela=tela,
                defaults={"pode_ver": v, "pode_criar": c, "pode_editar": e, "pode_excluir": d},
            )
        return perfil

    # ----------------------------------------------------------------- usuários
    def _usuario(self, username, senha, first, last, cpf, perfil, superuser=False):
        u, _ = Usuario.objects.get_or_create(
            username=username,
            defaults={"cpf": cpf, "email": f"{username}@example.com"},
        )
        u.first_name = first
        u.last_name = last
        u.perfil = perfil
        u.is_staff = superuser
        u.is_superuser = superuser
        u.is_active = True
        if not u.cpf:
            u.cpf = cpf
        u.set_password(senha)
        u.save()
        return u

    # ------------------------------------------------------------------- dados
    def _tipos_acao(self):
        for nome, motivo, aval, concl in TIPOS_ACAO:
            TipoAcao.objects.get_or_create(
                nome_acao=nome,
                defaults={
                    "motivo_acao": motivo,
                    "mensagem_padrao_avaliacao": aval,
                    "mensagem_padrao_conclusao": concl,
                },
            )

    def _entidades(self):
        return [EntidadeAuditoria.objects.get_or_create(nome=n)[0] for n in ENTIDADES]

    def _auditorias(self, entidades, envolvidos, responsavel_etapa):
        for idx, (nome, status, orgao, resp, dias_inicio, etapas) in enumerate(AUDITORIAS):
            matriz, _ = MatrizAuditoria.objects.get_or_create(
                descricao=f"Matriz — {nome}",
                defaults={
                    "objetivo": f"Avaliar a regularidade dos atos relativos a: {nome}.",
                    "entidade": entidades[idx % len(entidades)],
                },
            )
            auditoria, criada = Auditoria.objects.get_or_create(
                nome_auditoria=nome,
                defaults={
                    "status": status,
                    "orgao": orgao,
                    "responsavel_orgao": resp,
                    "matriz": matriz,
                    "data_inicio": _dias(dias_inicio),
                    "data_conclusao": _dias(dias_inicio + 90) if status == "CONCLUIDA" else None,
                },
            )
            auditoria.usuarios_envolvidos.set(envolvidos)

            for atividade, orientacao, documentos, situacao, prazo_dias, metodo in etapas:
                Etapa.objects.get_or_create(
                    auditoria=auditoria,
                    atividade=atividade,
                    defaults={
                        "orientacao": orientacao,
                        "documentos": documentos,
                        "situacao": situacao,
                        "prazo": _dias(prazo_dias),
                        "metodo": metodo,
                        "usuario": responsavel_etapa,
                    },
                )

            for (aud_nome, prefixo), descricoes in ACHADOS.items():
                if aud_nome != nome:
                    continue
                etapa = auditoria.etapas_list.filter(atividade__startswith=prefixo).first()
                if not etapa or etapa.achados.exists():
                    # descricao é EncryptedTextField — não dá para fazer lookup
                    # nela; a checagem de "já tem achado" é o que garante
                    # idempotência entre execuções sem --flush.
                    continue
                for descricao in descricoes:
                    Achado.objects.create(
                        etapa=etapa,
                        descricao=descricao,
                        usuario=responsavel_etapa,
                    )
