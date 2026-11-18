from datetime import date

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone

from ..decorators import requer_permissao
from ..middleware import set_current_user
from ..models import ConflitoEtapa
from .api_mobile_views import _campos_etapa_para_comparacao

_CAMPOS_ETAPA = ['orientacao', 'documentos', 'atividade', 'prazo', 'situacao', 'metodo']


@login_required(login_url='Auth:login')
@requer_permissao('auditorias', 'ver')
def listar_conflitos(request):
    """
    Conflitos atribuídos ao usuário logado (ver determinar_resolvedor em
    api_mobile_views.py). Usuários com permissão de exclusão em auditorias
    também veem os conflitos sem atribuição automática (empate na hierarquia
    sem ninguém elegível pra escalar) — precisam de intervenção manual.
    """
    atribuidos = ConflitoEtapa.objects.filter(
        atribuido_a=request.user, status='PENDENTE',
    ).select_related('etapa', 'etapa__auditoria', 'usuario_originador', 'usuario_atual')

    sem_atribuicao = ConflitoEtapa.objects.none()
    if request.user.tem_permissao('auditorias', 'excluir'):
        sem_atribuicao = ConflitoEtapa.objects.filter(
            atribuido_a__isnull=True, status='PENDENTE',
        ).select_related('etapa', 'etapa__auditoria', 'usuario_originador', 'usuario_atual')

    return render(request, 'conflitos/lista.html', {
        'conflitos_atribuidos': atribuidos,
        'conflitos_sem_atribuicao': sem_atribuicao,
    })


@login_required(login_url='Auth:login')
@requer_permissao('auditorias', 'editar')
def resolver_conflito(request, id_unico):
    conflito = get_object_or_404(ConflitoEtapa, id_unico=id_unico, status='PENDENTE')

    pode_resolver = (
        conflito.atribuido_a_id == request.user.pk
        or (conflito.atribuido_a_id is None and request.user.tem_permissao('auditorias', 'excluir'))
    )
    if not pode_resolver:
        messages.error(request, 'Você não tem permissão para resolver este conflito.')
        return redirect('Auth:listar_conflitos')

    if request.method == 'POST':
        escolha = request.POST.get('escolha')
        if escolha not in ('originador', 'atual'):
            messages.error(request, 'Escolha inválida.')
            return redirect('Auth:resolver_conflito', id_unico=id_unico)

        etapa = conflito.etapa

        # conflito.dados_atuais é um retrato congelado no instante em que o
        # conflito foi registrado, mas a resolução é manual e pode acontecer
        # bem depois. Se a Etapa mudou nesse meio-tempo (edição pelo site,
        # outro conflito resolvido antes deste), aplicar qualquer uma das duas
        # versões apagaria essa mudança em silêncio — exatamente o que a
        # checagem de baseline evita em todos os outros caminhos de escrita.
        if _campos_etapa_para_comparacao(etapa) != conflito.dados_atuais:
            messages.error(
                request,
                'A etapa foi alterada depois que este conflito foi registrado. '
                'O conflito precisa ser reavaliado antes de ser resolvido.',
            )
            return redirect('Auth:listar_conflitos')

        # Aplica as duas versões em sequência — primeiro a perdedora, depois
        # a vencedora — pra trilha de auditoria mostrar as duas tentativas
        # de alteração, não uma sumindo silenciosamente. A ordem entre as
        # duas saves é o único efeito colateral novo aqui; o signal de
        # auditoria em si não muda.
        if escolha == 'originador':
            perdedora, vencedora = conflito.dados_atuais, conflito.dados_originador
            autor_perdedora, autor_vencedora = conflito.usuario_atual, conflito.usuario_originador
        else:
            perdedora, vencedora = conflito.dados_originador, conflito.dados_atuais
            autor_perdedora, autor_vencedora = conflito.usuario_originador, conflito.usuario_atual

        # As duas saves + a baixa do conflito são uma unidade atômica. Sem
        # isso, uma falha entre a primeira e a segunda save (por exemplo um
        # DataError vindo do banco) deixaria a Etapa com a versão PERDEDORA
        # gravada e o conflito ainda PENDENTE — e, como o estado da Etapa não
        # bateria mais com o retrato congelado em dados_atuais, a checagem de
        # baseline acima bloquearia qualquer nova tentativa de resolução para
        # sempre, com o dado errado persistido.
        with transaction.atomic():
            for dados, autor in ((perdedora, autor_perdedora), (vencedora, autor_vencedora)):
                with set_current_user(autor or request.user):
                    for campo in _CAMPOS_ETAPA:
                        valor = dados[campo]
                        if campo == 'prazo' and valor:
                            valor = date.fromisoformat(valor)
                        setattr(etapa, campo, valor)
                    etapa.save()

            conflito.status = 'RESOLVIDO'
            conflito.resolvido_por = request.user
            conflito.resolvido_em = timezone.now()
            conflito.save(update_fields=['status', 'resolvido_por', 'resolvido_em'])

        messages.success(request, 'Conflito resolvido.')
        return redirect('Auth:listar_conflitos')

    return render(request, 'conflitos/resolver.html', {'conflito': conflito})
