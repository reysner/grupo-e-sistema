/**
 * Módulo Sucesso do Cliente — Frontend da aba "Agora"
 * ------------------------------------------------------------------
 * Segue a convenção descrita na Continuidade (seção 9 do CONTEXTO):
 * IIFE atribuída a window.App.<Modulo>. Vanilla JS, sem build.
 *
 * COMO INTEGRAR (não tenho acesso a public/js/app.js nem public/index.html
 * neste pacote — ver CONTEXTO seção 10 — então a integração final é manual):
 *
 * 1. Subir este arquivo em: public/js/cs.js
 * 2. Subir cs.css em: public/css/cs.css
 * 3. No index.html, dentro da área do SPA (onde ficam as outras telas/abas),
 *    adicionar um item de navegação para "Sucesso do Cliente" e o container:
 *
 *      <div id="cs-agora-container" class="cs-agora"></div>
 *      <button class="btn" onclick="App.CS.ingerirAgora()">Atualizar agora</button>
 *
 *    e, perto dos outros <script src="js/..."> no fim do <body>:
 *
 *      <link rel="stylesheet" href="css/cs.css">
 *      <script src="js/cs.js"></script>
 *
 * 4. Ao abrir a aba (no código que já troca de tela no app.js), chamar:
 *
 *      App.CS.init('cs-agora-container');
 *
 *    E ao sair da aba (se o app tiver esse hook), chamar App.CS.destruir()
 *    para parar o auto-refresh.
 *
 * 5. Ajustar CS._authHeaders() abaixo para o jeito real que o app.js guarda
 *    o token JWT (procurar por "Authorization" ou "token" no app.js real).
 */
(function () {
  'use strict';
  const App = window.App || (window.App = {});

  const CS = {
    _containerId: null,
    _timer: null,
    _intervaloMs: 60000, // 1 min — ~600 tickets/mês é volume baixo, não precisa ser mais agressivo

    /** Chamar ao abrir a aba "Agora". */
    async init(containerId) {
      this._containerId = containerId || 'cs-agora-container';
      await this.carregar();
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(() => this.carregar(), this._intervaloMs);
    },

    /** Chamar ao sair da aba, se o app tiver esse hook (evita polling em segundo plano). */
    destruir() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    },

    async carregar() {
      const container = document.getElementById(this._containerId);
      if (!container) return;
      try {
        const resp = await fetch('/api/cs/agora', { headers: CS._authHeaders() });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const { tickets } = await resp.json();
        CS._render(container, tickets || []);
      } catch (e) {
        container.innerHTML = '<p class="cs-erro">Não foi possível carregar o radar agora.</p>';
        console.error('[CS.Agora] carregar()', e);
      }
    },

    async ingerirAgora() {
      try {
        const resp = await fetch('/api/cs/ingerir', { method: 'POST', headers: CS._authHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        if (App.Toast && App.Toast.ok) App.Toast.ok(`Ingestão concluída: ${data.processados} tickets atualizados.`);
        await CS.carregar();
      } catch (e) {
        if (App.Toast && App.Toast.err) App.Toast.err('Falha ao atualizar tickets.');
        console.error('[CS.Agora] ingerirAgora()', e);
      }
    },

    _authHeaders() {
      // TODO: ajustar para o padrão real do app.js. Tentativa: token JWT em
      // localStorage (comum neste tipo de app) — confirmar chave exata.
      const token = localStorage.getItem('token') || localStorage.getItem('accessToken');
      return token ? { Authorization: 'Bearer ' + token } : {};
    },

    _render(container, tickets) {
      if (!tickets.length) {
        container.innerHTML = '<p class="cs-ok">✅ Nenhum ticket fora do SLA agora.</p>';
        return;
      }
      const linhas = tickets.map(CS._linha).join('');
      container.innerHTML =
        '<table class="cs-tabela">' +
        '<thead><tr><th></th><th>Empresa</th><th>Departamento</th><th>Analista</th><th>Relógio</th><th>Tempo</th></tr></thead>' +
        '<tbody>' + linhas + '</tbody>' +
        '</table>';
    },

    _linha(t) {
      let sla = {};
      try { sla = typeof t.sla === 'string' ? JSON.parse(t.sla) : (t.sla || {}); } catch (e) { sla = {}; }
      const radar = sla.radar || null;
      const cor = t.pior_status === 'vermelho' ? '🔴' : (t.pior_status === 'amarelo' ? '🟡' : '⚪');
      const empresa = t.empresa_nome || t.empresa_texto || '(sem vínculo)';
      const relogio = radar ? radar.rotulo : '—';
      const tempo = radar ? (radar.minutos_uteis + ' min (limite ' + (radar.limite ?? '—') + ')') : '—';
      return (
        '<tr class="cs-linha cs-' + (t.pior_status || '') + '">' +
        '<td>' + cor + '</td>' +
        '<td>' + CS._esc(empresa) + '</td>' +
        '<td>' + CS._esc(t.departamento || '—') + '</td>' +
        '<td>' + CS._esc(t.analista || '—') + '</td>' +
        '<td>' + CS._esc(relogio) + '</td>' +
        '<td>' + CS._esc(tempo) + '</td>' +
        '</tr>'
      );
    },

    _esc(s) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => map[c]);
    },
  };

  App.CS = CS;
})();
