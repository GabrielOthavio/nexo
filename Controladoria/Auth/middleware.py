import threading
from contextlib import contextmanager

from django.http import HttpResponseBadRequest

_thread_local = threading.local()


def get_current_user():
    return getattr(_thread_local, 'user', None)


@contextmanager
def set_current_user(usuario):
    """
    Usado pelas views internas chamadas pelo sync-backend (NestJS), fora do
    ciclo normal de request/CurrentUserMiddleware: impersona o auditor real
    durante a criação de um Achado via API interna, para que os signals de
    Audit by Design (HistoricoAlteracoes) atribuam a alteração a ele — e não
    a None/"Sistema".
    """
    anterior = getattr(_thread_local, 'user', None)
    _thread_local.user = usuario
    try:
        yield
    finally:
        _thread_local.user = anterior


class CurrentUserMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        _thread_local.user = getattr(request, 'user', None)
        try:
            response = self.get_response(request)
        finally:
            _thread_local.user = None
        return response


class RejeitaByteNuloMiddleware:
    """
    Recusa requisições com byte nulo em parâmetro de query ou de formulário.

    O PostgreSQL não aceita NUL dentro de uma string: o psycopg2 levanta
    `ValueError: A string literal cannot contain NUL (0x00) characters` ao
    montar o SQL. Como a busca das listagens joga o `?q=` direto num
    `icontains`, um `?q=%00` derrubava com HTTP 500 TODAS as telas com busca
    (ações, auditorias, usuários, índices, matrizes, entidades).

    Não aparecia antes porque o SQLite aceita NUL em string — é um defeito
    que só a migração para PostgreSQL expôs.

    Byte nulo nunca é entrada legítima aqui, então 400 é a resposta correta:
    o cliente mandou algo malformado. Preferido a limpar em silêncio, que
    esconderia de quem depura o que de fato foi enviado.
    """

    NULO = chr(0)

    def __init__(self, get_response):
        self.get_response = get_response

    @classmethod
    def _tem_nulo(cls, query_dict):
        return any(cls.NULO in v for vs in query_dict.lists() for v in vs)

    def __call__(self, request):
        if self._tem_nulo(request.GET) or (request.method == 'POST' and self._tem_nulo(request.POST)):
            return HttpResponseBadRequest('Parâmetro inválido.')
        return self.get_response(request)
