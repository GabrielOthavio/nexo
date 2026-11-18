"""
Fuso horário. O banco guarda instantes em UTC e o servidor de produção roda
com o relógio em UTC; tudo que o usuário lê ou digita precisa passar por
America/Sao_Paulo (TIME_ZONE). Um `strftime`/`isoformat` direto num
DateTimeField, ou um `date.today()`, sai três horas adiantado — e, entre 21h
e meia-noite, no dia seguinte. Foi assim que a aba de histórico ao vivo
mostrou "17/11/2026 00:35:20" para uma exclusão feita às 21:35 de 16/11.

Os testes de relógio fixam `timezone.now` em 17/11/2026 02:30 UTC (16/11/2026
23:30 em Brasília), quando a data em UTC já é "amanhã": qualquer caminho que
ignore o fuso troca o dia. Os caminhos que não dependem de `now` recebem o
instante direto. Por fim, um teste estático varre o código-fonte do app, para
que um `date.today()` ou `campo.strftime(...)` novo falhe aqui antes de
chegar à tela.
"""
import re
from datetime import date, datetime, timezone as dt_timezone
from pathlib import Path
from unittest.mock import patch

from django.apps import apps
from django.db import models
from django.test import SimpleTestCase

from ..forms import AcaoForm, IndiceForm
from ..models import HistoricoAlteracoes, LogAcesso
from ..views.historico import campos_diff
from .test_api_historico import HistoricoBase

INSTANTE_UTC = datetime(2026, 11, 17, 2, 30, 0, tzinfo=dt_timezone.utc)
INSTANTE_LOCAL = '16/11/2026 23:30:00'
HOJE_LOCAL = date(2026, 11, 16)


def relogio_fixo():
    return INSTANTE_UTC


class ApiHistoricoFusoTest(HistoricoBase):

    def test_data_hora_da_api_vem_no_fuso_do_projeto(self):
        # Mesmo formato e mesma conversão da aba de histórico ({{ ...|date }}).
        self.editar(self.etapa, self.auditor, situacao='CONCLUIDA')
        entrada = next(r for r in self.historico(self.auditor) if r['uuid_objeto'] == str(self.etapa.id_unico))
        registro = HistoricoAlteracoes.objects.get(id_unico=entrada['id'])
        esperado = registro.data_hora_alteracao.astimezone(_tz()).strftime('%d/%m/%Y %H:%M:%S')
        self.assertEqual(entrada['data_hora'], esperado)
        self.assertNotEqual(entrada['data_hora'], registro.data_hora_alteracao.strftime('%d/%m/%Y %H:%M:%S'),
                            'a API devolveu o instante em UTC')


class RepresentacoesFusoTest(SimpleTestCase):

    def test_str_do_historico_usa_hora_local(self):
        h = HistoricoAlteracoes(tipo_objeto='Etapa', operacao='ATUALIZADO', data_hora_alteracao=INSTANTE_UTC)
        self.assertIn('16/11/2026 23:30', str(h))
        self.assertNotIn('17/11/2026', str(h))

    def test_str_do_log_de_acesso_usa_hora_local(self):
        log = LogAcesso(data_hora_acesso=INSTANTE_UTC, ip_acesso='127.0.0.1')
        self.assertIn(INSTANTE_LOCAL, str(log))
        self.assertNotIn('+00:00', str(log))

    def test_campos_da_trilha_exibem_instantes_no_fuso_do_projeto(self):
        # A trilha serializa DateTimeField em ISO/UTC; a tela converte.
        iso_utc = INSTANTE_UTC.isoformat()
        entrada = HistoricoAlteracoes(
            tipo_objeto='Etapa', operacao='ATUALIZADO',
            estado_anterior={'data_criacao': iso_utc, 'prazo': '2026-11-20', 'situacao': 'PENDENTE'},
            estado_posterior={'data_criacao': iso_utc, 'prazo': '2026-11-20', 'situacao': 'CONCLUIDA'},
        )
        por_campo = {c['campo']: c for c in campos_diff(entrada)}
        self.assertEqual(por_campo['data_criacao']['posterior_exibido'], INSTANTE_LOCAL)
        self.assertEqual(por_campo['data_criacao']['anterior'], iso_utc, 'o valor bruto da trilha não pode mudar')
        self.assertFalse(por_campo['data_criacao']['mudou'])
        self.assertEqual(por_campo['prazo']['posterior_exibido'], '2026-11-20', 'DateField não tem fuso: fica como está')
        self.assertEqual(por_campo['situacao']['posterior_exibido'], 'Concluída')


