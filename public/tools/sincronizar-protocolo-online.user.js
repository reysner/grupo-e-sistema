// ==UserScript==
// @name         Grupo-E · Sincronizar Protocolo Online (Prefeitura de Uberlândia)
// @namespace    https://grupo-e-sistema-uc2w.onrender.com/
// @version      1.0.0
// @description  Ao abrir "Minhas Solicitações" no Protocolo Online, lê a lista completa de processos e envia pro sistema Grupo-E (módulo Legalização), que marca como Solicitação o alvará sanitário com processo em andamento.
// @match        https://requerimento.uberlandia.mg.gov.br/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      grupo-e-sistema-uc2w.onrender.com
// @updateURL    https://grupo-e-sistema-uc2w.onrender.com/tools/sincronizar-protocolo-online.user.js
// @downloadURL  https://grupo-e-sistema-uc2w.onrender.com/tools/sincronizar-protocolo-online.user.js
// ==/UserScript==

/*
 * Só LÊ a lista de solicitações da conta logada (nunca cria, paga nem cancela nada) e envia pro sistema Grupo-E, que grava só o que mudou.
 * O login do portal é com CPF (Josiane): o servidor não entra sozinho, então a leitura acontece quando você abre o portal logado.
 *   - Automático: na rodada semanal (segunda-feira, a partir das 09:30), ao abrir "Minhas Solicitações".
 *   - Na hora: menu do Tampermonkey → "Sincronizar Protocolo Online agora".
 * O token de sincronização fica só neste navegador (pedido na 1ª vez, num campo na própria página), nunca dentro deste arquivo.
 */
