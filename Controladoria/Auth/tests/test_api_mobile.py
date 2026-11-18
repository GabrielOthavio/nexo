"""
API interna consumida pelo sync-backend (Auth/views/api_mobile_views.py).

Cada endpoint é testado nos três eixos de autorização (perfil, envolvimento
na auditoria, status da auditoria) e nas garantias que o protocolo de sync
depende: idempotência por origem_mobile_uuid, detecção de conflito por
baseline, e trilha de auditoria com o autor certo e o campo cifrado redigido.
"""
import uuid
from datetime import date, timedelta

from ..models import Achado, ConflitoEtapa, Etapa, HistoricoAlteracoes
from .base import BaseMobileApiTest, campos_etapa


# ===========================================================================
# Listagens
# ===========================================================================

class ListarAuditoriasTest(BaseMobileApiTest):

    def test_lista_so_auditorias_abertas_em_que_esta_envolvido(self):
        resp = self.api_get(self.url_auditorias(), self.auditor)
        self.assertEqual(resp.status_code, 200)
        nomes = sorted(a['nome_auditoria'] for a in resp.json()['results'])
        # auditor está nas três, mas "Fechada" é CONCLUIDA e fica de fora
        self.assertEqual(nomes, ['Aberta', 'Planejada'])

    def test_nao_envolvido_ve_lista_vazia(self):
        resp = self.api_get(self.url_auditorias(), self.fora)
        self.assertEqual(resp.json()['results'], [])

    def test_serializa_os_campos_esperados_pelo_app(self):
        resp = self.api_get(self.url_auditorias(), self.leitor)
        item = resp.json()['results'][0]
        self.assertEqual(set(item), {'id_unico', 'nome_auditoria', 'orgao', 'status'})

    def test_sem_permissao_de_ver_e_403(self):
        sem_ver = self.leitor
        sem_ver.perfil.permissoes.filter(tela='auditorias').update(pode_ver=False)
        resp = self.api_get(self.url_auditorias(), sem_ver)
        self.assertEqual(resp.status_code, 403)

    def test_usuario_uuid_ausente_e_400(self):
        resp = self.api_get(self.url_auditorias())
        self.assertEqual(resp.status_code, 400)

    def test_usuario_inexistente_e_404(self):
        resp = self.api_get(self.url_auditorias(), usuario_uuid=str(uuid.uuid4()))
        self.assertEqual(resp.status_code, 404)

    def test_usuario_uuid_malformado_e_404_nao_500(self):
        resp = self.api_get(self.url_auditorias(), usuario_uuid='isso-nao-e-uuid')
        self.assertEqual(resp.status_code, 404)

    def test_usuario_desativado_e_tratado_como_inexistente(self):
        # O sync-backend tem cópia própria de `ativo` que não sincroniza com
        # is_active — este é o ponto que fecha a porta de verdade.
        self.auditor.is_active = False
        self.auditor.save()
        resp = self.api_get(self.url_auditorias(), self.auditor)
        self.assertEqual(resp.status_code, 404)


class ListarEtapasTest(BaseMobileApiTest):

    def test_lista_etapas_da_auditoria(self):
        resp = self.api_get(self.url_etapas(self.aberta), self.auditor)
        self.assertEqual(resp.status_code, 200)
        etapas = resp.json()['results']
        self.assertEqual([e['atividade'] for e in etapas], ['Etapa da aberta'])
        self.assertEqual(
            set(etapas[0]),
            {'id_unico', 'orientacao', 'documentos', 'atividade', 'prazo', 'situacao', 'metodo'},
        )

    def test_prazo_vai_em_iso(self):
        resp = self.api_get(self.url_etapas(self.aberta), self.auditor)
        self.assertEqual(resp.json()['results'][0]['prazo'], self.etapa.prazo.isoformat())

    def test_nao_envolvido_e_403(self):
        resp = self.api_get(self.url_etapas(self.aberta), self.fora)
        self.assertEqual(resp.status_code, 403)

    def test_chefe_sem_envolvimento_tambem_e_403(self):
        # Permissão total no perfil não substitui estar na equipe da auditoria.
        resp = self.api_get(self.url_etapas(self.aberta), self.chefe)
        self.assertEqual(resp.status_code, 403)

    def test_auditoria_inexistente_e_404(self):
        url = self.url_etapas(self.aberta).replace(str(self.aberta.id_unico), str(uuid.uuid4()))
        resp = self.api_get(url, self.auditor)
        self.assertEqual(resp.status_code, 404)