class FormulariosFusoTest(SimpleTestCase):

    def test_data_de_execucao_inicial_e_o_dia_local(self):
        with patch('django.utils.timezone.now', relogio_fixo):
            inicial = AcaoForm().fields['data_execucao'].initial
            self.assertEqual(inicial() if callable(inicial) else inicial, HOJE_LOCAL)

    def test_data_de_execucao_futura_e_hoje_sao_julgadas_pelo_dia_local(self):
        with patch('django.utils.timezone.now', relogio_fixo):
            amanha = AcaoForm(data={'data_execucao': '2026-11-17'})
            amanha.is_valid()
            self.assertIn('data_execucao', amanha.errors, 'o dia seguinte em UTC passou como "hoje"')
            hoje = AcaoForm(data={'data_execucao': '2026-11-16'})
            hoje.is_valid()
            self.assertNotIn('data_execucao', hoje.errors)

    def test_limite_do_ano_do_indice_usa_o_ano_local(self):
        with patch('django.utils.timezone.now', relogio_fixo):
            form = IndiceForm(data={'ano': 2032, 'mes': 1})
            form.is_valid()
            self.assertIn('ano', form.errors)
            form = IndiceForm(data={'ano': 2031, 'mes': 1})
            form.is_valid()
            self.assertNotIn('ano', form.errors)


class GuardaEstaticaFusoTest(SimpleTestCase):
    """
    Varre o código do app (fora de tests/ e migrations/) atrás dos padrões
    que produziram o bug. Falhar aqui é o objetivo: aponta o arquivo e a linha.
    """

    RAIZ = Path(__file__).resolve().parent.parent
    IGNORAR = ('tests', 'migrations', '__pycache__')
    RELOGIO_DO_SISTEMA = re.compile(r'\b(date\.today|datetime\.now|datetime\.utcnow|utcnow)\(')

    def arquivos(self):
        for p in sorted(self.RAIZ.rglob('*.py')):
            if not any(parte in self.IGNORAR for parte in p.relative_to(self.RAIZ).parts):
                yield p

    def campos_de_instante(self):
        return sorted({
            f.name
            for m in apps.get_app_config('Auth').get_models()
            for f in m._meta.fields
            if isinstance(f, models.DateTimeField)
        })

    def test_nenhum_uso_do_relogio_do_sistema(self):
        # date.today() e datetime.now() usam o fuso da máquina (UTC na VM);
        # o certo é timezone.localdate() / timezone.now().
        achados = []
        for p in self.arquivos():
            for n, linha in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
                if self.RELOGIO_DO_SISTEMA.search(linha) and not linha.lstrip().startswith('#'):
                    achados.append(f'{p.relative_to(self.RAIZ)}:{n}: {linha.strip()}')
        self.assertEqual(achados, [], 'use timezone.localdate()/timezone.now():\n' + '\n'.join(achados))

    def test_nenhum_instante_formatado_sem_localtime(self):
        campos = self.campos_de_instante()
        self.assertIn('data_hora_alteracao', campos)
        nomes = '|'.join(map(re.escape, campos))
        formatado = re.compile(r'\.(%s)\.(strftime|isoformat|strftime)\(' % nomes)
        interpolado = re.compile(r'\{[\w.]*\.(%s)\}' % nomes)
        achados = []
        for p in self.arquivos():
            for n, linha in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
                if linha.lstrip().startswith('#'):
                    continue
                if (formatado.search(linha) or interpolado.search(linha)) and 'localtime(' not in linha:
                    achados.append(f'{p.relative_to(self.RAIZ)}:{n}: {linha.strip()}')
        self.assertEqual(achados, [], 'converta com timezone.localtime(...) antes de formatar:\n' + '\n'.join(achados))


def _tz():
    from django.utils import timezone
    return timezone.get_current_timezone()
