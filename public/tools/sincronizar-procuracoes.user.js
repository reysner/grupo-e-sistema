// ==UserScript==
// @name         Grupo-E · Sincronizar procurações (e-CAC + FGTS Digital)
// @namespace    https://grupo-e-sistema-uc2w.onrender.com/
// @version      1.0.0
// @description  Ao abrir as procurações recebidas no e-CAC ou no SPE (FGTS Digital), lê a lista completa e envia pro sistema Grupo-E (módulo Legalização).
// @match        https://servicos.receitafederal.gov.br/servico/autorizacoes/*
// @match        https://spe.sistema.gov.br/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      grupo-e-sistema-uc2w.onrender.com
// @updateURL    https://grupo-e-sistema-uc2w.onrender.com/tools/sincronizar-procuracoes.user.js
// @downloadURL  https://grupo-e-sistema-uc2w.onrender.com/tools/sincronizar-procuracoes.user.js
// ==/UserScript==

/*
 * Só LÊ as procurações RECEBIDAS pelo escritório (nunca clica em Cancelar/Revogar) e
 * envia pro sistema Grupo-E, que grava só o que mudou. Roda sozinho quando você abre:
 *   - e-CAC → Autorizações de Acesso → Minhas Autorizações de Acesso
 *   - FGTS Digital → Procurações (SPE)
 * No máximo 1x a cada 6 horas por portal (ou pelo menu do Tampermonkey: "Sincronizar agora").
 * O token de sincronização fica só neste navegador (pedido na 1ª vez), nunca dentro deste arquivo.
 */