# ===========================================================================
# Achado
# ===========================================================================

class CriarAchadoTest(BaseMobileApiTest):

    def test_cria_achado_e_devolve_id_e_data(self):
        resp = self.api_post(self.url_criar_achado(), self.body_achado())
        self.assertEqual(resp.status_code, 200)
        dados = resp.json()
        achado = Achado.objects.get(id_unico=dados['id_unico'])
        self.assertEqual(achado.etapa, self.etapa)
        self.assertEqual(achado.usuario, self.auditor)
        self.assertEqual(achado.descricao, 'Achado de teste')  # decifra pelo ORM
        self.assertEqual(dados['data_achado'], achado.data_achado.isoformat())

    def test_idempotente_por_origem_mobile_uuid(self):
        body = self.body_achado()
        r1 = self.api_post(self.url_criar_achado(), body)
        r2 = self.api_post(self.url_criar_achado(), body)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r1.json()['id_unico'], r2.json()['id_unico'])
        self.assertEqual(Achado.objects.filter(origem_mobile_uuid=body['origem_mobile_uuid']).count(), 1)

    def test_retry_com_descricao_diferente_nao_sobrescreve_o_original(self):
        # get_or_create: o segundo envio com o mesmo uuid é ignorado — a
        # primeira versão confirmada é a que vale.
        body = self.body_achado(descricao='primeira')
        self.api_post(self.url_criar_achado(), body)
        self.api_post(self.url_criar_achado(), {**body, 'descricao': 'segunda'})
        self.assertEqual(Achado.objects.get(origem_mobile_uuid=body['origem_mobile_uuid']).descricao, 'primeira')

    def test_perfil_sem_editar_e_403(self):
        resp = self.api_post(self.url_criar_achado(), self.body_achado(usuario=self.leitor))
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(Achado.objects.count(), 0)

    def test_nao_envolvido_na_auditoria_e_403(self):
        resp = self.api_post(self.url_criar_achado(), self.body_achado(usuario=self.fora))
        self.assertEqual(resp.status_code, 403)

    def test_auditoria_fechada_e_409_auditoria_fechada(self):
        resp = self.api_post(self.url_criar_achado(), self.body_achado(etapa=self.etapa_fechada))
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['detail'], 'auditoria_fechada')

    def test_etapa_inexistente_e_404(self):
        resp = self.api_post(self.url_criar_achado(), self.body_achado(etapa_uuid=str(uuid.uuid4())))
        self.assertEqual(resp.status_code, 404)

    def test_campo_obrigatorio_ausente_e_400(self):
        for campo in ('usuario_uuid', 'etapa_uuid', 'descricao', 'origem_mobile_uuid'):
            body = self.body_achado()
            del body[campo]
            resp = self.api_post(self.url_criar_achado(), body)
            self.assertEqual(resp.status_code, 400, campo)

    def test_origem_mobile_uuid_malformado_e_400_nao_500(self):
        resp = self.api_post(self.url_criar_achado(), self.body_achado(origem_mobile_uuid='xyz'))
        self.assertEqual(resp.status_code, 400)

    def test_corpo_nao_json_e_400(self):
        resp = self.client.post(
            self.url_criar_achado(), 'isto nao e json', content_type='application/json',
            HTTP_X_INTERNAL_API_KEY='chave-interna-de-teste',
        )
        self.assertEqual(resp.status_code, 400)

    def test_get_nao_e_aceito(self):
        resp = self.api_get(self.url_criar_achado(), self.auditor)
        self.assertEqual(resp.status_code, 405)

    def test_audit_by_design_autor_impersonado_e_descricao_redigida(self):
        antes = HistoricoAlteracoes.objects.filter(tipo_objeto='Achado').count()
        resp = self.api_post(self.url_criar_achado(), self.body_achado(descricao='segredo em texto plano'))

        historico = HistoricoAlteracoes.objects.filter(tipo_objeto='Achado').order_by('-id')
        self.assertEqual(historico.count(), antes + 1)
        h = historico.first()
        self.assertEqual(h.operacao, 'CRIADO')
        self.assertEqual(str(h.uuid_objeto), resp.json()['id_unico'])
        # set_current_user impersona o auditor de campo, não fica None/"Sistema"
        self.assertEqual(h.usuario, self.auditor)
        # o campo cifrado não pode vazar em texto plano na trilha
        self.assertEqual(h.estado_posterior['descricao'], '[PROTEGIDO]')
        self.assertNotIn('segredo', str(h.estado_posterior))

    def test_retry_idempotente_nao_gera_segunda_linha_de_historico(self):
        body = self.body_achado()
        self.api_post(self.url_criar_achado(), body)
        antes = HistoricoAlteracoes.objects.filter(tipo_objeto='Achado').count()
        self.api_post(self.url_criar_achado(), body)
        self.assertEqual(HistoricoAlteracoes.objects.filter(tipo_objeto='Achado').count(), antes)


