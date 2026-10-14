/* Exportação de relatórios em CSV e PDF (páginas /cs e /financeiro). Roda no navegador, com os dados que a página já recebeu do servidor
 * (o servidor já aplicou permissões e valores ocultos): nada novo sai do servidor por aqui. O PDF usa jsPDF + AutoTable, carregados da
 * cdnjs só na primeira vez que alguém pede um PDF.
 *
 * Exportar.csv(nomeArquivo, colunas, linhas)
 * Exportar.pdf({ arquivo, titulo, subtitulo: [texto...], colunas, linhas, alinhar: ['left'|'center'|'right'...], orientacao: 'landscape'|'portrait', paginaDe: 'Grupo-E' })
 */
(function (g) {
  'use strict';

  var JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  var AUTOTABLE = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';

  function dataHoje() {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }
  function dataHora() { return new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }

  function baixar(blob, nome) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = nome; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }

  // ── CSV (Excel em português: separador ";", decimal com vírgula, UTF-8 com BOM) ──
  function celulaCsv(v) {
    if (v == null) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v).replace('.', ',') : '';
    var s = String(v).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^[=+@]/.test(s)) s = "'" + s;                  // evita fórmula em planilha
    return /[;"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv(arquivo, colunas, linhas) {
    var texto = '﻿' + [colunas].concat(linhas).map(function (l) { return l.map(celulaCsv).join(';'); }).join('\r\n') + '\r\n';
    baixar(new Blob([texto], { type: 'text/csv;charset=utf-8' }), arquivo + '-' + dataHoje() + '.csv');
  }

  // ── PDF ──
  function carregar(src) {
    return new Promise(function (ok, erro) {
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = ok; s.onerror = function () { erro(new Error('Não foi possível carregar o gerador de PDF (' + src.split('/').pop() + '). Verifique a conexão e tente de novo.')); };
      document.head.appendChild(s);
    });
  }
  var _pronto = null;
  function prepararPdf() {
    if (_pronto) return _pronto;
    _pronto = (g.jspdf ? Promise.resolve() : carregar(JSPDF)).then(function () {
      var tem = g.jspdf && g.jspdf.jsPDF && g.jspdf.jsPDF.API && g.jspdf.jsPDF.API.autoTable;
      return tem ? null : carregar(AUTOTABLE);
    }).catch(function (e) { _pronto = null; throw e; });
    return _pronto;
  }
  // A fonte padrão do PDF cobre o Latin-1 (acentos do português); o resto vira um equivalente simples.
  function paraPdf(v) {
    if (v == null) return '';
    var s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return s.replace(/[–—]/g, '-').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/[•·]/g, '-').replace(/…/g, '...')
      .replace(/⚠️?/g, '(!)').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[^\u0009\u000a -ÿ]/g, '').replace(/\s+/g, ' ').trim();
  }

  async function pdf(o) {
    await prepararPdf();
    var JsPDF = g.jspdf.jsPDF;
    var paisagem = (o.orientacao || 'landscape') === 'landscape';
    var doc = new JsPDF({ orientation: paisagem ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
    var largura = doc.internal.pageSize.getWidth(), altura = doc.internal.pageSize.getHeight(), margem = 28;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(20, 53, 42);
    doc.text(paraPdf(o.titulo), margem, 36);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90, 90, 90);
    var y = 52;
    (o.subtitulo || []).forEach(function (t) { var linhas = doc.splitTextToSize(paraPdf(t), largura - margem * 2); linhas.forEach(function (l) { doc.text(l, margem, y); y += 11; }); });
    doc.text('Gerado em ' + dataHora() + (o.paginaDe ? ' - ' + paraPdf(o.paginaDe) : ''), margem, y); y += 8;

    var estilos = {};
    (o.alinhar || []).forEach(function (a, i) { if (a && a !== 'left') estilos[i] = { halign: a }; });
    doc.autoTable({
      startY: y + 4,
      head: [o.colunas.map(paraPdf)],
      body: o.linhas.map(function (l) { return l.map(paraPdf); }),
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: o.fonte || 7.5, cellPadding: 3, overflow: 'linebreak', lineColor: [224, 228, 226], lineWidth: 0.4, textColor: [25, 25, 25] },
      headStyles: { fillColor: [37, 96, 80], textColor: 255, fontStyle: 'bold', halign: 'left' },
      alternateRowStyles: { fillColor: [247, 249, 248] },
      columnStyles: estilos,
      margin: { left: margem, right: margem, bottom: 30 },
      didDrawPage: function () {
        doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
        doc.text('Grupo-E', margem, altura - 14);
      },
    });
    var n = doc.getNumberOfPages();
    for (var i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
      doc.text('Página ' + i + ' de ' + n, largura - margem, altura - 14, { align: 'right' });
    }
    doc.save(o.arquivo + '-' + dataHoje() + '.pdf');
  }

  g.Exportar = { csv: csv, pdf: pdf, dataHoje: dataHoje, dataHora: dataHora };
})(window);
