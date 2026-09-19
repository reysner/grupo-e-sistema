// ==UserScript==
// @name         Grupo-E · Licenças da Redesim MG (alvará sanitário + funcionamento)
// @namespace    https://grupo-e-sistema-uc2w.onrender.com/
// @version      1.1.1
// @description  No Portal de Serviços da JUCEMG (logado no gov.br), consulta o licenciamento de cada empresa mineira do Grupo-E — 1 a cada 20 s — e envia a validade do alvará sanitário e o nº do alvará de funcionamento pro módulo Legalização.
// @match        https://portalservicos.jucemg.mg.gov.br/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      grupo-e-sistema-uc2w.onrender.com
// @updateURL    https://grupo-e-sistema-uc2w.onrender.com/tools/sincronizar-redesim.user.js
// @downloadURL  https://grupo-e-sistema-uc2w.onrender.com/tools/sincronizar-redesim.user.js
// ==/UserScript==

/*
 * COMO USAR: logue no Portal de Serviços da JUCEMG (gov.br) e, no menu do Tampermonkey, clique em
 * "Consultar licenças das empresas mineiras". A aba passa a navegar sozinha (Licenciamento → busca por CNPJ →
 * órgão da Prefeitura/Saúde → Voltar), UMA empresa a cada 20 segundos, e manda o resultado pro Grupo-E.
 * Só LÊ: nunca inicia nem altera licenciamento. Deixe a aba aberta; "Parar consulta" no menu interrompe.
 * Se o verificador da Cloudflare pedir "Confirme que é humano", o script espera e avisa — é só você clicar.
 * O token de sincronização fica só neste navegador (pedido 1x, num campo na própria página).
 */
