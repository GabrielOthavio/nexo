(function () {
  'use strict';

  /* ===== Tweaks ===== */
  function getTweaks() {
    try { return JSON.parse(localStorage.getItem('app_tweaks') || '{}'); } catch { return {}; }
  }
  function saveTweaks(t) {
    localStorage.setItem('app_tweaks', JSON.stringify(t));
  }
  function applyTweaks(t) {
    document.documentElement.setAttribute('data-theme',   t.theme   || 'dark');
    document.documentElement.setAttribute('data-density', t.density || 'compact');
    if (t.accentH) document.documentElement.style.setProperty('--accent-h', t.accentH);
    if (t.accentC) document.documentElement.style.setProperty('--accent-c', t.accentC);
    if (t.accentL) document.documentElement.style.setProperty('--accent-l', t.accentL);
  }

  /* ===== Sidebar ===== */
  function initSidebar() {
    var sidebar = document.getElementById('sidebar');
    var btn     = document.getElementById('sidebar-toggle');
    var icon    = document.getElementById('sidebar-toggle-icon');
    if (!sidebar || !btn) return;

    var t = getTweaks();
    if (t.sidebarCollapsed) {
      sidebar.classList.add('collapsed');
      if (icon) icon.className = 'bi bi-arrow-bar-right';
    }

    btn.addEventListener('click', function () {
      var collapsed = sidebar.classList.toggle('collapsed');
      var curr = getTweaks();
      curr.sidebarCollapsed = collapsed;
      saveTweaks(curr);
      if (icon) icon.className = collapsed ? 'bi bi-arrow-bar-right' : 'bi bi-arrow-bar-left';
    });
  }

  /* ===== Active nav ===== */
  function initActiveNav() {
    var path = location.pathname;
    document.querySelectorAll('[data-nav-path]').forEach(function (el) {
      var navPath = el.dataset.navPath;
      var exact   = el.dataset.navExact;
      if (!navPath) return;
      var active = exact
        ? path === navPath
        : navPath.length > 1 && path.startsWith(navPath);
      if (active) el.classList.add('active');
    });
  }

  /* ===== Tweaks panel ===== */
  function initTweaks() {
    var btn      = document.getElementById('tweaks-btn');
    var dropdown = document.getElementById('tweaks-dropdown');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', function () {
      dropdown.classList.remove('open');
    });
    dropdown.addEventListener('click', function (e) { e.stopPropagation(); });

    var t = getTweaks();

    /* Theme */
    dropdown.querySelectorAll('[data-theme-opt]').forEach(function (el) {
      if (el.dataset.themeOpt === (t.theme || 'dark')) el.classList.add('active');
      el.addEventListener('click', function () {
        dropdown.querySelectorAll('[data-theme-opt]').forEach(function (x) { x.classList.remove('active'); });
        el.classList.add('active');
        var curr = getTweaks(); curr.theme = el.dataset.themeOpt;
        saveTweaks(curr); applyTweaks(curr);
      });
    });

    /* Density */
    dropdown.querySelectorAll('[data-density-opt]').forEach(function (el) {
      if (el.dataset.densityOpt === (t.density || 'compact')) el.classList.add('active');
      el.addEventListener('click', function () {
        dropdown.querySelectorAll('[data-density-opt]').forEach(function (x) { x.classList.remove('active'); });
        el.classList.add('active');
        var curr = getTweaks(); curr.density = el.dataset.densityOpt;
        saveTweaks(curr); applyTweaks(curr);
      });
    });
  }

  /* ===== Toast ===== */
  var TOAST_ICONS = {
    success: 'bi-check-circle-fill',
    error:   'bi-x-circle-fill',
    warning: 'bi-exclamation-triangle-fill',
    info:    'bi-info-circle-fill',
  };

  function showToast(message, type, opts) {
    var stack = document.getElementById('toast-stack');
    if (!stack) return;
    type = type || 'info';
    opts = opts || {};
    var icon = TOAST_ICONS[type] || TOAST_ICONS.info;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;

    var iconEl = document.createElement('i');
    iconEl.className = 'bi ' + icon + ' toast-icon';

    var bodyEl = document.createElement('div');
    bodyEl.className = 'toast-body';
    if (opts.raw) {
      bodyEl.innerHTML = message;
    } else {
      bodyEl.textContent = message;
    }

    var closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Fechar');
    var closeIcon = document.createElement('i');
    closeIcon.className = 'bi bi-x';
    closeBtn.appendChild(closeIcon);
    closeBtn.addEventListener('click', function () {
      dismissToast(toast);
    });

    toast.appendChild(iconEl);
    toast.appendChild(bodyEl);
    toast.appendChild(closeBtn);
    stack.appendChild(toast);
    toast._timer = setTimeout(function () { dismissToast(toast); }, 4500);
  }

  function dismissToast(toast) {
    if (!toast.parentNode) return;
    clearTimeout(toast._timer);
    toast.classList.add('removing');
    toast.addEventListener('animationend', function () { toast.remove(); }, { once: true });
  }

  /* Convert hidden Django message spans → toasts */
  function initMessages() {
    document.querySelectorAll('[data-django-message]').forEach(function (el) {
      var tags = el.dataset.djangoMessage || '';
      var type = 'info';
      if (tags.includes('success')) type = 'success';
      else if (tags.includes('error') || tags.includes('danger')) type = 'error';
      else if (tags.includes('warning')) type = 'warning';
      showToast(el.textContent.trim(), type);
      el.remove();
    });
  }

  /* ===== Keyboard shortcuts ===== */
  function initShortcuts() {
    var gPressed = false, gTimer;

    document.addEventListener('keydown', function (e) {
      var active = document.activeElement || {};
      var tag = active.tagName;
      var editing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        active.isContentEditable;

      /* Esc — close tweaks */
      if (e.key === 'Escape') {
        var dd = document.getElementById('tweaks-dropdown');
        if (dd) dd.classList.remove('open');
        return;
      }

      if (editing) return;

      /* / — focus search (future) */
      if (e.key === '/') {
        e.preventDefault();
        var search = document.querySelector('[data-search-input]');
        if (search) search.focus();
        return;
      }

      /* N — new record */
      if (e.key === 'n' || e.key === 'N') {
        var newBtn = document.querySelector('[data-shortcut-new]');
        if (newBtn) { e.preventDefault(); newBtn.click(); }
        return;
      }

      /* ? — show shortcut hints */
      if (e.key === '?') {
        e.preventDefault();
        showToast(
          '<strong>Atalhos:</strong> N = novo registro &nbsp;·&nbsp; G+D = dashboard &nbsp;·&nbsp; G+A = ações &nbsp;·&nbsp; G+U = auditorias &nbsp;·&nbsp; G+I = índices',
          'info',
          { raw: true }
        );
        return;
      }

      /* G+D, G+A, G+U, G+I — navegação */
      if (e.key === 'g' || e.key === 'G') {
        gPressed = true;
        clearTimeout(gTimer);
        gTimer = setTimeout(function () { gPressed = false; }, 1200);
        return;
      }
      if (gPressed) {
        clearTimeout(gTimer);
        gPressed = false;
        if (e.key === 'd' || e.key === 'D') {
          var dashLink = document.querySelector('[data-nav-path][data-nav-exact]');
          if (dashLink) location.href = dashLink.href;
        }
        if (e.key === 'a' || e.key === 'A') {
          var acoesLink = document.querySelector('[data-nav-key="acoes"]');
          if (acoesLink) location.href = acoesLink.href;
        }
        if (e.key === 'u' || e.key === 'U') {
          var audLink = document.querySelector('[data-nav-key="auditorias"]');
          if (audLink) location.href = audLink.href;
        }
        if (e.key === 'i' || e.key === 'I') {
          var idxLink = document.querySelector('[data-nav-key="indices"]');
          if (idxLink) location.href = idxLink.href;
        }
      }
    });
  }

  /* ===== Confirmação de ações destrutivas (Etnometodologia — ação incorreta retorna ao estado anterior) ===== */
  function initConfirm() {
    document.querySelectorAll('[data-confirm]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (!window.confirm(el.dataset.confirm)) {
          e.preventDefault();
        }
      });
    });
  }

  /* ===== Pagination controls (shared across all list pages) ===== */
  function initPagination() {
    /* Page input — navigate on Enter or blur */
    document.querySelectorAll('.pg-input').forEach(function (inp) {
      var max = parseInt(inp.dataset.max, 10) || 1;

      function goTo() {
        var p = parseInt(inp.value, 10);
        if (isNaN(p) || p < 1) p = 1;
        if (p > max) p = max;
        var url = new URL(window.location.href);
        url.searchParams.set('page', p);
        window.location.href = url.toString();
      }

      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); goTo(); }
        if (e.key === 'Escape') { inp.value = inp.defaultValue; inp.blur(); }
      });
      inp.addEventListener('blur', function () {
        var p = parseInt(inp.value, 10);
        if (!isNaN(p) && p >= 1 && p <= max) goTo();
        else inp.value = inp.defaultValue;
      });
      inp.addEventListener('focus', function () { this.select(); });
    });

    /* Per-page select */
    document.querySelectorAll('.pg-per-page').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var url = new URL(window.location.href);
        url.searchParams.set('per_page', this.value);
        url.searchParams.set('page', '1');
        window.location.href = url.toString();
      });
    });
  }

  /* ===== Avatar dropdown ===== */
  function initAvatarMenu() {
    var menu     = document.getElementById('user-menu');
    var btn      = document.getElementById('user-menu-btn');
    var dropdown = document.getElementById('user-dropdown');
    if (!menu || !btn || !dropdown) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = dropdown.classList.toggle('open');
      btn.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function () {
      dropdown.classList.remove('open');
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    });
    dropdown.addEventListener('click', function (e) { e.stopPropagation(); });

    menu.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        dropdown.classList.remove('open');
        btn.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        btn.focus();
      }
    });
  }

  /* ===== Formulários: feedback de envio e bloqueio sem rede =====
     Todo <form method="post"> ganha (a) o botão travado com "Enviando…" a
     partir do clique — o usuário sabe que algo está acontecendo — e (b) o
     envio recusado na hora, com o motivo, quando o navegador está offline:
     um POST sem rede só terminaria na página de erro do browser, com o que
     foi digitado perdido. Opt-out por form: data-no-loading. */
  var MSG_OFFLINE = 'Sem conexão. Nada foi enviado — o que você preencheu continua nesta tela; reconecte e envie de novo.';

  function botoesDeEnvio(raiz) {
    return raiz.querySelectorAll('button[type="submit"], input[type="submit"]');
  }

  function travarEnvio(form) {
    botoesDeEnvio(form).forEach(function (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      var texto = btn.dataset.loadingText || 'Enviando…';
      if (btn.tagName === 'INPUT') {
        btn.dataset.rotuloOriginal = btn.value;
        btn.value = texto;
      } else {
        btn.dataset.rotuloOriginal = btn.innerHTML;
        btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> ' + texto;
      }
    });
  }

  function destravarEnvio(form) {
    botoesDeEnvio(form).forEach(function (btn) {
      if (btn.dataset.rotuloOriginal === undefined) return;
      if (btn.tagName === 'INPUT') btn.value = btn.dataset.rotuloOriginal;
      else btn.innerHTML = btn.dataset.rotuloOriginal;
      delete btn.dataset.rotuloOriginal;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    });
  }

  function initForms() {
    document.querySelectorAll('form[method="post" i]').forEach(function (form) {
      if (form.hasAttribute('data-no-loading')) return;
      form.addEventListener('submit', function (e) {
        if (!navigator.onLine) {
          e.preventDefault();
          showToast(MSG_OFFLINE, 'error');
          return;
        }
        // `submit` só dispara depois da validação nativa (required, pattern…),
        // então travar aqui nunca deixa o botão morto com o form ainda na tela.
        travarEnvio(form);
      });
    });
    // Voltar pelo bfcache restaura a página como estava — inclusive com o
    // botão travado do envio anterior. `pageshow` com persisted é o sinal.
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) document.querySelectorAll('form').forEach(destravarEnvio);
    });
  }

  /* ===== Estado da rede =====
     Enquanto o navegador está offline: faixa fixa explicando, e os botões de
     envio desabilitados (bloqueio preventivo — não só a mensagem depois do
     clique). Ao voltar, tudo é liberado e um toast avisa. */
  function initRede() {
    var faixa = null;
    var esteveOffline = false;

    function garantirFaixa() {
      if (faixa) return faixa;
      faixa = document.createElement('div');
      faixa.className = 'rede-offline';
      faixa.setAttribute('role', 'status');
      faixa.setAttribute('aria-live', 'assertive');
      var icone = document.createElement('i');
      icone.className = 'bi bi-wifi-off';
      icone.setAttribute('aria-hidden', 'true');
      var texto = document.createElement('span');
      texto.textContent = 'Sem conexão — os envios ficam bloqueados até a rede voltar. O que está na tela não se perde.';
      faixa.appendChild(icone);
      faixa.appendChild(texto);
      document.body.appendChild(faixa);
      return faixa;
    }

    function aplicar() {
      var offline = !navigator.onLine;
      document.body.classList.toggle('is-offline', offline);
      garantirFaixa().classList.toggle('is-visivel', offline);

      document.querySelectorAll('form[method="post" i]').forEach(function (form) {
        if (form.hasAttribute('data-no-loading')) return;
        botoesDeEnvio(form).forEach(function (btn) {
          if (offline) {
            if (btn.disabled) return; // já travado por um envio em andamento
            btn.disabled = true;
            btn.dataset.travadoPelaRede = '1';
          } else if (btn.dataset.travadoPelaRede) {
            btn.disabled = false;
            delete btn.dataset.travadoPelaRede;
          }
        });
      });

      if (offline) esteveOffline = true;
      else if (esteveOffline) {
        esteveOffline = false;
        showToast('Conexão restabelecida — já pode enviar.', 'success');
      }
    }

    window.addEventListener('offline', aplicar);
    window.addEventListener('online', aplicar);
    aplicar();
  }

  /* ===== CPF: máscara e validação ao sair do campo =====
     Espelho de Auth/forms/utils.py::validate_cpf no cliente. O servidor
     continua validando; aqui é só para o erro aparecer no próprio campo, na
     hora, em vez de depois do envio da página inteira. */
  function cpfValido(digitos) {
    if (digitos.length !== 11 || /^(\d)\1{10}$/.test(digitos)) return false;
    function dv(n) {
      var total = 0;
      for (var i = 0; i < n; i++) total += parseInt(digitos[i], 10) * (n + 1 - i);
      var d = (total * 10) % 11;
      return d >= 10 ? 0 : d;
    }
    return dv(9) === parseInt(digitos[9], 10) && dv(10) === parseInt(digitos[10], 10);
  }

  function mascararCpf(valor) {
    var d = valor.replace(/\D/g, '').slice(0, 11);
    return d
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }

  function initCpf() {
    document.querySelectorAll('input[name="cpf"]').forEach(function (input) {
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('maxlength', '14');
      input.setAttribute('autocomplete', 'off');

      // Feedback próprio, separado do que o servidor possa ter renderizado
      // (esse some assim que o usuário volta a digitar).
      var feedback = document.createElement('div');
      feedback.className = 'invalid-feedback';
      feedback.style.display = 'none';
      input.insertAdjacentElement('afterend', feedback);

      function marcar(msg) {
        input.classList.toggle('is-invalid', !!msg);
        feedback.textContent = msg || '';
        feedback.style.display = msg ? '' : 'none';
      }

      input.addEventListener('input', function () {
        input.value = mascararCpf(input.value);
        marcar(null);
        var doServidor = input.parentNode.querySelectorAll('.invalid-feedback');
        doServidor.forEach(function (el) { if (el !== feedback) el.style.display = 'none'; });
      });
      input.addEventListener('blur', function () {
        var d = input.value.replace(/\D/g, '');
        if (!d) marcar(null);
        else if (d.length !== 11) marcar('CPF deve conter 11 dígitos.');
        else if (!cpfValido(d)) marcar('CPF inválido.');
        else marcar(null);
      });
      if (input.value) input.value = mascararCpf(input.value);
    });
  }

  /* ===== Init ===== */
  document.addEventListener('DOMContentLoaded', function () {
    initSidebar();
    initActiveNav();
    initTweaks();
    initMessages();
    initShortcuts();
    initConfirm();
    initPagination();
    initAvatarMenu();
    initForms();
    initRede();
    initCpf();
  });

  window.showToast = showToast;
})();
