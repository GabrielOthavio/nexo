"""
Leitura da trilha de auditoria (`HistoricoAlteracoes`) para as telas.

A trilha é ESCRITA pelos signals em models.py em toda escrita, inclusive as
que chegam do app de campo. Este módulo só decide quem pode LER o quê e
prepara o diff campo a campo — usado tanto pela API do dashboard
(api_views.api_historico) quanto pela aba "Histórico" de Gerenciar
Auditoria (crud_Auditoria_views.gerenciar_auditoria). Ficam aqui para os
dois caminhos aplicarem exatamente a mesma regra.
"""
from django.db.models import Q
from datetime import datetime
from django.db import models
from django.utils import timezone

# Chaves que não interessam ao leitor humano: `id` é a PK numérica (o UUID
# `id_unico` já identifica o registro) — mesma exclusão do modal React do
# dashboard (ChangeDetailModal em static/Auth/src/dashboard.jsx).
CAMPOS_OCULTOS = {'id'}

# Campo que serve de rótulo humano para cada tipo, na ordem de preferência.
_CAMPO_ROTULO = {
    'Etapa':     ('atividade',),
    'Auditoria': ('nome_auditoria',),
    'Usuario':   ('username',),
}
_CAMPOS_ROTULO_GENERICOS = ('nome', 'descricao', 'nome_acao', 'titulo')


def _uuids_das_auditorias(auditoria_pks):
    """
    Os três conjuntos de `uuid_objeto` que compõem a história de um grupo de
    auditorias: elas próprias, suas etapas e os achados dessas etapas,
    INCLUSIVE os já excluídos.

    Etapas e achados apagados não existem mais nas suas tabelas; sem
    recuperá-los da própria trilha (pela FK gravada no estado_anterior da
    entrada EXCLUIDO), a exclusão de uma etapa sumia justamente da aba que
    deveria registrá-la.
    """
    from ..models import Achado, Auditoria, Etapa, HistoricoAlteracoes

    auditoria_pks = list(auditoria_pks)
    excluidas = HistoricoAlteracoes.objects.filter(operacao='EXCLUIDO')

    auditorias = list(Auditoria.objects.filter(pk__in=auditoria_pks).values_list('id_unico', flat=True))

    etapas_vivas = list(Etapa.objects.filter(auditoria__in=auditoria_pks).values_list('pk', 'id_unico'))
    etapas_mortas = [
        (h.estado_anterior.get('id'), h.uuid_objeto)
        for h in excluidas.filter(tipo_objeto='Etapa', estado_anterior__auditoria__in=auditoria_pks)
    ]
    etapa_pks = [pk for pk, _ in etapas_vivas + etapas_mortas if pk is not None]
    etapas = [u for _, u in etapas_vivas + etapas_mortas]

    achados = list(Achado.objects.filter(etapa__in=etapa_pks).values_list('id_unico', flat=True))
    achados += list(
        excluidas.filter(tipo_objeto='Achado', estado_anterior__etapa__in=etapa_pks)
        .values_list('uuid_objeto', flat=True)
    )
    return auditorias, etapas, achados


def uuids_da_auditoria(auditoria):
    """Os `uuid_objeto` da história de UMA auditoria (ver _uuids_das_auditorias)."""
    return _uuids_das_auditorias([auditoria.pk])


def _filtro_por_uuids(auditorias, etapas, achados):
    return (
        Q(tipo_objeto='Auditoria', uuid_objeto__in=auditorias)
        | Q(tipo_objeto='Etapa', uuid_objeto__in=etapas)
        | Q(tipo_objeto='Achado', uuid_objeto__in=achados)
    )


def historico_visivel(usuario):
    """
    Queryset de `HistoricoAlteracoes` que `usuario` pode ler, ou None se não
    pode ler nada.

      - quem vê usuários (chefia) enxerga a trilha inteira — inclusive
        alterações em Usuario/Perfil, que carregam cargo e unidade;
      - quem só vê auditorias enxerga a história das auditorias em que está
        envolvido (a própria auditoria, suas etapas e achados). É a mesma
        regra de envolvimento que já vale para editar etapas
        (crud_Auditoria_views._envolvido_na_auditoria) e para a API do mobile;
      - sem nenhuma das duas, nada.

    Não abrir para todos os logados de propósito: `_serializar_instancia`
    (models.py) redige só os campos cifrados e senha/e-mail/último login; o
    resto do estado — apuração financeira da auditoria, cargo e unidade do
    usuário — vai em texto plano para a trilha.
    """
    from ..models import Auditoria, HistoricoAlteracoes

    base = HistoricoAlteracoes.objects.select_related('usuario')

    if usuario.tem_permissao('usuarios', 'ver'):
        return base

    if not usuario.tem_permissao('auditorias', 'ver'):
        return None

    envolvidas = Auditoria.objects.filter(usuarios_envolvidos=usuario).values_list('pk', flat=True)
    return base.filter(_filtro_por_uuids(*_uuids_das_auditorias(envolvidas)))


