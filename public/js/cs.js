/**
 * Módulo Sucesso do Cliente — Frontend da aba "Agora"
 * ------------------------------------------------------------------
 * Convenção real confirmada no app.js (não a que eu tinha suposto antes):
 * cada módulo é um IIFE atribuído a `window.NomeDoModulo` (ex.: window.Tickets,
 * window.Carteira, window.Sensiveis) — NÃO window.App.<Modulo>. O objeto
 * `App` (App.Toast, App.Modal, App.Util, App.Auth) é só o núcleo compartilhado.
 *
 * IMPORTANTE: o prefixo "cs-" já é usado pelo módulo "Clientes Sensíveis"
 * (cs-pagination, cs-grid, cs-tbody...). Pra não colidir nem confundir,
 * este arquivo usa o prefixo "radar-" nos ids/classes (o nome que a própria
 * Continuidade já usa pra essa tela: "o radar de tickets fora do SLA").
 *
 * Nome do módulo: window.SucessoCliente (chave de página: "sucesso-cliente").
 *
 * INTEGRAÇÃO (já ajustada para os arquivos reais que a Thais subiu):
 *
 * 1. public/index.html — nav item (perto do de Tickets, dentro da <nav class="sidebar-nav">):
 *      <a class="nav-item admin-only" data-page="sucesso-cliente" href="#">
 *        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
 *          <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
 *        </svg>Sucesso do Cliente
 *      </a>
 *
 * 2. public/index.html — seção da página (perto de <section id="page-tickets">):
 *      <section id="page-sucesso-cliente" class="page admin-only" hidden>
 *        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
 *          <div id="radar-resumo" style="color:var(--gray-500);font-size:13px"></div>
 *          <div style="display:flex;gap:8px">
 *            <button class="btn btn-ghost btn-sm" onclick="SucessoCliente.testarConexao()">🔧 Testar conexão com Zappy</button>
 *            <button class="btn btn-sm" onclick="SucessoCliente.ingerirAgora()">🔄 Atualizar agora</button>
 *          </div>
 *        </div>
 *        <div id="radar-diagnostico"></div>
 *        <div id="radar-container"></div>
 *      </section>
 *
 * 3. public/index.html — no fim do <body>, perto dos outros <script src="js/...">:
 *      <link rel="stylesheet" href="css/cs.css">
 *      <script src="js/cs.js"></script>
 *
 * 4. public/js/app.js — PAGE_TITLES (perto do topo, junto dos outros):
 *      'sucesso-cliente':'Sucesso do Cliente',
 *
 * 5. public/js/app.js — dentro de Nav.go(page), junto das outras linhas "if (page === ...)":
 *      if (page === 'sucesso-cliente') window.SucessoCliente?.load();
 */