(function () {
  'use strict';

  const SISTEMA = 'https://grupo-e-sistema-uc2w.onrender.com';
  const CNPJ_ESCRITORIO = '25549775000141'; // Escritorial — só sincroniza logado como o escritório
  const INTERVALO_MS = 6 * 60 * 60 * 1000;

  const ehEcac = location.hostname === 'servicos.receitafederal.gov.br';
  const tipo = ehEcac ? 'ecac' : 'fgts';
  const rotulo = ehEcac ? 'E-CAC' : 'FGTS Digital';
  const chaveUltimo = 'ultimo_' + tipo;
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const br = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

  // ── aviso na tela ─────────────────────────────────────────────────────
  function aviso(texto, nivel) {
    const montar = () => {
      let el = document.getElementById('ge-sync-aviso');
      if (!el) {
        el = document.createElement('div');
        el.id = 'ge-sync-aviso';
        el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:340px;padding:12px 16px;border-radius:12px;' +
          'font:600 13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25)';
        document.body.appendChild(el);
      }
      el.style.background = nivel === 'erro' ? '#b42318' : nivel === 'ok' ? '#12704a' : '#1a4233';
      el.textContent = 'Grupo-E · ' + texto;
      clearTimeout(el._t);
      if (nivel) el._t = setTimeout(() => el.remove(), nivel === 'erro' ? 25000 : 9000);
    };
    if (document.body) montar(); else document.addEventListener('DOMContentLoaded', montar, { once: true });
  }

  // ── e-CAC: a API exige o cabeçalho x-hv que a PRÓPRIA página manda; pegamos dele ──
  let xhv = null;
  if (ehEcac) {
    const proto = unsafeWindow.XMLHttpRequest.prototype;
    const original = proto.setRequestHeader;
    proto.setRequestHeader = function (nome, valor) {
      if (String(nome).toLowerCase() === 'x-hv') xhv = valor;
      return original.apply(this, arguments);
    };
  }

  async function lerEcac() {
    for (let i = 0; i < 60 && !xhv; i++) await esperar(500);
    if (!xhv) throw new Error('não consegui identificar a sessão do portal. Abra "Minhas Autorizações de Acesso" e tente de novo.');
    const r = await fetch('/servico/autorizacoes/api/autorizacoes/recebidas/buscar', {
      credentials: 'include', headers: { 'x-hv': xhv, Accept: 'application/json, text/plain, */*' },
    });
    if (!r.ok) throw new Error('a Receita respondeu ' + r.status + ' (entre de novo no e-CAC).');
    const j = await r.json();
    const lista = j.lista || [];
    if (!lista.length) throw new Error('a lista de procurações veio vazia — nada foi enviado.');
    if (lista.some((p) => p.outorgado && p.outorgado.ni !== CNPJ_ESCRITORIO)) {
      throw new Error('você não está logado como o escritório (perfil diferente) — nada foi enviado.');
    }
    return {
      completo: !!j.cabecalho && j.cabecalho.qtdEncontrada === lista.length,
      procuracoes: lista
        .filter((p) => p.situacao === 'ATIVA' || p.situacao === 'EXPIRADA')
        .map((p) => ({ cnpj: p.outorgante.ni, validade: br(p.fimVigencia), situacao: p.situacao.toLowerCase() })),
    };
  }

  // ── FGTS Digital (SPE): 0 = Ativa, 3 = Expirada; as demais (revogada etc.) = sem dados ──
  async function lerSpe() {
    const todas = [];
    let pagina = 1, total = 0;
    do {
      const url = location.origin + '/api/v1/procuracoes/pesquisa?niParte=&nomeParte=&data=&status=&tipoParte=outorgado&itensPorPagina=500&paginaAtual=' + pagina;
      const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json, text/plain, */*' } });
      if (!r.ok) throw new Error('o SPE respondeu ' + r.status + ' (entre de novo no FGTS Digital).');
      const j = await r.json();
      total = (j.pageMetadata && j.pageMetadata.totalItems) || 0;
      todas.push(...(j.content || []));
      pagina++;
    } while (todas.length < total && pagina < 20);
    if (!todas.length) throw new Error('a lista de procurações veio vazia — nada foi enviado.');
    if (todas.some((p) => p.niOutorgado !== CNPJ_ESCRITORIO)) {
      throw new Error('você não está logado como o escritório (perfil diferente) — nada foi enviado.');
    }
    const nome = { 0: 'ativa', 3: 'expirada' };
    return {
      completo: todas.length === total,
      procuracoes: todas
        .filter((p) => p.status in nome)
        .map((p) => ({ cnpj: p.niOutorgante, validade: br(p.dataFimVigencia), situacao: nome[p.status] })),
    };
  }

  // ── envio pro sistema Grupo-E ─────────────────────────────────────────
  function pedirToken() {
    const t = (prompt('Grupo-E — cole o token de sincronização (só pede uma vez neste navegador):') || '').trim();
    if (t) GM_setValue('token', t);
    return t;
  }

  function enviar(dados) {
    return new Promise((resolve, reject) => {
      const token = GM_getValue('token', '') || pedirToken();
      if (!token) return reject(new Error('sem token de sincronização.'));
      GM_xmlhttpRequest({
        method: 'POST',
        url: SISTEMA + '/api/data/legalizacao/procuracoes/importar',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token },
        data: JSON.stringify(Object.assign({ tipo }, dados)),
        timeout: 180000,
        onload: (r) => {
          let j = {};
          try { j = JSON.parse(r.responseText); } catch (e) { /* resposta não-JSON */ }
          if (r.status === 401) { GM_deleteValue('token'); return reject(new Error('token recusado — recarregue a página e cole o token certo.')); }
          if (r.status >= 200 && r.status < 300) resolve(j);
          else reject(new Error(j.error || 'o sistema respondeu ' + r.status));
        },
        onerror: () => reject(new Error('sem conexão com o sistema Grupo-E.')),
        ontimeout: () => reject(new Error('o sistema demorou demais pra responder.')),
      });
    });
  }

  let rodando = false;
  async function sincronizar(forcar) {
    if (rodando) return;
    if (!forcar && Date.now() - GM_getValue(chaveUltimo, 0) < INTERVALO_MS) return;
    rodando = true;
    try {
      aviso('sincronizando procurações ' + rotulo + '…');
      const dados = ehEcac ? await lerEcac() : await lerSpe();
      const r = await enviar(dados);
      GM_setValue(chaveUltimo, Date.now());
      aviso('procurações ' + rotulo + ' em dia: ' + r.atualizados + ' atualizada(s)' + (r.limpos ? ', ' + r.limpos + ' zerada(s)' : '') + '.', 'ok');
    } catch (e) {
      aviso('não sincronizou (' + e.message + ')', 'erro');
    } finally {
      rodando = false;
    }
  }

  GM_registerMenuCommand('Sincronizar procurações agora', () => sincronizar(true));
  GM_registerMenuCommand('Trocar o token do Grupo-E', () => { GM_deleteValue('token'); pedirToken(); });

  // só na tela de procurações recebidas (não em toda página do portal)
  const naTela = ehEcac ? location.pathname.includes('/minhas-autorizacoes') : location.pathname.startsWith('/procuracao');
  if (naTela) window.addEventListener('load', () => setTimeout(() => sincronizar(false), 3000));
})();
