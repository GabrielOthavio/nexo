from django.http import JsonResponse, HttpResponseForbidden, HttpResponseBadRequest
from django.contrib.auth.decorators import login_required
from django.views.decorators.http import require_GET
from django.core.exceptions import ValidationError
from django.db.models import Count, Max, Q
from django.utils import timezone


@login_required(login_url='Auth:login')
@require_GET
def api_dashboard(request):
    from ..models import Auditoria, Acao, Indice, Usuario
    status_counts = (
        Auditoria.objects
        .values('status')
        .annotate(total=Count('status'))
        .order_by('status')
    )
    return JsonResponse({
        'total_acoes':      Acao.objects.count(),
        'total_auditorias': Auditoria.objects.count(),
        'total_indices':    Indice.objects.count(),
        'total_usuarios':   Usuario.objects.count(),
        'auditorias_por_status': list(status_counts),
    })


@login_required(login_url='Auth:login')
@require_GET
def api_historico(request):
    """
    Trilha de auditoria para o card do dashboard. Quem vê o quê é decidido
    em views/historico.py::historico_visivel — chefia vê tudo, auditor vê as
    auditorias em que está envolvido. Antes o endpoint exigia `usuarios.ver`
    e devolvia 403 ao resto, o que derrubava o dashboard inteiro para quem
    não era chefia (o SPA carrega dashboard e histórico num Promise.all) e
    escondia do auditor o rastro da própria alteração.

    `?objeto=<uuid>` restringe a um registro; `?limit=` até 100.
    """
    from .historico import descricao_do_estado, historico_visivel

    qs = historico_visivel(request.user)
    if qs is None:
        return HttpResponseForbidden()

    objeto = request.GET.get('objeto')
    if objeto:
        try:
            qs = qs.filter(uuid_objeto=objeto)
        except (ValueError, ValidationError):
            return HttpResponseBadRequest('objeto deve ser um UUID')

    try:
        limit = max(1, min(int(request.GET.get('limit', 20)), 100))
    except (ValueError, TypeError):
        limit = 20
    qs = qs.order_by('-data_hora_alteracao')[:limit]
    results = [
        {
            'id':               str(h.id_unico),
            'usuario':          (h.usuario.get_full_name() or h.usuario.username) if h.usuario else 'Sistema',
            'tipo_objeto':      h.tipo_objeto,
            'operacao':         h.operacao,
            'uuid_objeto':      str(h.uuid_objeto) if h.uuid_objeto else None,
            'descricao':        descricao_do_estado(h.tipo_objeto, h.estado_posterior, h.estado_anterior),
            'data_hora':        timezone.localtime(h.data_hora_alteracao).strftime('%d/%m/%Y %H:%M:%S'),
            'estado_anterior':  h.estado_anterior,
            'estado_posterior': h.estado_posterior,
        }
        for h in qs
    ]
    return JsonResponse({'results': results})


@login_required(login_url='Auth:login')
@require_GET
def api_auditorias(request):
    from ..models import Auditoria
    qs = Auditoria.objects.all().order_by('-data_criacao')[:50]
    results = [
        {
            'id':            str(a.id_unico),
            'nome':          a.nome_auditoria,
            'status':        a.status,
            'data_inicio':   a.data_inicio.strftime('%d/%m/%Y') if a.data_inicio else None,
            'data_conclusao': a.data_conclusao.strftime('%d/%m/%Y') if a.data_conclusao else None,
            'apuracao_inicial': str(a.apuracao_inicial) if a.apuracao_inicial is not None else None,
            'apuracao_final':   str(a.apuracao_final)   if a.apuracao_final   is not None else None,
            'resultado_calculado': str(a.resultado_calculado) if a.resultado_calculado is not None else None,
        }
        for a in qs
    ]
    return JsonResponse({'results': results})


@login_required(login_url='Auth:login')
@require_GET
def api_acoes(request):
    from ..models import Acao
    qs = Acao.objects.select_related('tipo_acao', 'usuario').order_by('-data_execucao')[:50]
    results = [
        {
            'id':            str(a.id_unico),
            'identificacao': a.identificacao_semantica,
            'tipo_acao':     a.tipo_acao.nome_acao,
            'usuario':       a.usuario.get_full_name() or a.usuario.username,
            'data_execucao': a.data_execucao.strftime('%d/%m/%Y'),
        }
        for a in qs
    ]
    return JsonResponse({'results': results})


