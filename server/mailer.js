'use strict';
// Serviço de envio de e-mail via Gmail SMTP (nodemailer)
// Variáveis de ambiente necessárias no Render:
//   GMAIL_USER      -> a conta Gmail que envia (ex.: sistema@escritorial.com.br)
//   GMAIL_APP_PASS  -> a "senha de app" de 16 caracteres gerada no Google
//   APP_URL         -> URL base do sistema (ex.: https://grupo-e-sistema.onrender.com)
const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS || '';
const APP_URL = process.env.APP_URL || 'https://grupo-e-sistema.onrender.com';

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  if (!GMAIL_USER || !GMAIL_APP_PASS) {
    console.error('[mailer] GMAIL_USER / GMAIL_APP_PASS não configurados nas variáveis de ambiente.');
    return null;
  }
  _transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,          // 587 usa STARTTLS (não SSL direto)
    requireTLS: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 12000,
  });
  return _transporter;
}

// Envia o e-mail de recuperação de senha com o link contendo o token
async function enviarEmailRecuperacao(destinatario, nome, token) {
  const t = getTransporter();
  if (!t) throw new Error('Serviço de e-mail não configurado.');
  const link = `${APP_URL}/reset-password.html?token=${encodeURIComponent(token)}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a202c">
      <div style="background:#14532d;padding:24px;text-align:center;border-radius:12px 12px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px">Grupo-E · Recuperação de senha</h1>
      </div>
      <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:28px 24px">
        <p>Olá${nome ? ', ' + nome : ''},</p>
        <p>Recebemos um pedido para redefinir a senha da sua conta no sistema Grupo-E. Clique no botão abaixo para criar uma nova senha:</p>
        <p style="text-align:center;margin:28px 0">
          <a href="${link}" style="background:#14532d;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;display:inline-block">Redefinir minha senha</a>
        </p>
        <p style="font-size:13px;color:#64748b">Ou copie e cole este endereço no navegador:<br><a href="${link}" style="color:#14532d;word-break:break-all">${link}</a></p>
        <p style="font-size:13px;color:#64748b">Este link é válido por <strong>1 hora</strong> e só pode ser usado uma vez. Se você não solicitou a troca de senha, ignore este e-mail — sua senha atual continua valendo.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0" />
        <p style="font-size:12px;color:#94a3b8">Grupo-E Soluções Empresariais · mensagem automática, não responda.</p>
      </div>
    </div>`;
  await t.sendMail({
    from: `"Grupo-E Sistema" <${GMAIL_USER}>`,
    to: destinatario,
    subject: 'Recuperação de senha — Grupo-E',
    html,
  });
}

module.exports = { enviarEmailRecuperacao };
