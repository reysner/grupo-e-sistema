/* Avisos do navegador: notificação do sistema operacional + sinal sonoro + aviso na própria página + push (com a página fechada).
 * Usado pelo sistema principal (sino) e pelo painel /cs (ocorrências de Qualidade). Cada pessoa liga ou desliga no próprio navegador.
 * Com a página aberta: notificação, som e balão. Com a página fechada: o push (service worker /sw.js) mostra a notificação do sistema. */
(function () {
  var CH_ATIVO = 'ge_avisos_ativo', CH_SOM = 'ge_avisos_som', CH_PUSH = 'ge_push_ok';
  var ctx = null, baseTitulo = null, pendentes = 0, tokenFn = null, navegarFn = null, ouvindoSW = false;
  var vistos = [];   // tags já avisadas nesta sessão (o mesmo fato pode chegar pelo push e pela consulta periódica)

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function suportaNotificacao() { return typeof window.Notification !== 'undefined'; }
  function permissao() { return suportaNotificacao() ? window.Notification.permission : 'indisponivel'; }
  function ativo() { return ls(CH_ATIVO) === '1'; }
  function somLigado() { return ls(CH_SOM) !== '0'; }
  function pushAtivo() { return ls(CH_PUSH) === '1'; }
  function suportaPush() { return !!(typeof navigator !== 'undefined' && navigator.serviceWorker && typeof window.PushManager !== 'undefined'); }
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

  /** Abre a tela de um aviso: a página pode definir como navegar (sem recarregar); senão vai para o endereço. */
  function abrir(url) {
    if (!url) return;
    if (navegarFn) { try { navegarFn(url); return; } catch (e) { /* cai no padrão */ } }
    try { window.location.href = url; } catch (e) { /* sem navegação */ }
  }
  /** true se este fato já foi avisado nesta sessão (tag igual); registra a tag. */
  function jaAvisado(tag) {
    if (!tag) return false;
    if (vistos.indexOf(tag) >= 0) return true;
    vistos.push(tag); if (vistos.length > 80) vistos.shift();
    return false;
  }

  // ── push (com a página fechada) ──
  function chaveParaBytes(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4), base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/'), raw = window.atob(base), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function chamar(caminho, corpo) {
    var o = { headers: { Authorization: 'Bearer ' + (tokenFn ? tokenFn() : '') } };
    if (corpo !== undefined) { o.method = 'POST'; o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(corpo); }
    var r = await fetch(caminho, o);
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || 'Erro ' + r.status);
    return j;
  }
  /** Cadastra este aparelho no servidor para receber os avisos com a página fechada. Devolve 'ok' ou o motivo de não ter sido possível. */
  async function inscreverPush() {
    if (!tokenFn || !suportaPush()) return 'indisponivel';
    if (permissao() !== 'granted') return 'sem-permissao';
    try {
      var reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes((await chamar('/api/push/chave')).chave) });
      await chamar('/api/push/assinar', { subscription: sub.toJSON ? sub.toJSON() : sub });
      ls(CH_PUSH, '1');
      return 'ok';
    } catch (e) { ls(CH_PUSH, null); return 'falhou'; }
  }
  async function cancelarPush() {
    ls(CH_PUSH, null);
    try {
      if (!suportaPush()) return;
      var reg = await navigator.serviceWorker.getRegistration('/sw.js');
      var sub = reg && await reg.pushManager.getSubscription();
      if (sub) { try { if (tokenFn) await chamar('/api/push/cancelar', { endpoint: sub.endpoint }); } catch (e) { /* o servidor limpa depois */ } await sub.unsubscribe(); }
    } catch (e) { /* ok */ }
  }
  /** O service worker avisa a página aberta (em vez de mostrar a notificação do sistema): aqui entram o balão e o som. */
  function ouvirServiceWorker() {
    if (ouvindoSW || !suportaPush() || !navigator.serviceWorker.addEventListener) return;
    ouvindoSW = true;
    navigator.serviceWorker.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.tipo !== 'push' || !d.aviso || !ativo() || jaAvisado(d.aviso.tag)) return;
      if (somLigado()) beep();
      toast(String(d.aviso.titulo || 'Aviso') + (d.aviso.texto ? ': ' + d.aviso.texto : ''), function () { abrir(d.aviso.url); });
      marcarTitulo();
    });
  }

  /** Liga os avisos (precisa vir de um clique): pede a permissão do navegador, libera o som, toca um teste e cadastra o aparelho para push. */
  async function ativar() {
    var perm = permissao();
    if (perm === 'default') { try { perm = await window.Notification.requestPermission(); } catch (e) { perm = permissao(); } }
    ls(CH_ATIVO, '1');
    beep();
    var push = perm === 'granted' ? await inscreverPush() : 'sem-permissao';
    return { permissao: perm, ativo: true, push: push };
  }
  async function desativar() { ls(CH_ATIVO, '0'); await cancelarPush(); }
  function ligarSom(sim) { ls(CH_SOM, sim ? '1' : '0'); }

  /** Dispara um aviso: notificação do sistema (se permitida), som (se ligado) e um balão na página. Só age se os avisos estiverem ligados. */
  function alertar(o) {
    if (!ativo()) return false;
    if (jaAvisado(o.tag)) return false;
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

  /** Botões "Avisos" e "Som" dentro de `el`. opcoes: { token: () => JWT da página, navegar: (url) => abre a tela, aoMudar: () => ... }. */
  function montarControle(el, opcoes) {
    if (!el) return;
    var o = opcoes || {};
    if (o.token) tokenFn = o.token;
    if (o.navegar) navegarFn = o.navegar;
    ouvirServiceWorker();
    function desenhar() {
      var on = ativo(), perm = permissao(), push = pushAtivo();
      var dica = on ? 'Avisos ligados neste navegador. Clique para desligar.' : 'Liga a notificação do navegador, o sinal sonoro e o aviso com a página fechada (push) para ocorrências novas.';
      var nota = '';
      if (on && perm === 'denied') nota = '<span class="avisos-nota" title="O navegador bloqueou as notificações deste site. Libere no cadeado da barra de endereço.">⚠ notificação bloqueada (só som e balão)</span>';
      else if (on && push) nota = '<span class="avisos-nota ok" title="Este aparelho recebe os avisos mesmo com a página fechada, enquanto o navegador estiver aberto ou em segundo plano.">✔ push ativo</span>';
      else if (on && !suportaPush()) nota = '<span class="avisos-nota" title="Este navegador não oferece push: os avisos só chegam com a página aberta.">só com a página aberta</span>';
      el.innerHTML = '<span class="avisos-ctl">' +
        '<button type="button" class="avisos-btn' + (on ? ' on' : '') + '" id="avisos-btn" title="' + esc(dica) + '" aria-pressed="' + (on ? 'true' : 'false') + '">🔔 Avisos ' + (on ? 'ligados' : 'desligados') + '</button>' +
        (on ? '<button type="button" class="avisos-btn" id="avisos-som" title="Liga ou desliga o sinal sonoro" aria-pressed="' + (somLigado() ? 'true' : 'false') + '">' + (somLigado() ? '🔊 Som' : '🔇 Mudo') + '</button>' : '') + nota + '</span>';
      var b = el.querySelector('#avisos-btn'), s = el.querySelector('#avisos-som');
      if (b) b.addEventListener('click', async function () {
        if (ativo()) await desativar(); else {
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
        st.textContent = '.avisos-ctl{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}.avisos-btn{border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:999px;padding:3px 10px;font:600 12px system-ui,sans-serif;cursor:pointer}.avisos-btn.on{background:#e6f4ee;border-color:#256050;color:#256050}.avisos-nota{font:600 11px system-ui,sans-serif;color:#b45309}.avisos-nota.ok{color:#166534}';
        document.head.appendChild(st);
      }
    } catch (e) { /* sem estilo */ }
    desenhar();
    // já ligado em outra visita: renova o cadastro do aparelho no servidor (idempotente) e atualiza o texto
    if (ativo() && permissao() === 'granted' && tokenFn && suportaPush()) inscreverPush().then(desenhar).catch(function () { /* ok */ });
  }

  window.Avisos = { ativo: ativo, somLigado: somLigado, permissao: permissao, pushAtivo: pushAtivo, ativar: ativar, desativar: desativar, alertar: alertar, beep: beep, montarControle: montarControle, abrir: abrir };
})();