# ===========================================================================
# Etapa — criar
# ===========================================================================

class CriarEtapaTest(BaseMobileApiTest):

    def test_cria_etapa_com_o_auditor_como_responsavel(self):
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar())
        self.assertEqual(resp.status_code, 200)
        etapa = Etapa.objects.get(id_unico=resp.json()['id_unico'])
        self.assertEqual(etapa.auditoria, self.aberta)
        self.assertEqual(etapa.usuario, self.auditor)
        self.assertEqual(etapa.situacao, 'PENDENTE')  # default quando não vem
        self.assertEqual(etapa.documentos, '')

    def test_resposta_tem_o_mesmo_formato_da_listagem(self):
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar())
        self.assertEqual(
            set(resp.json()),
            {'id_unico', 'orientacao', 'documentos', 'atividade', 'prazo', 'situacao', 'metodo'},
        )

    def test_idempotente_por_origem_mobile_uuid(self):
        body = self.body_etapa_criar()
        r1 = self.api_post(self.url_criar_etapa(), body)
        r2 = self.api_post(self.url_criar_etapa(), body)
        self.assertEqual(r1.json()['id_unico'], r2.json()['id_unico'])
        self.assertEqual(Etapa.objects.filter(origem_mobile_uuid=body['origem_mobile_uuid']).count(), 1)

    def test_campos_opcionais_sao_respeitados(self):
        body = self.body_etapa_criar(documentos='Doc X', situacao='EM_ANDAMENTO', metodo='Amostragem')
        etapa = Etapa.objects.get(id_unico=self.api_post(self.url_criar_etapa(), body).json()['id_unico'])
        self.assertEqual((etapa.documentos, etapa.situacao, etapa.metodo), ('Doc X', 'EM_ANDAMENTO', 'Amostragem'))

    def test_prazo_invalido_e_400(self):
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar(prazo='31/12/2026'))
        self.assertEqual(resp.status_code, 400)
        self.assertIn('prazo', resp.json()['detail'])

    def test_campo_obrigatorio_ausente_e_400(self):
        for campo in ('usuario_uuid', 'auditoria_uuid', 'origem_mobile_uuid', 'orientacao', 'atividade', 'prazo'):
            body = self.body_etapa_criar()
            del body[campo]
            self.assertEqual(self.api_post(self.url_criar_etapa(), body).status_code, 400, campo)

    def test_situacao_fora_das_choices_e_400_nao_500(self):
        # Sem full_clean isso só estouraria no banco como DataError → 500.
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar(situacao='INVENTADA'))
        self.assertEqual(resp.status_code, 400)
        self.assertIn('situacao', resp.json()['detail'])
        self.assertEqual(Etapa.objects.filter(auditoria=self.aberta).count(), 1)  # só a do setUp

    def test_atividade_acima_do_max_length_e_400(self):
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar(atividade='x' * 501))
        self.assertEqual(resp.status_code, 400)
        self.assertIn('atividade', resp.json()['detail'])

    def test_validacao_nao_deixa_rastro_quando_falha(self):
        # A instância descartável de validação não pode disparar signal.
        antes = HistoricoAlteracoes.objects.filter(tipo_objeto='Etapa').count()
        self.api_post(self.url_criar_etapa(), self.body_etapa_criar(situacao='INVENTADA'))
        self.assertEqual(HistoricoAlteracoes.objects.filter(tipo_objeto='Etapa').count(), antes)

    def test_perfil_sem_editar_e_403(self):
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar(usuario=self.leitor))
        self.assertEqual(resp.status_code, 403)

    def test_nao_envolvido_e_403(self):
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar(usuario=self.fora))
        self.assertEqual(resp.status_code, 403)

    def test_auditoria_fechada_e_409(self):
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar(auditoria=self.fechada))
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['detail'], 'auditoria_fechada')

    def test_auditoria_inexistente_e_404(self):
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar(auditoria_uuid=str(uuid.uuid4())))
        self.assertEqual(resp.status_code, 404)

    def test_historico_registra_autor_impersonado(self):
        resp = self.api_post(self.url_criar_etapa(), self.body_etapa_criar())
        h = HistoricoAlteracoes.objects.filter(tipo_objeto='Etapa', uuid_objeto=resp.json()['id_unico']).get()
        self.assertEqual(h.operacao, 'CRIADO')
        self.assertEqual(h.usuario, self.auditor)


