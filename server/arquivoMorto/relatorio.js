'use strict';
/**
 * Monta e envia o e-mail de resumo diário do job (pro Reysner).
 * Mesmo estilo visual e mesmo transporte (Gmail SMTP + senha de app) do
 * ../mailer.js do sistema.
 */

const nodemailer = require('nodemailer');

function _transporter(user, pass) {
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true,
    auth: { user, pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    family: 4, dnsTimeout: 10000, tls: { family: 4 },
  });
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Texto curto do assunto. */
function assunto(rel) {
  const arq = rel.processadas.filter(p => p.status === 'ok').length;
  const partes = [`${arq} arquivada(s)`];
  if (rel.naoLocalizadas.length) partes.push(`${rel.naoLocalizadas.length} não localizada(s)`);
  if (rel.comAmbiguidade.length) partes.push(`${rel.comAmbiguidade.length} ambígua(s)`);
  if (rel.erros.length) partes.push(`${rel.erros.length} com erro`);
  const dia = new Date(rel.inicio).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `Arquivo Morto — ${dia}: ${partes.join(', ')}${rel.dryRun ? ' [DRY-RUN]' : ''}`;
}

function montarHtml(rel) {
  const dur = Math.round((new Date(rel.fim) - new Date(rel.inicio)) / 1000);
  const linhas = rel.processadas.map(p => {
    const blocos = Object.entries(p.blocos)
      .map(([k, b]) => b.encontrada ? `${esc(k)}: ${b.copiados}✓${b.jaExistiam ? ` / ${b.jaExistiam}=` : ''}` : null)
      .filter(Boolean).join(' · ') || '—';
    const cor = p.status === 'ok' ? '#166534' : p.status === 'nao_localizada' ? '#92400e' : '#b91c1c';
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">${esc(p.nome)}<br><span style="color:#94a3b8;font-size:11px">${esc(p.cnpj || 's/ CNPJ')} · até ${esc(p.clienteAte || '?')}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;color:${cor};font-weight:600">${esc(p.status)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">${esc(p.faixa)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px">${blocos}</td>
    </tr>`;
  }).join('');

  const secAmbig = rel.comAmbiguidade.length ? `
    <h3 style="color:#92400e;margin:20px 0 6px">Ambiguidade (não copiado — resolver na mão)</h3>
    <ul style="font-size:13px;color:#475569">${rel.comAmbiguidade.map(a =>
      `<li><strong>${esc(a.nome)}</strong>: ${a.ambiguidades.map(x => `${esc(x.bloco)} → ${x.candidatos.map(esc).join(' | ')}`).join('; ')}</li>`).join('')}</ul>` : '';

  const secErros = rel.erros.length ? `
    <h3 style="color:#b91c1c;margin:20px 0 6px">Erros</h3>
    <ul style="font-size:13px;color:#475569">${rel.erros.map(e =>
      `<li><strong>${esc(e.nome)}</strong>: ${e.itens.map(i => `${esc(i.bloco)} — ${esc(i.motivo)}`).join('; ')}</li>`).join('')}</ul>` : '';

  const secNaoLoc = rel.naoLocalizadas.length ? `
    <h3 style="color:#92400e;margin:20px 0 6px">Não localizadas em nenhuma origem</h3>
    <ul style="font-size:13px;color:#475569">${rel.naoLocalizadas.map(n =>
      `<li>${esc(n.nome)} (${esc(n.cnpj || 's/ CNPJ')}) — inativa desde ${esc(n.clienteAte || '?')}</li>`).join('')}</ul>` : '';

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:760px;margin:0 auto;color:#1a202c">
    <div style="background:#14532d;padding:20px 24px;border-radius:12px 12px 0 0">
      <h1 style="color:#fff;margin:0;font-size:18px">Arquivo Morto — empresas inativas${rel.dryRun ? ' · DRY-RUN' : ''}</h1>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:22px 24px">
      <p style="margin:0 0 14px;font-size:13px;color:#475569">
        Corte: <strong>Cliente até &ge; ${esc(rel.desde)}</strong> ·
        ${rel.total} inativa(s) na faixa · ${rel.puladas} já concluída(s) antes ·
        ${rel.processadas.length} processada(s) agora · ${dur}s
      </p>
      <p style="margin:0 0 14px;font-size:13px">
        Total copiado nesta execução: <strong>${rel.processadas.reduce((s, p) => s + p.totais.copiados, 0)} arquivo(s)</strong>
        (${fmtBytes(rel.processadas.reduce((s, p) => s + p.totais.bytes, 0))});
        já existiam: ${rel.processadas.reduce((s, p) => s + p.totais.jaExistiam, 0)}.
      </p>
      ${rel.processadas.length ? `<table style="border-collapse:collapse;width:100%;font-size:13px">
        <tr style="background:#f1f5f9;text-align:left">
          <th style="padding:6px 8px">Empresa</th><th style="padding:6px 8px">Status</th>
          <th style="padding:6px 8px">Faixa</th><th style="padding:6px 8px">Blocos (✓=copiado, ==já existia)</th>
        </tr>${linhas}</table>` : '<p style="color:#64748b">Nada novo pra arquivar hoje.</p>'}
      ${secNaoLoc}${secAmbig}${secErros}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0" />
      <p style="font-size:12px;color:#94a3b8">Grupo-E · job automático "Arquivar empresas inativas" (Modelo 01) · mensagem automática, não responda.</p>
    </div>
  </div>`;
}

async function enviarResumo(rel, emailCfg) {
  const t = _transporter(emailCfg.user, emailCfg.pass);
  if (!t) {
    console.warn('[arquivoMorto] GMAIL_USER/GMAIL_APP_PASS não configurados — resumo NÃO enviado.');
    return false;
  }
  await t.sendMail({
    from: `"Grupo-E Arquivo Morto" <${emailCfg.user}>`,
    to: emailCfg.to,
    subject: assunto(rel),
    html: montarHtml(rel),
  });
  return true;
}

module.exports = { enviarResumo, montarHtml, assunto };