(function () {
  'use strict';

  const SucessoCliente = {
    _timer: null,
    _intervaloMs: 60000, // 1 min — ~600 tickets/mês é volume baixo, não precisa ser mais agressivo

    /** Chamado pelo Nav.go('sucesso-cliente') ao abrir a aba. */
    async load() {
      await this.carregar();
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(() => this.carregar(), this._intervaloMs);
    },

    /** Opcional: parar o auto-refresh se algum dia o app tiver hook de "saiu da aba". */
    destruir() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    },

    async carregar() {
      const container = document.getElementById('radar-container');
      const resumo = document.getElementById('radar-resumo');
      if (!container) return;
      try {
        const resp = await fetch('/api/cs/agora', { headers: SucessoCliente._authHeaders() });
        const texto = await resp.text();
        let data;
        try { data = texto ? JSON.parse(texto) : {}; } catch (e) { data = null; }
        if (!resp.ok || !data) {
          const detalhe = data && data.error ? data.error : (texto || '').slice(0, 200);
          throw new Error('HTTP ' + resp.status + (detalhe ? ' — ' + detalhe : ''));
        }
        const { tickets } = data;
        SucessoCliente._render(container, tickets || []);
        if (resumo) {
          resumo.textContent = (tickets || []).length
            ? `${tickets.length} ticket${tickets.length !== 1 ? 's' : ''} fora do SLA agora`
            : 'Tudo dentro do SLA';
        }
      } catch (e) {
        container.innerHTML =
          '<p class="radar-erro">Não foi possível carregar o radar agora.</p>' +
          '<p style="font-family:monospace;font-size:12px;color:var(--gray-500)">' + SucessoCliente._esc(e.message) + '</p>';
        console.error('[SucessoCliente] carregar()', e);
      }
    },

    async ingerirAgora() {
      try {
        const resp = await fetch('/api/cs/ingerir', { method: 'POST', headers: SucessoCliente._authHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        const extra = data.ignoradosPreDataInicio ? ` (${data.ignoradosPreDataInicio} ignorados por serem anteriores à data de início da coleta)` : '';
        if (window.App && App.Toast) App.Toast.ok(`Ingestão concluída: ${data.processados} tickets atualizados${extra}.`);
        await SucessoCliente.carregar();
      } catch (e) {
        if (window.App && App.Toast) App.Toast.err('Falha ao atualizar tickets.');
        console.error('[SucessoCliente] ingerirAgora()', e);
      }
    },

    /**
     * Botão "Testar conexão com Zappy" — usa SÓ o endpoint que já sabemos
     * que existe (GET /tickets/:id), sem depender do palpite do endpoint
     * de listagem em lote. Pede um número de ticket real e mostra o
     * resultado (ou o erro, já explicado) direto na tela — sem precisar
     * abrir o Console do navegador.
     */
    async testarConexao() {
      const div = document.getElementById('radar-diagnostico');
      if (!div) return;
      const ticketId = window.prompt('Número de um ticket REAL do Zappy pra testar (ex.: 46072):', '46072');
      if (!ticketId) return;
      div.innerHTML = '<p style="color:var(--gray-500)">Testando...</p>';
      try {
        const resp = await fetch('/api/cs/diagnostico?ticketId=' + encodeURIComponent(ticketId), {
          headers: SucessoCliente._authHeaders(),
        });
        const data = await resp.json();
        if (data.ok) {
          div.innerHTML =
            '<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px;margin-bottom:16px">' +
            '<strong>✅ Conexão funcionando!</strong><br>' +
            'Ticket #' + SucessoCliente._esc(data.ticket.id) + ' — status: ' + SucessoCliente._esc(data.ticket.status) +
            (data.ticket.contact ? ' — contato: ' + SucessoCliente._esc(data.ticket.contact.name || '') : '') +
            '</div>';
        } else {
          div.innerHTML =
            '<div style="background:#fdecec;border:1px solid #f5b5b5;border-radius:8px;padding:12px;margin-bottom:16px">' +
            '<strong>❌ Erro na conexão</strong><br>' +
            '<span style="font-family:monospace;font-size:12px">' + SucessoCliente._esc(data.error) + '</span>' +
            '</div>';
        }
      } catch (e) {
        div.innerHTML = '<div style="background:#fdecec;border-radius:8px;padding:12px">❌ Falha ao testar: ' + SucessoCliente._esc(e.message) + '</div>';
      }
    },

    // Mesmo padrão usado nos outros módulos do app.js (ex.: linha "const _tk = () => localStorage.getItem('ge_token') || '';")
    _authHeaders() {
      const token = localStorage.getItem('ge_token') || '';
      return token ? { Authorization: 'Bearer ' + token } : {};
    },

    _render(container, tickets) {
      if (!tickets.length) {
        container.innerHTML = '<p class="radar-ok">✅ Nenhum ticket fora do SLA agora.</p>';
        return;
      }
      const linhas = tickets.map(SucessoCliente._linha).join('');
      container.innerHTML =
        '<table class="radar-tabela">' +
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
        '<tr class="radar-linha radar-' + (t.pior_status || '') + '">' +
        '<td>' + cor + '</td>' +
        '<td>' + SucessoCliente._esc(empresa) + '</td>' +
        '<td>' + SucessoCliente._esc(t.departamento || '—') + '</td>' +
        '<td>' + SucessoCliente._esc(t.analista || '—') + '</td>' +
        '<td>' + SucessoCliente._esc(relogio) + '</td>' +
        '<td>' + SucessoCliente._esc(tempo) + '</td>' +
        '</tr>'
      );
    },

    _esc(s) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => map[c]);
    },
  };

  window.SucessoCliente = SucessoCliente;
})();
