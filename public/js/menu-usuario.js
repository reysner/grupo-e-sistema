/* Menu do usuário (nome + perfil, Editar perfil, Sair) — usado em /cs, /financeiro e /legalizacao.
 * Uso: MenuUsuario.montar({ alvo, usuario, chamar, aoSair, aoAtualizar, rotulos })
 *   alvo        elemento onde o menu é colocado
 *   usuario     { name, email, role }
 *   chamar      function (url, opcoes) -> Promise<Response>   (a página põe o token e renova a sessão)
 *   aoSair      function ()
 *   aoAtualizar function (usuario)   chamado depois de salvar o perfil, para guardar o novo nome/e-mail
 *   rotulos     { role: 'Texto' }    opcional, troca o texto da etiqueta de perfil
 * O modal "Editar perfil" fica no próprio módulo; o servidor confere a senha atual (PATCH /api/data/perfil).
 */
(function (global) {
  'use strict';
  var ROTULOS = { administrador: 'Administrador', usuario: 'Usuário', contabil: 'Contábil', colaborador: 'Colaborador' };
  var CSS = '' +
    '.mu-wrap{position:relative;display:inline-block}' +
    '.mu-btn{display:flex;align-items:center;gap:8px;background:transparent;color:var(--text,#1e293b);border:1px solid var(--border,#cbd5e1);padding:6px 12px;border-radius:9px;cursor:pointer;font-weight:600;font-size:13px;line-height:1.2;font-family:inherit}' +
    '.mu-btn:hover{background:var(--surface2,#f1f5f9);border-color:var(--text3,#94a3b8)}' +
    '.mu-btn:focus-visible{outline:2px solid #f5c518;outline-offset:2px}' +
    '.mu-papel{background:#f5c518;color:#1a4233;font-size:10.5px;font-weight:800;letter-spacing:.4px;padding:3px 9px;border-radius:999px;text-transform:uppercase}' +
    '.mu-seta{font-size:10px;opacity:.85}' +
    '.mu-menu{position:absolute;right:0;top:calc(100% + 8px);background:#fff;color:#334155;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.2);min-width:240px;overflow:hidden;z-index:900;display:none}' +
    '.mu-menu.aberto{display:block}' +
    '.mu-cab{padding:14px 16px;border-bottom:1px solid #eef2f7}' +
    '.mu-nome{font-weight:700;color:#1a4233;font-size:14px;overflow-wrap:anywhere}' +
    '.mu-email{color:#94a3b8;font-size:12px;margin-top:2px;overflow-wrap:anywhere}' +
    '.mu-item{display:flex;align-items:center;gap:8px;padding:11px 16px;cursor:pointer;font-weight:500;font-size:13px;line-height:1.2;font-family:inherit;color:#334155;background:none;border:none;width:100%;text-align:left}' +
    '.mu-item:hover{background:#f8fafc}' +
    '.mu-item.perigo{color:#e53e3e}' +
    '.mu-fundo{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:1000;padding:20px}' +
    '.mu-fundo.aberto{display:flex}' +
    '.mu-caixa{background:#fff;color:#334155;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.25);width:100%;max-width:460px;max-height:90vh;overflow-y:auto}' +
    '.mu-caixa-cab{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #eef2f7}' +
    '.mu-caixa-cab h2{font-size:16px;color:#1a4233;margin:0}' +
    '.mu-x{background:none;border:none;font-size:22px;cursor:pointer;color:#94a3b8;line-height:1}' +
    '.mu-corpo{padding:20px 22px}' +
    '.mu-campo{display:flex;flex-direction:column;gap:4px;margin-bottom:14px}' +
    '.mu-campo label{font-size:12px;font-weight:600;color:#64748b}' +
    '.mu-campo input{padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-family:inherit;color:#1e293b;background:#fff}' +
    '.mu-campo input:focus{outline:2px solid #1a4233;outline-offset:0;border-color:#1a4233}' +
    '.mu-dica{font-size:12px;color:#94a3b8;margin:4px 0 12px}' +
    '.mu-linha{border:none;border-top:1px solid #eef2f7;margin:14px 0}' +
    '.mu-erro{color:#b42318;font-size:13px;min-height:18px;margin:0 0 8px}' +
    '.mu-acoes{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}' +
    '.mu-cancelar{background:#fff;border:1px solid #cbd5e1;color:#334155;padding:9px 16px;border-radius:8px;font-weight:600;font-size:13px;line-height:1;font-family:inherit;cursor:pointer}' +
    '.mu-salvar{background:#1a4233;border:none;color:#fff;padding:10px 20px;border-radius:8px;font-weight:700;font-size:13px;line-height:1;font-family:inherit;cursor:pointer}' +
    '.mu-salvar:disabled{opacity:.6;cursor:default}' +
    '.mu-ok{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#1a4233;color:#fff;padding:11px 18px;border-radius:10px;font-size:13.5px;font-weight:600;z-index:1100;box-shadow:0 6px 20px rgba(0,0,0,.25)}';

  function el(tag, classe, texto) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }
  function campo(rotulo, id, tipo, valor, dica) {
    var d = el('div', 'mu-campo');
    var l = el('label', null, rotulo); l.setAttribute('for', id);
    var i = el('input'); i.id = id; i.type = tipo; if (valor != null) i.value = valor; if (dica) i.placeholder = dica;
    i.autocomplete = tipo === 'password' ? 'current-password' : 'off';
    d.appendChild(l); d.appendChild(i);
    return d;
  }

  var estiloPosto = false;
  function colocarEstilo() {
    if (estiloPosto) return;
    var s = document.createElement('style'); s.setAttribute('data-menu-usuario', '1'); s.textContent = CSS;
    document.head.appendChild(s); estiloPosto = true;
  }

  function montar(opc) {
    colocarEstilo();
    var u = Object.assign({}, opc.usuario || {});
    var rotulos = Object.assign({}, ROTULOS, opc.rotulos || {});
    var alvo = opc.alvo;
    if (alvo.__mu) { alvo.__mu.atualizar(opc.usuario); return alvo.__mu; } // já montado (a página recarrega os dados)
    alvo.textContent = '';

    var wrap = el('div', 'mu-wrap');
    var btn = el('button', 'mu-btn'); btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true'); btn.setAttribute('aria-expanded', 'false');
    var nomeBtn = el('span'); var papel = el('span', 'mu-papel'); var seta = el('span', 'mu-seta', '▼');
    btn.appendChild(nomeBtn); btn.appendChild(papel); btn.appendChild(seta);

    var menu = el('div', 'mu-menu');
    var cab = el('div', 'mu-cab'); var nomeMenu = el('div', 'mu-nome'); var emailMenu = el('div', 'mu-email');
    cab.appendChild(nomeMenu); cab.appendChild(emailMenu);
    var bEditar = el('button', 'mu-item', '✏️ Editar perfil'); bEditar.type = 'button';
    var bSair = el('button', 'mu-item perigo', '⏻ Sair'); bSair.type = 'button';
    menu.appendChild(cab); menu.appendChild(bEditar); menu.appendChild(bSair);
    wrap.appendChild(btn); wrap.appendChild(menu); alvo.appendChild(wrap);

    function preencher() {
      nomeBtn.textContent = u.name || '';
      papel.textContent = rotulos[u.role] || rotulos.colaborador;
      nomeMenu.textContent = u.name || '';
      emailMenu.textContent = u.email || '';
    }
    function abrirMenu(v) {
      menu.classList.toggle('aberto', v);
      btn.setAttribute('aria-expanded', v ? 'true' : 'false');
    }
    btn.addEventListener('click', function (e) { e.stopPropagation(); abrirMenu(!menu.classList.contains('aberto')); });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) abrirMenu(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { abrirMenu(false); fechar(); } });
    bSair.addEventListener('click', function () { abrirMenu(false); if (opc.aoSair) opc.aoSair(); });

    // modal
    var fundo = el('div', 'mu-fundo'); fundo.setAttribute('role', 'dialog'); fundo.setAttribute('aria-modal', 'true'); fundo.setAttribute('aria-label', 'Editar perfil');
    var caixa = el('div', 'mu-caixa'); var caixaCab = el('div', 'mu-caixa-cab');
    var x = el('button', 'mu-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Fechar');
    caixaCab.appendChild(el('h2', null, 'Editar perfil')); caixaCab.appendChild(x);
    var corpo = el('div', 'mu-corpo'); caixa.appendChild(caixaCab); caixa.appendChild(corpo); fundo.appendChild(caixa);
    document.body.appendChild(fundo);
    fundo.addEventListener('click', function (e) { if (e.target === fundo) fechar(); });
    x.addEventListener('click', fechar);

    function fechar() { fundo.classList.remove('aberto'); }
    function aviso(texto) {
      var a = el('div', 'mu-ok', texto); a.setAttribute('role', 'status'); document.body.appendChild(a);
      setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 2800);
    }
    function abrirPerfil() {
      abrirMenu(false);
      corpo.textContent = '';
      corpo.appendChild(campo('Nome', 'mu-nome-inp', 'text', u.name || ''));
      corpo.appendChild(campo('E-mail', 'mu-email-inp', 'email', u.email || ''));
      corpo.appendChild(el('hr', 'mu-linha'));
      corpo.appendChild(el('div', 'mu-dica', 'Deixe os campos de senha em branco para não alterá-la.'));
      corpo.appendChild(campo('Senha atual', 'mu-senha-atual', 'password', '', 'Necessária para salvar'));
      var nova = campo('Nova senha', 'mu-senha-nova', 'password', '', 'Mínimo 6 caracteres (opcional)');
      nova.querySelector('input').autocomplete = 'new-password';
      corpo.appendChild(nova);
      var erro = el('p', 'mu-erro'); erro.setAttribute('role', 'alert'); corpo.appendChild(erro);
      var acoes = el('div', 'mu-acoes');
      var cancelar = el('button', 'mu-cancelar', 'Cancelar'); cancelar.type = 'button';
      var salvar = el('button', 'mu-salvar', 'Salvar'); salvar.type = 'button';
      acoes.appendChild(cancelar); acoes.appendChild(salvar); corpo.appendChild(acoes);
      cancelar.addEventListener('click', fechar);
      salvar.addEventListener('click', async function () {
        var nome = document.getElementById('mu-nome-inp').value.trim();
        var email = document.getElementById('mu-email-inp').value.trim();
        var atual = document.getElementById('mu-senha-atual').value;
        var novaS = document.getElementById('mu-senha-nova').value;
        erro.textContent = '';
        if (!nome || !email) { erro.textContent = 'Nome e e-mail são obrigatórios.'; return; }
        if (!atual) { erro.textContent = 'Informe sua senha atual para salvar as alterações.'; return; }
        if (novaS && novaS.length < 6) { erro.textContent = 'A nova senha deve ter ao menos 6 caracteres.'; return; }
        salvar.disabled = true; salvar.textContent = 'Salvando…';
        try {
          var r = await opc.chamar('/api/data/perfil', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome, email: email, senhaAtual: atual, senhaNova: novaS || undefined })
          });
          var j = await r.json().catch(function () { return {}; });
          if (!r.ok) { erro.textContent = j.error || 'Não foi possível atualizar o perfil.'; return; }
          u.name = nome; u.email = email;
          preencher();
          if (opc.aoAtualizar) opc.aoAtualizar(Object.assign({}, u));
          fechar();
          aviso('Perfil atualizado.');
        } catch (e) {
          erro.textContent = 'Sem conexão com o servidor. Tente de novo.';
        } finally {
          salvar.disabled = false; salvar.textContent = 'Salvar';
        }
      });
      fundo.classList.add('aberto');
      document.getElementById('mu-nome-inp').focus();
    }
    bEditar.addEventListener('click', abrirPerfil);
    preencher();
    alvo.__mu = { atualizar: function (novo) { u = Object.assign(u, novo || {}); preencher(); } };
    return alvo.__mu;
  }

  global.MenuUsuario = { montar: montar };
})(typeof window !== 'undefined' ? window : globalThis);
