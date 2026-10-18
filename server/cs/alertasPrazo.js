'use strict';
/**
 * Alerta de prazo das ocorrências do módulo Qualidade (18/10/2026): todo dia de manhã, avisa quem precisa agir quando o prazo
 * vence amanhã, vence hoje ou venceu (nos últimos 7 dias). Cada aviso sai UMA vez por ocorrência, nível e prazo: se o prazo mudar,
 * o aviso vale de novo. O aviso vai por push (celular/navegador) e para o sino, e fica nos Logs de atividades.
 *
 * Quem recebe depende de onde a ocorrência está parada:
 *   registrada, tratativa definida, em validação  -> gestor(es) do departamento (ou o Sucesso do Cliente, quando não há gestor)
 *   com o analista                                -> os analistas responsáveis e o gestor
 *   devolutiva ao cliente                         -> o Sucesso do Cliente
 */
const ETAPAS_COM_PRAZO = ['registrada', 'tratativa_definida', 'com_analista', 'validacao_gestor', 'devolutiva_cliente'];
const JANELA_VENCIDA_DIAS = 7;   // vencida há mais que isso não gera aviso novo (evita enxurrada de aviso de caso antigo)

/** Dias entre duas datas AAAA-MM-DD (prazo menos hoje); null se alguma for inválida. */
function diasAte(prazoIso, hojeIso) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const p = String(prazoIso || '').slice(0, 10), h = String(hojeIso || '').slice(0, 10);
  if (!re.test(p) || !re.test(h)) return null;
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(p) - t(h)) / 86400000);
}
/** 'amanha' | 'hoje' | 'vencida' | null (nada a avisar). */
function nivelDoAlerta(dias) {
  if (dias === null || dias === undefined) return null;
  if (dias === 1) return 'amanha';
  if (dias === 0) return 'hoje';
  if (dias < 0 && dias >= -JANELA_VENCIDA_DIAS) return 'vencida';
  return null;
}
/** Quem recebe: 'responsaveis' (e o gestor), 'gestores' ou 'sucesso'. */
function destinoDoAlerta(etapa) {
  if (etapa === 'com_analista') return ['responsaveis', 'gestores'];
  if (etapa === 'devolutiva_cliente') return ['sucesso'];
  if (['registrada', 'tratativa_definida', 'validacao_gestor'].includes(etapa)) return ['gestores'];
  return [];
}
const ROT_ETAPA = { registrada: 'aguardando análise do gestor', tratativa_definida: 'tratativa definida, ainda não aberta', com_analista: 'com o analista', validacao_gestor: 'em validação do gestor', devolutiva_cliente: 'devolutiva ao cliente' };
const dataBr = (iso) => String(iso).slice(8, 10) + '/' + String(iso).slice(5, 7) + '/' + String(iso).slice(0, 4);
function textoDoAlerta(nivel, reg) {
  const titulo = nivel === 'amanha' ? 'Prazo vence amanhã' : nivel === 'hoje' ? 'Prazo vence hoje' : 'Prazo vencido';
  const texto = (reg.ocultar_empresa ? 'Empresa não informada' : (reg.cliente_nome || 'Empresa')) + ' — ' + (reg.assunto || 'ocorrência') + ' · prazo ' + dataBr(reg.prazo) + ' · ' + (ROT_ETAPA[reg.etapa] || reg.etapa);
  return { titulo, texto };
}

let tabela = null;
function garantirTabela(pool) {
  if (!tabela) {
    tabela = pool.query(`CREATE TABLE IF NOT EXISTS cs_qualidade_alertas (
      registro_id UUID NOT NULL REFERENCES cs_qualidade_registros(id) ON DELETE CASCADE,
      nivel TEXT NOT NULL, prazo DATE NOT NULL, enviado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (registro_id, nivel, prazo)
    )`).then(() => pool.query('ALTER TABLE cs_qualidade_alertas ENABLE ROW LEVEL SECURITY')).catch((e) => { tabela = null; throw e; });
  }
  return tabela;
}

/**
 * Roda uma vez (o agendador chama de manhã; reexecutar no mesmo dia não repete aviso).
 * deps: { pool, hoje, idsGestoresDe, idsDosResponsaveis, idsSucesso, avisarPush, notificar, registrarLog }
 */
async function rodar(deps) {
  const { pool, hoje } = deps;
  await garantirTabela(pool);
  const { rows } = await pool.query(
    `SELECT id, cliente_nome, ocultar_empresa, assunto, etapa, departamentos, fila, analista_id, to_char(prazo, 'YYYY-MM-DD') AS prazo
       FROM cs_qualidade_registros
      WHERE origem IN ('modulo', 'filha') AND status NOT IN ('cancelado', 'resolvido') AND etapa = ANY($1::text[])
        AND prazo IS NOT NULL AND prazo <= ($2::date + 1) AND prazo >= ($2::date - $3::int)`,
    [ETAPAS_COM_PRAZO, hoje, JANELA_VENCIDA_DIAS]);
  let enviados = 0;
  for (const r of rows) {
    const nivel = nivelDoAlerta(diasAte(r.prazo, hoje));
    if (!nivel) continue;
    const novo = await pool.query('INSERT INTO cs_qualidade_alertas (registro_id, nivel, prazo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING registro_id', [r.id, nivel, r.prazo]);
    if (!novo.rows.length) continue;   // este aviso já saiu
    const t = textoDoAlerta(nivel, r);
    const destinos = destinoDoAlerta(r.etapa);
    const ids = [];
    try {
      if (destinos.includes('responsaveis')) ids.push(...(await deps.idsDosResponsaveis(r.id, r.analista_id)));
      if (destinos.includes('gestores')) ids.push(...(r.fila === 'sucesso' ? await deps.idsSucesso() : await deps.idsGestoresDe(r.departamentos)));
      if (destinos.includes('sucesso')) ids.push(...(await deps.idsSucesso()));
    } catch (e) { /* sem destinatário: o sino e o log ainda saem */ }
    await deps.avisarPush(async () => ids, { titulo: t.titulo, texto: t.texto, url: '/cs?aba=' + (r.etapa === 'com_analista' ? 'analista' : r.etapa === 'devolutiva_cliente' ? 'sucesso' : 'gestor'), tag: 'prazo-' + r.id + '-' + nivel }, null);
    if (deps.notificar) await deps.notificar(t.titulo, t.texto);
    if (deps.registrarLog) await deps.registrarLog(t.titulo + ': ' + t.texto);
    enviados++;
  }
  return { avaliadas: rows.length, enviados };
}

module.exports = { rodar, diasAte, nivelDoAlerta, destinoDoAlerta, textoDoAlerta, ETAPAS_COM_PRAZO, JANELA_VENCIDA_DIAS };