def historico_da_auditoria(usuario, auditoria, limite=100):
    """Trilha de uma auditoria específica, já filtrada pelo que `usuario` pode ler."""
    visivel = historico_visivel(usuario)
    if visivel is None:
        return None
    auditorias, etapas, achados = uuids_da_auditoria(auditoria)
    return (
        visivel
        .filter(_filtro_por_uuids(auditorias, etapas, achados))
        .order_by('-data_hora_alteracao')[:limite]
    )


def descricao_do_estado(tipo_objeto, estado_posterior, estado_anterior):
    """
    Rótulo humano de uma entrada da trilha ("Reunião de abertura…" em vez de
    "260e890c…"), tirado do estado gravado. None quando o tipo não tem um
    campo de nome reconhecível.
    """
    estado = estado_posterior or estado_anterior or {}
    for campo in _CAMPO_ROTULO.get(tipo_objeto, ()) + _CAMPOS_ROTULO_GENERICOS:
        valor = estado.get(campo)
        if valor and valor != '[PROTEGIDO]':
            return str(valor)
    return None


def _campos_do_modelo(tipo_objeto):
    """{nome_do_campo: Field} do modelo da entrada, ou {} se o tipo não existe mais."""
    from django.apps import apps
    try:
        modelo = apps.get_model('Auth', tipo_objeto)
    except (LookupError, ValueError):
        return {}
    campos = {f.name: f for f in modelo._meta.concrete_fields}
    campos.update({f.attname: f for f in modelo._meta.concrete_fields})
    return campos


def _exibir(campo, valor):
    """
    Valor como o usuário o vê no formulário: 'CONCLUIDA' -> 'Concluída'; instantes,
    que a trilha guarda em ISO/UTC, no fuso do projeto ('16/11/2026 21:35:20').
    """
    if valor is None or campo is None:
        return valor
    if isinstance(campo, models.DateTimeField) and isinstance(valor, str):
        try:
            instante = datetime.fromisoformat(valor)
        except ValueError:
            return valor
        if timezone.is_aware(instante):
            return timezone.localtime(instante).strftime('%d/%m/%Y %H:%M:%S')
        return valor
    if not campo.choices:
        return valor
    return dict(campo.flatchoices).get(valor, valor)


def campos_diff(entrada):
    """
    Lista de {campo, rotulo, anterior, posterior, anterior_exibido,
    posterior_exibido, mudou} para uma entrada da trilha — união das chaves
    dos dois estados, na ordem em que aparecem, sem as ocultas. `mudou`
    compara os valores serializados como estão no JSON (o que a trilha
    guarda); `rotulo` e `*_exibido` são só para a tela: o nome do campo e o
    valor na linguagem do formulário ("Situação: Concluída"), em vez do nome
    da coluna e do código guardado ("situacao: CONCLUIDA").
    """
    anterior = entrada.estado_anterior or {}
    posterior = entrada.estado_posterior or {}
    campos = _campos_do_modelo(entrada.tipo_objeto)
    chaves = list(anterior)
    chaves += [c for c in posterior if c not in anterior]
    itens = []
    for chave in chaves:
        if chave in CAMPOS_OCULTOS:
            continue
        campo = campos.get(chave)
        rotulo = str(campo.verbose_name) if campo is not None else chave
        itens.append({
            'campo': chave,
            'rotulo': rotulo[:1].upper() + rotulo[1:],
            'anterior': anterior.get(chave),
            'posterior': posterior.get(chave),
            'anterior_exibido': _exibir(campo, anterior.get(chave)),
            'posterior_exibido': _exibir(campo, posterior.get(chave)),
            'mudou': anterior.get(chave) != posterior.get(chave),
        })
    return itens
