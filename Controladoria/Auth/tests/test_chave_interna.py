"""
`requer_chave_interna` — o único portão entre a internet e a API interna do
mobile. Um erro aqui vira "qualquer um cria Achado em nome de qualquer
auditor", então cada ramo do decorator ganha um teste.
"""
from django.test import override_settings

from .base import BaseMobileApiTest, CHAVE_INTERNA_TESTE


class ChaveInternaTest(BaseMobileApiTest):

    def test_sem_header_e_403(self):
        resp = self.client.get(self.url_auditorias(), {'usuario_uuid': str(self.auditor.id_unico)})
        self.assertEqual(resp.status_code, 403)
        self.assertIn('Chave interna', resp.json()['detail'])

    def test_chave_errada_e_403(self):
        resp = self.client.get(
            self.url_auditorias(), {'usuario_uuid': str(self.auditor.id_unico)},
            HTTP_X_INTERNAL_API_KEY='outra-chave',
        )
        self.assertEqual(resp.status_code, 403)

    def test_chave_vazia_e_403(self):
        resp = self.client.get(self.url_auditorias(), HTTP_X_INTERNAL_API_KEY='')
        self.assertEqual(resp.status_code, 403)

    def test_chave_certa_passa_pelo_decorator(self):
        resp = self.api_get(self.url_auditorias(), self.auditor)
        self.assertEqual(resp.status_code, 200)

    def test_prefixo_da_chave_nao_basta(self):
        # compare_digest compara comprimento também — um prefixo correto não
        # pode ser aceito nem "quase" aceito.
        resp = self.client.get(self.url_auditorias(), HTTP_X_INTERNAL_API_KEY=CHAVE_INTERNA_TESTE[:-1])
        self.assertEqual(resp.status_code, 403)

    def test_header_nao_ascii_vira_403_e_nao_500(self):
        # O WSGI entrega o header decodificado em latin-1; se o decorator
        # comparasse str com compare_digest, um byte > 127 levantaria
        # TypeError e viraria 500. Tem que ser 403 limpo.
        resp = self.client.get(self.url_auditorias(), HTTP_X_INTERNAL_API_KEY='chavé-com-acento')
        self.assertEqual(resp.status_code, 403)

    @override_settings(MOBILE_SYNC_ALLOWED_IPS=['10.0.0.5'])
    def test_allowlist_bloqueia_ip_fora_da_lista(self):
        # O test client vem de 127.0.0.1 por padrão.
        resp = self.api_get(self.url_auditorias(), self.auditor)
        self.assertEqual(resp.status_code, 403)
        self.assertIn('Origem', resp.json()['detail'])

    @override_settings(MOBILE_SYNC_ALLOWED_IPS=['10.0.0.5'])
    def test_allowlist_aceita_ip_da_lista(self):
        resp = self.client.get(
            self.url_auditorias(), {'usuario_uuid': str(self.auditor.id_unico)},
            HTTP_X_INTERNAL_API_KEY=CHAVE_INTERNA_TESTE, REMOTE_ADDR='10.0.0.5',
        )
        self.assertEqual(resp.status_code, 200)

    @override_settings(MOBILE_SYNC_ALLOWED_IPS=['10.0.0.5'])
    def test_chave_e_verificada_antes_do_ip(self):
        # Chave errada de um IP permitido continua 403 por chave — o IP não
        # substitui o segredo, só soma a ele.
        resp = self.client.get(
            self.url_auditorias(), HTTP_X_INTERNAL_API_KEY='errada', REMOTE_ADDR='10.0.0.5',
        )
        self.assertEqual(resp.status_code, 403)
        self.assertIn('Chave interna', resp.json()['detail'])

    def test_sessao_de_browser_nao_substitui_a_chave(self):
        # Mesmo logado no site como superusuário, a API interna exige a chave:
        # ela nunca deve ser alcançável por uma sessão de navegador.
        self.chefe.is_superuser = True
        self.chefe.save()
        self.client.force_login(self.chefe)
        resp = self.client.get(self.url_auditorias(), {'usuario_uuid': str(self.auditor.id_unico)})
        self.assertEqual(resp.status_code, 403)
