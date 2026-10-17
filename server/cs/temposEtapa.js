'use strict';
/**
 * Tempo médio de cada etapa das ocorrências do módulo Qualidade (18/10/2026), calculado a partir do histórico (cs_qualidade_historico):
 *   Com o gestor ........ do registro até abrir para o analista (análise, plano de ação e prazo)
 *   Com o analista ...... da abertura até a última vez que o analista encerrou a parte dele (inclui o retrabalho, se o gestor devolveu)
 *   Validação do gestor . do último encerramento do analista até o gestor validar
 *   Devolutiva .......... da validação até o gestor final encerrar o processo
 *   Total ............... do registro ao encerramento
 * Só entra a etapa que a ocorrência já cumpriu (tem começo e fim registrados). Tempo corrido (inclui fim de semana), em horas.
 */
const ETAPAS_TEMPO = [
  { chave: 'gestor', rotulo: 'Com o gestor (análise até abrir para o analista)', de: ['criado', 'primeiro'], ate: ['liberada', 'primeiro'] },
  { chave: 'analista', rotulo: 'Com o analista (tratando)', de: ['liberada', 'primeiro'], ate: ['analista_encerrou', 'ultimo'] },
  { chave: 'validacao', rotulo: 'Validação do gestor', de: ['analista_encerrou', 'ultimo'], ate: ['gestor_validou', 'ultimo'] },
  { chave: 'devolutiva', rotulo: 'Devolutiva ao cliente (Sucesso do Cliente)', de: ['gestor_validou', 'ultimo'], ate: ['encerrada', 'ultimo'] },
  { chave: 'total', rotulo: 'Do registro ao encerramento', de: ['criado', 'primeiro'], ate: ['encerrada', 'ultimo'] },
];
const ACOES_DO_HISTORICO = ['liberada', 'analista_encerrou', 'gestor_validou', 'encerrada'];

/** Instante (ms) de um evento da ocorrência: o primeiro ou o último daquela ação; "criado" é o próprio registro. null se não aconteceu. */
function momento(reg, acao, qual) {
  if (acao === 'criado') { const t = Date.parse(reg.criado_em); return isNaN(t) ? null : t; }
  const ts = (reg.eventos || []).filter((e) => e.acao === acao).map((e) => Date.parse(e.em)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  if (!ts.length) return null;
  return qual === 'ultimo' ? ts[ts.length - 1] : ts[0];
}
const horasEntre = (a, b) => (a == null || b == null || b < a ? null : (b - a) / 3600000);
const arred = (n) => Math.round(n * 100) / 100;
function resumo(lista) {
  if (!lista.length) return { n: 0, media_h: null, mediana_h: null, max_h: null };
  const o = lista.slice().sort((a, b) => a - b), n = o.length;
  const mediana = n % 2 ? o[(n - 1) / 2] : (o[n / 2 - 1] + o[n / 2]) / 2;
  return { n, media_h: arred(o.reduce((s, x) => s + x, 0) / n), mediana_h: arred(mediana), max_h: arred(o[n - 1]) };
}

/** regs: [{ criado_em, departamentos, eventos: [{ acao, em }] }] -> { ocorrencias, etapas, por_departamento } */
function calcularTempos(regs) {
  const por = {}; ETAPAS_TEMPO.forEach((e) => { por[e.chave] = []; });
  const deptos = {};
  (regs || []).forEach((r) => {
    const h = {};
    ETAPAS_TEMPO.forEach((e) => {
      const v = horasEntre(momento(r, e.de[0], e.de[1]), momento(r, e.ate[0], e.ate[1]));
      if (v !== null) { por[e.chave].push(v); h[e.chave] = v; }
    });
    const d = (r.departamentos || [])[0] || '—';
    const g = deptos[d] = deptos[d] || { gestor: [], analista: [], total: [] };
    ['gestor', 'analista', 'total'].forEach((k) => { if (h[k] !== undefined) g[k].push(h[k]); });
  });
  return {
    ocorrencias: (regs || []).length,
    etapas: ETAPAS_TEMPO.map((e) => Object.assign({ chave: e.chave, rotulo: e.rotulo }, resumo(por[e.chave]))),
    por_departamento: Object.keys(deptos).sort((a, b) => a.localeCompare(b, 'pt-BR')).map((d) => ({
      departamento: d, encerradas: deptos[d].total.length,
      gestor_media_h: resumo(deptos[d].gestor).media_h, analista_media_h: resumo(deptos[d].analista).media_h, total_media_h: resumo(deptos[d].total).media_h,
    })),
  };
}

module.exports = { calcularTempos, ETAPAS_TEMPO, ACOES_DO_HISTORICO, momento };
