/**
 * Aviso de "chegou dado novo" — resolve o caso em que o auditor sincroniza do
 * app de campo e quem está no sistema web não vê nada até apertar F5.
 *
 * Deliberadamente NÃO redesenha a tela: consulta um carimbo de versão barato
 * (Auth/views/api_views.py::api_atualizacoes, que não devolve conteúdo algum)
 * e, quando ele muda, mostra uma faixa oferecendo atualizar. Quem decide é o
 * usuário. Numa ferramenta de auditoria isso importa: a lista não pode se
 * mexer no instante em que a pessoa vai clicar em "Resolver", e "o que eu vi
 * foi isto" precisa continuar valendo até eu mandar atualizar.
 *
 * Configuração vem do próprio elemento (data-url, data-intervalo).
 */
(function () {
  'use strict';

  var aviso = document.getElementById('aviso-atualizacao');
  if (!aviso || !aviso.dataset.url) return;

  var url = aviso.dataset.url;
  var intervalo = parseInt(aviso.dataset.intervalo, 10) || 20000;
  var textoEl = aviso.querySelector('[data-aviso-texto]');
  var btnAtualizar = aviso.querySelector('[data-aviso-atualizar]');
  var btnDispensar = aviso.querySelector('[data-aviso-dispensar]');

  var versaoBase = null;
  var itensBase = 0;
  var timer = null;
  var emVoo = false;
  var falhasSeguidas = 0;
  var LIMITE_FALHAS = 5;

  function montarTexto(itens) {
    var delta = itens - itensBase;
    if (delta > 0) {
      return delta === 1
        ? '1 novo registro sincronizado do campo.'
        : delta + ' novos registros sincronizados do campo.';
    }
    if (delta < 0) {
      return 'Registros foram removidos ou resolvidos por outra pessoa.';
    }
    return 'Há alterações novas nesta tela.';
  }

  function mostrar(itens) {
    if (textoEl) textoEl.textContent = montarTexto(itens);
    aviso.classList.add('is-visivel');
    // Uma vez avisado, parar de consultar: a faixa já está na tela e o texto
    // não fica mais preciso a cada volta — só gastaria query. O próximo ciclo
    // começa depois do reload.
    parar();
  }

  function parar() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function iniciar() {
    if (timer || aviso.classList.contains('is-visivel')) return;
    timer = setInterval(consultar, intervalo);
  }

  function consultar() {
    // Aba em segundo plano não precisa de aviso nenhum, e manter o polling
    // rodando em N abas esquecidas é carga pura no banco.
    if (document.hidden || emVoo) return;
    emVoo = true;

    fetch(url, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(function (res) {
        // Sessão expirada devolve um 302 para o HTML do login: o fetch segue o
        // redirect e entrega 200 com HTML, que estouraria no .json(). Checar o
        // content-type é o que separa "sem novidade" de "não estou mais logado".
        var tipo = res.headers.get('content-type') || '';
        if (!res.ok || tipo.indexOf('application/json') === -1) {
          throw new Error('resposta inesperada: ' + res.status);
        }
        return res.json();
      })
      .then(function (dados) {
        falhasSeguidas = 0;
        if (versaoBase === null) {
          // Primeira resposta é só a linha de base do que já está na tela.
          versaoBase = dados.versao;
          itensBase = dados.itens;
          return;
        }
        if (dados.versao !== versaoBase) mostrar(dados.itens);
      })
      .catch(function () {
        falhasSeguidas += 1;
        // Servidor fora, sessão expirada, rede caída: desistir em silêncio em
        // vez de bater de 20 em 20 segundos para sempre. A página continua
        // perfeitamente utilizável — só volta a depender do F5.
        if (falhasSeguidas >= LIMITE_FALHAS) parar();
      })
      .finally(function () {
        emVoo = false;
      });
  }

  if (btnAtualizar) {
    btnAtualizar.addEventListener('click', function () {
      window.location.reload();
    });
  }

  if (btnDispensar) {
    btnDispensar.addEventListener('click', function () {
      aviso.classList.remove('is-visivel');
      versaoBase = null; // próxima resposta vira a nova linha de base
      iniciar();
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) parar();
    else iniciar();
  });

  consultar(); // linha de base imediata, para não perder o que chegar já no 1º ciclo
  iniciar();
})();