# ===========================================================================
# Etapa — editar (com detecção de conflito por baseline)
# ===========================================================================

class EditarEtapaTest(BaseMobileApiTest):

    def test_baseline_correto_aplica_replace_completo(self):
        resp = self.api_post(
            self.url_editar_etapa(self.etapa),
            self.body_etapa_editar(situacao='CONCLUIDA', metodo='Novo método'),
        )
        self.assertEqual(resp.status_code, 200)
        self.etapa.refresh_from_db()
        self.assertEqual(self.etapa.situacao, 'CONCLUIDA')
        self.assertEqual(self.etapa.metodo, 'Novo método')
        self.assertEqual(resp.json()['situacao'], 'CONCLUIDA')
        self.assertEqual(ConflitoEtapa.objects.count(), 0)

    def test_edicao_gera_historico_atualizado_com_autor(self):
        self.api_post(self.url_editar_etapa(self.etapa), self.body_etapa_editar(situacao='CONCLUIDA'))
        h = HistoricoAlteracoes.objects.filter(
            tipo_objeto='Etapa', uuid_objeto=self.etapa.id_unico, operacao='ATUALIZADO',
        ).order_by('-id').first()
        self.assertIsNotNone(h)
        self.assertEqual(h.usuario, self.auditor)
        self.assertEqual(h.estado_anterior['situacao'], 'PENDENTE')
        self.assertEqual(h.estado_posterior['situacao'], 'CONCLUIDA')

    def test_baseline_defasado_gera_conflito_e_nao_aplica(self):
        # Alguém mudou a etapa DEPOIS do aparelho ler o baseline.
        body = self.body_etapa_editar(situacao='CONCLUIDA')
        Etapa.objects.filter(pk=self.etapa.pk).update(orientacao='Mudou no site')

        resp = self.api_post(self.url_editar_etapa(self.etapa), body)
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['detail'], 'conflito_pendente')

        conflito = ConflitoEtapa.objects.get(id_unico=resp.json()['conflito_id'])
        self.assertEqual(conflito.status, 'PENDENTE')
        self.assertEqual(conflito.etapa, self.etapa)
        self.assertEqual(conflito.usuario_originador, self.auditor)
        self.assertEqual(conflito.dados_originador['situacao'], 'CONCLUIDA')
        self.assertEqual(conflito.dados_atuais['orientacao'], 'Mudou no site')

        self.etapa.refresh_from_db()
        self.assertEqual(self.etapa.situacao, 'PENDENTE')  # nada aplicado

    def test_conflito_e_atribuido_pelo_resolvedor(self):
        # O último a alterar (via site, logado) foi o chefe (perfil raiz, prof.
        # 0) — mais raso que o auditor (prof. 1) → o chefe julga.
        self.client.force_login(self.chefe)
        self.etapa.orientacao = 'Chefe mexeu'
        # save via ORM dentro de um request seria o ideal; aqui simulamos o
        # autor da última alteração gravando o histórico com o chefe.
        from ..middleware import set_current_user
        with set_current_user(self.chefe):
            self.etapa.save()
        self.client.logout()

        body = self.body_etapa_editar(situacao='CONCLUIDA')
        body['baseline']['orientacao'] = 'Orientação padrão'  # baseline velho
        resp = self.api_post(self.url_editar_etapa(self.etapa), body)
        conflito = ConflitoEtapa.objects.get(id_unico=resp.json()['conflito_id'])
        self.assertEqual(conflito.usuario_atual, self.chefe)
        self.assertEqual(conflito.atribuido_a, self.chefe)

    def test_reenvio_de_edicao_ja_aplicada_devolve_200_sem_conflito(self):
        # Resposta perdida: app reenvia com baseline velho, mas o que ele quer
        # gravar JÁ é o estado atual → não há divergência real.
        body = self.body_etapa_editar(situacao='CONCLUIDA')
        self.assertEqual(self.api_post(self.url_editar_etapa(self.etapa), body).status_code, 200)
        resp = self.api_post(self.url_editar_etapa(self.etapa), body)  # mesmo body, baseline agora velho
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(ConflitoEtapa.objects.count(), 0)

    def test_reenvio_do_mesmo_conflito_reusa_o_conflito_existente(self):
        body = self.body_etapa_editar(situacao='CONCLUIDA')
        Etapa.objects.filter(pk=self.etapa.pk).update(orientacao='Mudou no site')
        r1 = self.api_post(self.url_editar_etapa(self.etapa), body)
        r2 = self.api_post(self.url_editar_etapa(self.etapa), body)
        self.assertEqual(r1.json()['conflito_id'], r2.json()['conflito_id'])
        self.assertEqual(ConflitoEtapa.objects.count(), 1)

    def test_edicao_diferente_sobre_o_mesmo_conflito_gera_conflito_proprio(self):
        Etapa.objects.filter(pk=self.etapa.pk).update(orientacao='Mudou no site')
        self.api_post(self.url_editar_etapa(self.etapa), self.body_etapa_editar(situacao='CONCLUIDA'))
        self.api_post(self.url_editar_etapa(self.etapa), self.body_etapa_editar(situacao='REABERTA'))
        self.assertEqual(ConflitoEtapa.objects.count(), 2)

    def test_conflito_resolvido_nao_e_reaproveitado(self):
        body = self.body_etapa_editar(situacao='CONCLUIDA')
        Etapa.objects.filter(pk=self.etapa.pk).update(orientacao='Mudou no site')
        r1 = self.api_post(self.url_editar_etapa(self.etapa), body)
        ConflitoEtapa.objects.filter(id_unico=r1.json()['conflito_id']).update(status='RESOLVIDO')
        r2 = self.api_post(self.url_editar_etapa(self.etapa), body)
        self.assertNotEqual(r1.json()['conflito_id'], r2.json()['conflito_id'])

    def test_campo_obrigatorio_ausente_e_400(self):
        for campo in ('orientacao', 'documentos', 'atividade', 'prazo', 'situacao', 'metodo'):
            body = self.body_etapa_editar()
            del body[campo]
            resp = self.api_post(self.url_editar_etapa(self.etapa), body)
            self.assertEqual(resp.status_code, 400, campo)
            self.assertIn(campo, resp.json()['detail'])

    def test_baseline_nao_dict_e_400(self):
        body = self.body_etapa_editar()
        body['baseline'] = 'string'
        self.assertEqual(self.api_post(self.url_editar_etapa(self.etapa), body).status_code, 400)

    def test_prazo_nulo_e_400(self):
        resp = self.api_post(self.url_editar_etapa(self.etapa), self.body_etapa_editar(prazo=None))
        self.assertEqual(resp.status_code, 400)

    def test_situacao_invalida_e_400_e_nao_persiste(self):
        resp = self.api_post(self.url_editar_etapa(self.etapa), self.body_etapa_editar(situacao='INVENTADA'))
        self.assertEqual(resp.status_code, 400)
        self.etapa.refresh_from_db()
        self.assertEqual(self.etapa.situacao, 'PENDENTE')

    def test_auditoria_fechada_e_409_sem_conflito_id(self):
        # O sync-backend distingue "auditoria fechada" de "conflito" pelo
        # detail — este 409 NÃO pode vir com conflito_id.
        resp = self.api_post(
            self.url_editar_etapa(self.etapa_fechada),
            self.body_etapa_editar(etapa=self.etapa_fechada, situacao='CONCLUIDA'),
        )
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['detail'], 'auditoria_fechada')
        self.assertNotIn('conflito_id', resp.json())
        self.assertEqual(ConflitoEtapa.objects.count(), 0)

    def test_perfil_sem_editar_e_403(self):
        resp = self.api_post(self.url_editar_etapa(self.etapa), self.body_etapa_editar(usuario=self.leitor))
        self.assertEqual(resp.status_code, 403)

    def test_nao_envolvido_e_403(self):
        resp = self.api_post(self.url_editar_etapa(self.etapa), self.body_etapa_editar(usuario=self.fora))
        self.assertEqual(resp.status_code, 403)

    def test_etapa_inexistente_e_404(self):
        url = self.url_editar_etapa(self.etapa).replace(str(self.etapa.id_unico), str(uuid.uuid4()))
        self.assertEqual(self.api_post(url, self.body_etapa_editar()).status_code, 404)


