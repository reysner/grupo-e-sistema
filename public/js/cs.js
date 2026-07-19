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
 *
 *        <hr style="margin:32px 0;border:none;border-top:1px solid var(--gray-200)">
 *
 *        <h3 style="margin-bottom:12px">Histórico de Atendimentos</h3>
 *        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
 *          <select id="hist-departamento" class="radar-select"><option value="">Todos os departamentos</option></select>
 *          <select id="hist-analista" class="radar-select"><option value="">Todos os analistas</option></select>
 *          <select id="hist-status" class="radar-select">
 *            <option value="">Todos os status</option>
 *            <option value="vermelho">🔴 Vermelho</option>
 *            <option value="amarelo">🟡 Amarelo</option>
 *            <option value="verde">🟢 Verde</option>
 *          </select>
 *          <button class="btn btn-sm" onclick="SucessoCliente.filtrarHistorico()">Filtrar</button>
 *          <button class="btn btn-ghost btn-sm" onclick="SucessoCliente.exportHistoricoCSV()">⬇ Exportar CSV</button>
 *          <button class="btn btn-ghost btn-sm" onclick="SucessoCliente.exportHistoricoPDF()">🖶 Exportar PDF</button>
 *        </div>
 *        <div id="hist-container"></div>
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
      await this.carregarFiltros();
      await this.filtrarHistorico();
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

    /**
     * Popula os <select> de departamento/analista da tela de Histórico com
     * os valores já vistos nos tickets gravados (GET /api/cs/filtros).
     * Chamado uma vez ao abrir a aba (load()).
     */
    async carregarFiltros() {
      const selDep = document.getElementById('hist-departamento');
      const selAna = document.getElementById('hist-analista');
      if (!selDep || !selAna) return; // seção de histórico ainda não colada no HTML
      try {
        const resp = await fetch('/api/cs/filtros', { headers: SucessoCliente._authHeaders() });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const { departamentos, analistas } = await resp.json();
        const preencher = (select, valores) => {
          const atual = select.value;
          select.querySelectorAll('option[data-dinamico]').forEach(o => o.remove());
          (valores || []).forEach(v => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            opt.setAttribute('data-dinamico', '1');
            select.appendChild(opt);
          });
          select.value = atual;
        };
        preencher(selDep, departamentos);
        preencher(selAna, analistas);
      } catch (e) {
        console.error('[SucessoCliente] carregarFiltros()', e);
      }
    },

    /**
     * Busca o histórico de tickets (GET /api/cs/historico) já aplicando os
     * filtros selecionados nos <select> da tela, e renderiza a tabela.
     * Chamado pelo botão "Filtrar" e uma vez ao abrir a aba.
     */
    async filtrarHistorico() {
      const container = document.getElementById('hist-container');
      if (!container) return; // seção de histórico ainda não colada no HTML
      const departamento = (document.getElementById('hist-departamento') || {}).value || '';
      const analista = (document.getElementById('hist-analista') || {}).value || '';
      const status = (document.getElementById('hist-status') || {}).value || '';
      container.innerHTML = '<p style="color:var(--gray-500)">Carregando...</p>';
      try {
        const qs = new URLSearchParams();
        if (departamento) qs.set('departamento', departamento);
        if (analista) qs.set('analista', analista);
        if (status) qs.set('status', status);
        const resp = await fetch('/api/cs/historico?' + qs.toString(), { headers: SucessoCliente._authHeaders() });
        const texto = await resp.text();
        let data;
        try { data = texto ? JSON.parse(texto) : {}; } catch (e) { data = null; }
        if (!resp.ok || !data) {
          const detalhe = data && data.error ? data.error : (texto || '').slice(0, 200);
          throw new Error('HTTP ' + resp.status + (detalhe ? ' — ' + detalhe : ''));
        }
        SucessoCliente._ultimoHistorico = data.tickets || []; // guardado p/ exportCSV/exportPDF sem refazer a chamada
        SucessoCliente._renderHistorico(container, SucessoCliente._ultimoHistorico);
      } catch (e) {
        SucessoCliente._ultimoHistorico = [];
        container.innerHTML =
          '<p class="radar-erro">Não foi possível carregar o histórico.</p>' +
          '<p style="font-family:monospace;font-size:12px;color:var(--gray-500)">' + SucessoCliente._esc(e.message) + '</p>';
        console.error('[SucessoCliente] filtrarHistorico()', e);
      }
    },

    // Colunas/labels compartilhadas pelos dois exports (mesmo padrão usado em
    // app.js — ver Atendimento.exportCSV/exportPDF: separador ";", BOM no CSV,
    // popup + window.print() no PDF).
    _colunasHistorico: ['abertura', 'encerramento', 'empresa', 'departamento', 'analista', 'pior_status'],
    _labelsHistorico: {
      abertura: 'Abertura', encerramento: 'Encerramento', empresa: 'Empresa',
      departamento: 'Departamento', analista: 'Analista', pior_status: 'Status SLA',
    },
    _valorHistorico(r, c) {
      if (c === 'empresa') return r.empresa_nome || r.empresa_texto || '—';
      if (c === 'abertura' || c === 'encerramento') return r[c] ? new Date(r[c]).toLocaleString('pt-BR') : '—';
      if (c === 'pior_status') {
        return r.pior_status === 'vermelho' ? 'Vermelho' : r.pior_status === 'amarelo' ? 'Amarelo' : r.pior_status === 'verde' ? 'Verde' : '—';
      }
      return r[c] ?? '—';
    },

    /** Botão "Exportar CSV" — usa os dados já carregados na tela (filtro atual aplicado). */
    exportHistoricoCSV() {
      const data = SucessoCliente._ultimoHistorico || [];
      if (!data.length) { if (window.App && App.Toast) App.Toast.err('Nenhum dado para exportar.'); return; }
      const cols = SucessoCliente._colunasHistorico;
      const labels = SucessoCliente._labelsHistorico;
      const header = cols.map(c => labels[c]).join(';');
      const rows = data.map(r => cols.map(c => `"${String(SucessoCliente._valorHistorico(r, c)).replace(/"/g, '""')}"`).join(';'));
      const csv = [header, ...rows].join('\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sucesso_cliente_historico_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (window.App && App.Toast) App.Toast.ok('CSV exportado!');
    },

    /** Botão "Exportar PDF" — mesmo padrão dos outros módulos: popup + Ctrl+P / Salvar como PDF. */
    exportHistoricoPDF() {
      const data = SucessoCliente._ultimoHistorico || [];
      if (!data.length) { if (window.App && App.Toast) App.Toast.err('Nenhum dado para exportar.'); return; }
      const cols = SucessoCliente._colunasHistorico;
      const labels = SucessoCliente._labelsHistorico;
      const rows = data.map(r =>
        '<tr>' + cols.map(c => '<td>' + SucessoCliente._esc(String(SucessoCliente._valorHistorico(r, c))) + '</td>').join('') + '</tr>'
      ).join('');
      const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Histórico — Sucesso do Cliente</title>
      <style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
      h1{font-size:15px;color:#1a4233;margin-bottom:4px}p.sub{color:#666;font-size:11px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:10px}
      th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
      td{padding:5px 8px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#f8f8f8}
      @media print{body{margin:10px}}</style></head><body>
      <h1>Grupo-E — Histórico de Atendimentos (Sucesso do Cliente)</h1>
      <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
      <table><thead><tr>${cols.map(c => '<th>' + labels[c] + '</th>').join('')}</tr></thead>
      <tbody>${rows}</tbody></table>
      <script>window.onload=()=>{window.print();}<\/script></body></html>`;
      const win = window.open('', '_blank');
      if (!win) { if (window.App && App.Toast) App.Toast.err('Permita popups para exportar PDF.'); return; }
      win.document.write(html);
      win.document.close();
      if (window.App && App.Toast) App.Toast.ok('PDF gerado — use Ctrl+P para salvar!');
    },

    _renderHistorico(container, tickets) {
      if (!tickets.length) {
        container.innerHTML = '<p style="color:var(--gray-500)">Nenhum ticket encontrado com esses filtros.</p>';
        return;
      }
      const linhas = tickets.map(SucessoCliente._linhaHistorico).join('');
      container.innerHTML =
        '<table class="radar-tabela">' +
        '<thead><tr><th></th><th>Empresa</th><th>Departamento</th><th>Analista</th><th>Abertura</th><th>Encerramento</th></tr></thead>' +
        '<tbody>' + linhas + '</tbody>' +
        '</table>';
    },

    _linhaHistorico(t) {
      const cor = t.pior_status === 'vermelho' ? '🔴' : (t.pior_status === 'amarelo' ? '🟡' : '🟢');
      const empresa = t.empresa_nome || t.empresa_texto || '(sem vínculo)';
      const fmt = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
      return (
        '<tr class="radar-linha radar-' + (t.pior_status || '') + '">' +
        '<td>' + cor + '</td>' +
        '<td>' + SucessoCliente._esc(empresa) + '</td>' +
        '<td>' + SucessoCliente._esc(t.departamento || '—') + '</td>' +
        '<td>' + SucessoCliente._esc(t.analista || '—') + '</td>' +
        '<td>' + fmt(t.abertura) + '</td>' +
        '<td>' + fmt(t.encerramento) + '</td>' +
        '</tr>'
      );
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
      const cor = t.pior_status === 'vermelho' ? '🔴' : (t.pior_status === 'amarelo' ? '🟡' : '🟢');
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
