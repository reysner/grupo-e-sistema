/* Avisos do navegador: notificação do sistema operacional + sinal sonoro + aviso na própria página.
 * Usado pelo sistema principal (sino) e pelo painel /cs (ocorrências de Qualidade). Só funciona com a página aberta
 * (não é "push": com a aba fechada o navegador não recebe). Cada pessoa liga ou desliga no próprio navegador. */
(function () {
  var CH_ATIVO = 'ge_avisos_ativo', CH_SOM = 'ge_avisos_som';
  var ctx = null, baseTitulo = null, pendentes = 0;

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function suportaNotificacao() { return typeof window.Notification !== 'undefined'; }
  function permissao() { return suportaNotificacao() ? window.Notification.permission : 'indisponivel'; }
  function ativo() { return ls(CH_ATIVO) === '1'; }
  function somLigado() { return ls(CH_SOM) !== '0'; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  /** Dois toques curtos. O navegador só libera som depois de um clique da pessoa na página: por isso a primeira vez vem do botão "Avisos". */
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      if (!ctx) ctx = new AC();
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      [[880, 0], [1175, 0.2]].forEach(function (p) {
        var o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + p[1];
        o.type = 'sine'; o.frequency.value = p[0];
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
        o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.34);
      });
    } catch (e) { /* sem som neste navegador */ }
  }

  function toast(texto, aoClicar) {
    try {
      var t = document.createElement('div');
      t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:5000;max-width:360px;background:#256050;color:#fff;border-radius:12px;padding:12px 16px;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3);cursor:pointer';
      t.textContent = texto;
      t.addEventListener('click', function () { if (t.parentNode) t.parentNode.removeChild(t); if (aoClicar) aoClicar(); });
      document.body.appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 9000);
    } catch (e) { /* sem aviso na página */ }
  }

  /** Mostra "(N)" no título da aba até a pessoa voltar para ela. */
  function marcarTitulo() {
    try {
      if (!document.hidden) return;
      if (baseTitulo === null) baseTitulo = document.title;
      pendentes++;
      document.title = '(' + pendentes + ') ' + baseTitulo;
    } catch (e) { /* sem título */ }
  }
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', function () {
    if (!document.hidden && baseTitulo !== null) { document.title = baseTitulo; baseTitulo = null; pendentes = 0; }
  });

  /** Liga os avisos (precisa vir de um clique): pede a permissão do navegador, libera o som e toca um teste. */
  async function ativar() {
    var perm = permissao();
    if (perm === 'default') { try { perm = await window.Notification.requestPermission(); } catch (e) { perm = permissao(); } }
    ls(CH_ATIVO, '1');
    beep();
    return { permissao: perm, ativo: true };
  }
  function desativar() { ls(CH_ATIVO, '0'); }
  function ligarSom(sim) { ls(CH_SOM, sim ? '1' : '0'); }

  /** Dispara um aviso: notificação do sistema (se permitida), som (se ligado) e um balão na página. Só age se os avisos estiverem ligados. */
  function alertar(o) {
    if (!ativo()) return false;
    var titulo = String(o.titulo || 'Aviso'), texto = String(o.texto || '');
    if (permissao() === 'granted') {
      try {
        var n = new window.Notification(titulo, { body: texto, tag: o.tag || undefined });
        n.onclick = function () { try { window.focus(); n.close(); } catch (e) { /* ok */ } if (o.aoClicar) o.aoClicar(); };
      } catch (e) { /* alguns navegadores só aceitam notificação por service worker */ }
    }
    if (somLigado()) beep();
    toast(titulo + (texto ? ': ' + texto : ''), o.aoClicar);
    marcarTitulo();
    return true;
  }

  /** Botões "Avisos" e "Som" dentro de `el`. aoMudar() é chamado quando a pessoa liga ou desliga. */
  function montarControle(el, opcoes) {
    if (!el) return;
    var o = opcoes || {};
    function desenhar() {
      var on = ativo(), perm = permissao();
      var dica = on ? 'Avisos ligados neste navegador. Clique para desligar.' : 'Liga a notificação do navegador e o sinal sonoro para ocorrências novas (só com esta página aberta).';
      el.innerHTML = '<span class="avisos-ctl">' +
        '<button type="button" class="avisos-btn' + (on ? ' on' : '') + '" id="avisos-btn" title="' + esc(dica) + '" aria-pressed="' + (on ? 'true' : 'false') + '">🔔 Avisos ' + (on ? 'ligados' : 'desligados') + '</button>' +
        (on ? '<button type="button" class="avisos-btn" id="avisos-som" title="Liga ou desliga o sinal sonoro" aria-pressed="' + (somLigado() ? 'true' : 'false') + '">' + (somLigado() ? '🔊 Som' : '🔇 Mudo') + '</button>' : '') +
        (on && perm === 'denied' ? '<span class="avisos-nota" title="O navegador bloqueou as notificações deste site. Libere no cadeado da barra de endereço.">⚠ notificação bloqueada no navegador (só som e balão)</span>' : '') +
        '</span>';
      var b = el.querySelector('#avisos-btn'), s = el.querySelector('#avisos-som');
      if (b) b.addEventListener('click', async function () {
        if (ativo()) desativar(); else {
          var r = await ativar();
          if (r.permissao === 'denied') window.alert('O navegador bloqueou as notificações deste site. Os avisos funcionam só com som e balão na tela. Para receber a notificação do navegador, libere no cadeado da barra de endereço e ligue de novo.');
        }
        desenhar(); if (o.aoMudar) o.aoMudar();
      });
      if (s) s.addEventListener('click', function () { ligarSom(!somLigado()); if (somLigado()) beep(); desenhar(); });
    }
    try {
      if (!document.getElementById('avisos-css')) {
        var st = document.createElement('style'); st.id = 'avisos-css';
        st.textContent = '.avisos-ctl{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}.avisos-btn{border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:999px;padding:3px 10px;font:600 12px system-ui,sans-serif;cursor:pointer}.avisos-btn.on{background:#e6f4ee;border-color:#256050;color:#256050}.avisos-nota{font:600 11px system-ui,sans-serif;color:#b45309}';
        document.head.appendChild(st);
      }
    } catch (e) { /* sem estilo */ }
    desenhar();
  }

  window.Avisos = { ativo: ativo, somLigado: somLigado, permissao: permissao, ativar: ativar, desativar: desativar, alertar: alertar, beep: beep, montarControle: montarControle };
})();