# ===========================================================================
# Etapa — excluir
# ===========================================================================

class ExcluirEtapaTest(BaseMobileApiTest):

    def body(self, usuario=None):
        return {'usuario_uuid': str((usuario or self.auditor).id_unico)}

    def test_exclui_e_devolve_ja_excluida_false(self):
        resp = self.api_post(self.url_excluir_etapa(self.etapa), self.body())
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {'id_unico': str(self.etapa.id_unico), 'ja_excluida': False})
        self.assertFalse(Etapa.objects.filter(pk=self.etapa.pk).exists())

    def test_segunda_exclusao_e_idempotente(self):
        self.api_post(self.url_excluir_etapa(self.etapa), self.body())
        resp = self.api_post(self.url_excluir_etapa(self.etapa), self.body())
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()['ja_excluida'])

    def test_exclusao_cascateia_achados_e_registra_no_historico(self):
        Achado.objects.create(etapa=self.etapa, usuario=self.auditor, descricao='vai junto')
        self.api_post(self.url_excluir_etapa(self.etapa), self.body())
        self.assertEqual(Achado.objects.count(), 0)
        h = HistoricoAlteracoes.objects.filter(tipo_objeto='Etapa', uuid_objeto=self.etapa.id_unico, operacao='EXCLUIDO').get()
        self.assertEqual(h.usuario, self.auditor)
        self.assertIsNone(h.estado_posterior)

    def test_rbac_usa_excluir_e_nao_editar(self):
        # editor_sem_excluir tem 'editar' mas não 'excluir' — mesma distinção
        # que o site faz.
        resp = self.api_post(self.url_excluir_etapa(self.etapa), self.body(self.editor_sem_excluir))
        self.assertEqual(resp.status_code, 403)
        self.assertTrue(Etapa.objects.filter(pk=self.etapa.pk).exists())

    def test_nao_envolvido_e_403(self):
        resp = self.api_post(self.url_excluir_etapa(self.etapa), self.body(self.fora))
        self.assertEqual(resp.status_code, 403)

    def test_auditoria_fechada_e_409(self):
        resp = self.api_post(self.url_excluir_etapa(self.etapa_fechada), self.body())
        self.assertEqual(resp.status_code, 409)
        self.assertTrue(Etapa.objects.filter(pk=self.etapa_fechada.pk).exists())

    def test_usuario_uuid_ausente_e_400(self):
        self.assertEqual(self.api_post(self.url_excluir_etapa(self.etapa), {}).status_code, 400)