(function () {
  'use strict';

  const SISTEMA = 'https://grupo-e-sistema-uc2w.onrender.com';
  const INTERVALO_MS = 6 * 24 * 60 * 60 * 1000;   // 1x por semana
  const rodadaSemanal = () => { const d = new Date(); const min = d.getHours() * 60 + d.getMinutes(); return d.getDay() === 1 && min >= 9 * 60 + 30; };
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  function aviso(texto, nivel) {
    let el = document.getElementById('ge-sync-aviso');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ge-sync-aviso';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:340px;padding:12px 16px;border-radius:12px;font:600 13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25)';
      document.body.appendChild(el);
    }
    el.style.background = nivel === 'erro' ? '#b42318' : nivel === 'ok' ? '#12704a' : '#1a4233';
    el.textContent = 'Grupo-E · ' + texto;
    clearTimeout(el._t);
    if (nivel) el._t = setTimeout(() => el.remove(), nivel === 'erro' ? 25000 : 9000);
  }

  /** O portal guarda a sessão no localStorage ("token") e a API a recebe no cabeçalho X-Session-Data. O id do usuário vem do próprio token do portal. */
  function sessao() {
    const token = localStorage.getItem('token');
    let usuario = null;
    try { const u = JSON.parse(localStorage.getItem('usuarioLogado') || 'null'); usuario = u && (u.oidUsuario || u.oid || u.id || null); } catch (e) { /* segue */ }
    return { token, usuario };
  }

  async function lerSolicitacoes() {
    const { token } = sessao();
    if (!token) throw new Error('entre no Protocolo Online (login com CPF) e tente de novo.');
    // o id do usuário aparece na própria chamada que a página faz ao abrir "Minhas Solicitações"; se não achar no cadastro local, usa o da primeira chamada da página
    let oid = null;
    try { const u = JSON.parse(localStorage.getItem('usuarioLogado') || 'null'); oid = u && (u.oidUsuario || (u.usuario && u.usuario.oidUsuario) || null); } catch (e) { /* segue */ }
    if (!oid) {
      const visto = performance.getEntriesByType('resource').map((e) => e.name).map((n) => /usuarios\/ativo\?oidUsuario=(\d+)/.exec(n)).filter(Boolean).pop();
      oid = visto && visto[1];
    }
    if (!oid) throw new Error('não consegui identificar o usuário do portal. Abra "Minhas Solicitações" e tente de novo.');
    const r = await fetch('/requerimentoonline/solicitacoes-requerimentos/oidUsuario/' + oid + '/0/1000/-1/-1', { headers: { 'X-Session-Data': token, Accept: 'application/json' } });
    if (!r.ok) throw new Error('o portal respondeu ' + r.status + ' (entre de novo no Protocolo Online).');
    const j = await r.json();
    const lista = j.content || [];
    if (!lista.length) throw new Error('a lista de solicitações veio vazia — nada foi enviado.');
    if (j.totalElements && j.totalElements > lista.length) throw new Error('a lista veio incompleta (' + lista.length + ' de ' + j.totalElements + ') — nada foi enviado.');
    return lista.map((x) => ({
      protocolo: x.nrProtocolo, data: x.dtSolicitacao, cod: x.idAprovado, situacao: x.textoAprovado, descricao: x.dsAprovado, pagamento: x.textoPagamento,
      modelo: x.nmTemplateRequerimento, cnpj: x.nrCpfCnpjPessoa, cnpj_estab: x.nrCpfCnpjEstabelecimento, nome: x.nmPessoa, ult_alter: x.dtUltAlter,
    }));
  }

  function pedirToken() {
    return new Promise((resolve) => {
      const caixa = document.createElement('div');
      caixa.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;padding:14px;border-radius:12px;background:#1a4233;color:#fff;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
      caixa.innerHTML = '<div style="margin-bottom:8px">Grupo-E · cole o token de sincronização (uma vez só):</div><input type="password" style="width:100%;box-sizing:border-box;padding:6px;border-radius:6px;border:0" /><button style="margin-top:8px;padding:6px 12px;border-radius:6px;border:0;background:#f5c518;font-weight:700;cursor:pointer">Salvar</button>';
      document.body.appendChild(caixa);
      caixa.querySelector('button').onclick = () => { const v = caixa.querySelector('input').value.trim(); if (v) { caixa.remove(); resolve(v); } };
    });
  }

  function enviar(solicitacoes, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url: SISTEMA + '/api/data/legalizacao/protocolo-online', timeout: 120000,
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token }, data: JSON.stringify({ solicitacoes }),
        onload: (r) => { let j = {}; try { j = JSON.parse(r.responseText); } catch (e) { /* segue */ } if (r.status >= 200 && r.status < 300) resolve(j); else reject(Object.assign(new Error(j.error || ('o sistema respondeu ' + r.status)), { status: r.status })); },
        onerror: () => reject(new Error('sem conexão com o sistema Grupo-E.')), ontimeout: () => reject(new Error('o sistema Grupo-E demorou demais para responder.')),
      });
    });
  }

  let rodando = false;
  async function sincronizar(manual) {
    if (rodando) return; rodando = true;
    try {
      if (!manual && Date.now() - Number(GM_getValue('ultimo', 0)) < INTERVALO_MS) return;
      aviso('lendo as solicitações do Protocolo Online…');
      const lista = await lerSolicitacoes();
      let token = GM_getValue('token', '') || await pedirToken();
      try { GM_setValue('token', token); const r = await enviar(lista, token); GM_setValue('ultimo', Date.now()); aviso('Protocolo Online lido: ' + r.solicitacoes + ' solicitação(ões); ' + r.aplicados + ' alvará(s) sanitário(s) em andamento marcado(s) como Solicitação' + (r.removidos ? ', ' + r.removidos + ' protocolo(s) encerrado(s)' : '') + '.', 'ok'); }
      catch (e) { if (e.status === 401) { GM_deleteValue('token'); throw new Error('token de sincronização recusado: rode de novo para informar o token certo.'); } throw e; }
    } catch (e) { aviso(e.message || String(e), 'erro'); }
    finally { rodando = false; }
  }

  GM_registerMenuCommand('Sincronizar Protocolo Online agora', () => sincronizar(true));
  GM_registerMenuCommand('Trocar o token do Grupo-E', () => { GM_deleteValue('token'); sincronizar(true); });

  // automático: só na rodada semanal e só na tela "Minhas Solicitações"
  if (rodadaSemanal()) (async () => { for (let i = 0; i < 40; i++) { if (/\/solicitacao\b/.test(location.pathname) && sessao().token) { await esperar(2500); return sincronizar(false); } await esperar(1500); } })();
})();
