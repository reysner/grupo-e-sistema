'use strict';
/**
 * Configuração do job "Arquivar empresas inativas" (Modelo 01).
 *
 * Roda numa ESTAÇÃO WINDOWS da rede (não no Render) — precisa enxergar:
 *   - o Google Drive para Desktop montado (ex.: H:\Drives compartilhados)
 *   - o compartilhamento de arquivos \\192.168.251.13\escritorial$ (caminho UNC,
 *     não depende do mapeamento Z:)
 *
 * Todos os caminhos saem de 2 raízes configuráveis (ARQUIVO_MORTO_UNC_ROOT e
 * ARQUIVO_MORTO_DRIVE_MOUNT) pra dar pra apontar tudo pra pastas de teste locais
 * num --dry-run offline, sem tocar na rede de verdade.
 *
 * Segredos (token da Acessórias, senha de app do Gmail) NUNCA ficam no código —
 * vêm de server/arquivoMorto/.env (git-ignored). Mesmo padrão do resto do sistema.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

function obrigatorio(nome) {
  const v = process.env[nome];
  if (!v || !String(v).trim()) {
    throw new Error(`Variável de ambiente ${nome} não configurada (server/arquivoMorto/.env).`);
  }
  return String(v).trim();
}

/** Junta segmentos sob uma raiz preservando `\\servidor\share` (UNC) no Windows. */
function sob(raiz, ...partes) {
  return path.win32.join(raiz, ...partes);
}

function carregarConfig() {
  const UNC = obrigatorio('ARQUIVO_MORTO_UNC_ROOT');       // \\192.168.251.13\escritorial$\UNIDADE ORGANIZACIONAL
  const DRV = obrigatorio('ARQUIVO_MORTO_DRIVE_MOUNT');    // H:\Drives compartilhados
  const EMPRESAS = sob(UNC, 'EMPRESAS');

  // Os Drives Compartilhados vindos da migração rclone têm aninhamento duplo:
  // dentro do Drive "<nome>" existe uma pasta "<nome>" e o conteúdo real está
  // nela. Confirmado no diag (cada um com 1 subpasta homônima). `drvDuplo`
  // aponta pro nível certo.
  const drvDuplo = nome => sob(DRV, nome, nome);

  return {
    // ── Acessórias ──────────────────────────────────────────────────────────
    acessoriasToken: obrigatorio('ACESSORIAS_API_TOKEN'),
    // Data de corte: só arquiva empresa cujo "Cliente até" seja >= isso.
    desde: (process.env.ARQUIVO_MORTO_DESDE || '2026-09-20').trim(),

    // ── E-mail de resumo ───────────────────────────────────────────────────
    email: {
      to: (process.env.ARQUIVO_MORTO_EMAIL_TO || 'reysner@escritorial.com.br').trim(),
      user: process.env.GMAIL_USER || '',
      pass: process.env.GMAIL_APP_PASS || '',
    },

    // ── Origens ────────────────────────────────────────────────────────────
    // Cada empresa é uma PASTA no 1º nível dessas pastas, com nome = razão social.
    origens: {
      // 2024: pasta local do ano + as 5 "Anos Anteriores 2024" no Drive
      ano2024: [
        sob(EMPRESAS, '2024'),
        drvDuplo('EMPRESAS - ANOS ANTERIORES 2024 - A a F'),
        drvDuplo('EMPRESAS - ANOS ANTERIORES 2024 - G a L'),
        drvDuplo('EMPRESAS - ANOS ANTERIORES 2024 - M a R'),
        drvDuplo('EMPRESAS - ANOS ANTERIORES 2024 - S a T'),
        drvDuplo('EMPRESAS - ANOS ANTERIORES 2024 - U a Z'),
      ],
      ano2025: [sob(EMPRESAS, '2025')],
      ano2026: [sob(EMPRESAS, '2026')],
      legalizacao: sob(EMPRESAS, 'LEGALIZACAO'),
      certificadosPj: sob(UNC, 'DEPARTAMENTO LEGALIZACAO', 'CERTIFICADOS PJ'),
      sucessoDoCliente: drvDuplo('EMPRESAS - SUCESSO DO CLIENTE'),
    },

    // ── Destinos ──────────────────────────────────────────────────────────
    destinos: {
      // Local: sem divisão por faixa — \...\EMPRESAS - ARQUIVO MORTO\<EMPRESA>\...
      localBase: sob(EMPRESAS, 'EMPRESAS - ARQUIVO MORTO'),
      // Drive: dividido por faixa de letra inicial do nome.
      driveBasePorFaixa: {
        'A a D': drvDuplo('EMPRESAS - ARQUIVO MORTO A a D'),
        'E a L': drvDuplo('EMPRESAS - ARQUIVO MORTO E a L'),
        'M a R': drvDuplo('EMPRESAS - ARQUIVO MORTO M a R'),
        'S a T': drvDuplo('EMPRESAS - ARQUIVO MORTO S a T'),
        'U a Z': drvDuplo('EMPRESAS - ARQUIVO MORTO U a Z'),
      },
    },

    // ── Nomes das subpastas criadas no destino ────────────────────────────
    subpastas: {
      ano2024: '2024',
      ano2025: '2025',
      ano2026: '2026',
      legalizacao: 'Legalização',
      certificadoDigital: 'Certificado Digital', // dentro de "Legalização"
      sucessoDoCliente: 'Sucesso do Cliente',
    },

    // Pasta de estado (json de controle) e de logs — git-ignored.
    estadoDir: path.join(__dirname, 'estado'),
    logsDir: path.join(__dirname, 'logs'),
  };
}

module.exports = { carregarConfig, sob };