(function () {
  'use strict';

  const SISTEMA = 'https://grupo-e-sistema-uc2w.onrender.com';
  const CONSULTA_URL = 'https://portalservicos.jucemg.mg.gov.br/licenciamento-web/pages/licenciamento/consultarLicenciamentoEmpresa.jsf';
  const INTERVALO_MS = 20 * 1000;      // entre o início de uma empresa e a próxima
  const ZUMBI_MS = 15 * 60 * 1000;     // se ficar parado tanto tempo, desiste sozinho
  const CHAVE = 'redesim_estado';

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const path = location.pathname;

  // ── estado (sobrevive às trocas de página) ──────────────────────────
  const estado = () => GM_getValue(CHAVE, null);
  function salvar(e) { e.atividade = Date.now(); GM_setValue(CHAVE, e); return e; }
  function parar(msg, nivel) { GM_deleteValue(CHAVE); if (msg) aviso(msg, nivel || 'ok'); }

  // ── aviso na tela ───────────────────────────────────────────────────
  function aviso(texto, nivel) {
    let el = document.getElementById('ge-redesim-aviso');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ge-redesim-aviso';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:12px 16px;border-radius:12px;' +
        'font:600 13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25)';
      document.body.appendChild(el);
    }
    el.style.background = nivel === 'erro' ? '#b42318' : nivel === 'ok' ? '#12704a' : nivel === 'atencao' ? '#b54708' : '#1a4233';
    el.textContent = 'Grupo-E · ' + texto;
  }

  // ── token de sincronização + chamadas ao Grupo-E ────────────────────
  function pedirToken() {
    return new Promise((resolve) => {
      const caixa = document.createElement('div');
      caixa.style.cssText = 'position:fixed;right:16px;bottom:80px;z-index:2147483647;width:340px;padding:16px;border-radius:14px;background:#fff;' +
        'color:#1a4233;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.3);border:2px solid #2a6e4a';
      caixa.innerHTML = '<div style="margin-bottom:8px">Grupo-E · cole o token de sincronização<br><span style="font-weight:400;color:#64748b">(só pede uma vez neste navegador)</span></div>' +
        '<input type="password" placeholder="token" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;margin-bottom:10px">' +
        '<button style="width:100%;padding:10px;border:0;border-radius:8px;background:#1a4233;color:#fff;font-weight:700;font-size:13px;cursor:pointer">Salvar e continuar</button>';
      document.body.appendChild(caixa);
      const campo = caixa.querySelector('input');
      const ok = () => { const v = campo.value.trim(); if (!v) return; GM_setValue('token', v); caixa.remove(); resolve(v); };
      caixa.querySelector('button').addEventListener('click', ok);
      campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      campo.focus();
    });
  }

  async function api(metodo, rota, corpo) {
    const token = GM_getValue('token', '') || (aviso('aguardando o token de sincronização…', 'atencao'), await pedirToken());
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: metodo,
        url: SISTEMA + '/api/data/legalizacao/' + rota,
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token },
        data: corpo ? JSON.stringify(corpo) : undefined,
        timeout: 120000,
        onload: (r) => {
          let j = {};
          try { j = JSON.parse(r.responseText); } catch (e) { /* não-JSON */ }
          if (r.status === 401) { GM_deleteValue('token'); return reject(new Error('token recusado — comece de novo e cole o token certo.')); }
          if (r.status >= 200 && r.status < 300) resolve(j);
          else reject(new Error(j.error || 'o sistema respondeu ' + r.status));
        },
        onerror: () => reject(new Error('sem conexão com o sistema Grupo-E.')),
        ontimeout: () => reject(new Error('o sistema demorou demais pra responder.')),
      });
    });
  }

  // ── utilidades de página ────────────────────────────────────────────
  const fmtCnpj = (d) => d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  function achar(seletor, re) {
    return Array.prototype.slice.call(document.querySelectorAll(seletor)).find((e) => re.test(txt(e)));
  }

  // ── passo 1: tela de busca por CNPJ ─────────────────────────────────
  async function passoBusca(e) {
    // fila vazia: pede a próxima leva ao Grupo-E
    if (!e.atual) {
      if (!e.fila.length) {
        aviso('buscando no Grupo-E as empresas mineiras que faltam conferir…');
        const r = await api('GET', 'redesim-a-consultar?limite=40');
        e.fila = r.data || [];
        if (!e.fila.length) return parar('tudo conferido! Nenhuma empresa mineira pendente (as consultas valem por 7 dias).', 'ok');
        salvar(e);
      }
      e.atual = Object.assign({ fase: 'busca', tentativas: 0, orgaos: [], abrir: [], abertos: 0 }, e.fila.shift());
      salvar(e);
    }
    const a = e.atual;

    // voltou pra cá depois de Pesquisar sem avançar: o portal não achou / recusou
    if (a.fase === 'pesquisando') {
      a.tentativas = (a.tentativas || 0) + 1;
      // o portal da JUCEMG consulta a Receita Federal; quando ela dá timeout aparece o aviso "Atenção" — fecha e tenta de novo
      const erroPortal = /indispon[ií]vel|timed out|Erro inesperado/i.test(document.body.innerText);
      const ok = achar('button, a, input[type=button]', /^OK$/i);
      if (ok) ok.click();
      if (a.tentativas >= 3) {
        if (erroPortal) { // problema do portal, não da empresa: pula SEM registrar (volta na próxima leva)
          e.pulados = (e.pulados || 0) + 1; e.falhasSeguidas = (e.falhasSeguidas || 0) + 1; e.atual = null; salvar(e);
          if (e.falhasSeguidas >= 4) return parar('parei: o portal/Receita falhou 4 vezes seguidas — tente de novo mais tarde.', 'erro');
          aviso('o portal/Receita não respondeu para ' + (a.nome_empresa || a.cnpj) + ' — pulei (volta na próxima leva).', 'atencao');
        } else {
          await api('POST', 'redesim-resultado', { cliente_id: a.cliente_id, cnpj: a.cnpj, orgaos: [], nao_encontrado: true });
          e.feitos = (e.feitos || 0) + 1; e.atual = null; salvar(e);
          aviso('CNPJ ' + fmtCnpj(a.cnpj.replace(/\D/g, '')) + ' não encontrado no portal — próxima empresa.', 'atencao');
        }
        await esperar(1500);
        return passoBusca(estado());
      }
      a.fase = 'busca'; salvar(e);
    }

    // respeita o ritmo: 1 empresa a cada 20 s
    const falta = (e.ultimoInicio || 0) + INTERVALO_MS - Date.now();
    if (falta > 0) { aviso('próxima empresa em ' + Math.ceil(falta / 1000) + 's… (' + (e.feitos || 0) + ' feitas)'); await esperar(falta); }

    const campo = document.getElementById('inputIdentificador');
    if (!campo) return parar('não achei o campo de CNPJ — o portal mudou?', 'erro');
    aviso('consultando ' + (a.nome_empresa || a.cnpj) + '…');

    // espera o verificador da Cloudflare (passa sozinho; se pedir clique, avisa)
    let esperou = 0, avisou = false;
    const token = () => { const i = document.querySelector('input[name="cf-turnstile-response"]'); return i && i.value; };
    while (!token()) {
      await esperar(500); esperou += 500;
      if (esperou > 20000 && !avisou) {
        avisou = true;
        aviso('clique em "Confirme que é humano" (Cloudflare) para eu continuar', 'atencao');
        try { GM_notification({ title: 'Grupo-E · Redesim', text: 'Clique em "Confirme que é humano" na aba da JUCEMG.', timeout: 15000 }); } catch (x) { /* sem notificação */ }
      }
      if (esperou > 10 * 60 * 1000) return parar('parei: o verificador da Cloudflare não foi confirmado em 10 minutos.', 'erro');
      if (!estado()) return; // usuário mandou parar
    }

    aviso('pesquisando ' + (a.nome_empresa || a.cnpj) + '…'); // apaga o aviso laranja do verificador, se houve
    // o portal limpa o campo ao validar; preenche por último
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(campo, fmtCnpj(a.cnpj.replace(/\D/g, '')));
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    campo.dispatchEvent(new Event('change', { bubbles: true }));
    await esperar(600);

    const btn = achar('button, input[type=submit], a', /^Pesquisar$/i) || document.querySelector('button.btn-primary');
    if (!btn) return parar('não achei o botão Pesquisar — o portal mudou?', 'erro');
    a.fase = 'pesquisando'; e.ultimoInicio = Date.now(); salvar(e);
    btn.click();
  }

  // ── passo 2: "Dados públicos do Empreendimento" (lista de órgãos) ───
  function lerSecoes() {
    // percorre a página na ordem: títulos "Licenciamento - ..." e as tabelas que vêm depois deles
    // títulos <h3> "Licenciamento - Órgãos Estaduais" / "Licenciamento - Prefeitura de X", cada um seguido da tabela Órgão|Situação|Grau de risco|Ações
    const secoes = [];
    let atual = null;
    document.querySelectorAll('h3, table').forEach((n) => {
      if (n.tagName === 'H3') {
        const t = txt(n);
        if (/^Licenciamento\s*-\s*\S/.test(t)) { atual = { titulo: t, linhas: [] }; secoes.push(atual); } else atual = null;
      } else if (atual && /[ÓO]rg[ãa]o/i.test(txt(n.querySelector('thead') || n.querySelector('tr')))) {
        Array.prototype.slice.call(n.querySelectorAll('tbody tr')).forEach((tr) => {
          const cel = Array.prototype.slice.call(tr.querySelectorAll('td')).map(txt);
          const link = Array.prototype.slice.call(tr.querySelectorAll('a')).find((x) => /^Visualizar$/i.test(txt(x)));
          if (cel.length >= 2 && cel[0]) atual.linhas.push({ orgao: cel[0], situacao: cel[1], risco: cel[2] && !/Visualizar|Orienta/i.test(cel[2]) ? cel[2] : '', temLink: !!link });
        });
      }
    });
    return secoes;
  }

  async function passoLista(e) {
    const a = e.atual;
    if (!a) return;
    if (a.fase === 'pesquisando') { // acabou de chegar da busca: lê a lista
      const secoes = lerSecoes();
      const municipais = secoes.filter((s) => /prefeitura/i.test(s.titulo));
      a.orgaos = [];
      a.abrir = [];
      municipais.forEach((s) => s.linhas.forEach((l) => {
        a.orgaos.push({ orgao: l.orgao, situacao: l.situacao, risco: l.risco });
        if (l.temLink) a.abrir.push(l.orgao);
      }));
      a.semLic = municipais.length === 0 || !a.orgaos.length;
      a.abertos = 0;
      a.fase = 'detalhes';
      salvar(e);
    }
    // ainda há órgão pra abrir? clica no "Visualizar" da linha correspondente
    if (a.abertos < a.abrir.length) {
      const alvo = a.abrir[a.abertos];
      const linhas = Array.prototype.slice.call(document.querySelectorAll('table'))
        .filter((t) => /[ÓO]rg[ãa]o/i.test(txt(t.querySelector('thead') || t.querySelector('tr'))))
        .reduce((acc, t) => acc.concat(Array.prototype.slice.call(t.querySelectorAll('tbody tr'))), []);
      const tr = linhas.find((l) => txt(l).toUpperCase().indexOf(alvo.toUpperCase()) >= 0);
      const link = tr && Array.prototype.slice.call(tr.querySelectorAll('a')).find((x) => /^Visualizar$/i.test(txt(x)));
      if (!link) { a.abertos++; salvar(e); return passoLista(estado()); }
      aviso('lendo ' + alvo + '…');
      await esperar(800);
      link.click();
      return;
    }
    await concluirEmpresa(e);
  }

  // ── passo 3: detalhes de um órgão ───────────────────────────────────
  function lerDetalhe() {
    const t = document.body.innerText;
    const pega = (re) => { const m = re.exec(t); return m ? m[1].trim() : ''; };
    return {
      orgao: pega(/[óo]rg[ãa]o\s+(.+?)\s+encontra-se/i),
      situacao: pega(/status:\s*([^\n]+)/i),
      risco: pega(/Grau de risco do estabelecimento:\s*([^\n]+)/i),
      documento: pega(/Documentos:\s*\n+\s*([^\n]+)/i),
      validade: pega(/Validade:\s*(\d{2}\/\d{2}\/\d{4})/i),
      alvara: pega(/Alvar[áa]:\s*\n*\s*([^\n]+)/i),
      observacao: pega(/Observa[çc][ãa]o:\s*\n*\s*([^\n]+)/i),
      link: pega(/Link:\s*\n*\s*(https?:\/\/\S+)/i),
    };
  }

  async function passoDetalhe(e) {
    const a = e.atual;
    if (!a) return;
    const d = lerDetalhe();
    const base = a.orgaos.find((o) => d.orgao && o.orgao.toUpperCase().indexOf(d.orgao.toUpperCase()) >= 0 || d.orgao.toUpperCase().indexOf(o.orgao.toUpperCase()) >= 0);
    if (base) Object.assign(base, d); else a.orgaos.push(d);
    a.abertos++;
    salvar(e);
    await esperar(800);
    const voltar = achar('a, button, input[type=button], input[type=submit]', /^Voltar$/i) || document.querySelector('input[value="Voltar"]');
    if (voltar) voltar.click(); else location.href = CONSULTA_URL;
  }

  async function concluirEmpresa(e) {
    const a = e.atual;
    try {
      const r = await api('POST', 'redesim-resultado', { cliente_id: a.cliente_id, cnpj: a.cnpj, orgaos: a.orgaos.filter((o) => o.situacao !== undefined), sem_licenciamento: !!a.semLic });
      e.feitos = (e.feitos || 0) + 1; e.falhasSeguidas = 0;
      if (r.sanitario) e.sanitarios = (e.sanitarios || 0) + 1;
      aviso((a.nome_empresa || a.cnpj) + ': ' + (r.sanitario ? 'sanitário vence ' + r.sanitario.split('-').reverse().join('/') : a.semLic ? 'sem licenciamento na Redesim' : 'lido') + ' · ' + e.feitos + ' feitas', 'ok');
    } catch (err) {
      return parar('erro ao enviar: ' + err.message, 'erro');
    }
    e.atual = null; salvar(e);
    location.href = CONSULTA_URL;
  }

  // ── roteamento por página ───────────────────────────────────────────
  // Botão fixo na página (canto inferior esquerdo): iniciar / parar, sem depender do menu do Tampermonkey.
  function controle(ativo) {
    if (!document.body) return;
    let b = document.getElementById('ge-redesim-ctrl');
    if (!b) {
      b = document.createElement('button');
      b.id = 'ge-redesim-ctrl';
      b.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:11px 16px;border:0;border-radius:12px;cursor:pointer;' +
        'font:700 13px system-ui,sans-serif;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25)';
      document.body.appendChild(b);
    }
    b.style.background = ativo ? '#b42318' : '#12704a';
    b.textContent = ativo ? '■ Parar consulta (Grupo-E)' : '▶ Consultar licenças (Grupo-E)';
    b.onclick = () => {
      if (ativo) { parar('consulta interrompida.', 'atencao'); controle(false); return; }
      salvar({ fila: [], atual: null, feitos: 0, sanitarios: 0, ultimoInicio: 0 });
      location.href = CONSULTA_URL;
    };
  }

  async function rodar() {
    const e = estado();
    controle(!!e);
    if (!e) return;
    if (Date.now() - (e.atividade || 0) > ZUMBI_MS) return parar('consulta antiga demais — recomece pelo menu.', 'atencao');
    try {
      if (path.indexOf('consultarLicenciamentoEmpresa') >= 0) await passoBusca(e);
      else if (path.indexOf('dadosPublicosLicenciamento') >= 0) await passoLista(e);
      else if (path.indexOf('detalhesPublicosLicenciamentoOrgao') >= 0) await passoDetalhe(e);
      else if (path.indexOf('/Portal/') >= 0 || path.indexOf('licenciamento-web') >= 0) { aviso('voltando pra tela de licenciamento…'); await esperar(1200); location.href = CONSULTA_URL; }
    } catch (err) {
      parar('parei: ' + err.message, 'erro');
    }
  }

  GM_registerMenuCommand('Consultar licenças das empresas mineiras', () => {
    salvar({ fila: [], atual: null, feitos: 0, sanitarios: 0, ultimoInicio: 0 });
    location.href = CONSULTA_URL;
  });
  GM_registerMenuCommand('Parar consulta', () => parar('consulta interrompida.', 'atencao'));
  GM_registerMenuCommand('Trocar o token do Grupo-E', () => { GM_deleteValue('token'); aviso('token apagado — será pedido de novo.', 'ok'); });

  rodar();
})();