def _versao_conflitos(usuario):
    """
    Mesma visibilidade de conflitos_views.listar_conflitos: os atribuídos a
    mim, mais os sem atribuição automática se eu puder excluir auditorias.
    """
    from ..models import ConflitoEtapa

    visiveis = ConflitoEtapa.objects.filter(status='PENDENTE', atribuido_a=usuario)
    if usuario.tem_permissao('auditorias', 'excluir'):
        visiveis = ConflitoEtapa.objects.filter(status='PENDENTE').filter(
            Q(atribuido_a=usuario) | Q(atribuido_a__isnull=True)
        )

    agg = visiveis.aggregate(n=Count('id'), ultimo=Max('criado_em'))
    return f"{agg['n']}:{agg['ultimo'].isoformat() if agg['ultimo'] else '-'}", agg['n']


def _versao_auditoria(auditoria):
    """
    Carimbo das Etapas/Achados de uma auditoria. Criação e exclusão aparecem
    nas contagens; EDIÇÃO de Etapa não muda contagem nem `data_criacao`, então
    entra por `HistoricoAlteracoes` — a trilha de auditoria já é escrita pelos
    signals em toda escrita, inclusive as que vêm do app de campo, e serve
    aqui como feed de mudanças sem precisar de coluna nova.
    """
    from ..models import Achado, HistoricoAlteracoes

    agg_etapas = auditoria.etapas_list.aggregate(n=Count('id'), ultimo=Max('data_criacao'))
    n_achados = Achado.objects.filter(etapa__auditoria=auditoria).count()

    etapa_uuids = list(auditoria.etapas_list.values_list('id_unico', flat=True))
    ultima_alt = None
    if etapa_uuids:
        ultima_alt = HistoricoAlteracoes.objects.filter(
            tipo_objeto='Etapa', uuid_objeto__in=etapa_uuids,
        ).aggregate(m=Max('data_hora_alteracao'))['m']

    partes = [
        str(agg_etapas['n']),
        agg_etapas['ultimo'].isoformat() if agg_etapas['ultimo'] else '-',
        str(n_achados),
        ultima_alt.isoformat() if ultima_alt else '-',
    ]
    return ':'.join(partes), agg_etapas['n'] + n_achados


@login_required(login_url='Auth:login')
@require_GET
def api_atualizacoes(request):
    """
    Carimbo barato do estado de uma tela — alimenta o aviso "chegou dado novo
    do campo" (ver Auth/static/Auth/js/atualizacoes.js).

    Devolve SÓ uma string de versão e uma contagem: o cliente compara com a
    que recebeu antes e, se mudou, mostra uma faixa oferecendo atualizar. A
    tela nunca é redesenhada por baixo do usuário — o redesenho é um reload
    normal, disparado por clique, que volta a passar pelas views de sempre
    (e pelo RBAC delas). Por isso este endpoint não serializa conteúdo algum:
    nada aqui pode vazar um dado que a view da página não mostraria.
    """
    from ..models import Auditoria

    escopo = request.GET.get('escopo')

    if escopo == 'conflitos':
        if not request.user.tem_permissao('auditorias', 'ver'):
            return HttpResponseForbidden()
        versao, itens = _versao_conflitos(request.user)
        return JsonResponse({'versao': versao, 'itens': itens})

    if escopo == 'auditoria':
        if not request.user.tem_permissao('auditorias', 'ver'):
            return HttpResponseForbidden()
        try:
            auditoria = Auditoria.objects.get(id_unico=request.GET.get('id'))
        except (Auditoria.DoesNotExist, ValueError, ValidationError):
            return JsonResponse({'detail': 'Auditoria não encontrada.'}, status=404)
        versao, itens = _versao_auditoria(auditoria)
        return JsonResponse({'versao': versao, 'itens': itens})

    return HttpResponseBadRequest('escopo inválido')
