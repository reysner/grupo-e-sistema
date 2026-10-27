'use strict';

/**
 * Grava a lista de certificados da CertiSeguro (nome, cnpj/cpf, validade dd/mm/aaaa) em legalizacao_certificados — EM LOTE.
 * Antes eram 2 consultas por certificado (479 certificados ≈ mais de 2 min no banco remoto, estourando o tempo do Render); agora são 4–5 consultas no total.
 * Regras (as mesmas de antes):
 *   - CNPJ (14 dígitos) de cliente ativo da Carteira → upsert do certificado PJ do cliente (atualizado);
 *   - senão, se já existe certificado com esse documento → atualiza a validade (atualizado);
 *   - senão, com nome → cria certificado PF/avulso (criado); sem nome → ignorado. Sem documento/validade válidos → ignorado.
 * Só muda a notificação de vencimento quando a data muda. `pool` é injetado para poder testar sem banco.
 */
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

async function importarCertificados(pool, lista) {
  const itens = [];
  let ignorados = 0;
  for (const it of Array.isArray(lista) ? lista : []) {
    const doc = soDigitos(it && (it.cnpj || it.documento));
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String((it && it.validade) || '').trim());
    if (!doc || !m) { ignorados++; continue; }
    itens.push({ doc, venc: `${m[3]}-${m[2]}-${m[1]}`, nome: (it.nome_amigavel || it.nome || null) });
  }
  // Certificado renovado = a lista pode trazer o velho e o novo do mesmo documento; vale a validade MAIS RECENTE (antes valia o último da lista, e a ordem não é por data).
  const maisRecente = new Map();
  for (const i of itens) { const x = maisRecente.get(i.doc); if (!x || i.venc > x.venc) maisRecente.set(i.doc, { ...i, nome: i.nome || (x && x.nome) || null }); else if (!x.nome && i.nome) x.nome = i.nome; }
  itens.length = 0; maisRecente.forEach((i) => itens.push(i));

  // 1) clientes ativos por CNPJ (uma consulta)
  const cnpjs = [...new Set(itens.filter((i) => i.doc.length === 14).map((i) => i.doc))];
  const porCnpj = new Map();
  if (cnpjs.length) {
    const { rows } = await pool.query(
      `SELECT id::text AS id, nome_empresa, cnpj, regexp_replace(cnpj, '\\D', '', 'g') AS doc FROM clientes WHERE regexp_replace(cnpj, '\\D', '', 'g') = ANY($1::text[])`, [cnpjs]);
    rows.forEach((r) => { if (!porCnpj.has(r.doc)) porCnpj.set(r.doc, r); });
  }

  const pj = new Map();      // cliente_id -> { nome, cnpj, venc }   (o último da lista vence, como no laço antigo)
  const outros = [];         // sem cliente (ou CPF): atualizar existente / criar avulso
  for (const i of itens) {
    const cli = i.doc.length === 14 ? porCnpj.get(i.doc) : null;
    if (cli) pj.set(cli.id, { nome: cli.nome_empresa, cnpj: cli.cnpj, venc: i.venc }); else outros.push(i);
  }
  let atualizados = 0, criados = 0;

  if (pj.size) {
    const ids = [...pj.keys()];
    await pool.query(
      `INSERT INTO legalizacao_certificados (cliente_id, tipo, titular_nome, titular_documento, data_vencimento, fonte, criado_por)
       SELECT u.cid, 'pj', u.nome, u.doc, u.venc, 'certiseguro', 'CertiSeguro (sync automático)'
         FROM unnest($1::text[], $2::text[], $3::text[], $4::date[]) AS u(cid, nome, doc, venc)
       ON CONFLICT (cliente_id) WHERE tipo = 'pj' AND cliente_id IS NOT NULL DO UPDATE SET
         data_vencimento = EXCLUDED.data_vencimento, fonte = 'certiseguro', atualizado_em = NOW(),
         notificado_vencimento_em = CASE WHEN EXCLUDED.data_vencimento IS DISTINCT FROM legalizacao_certificados.data_vencimento THEN NULL ELSE legalizacao_certificados.notificado_vencimento_em END`,
      [ids, ids.map((k) => pj.get(k).nome), ids.map((k) => pj.get(k).cnpj), ids.map((k) => pj.get(k).venc)]);
    atualizados += ids.length;
  }

  if (outros.length) {
    const docs = [...new Set(outros.map((i) => i.doc))];
    const { rows: ex } = await pool.query(
      `SELECT DISTINCT ON (d) id, d FROM (SELECT id, regexp_replace(titular_documento, '\\D', '', 'g') AS d FROM legalizacao_certificados) t WHERE d = ANY($1::text[]) ORDER BY d, id`, [docs]);
    const existente = new Map(ex.map((r) => [r.d, r.id]));
    const upd = new Map();   // id do certificado -> venc
    const novos = new Map(); // doc -> { nome, venc }
    for (const i of outros) {
      if (existente.has(i.doc)) upd.set(existente.get(i.doc), i.venc);
      else if (i.nome) novos.set(i.doc, { nome: i.nome, venc: i.venc });
      else ignorados++;
    }
    if (upd.size) {
      const ids = [...upd.keys()];
      await pool.query(
        `UPDATE legalizacao_certificados c SET data_vencimento = u.venc, fonte = 'certiseguro', atualizado_em = NOW(),
           notificado_vencimento_em = CASE WHEN u.venc IS DISTINCT FROM c.data_vencimento THEN NULL ELSE c.notificado_vencimento_em END
          FROM unnest($1::uuid[], $2::date[]) AS u(id, venc) WHERE c.id = u.id`,
        [ids, ids.map((k) => upd.get(k))]);
      atualizados += ids.length;
    }
    if (novos.size) {
      const ds = [...novos.keys()];
      await pool.query(
        `INSERT INTO legalizacao_certificados (cliente_id, tipo, titular_nome, titular_documento, data_vencimento, fonte, criado_por)
         SELECT NULL, 'pf', u.nome, u.doc, u.venc, 'certiseguro', 'CertiSeguro (sync automático)'
           FROM unnest($1::text[], $2::text[], $3::date[]) AS u(nome, doc, venc)`,
        [ds.map((k) => novos.get(k).nome), ds, ds.map((k) => novos.get(k).venc)]);
      criados += ds.length;
    }
  }
  return { atualizados, criados, ignorados, total: Array.isArray(lista) ? lista.length : 0 };
}

module.exports = { importarCertificados };
