"""
Verifica o encadeamento da trilha central (HistoricoAlteracoes).

    python manage.py verificar_trilha
    python manage.py verificar_trilha --esperado <hash registrado antes>

A cadeia detecta, sozinha, qualquer entrada alterada, removida, inserida ou
reordenada sem recálculo dos hashes seguintes. Quem tem acesso direto ao banco
e recalcula a cadeia inteira produz uma cadeia de novo consistente; isso só é
detectável comparando o último hash com um valor registrado FORA do banco (no
relatório de auditoria, por exemplo). Por isso o comando imprime o último hash
e aceita `--esperado` para conferir um valor anotado anteriormente: se a trilha
legítima só cresce por acréscimo, o hash anotado tem de continuar aparecendo
como `hash_atual` de alguma entrada.
"""
from django.core.management.base import BaseCommand, CommandError

from Auth.models import HistoricoAlteracoes


class Command(BaseCommand):
    help = 'Verifica o encadeamento de hashes da trilha de auditoria central.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--esperado', metavar='HASH',
            help='Hash anotado anteriormente; precisa continuar presente na cadeia.',
        )

    def handle(self, *args, **options):
        ok, total, ultimo, quebrada = HistoricoAlteracoes.verificar_cadeia()
        if not ok:
            raise CommandError(
                f'Cadeia QUEBRADA na entrada id={quebrada} (posição {total}). '
                'Entrada alterada, removida ou inserida fora da aplicação.'
            )
        self.stdout.write(self.style.SUCCESS(f'Cadeia íntegra: {total} entradas.'))
        self.stdout.write(f'Último hash: {ultimo}')

        esperado = options.get('esperado')
        if esperado and not HistoricoAlteracoes.objects.filter(hash_atual=esperado).exists():
            raise CommandError(
                'O hash anotado não está mais na cadeia: a trilha foi recalculada '
                'depois do registro desse valor.'
            )
        if esperado:
            self.stdout.write(self.style.SUCCESS('Hash anotado presente na cadeia.'))
