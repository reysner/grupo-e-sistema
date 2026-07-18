-- ============================================================================
-- Módulo Sucesso do Cliente — Schema (Supabase / PostgreSQL)
-- ----------------------------------------------------------------------------
-- Rodar no Supabase → SQL Editor. Idempotente (CREATE TABLE IF NOT EXISTS).
-- Prefixo cs_ isola o módulo. Nada aqui altera tabelas existentes do sistema.
-- ============================================================================

-- ── 1. VÍNCULOS (de-para telefone → empresa) ────────────────────────────────
-- Âncora = telefone. Casa com a Carteira (clientes) por confirmação humana.
-- tipo controla quem entra no SLA/score: só 'cliente'.
CREATE TABLE IF NOT EXISTS cs_vinculos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telefone      TEXT NOT NULL UNIQUE,          -- normalizado (só dígitos, com DDI/DDD)
  cliente_id    TEXT,                          -- FK lógica -> clientes.id (Carteira). NULL até vincular
  empresa_nome  TEXT,                          -- nome exibido (da Carteira ou do contato)
  cnpj          TEXT,
  tipo          TEXT NOT NULL DEFAULT 'pendente'
                CHECK (tipo IN ('cliente','fornecedor','interno','software','pendente')),
  confianca     INTEGER,                       -- 0-100, se veio de sugestão automática
  confirmado_por TEXT,                         -- quem confirmou o vínculo
  confirmado_em  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cs_vinculos_cliente ON cs_vinculos (cliente_id);
CREATE INDEX IF NOT EXISTS idx_cs_vinculos_tipo    ON cs_vinculos (tipo);

-- ── 2. TICKETS ──────────────────────────────────────────────────────────────
-- Espelho enxuto do ticket do Zappy + resultado do cálculo de SLA.
CREATE TABLE IF NOT EXISTS cs_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zappy_id      TEXT NOT NULL UNIQUE,          -- id do ticket no Zappy (evita duplicar na ingestão)
  telefone      TEXT,
  empresa_texto TEXT,                          -- "Empresa" livre do contato (pista pro de-para)
  vinculo_id    UUID REFERENCES cs_vinculos(id) ON DELETE SET NULL,
  departamento  TEXT,
  analista      TEXT,                          -- quem atendeu (nome/identificador do Zappy)
  status        TEXT,                          -- 'nova'/'em_andamento'/'encerrada'/... (do Zappy)
  abertura        TIMESTAMPTZ,
  aceite          TIMESTAMPTZ,
  transferencia   TIMESTAMPTZ,
  encerramento    TIMESTAMPTZ,
  reaberturas     INTEGER DEFAULT 0,
  nota_avaliacao  SMALLINT,                    -- 1-5 (avaliação automática do Zappy)
  comentario_avaliacao TEXT,
  -- Resultado do motor de SLA (recalculável a qualquer momento):
  sla            JSONB DEFAULT '{}',           -- { relogios:[...], radar:{...} }
  em_risco       BOOLEAN DEFAULT FALSE,        -- radar != null e não-verde (facilita o filtro "Agora")
  pior_status    TEXT,                         -- verde|amarelo|vermelho do radar
  ingerido_em    TIMESTAMPTZ DEFAULT NOW(),
  calculado_em   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cs_tickets_vinculo ON cs_tickets (vinculo_id);
CREATE INDEX IF NOT EXISTS idx_cs_tickets_risco   ON cs_tickets (em_risco) WHERE em_risco = TRUE;
CREATE INDEX IF NOT EXISTS idx_cs_tickets_abertura ON cs_tickets (abertura DESC);
CREATE INDEX IF NOT EXISTS idx_cs_tickets_analista ON cs_tickets (analista);

-- ── 3. MENSAGENS ────────────────────────────────────────────────────────────
-- Necessárias para o "de quem é a vez" e (Fase 2) para a IA.
CREATE TABLE IF NOT EXISTS cs_mensagens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
  zappy_msg_id TEXT,                           -- id da msg no Zappy (dedupe)
  remetente   TEXT NOT NULL CHECK (remetente IN ('cliente','escritorio','sistema')),
  autor       TEXT,                            -- nome do atendente, se aplicável
  hora        TIMESTAMPTZ NOT NULL,
  texto       TEXT,
  UNIQUE (ticket_id, zappy_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_cs_mensagens_ticket ON cs_mensagens (ticket_id, hora);

-- ── 4. CALENDÁRIO (feriados + expediente especial) ──────────────────────────
-- Fonte da verdade para o motor de tempo útil (quando migrado do hardcode).
-- tipo: 'feriado' (não conta) | 'especial' (horário próprio) | 'normal' (exceção que passa a contar)
CREATE TABLE IF NOT EXISTS cs_calendario (
  data        DATE PRIMARY KEY,
  tipo        TEXT NOT NULL CHECK (tipo IN ('feriado','especial','normal')),
  hora_inicio TIME,                            -- só para 'especial'
  hora_fim    TIME,                            -- só para 'especial'
  hora_inicio2 TIME,                           -- 2º turno opcional (tarde)
  hora_fim2    TIME,
  descricao   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Feriados 2026 em dia útil (seed inicial)
INSERT INTO cs_calendario (data, tipo, descricao) VALUES
  ('2026-01-01','feriado','Confraternização Universal'),
  ('2026-04-03','feriado','Paixão de Cristo'),
  ('2026-04-21','feriado','Tiradentes'),
  ('2026-05-01','feriado','Dia do Trabalho'),
  ('2026-06-04','feriado','Corpus Christi'),
  ('2026-08-31','feriado','São Raimundo (Aniversário de Uberlândia)'),
  ('2026-09-07','feriado','Independência do Brasil'),
  ('2026-10-12','feriado','Nossa Senhora Aparecida'),
  ('2026-11-02','feriado','Finados'),
  ('2026-11-20','feriado','Consciência Negra'),
  ('2026-12-25','feriado','Natal')
ON CONFLICT (data) DO NOTHING;

-- Expediente especial (só manhã)
INSERT INTO cs_calendario (data, tipo, hora_inicio, hora_fim, descricao) VALUES
  ('2026-12-24','especial','07:30','11:30','Véspera de Natal — só manhã'),
  ('2026-12-31','especial','07:30','11:30','Véspera de Ano Novo — só manhã')
ON CONFLICT (data) DO NOTHING;

-- ── 5. ANÁLISES DE IA (Fase 2 — placeholder) ────────────────────────────────
CREATE TABLE IF NOT EXISTS cs_analises (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    UUID NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
  sentimento   TEXT,                           -- ex.: positivo/neutro/negativo
  emocoes      JSONB DEFAULT '{}',             -- { frustracao:0-10, ansiedade:..., ... }
  ces_estimado SMALLINT,
  sinais       JSONB DEFAULT '[]',             -- ['pressao_prazo','escalada', ...]
  resumo       TEXT,
  modelo       TEXT,
  versao_prompt TEXT,
  custo_usd    NUMERIC(10,5),
  analisado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ticket_id)
);

-- ── 6. SCORES (health/churn por empresa) ────────────────────────────────────
-- Snapshot diário/periódico. Guarda o histórico para calibração futura.
CREATE TABLE IF NOT EXISTS cs_scores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vinculo_id    UUID REFERENCES cs_vinculos(id) ON DELETE CASCADE,
  cliente_id    TEXT,
  data          DATE NOT NULL,
  rei           NUMERIC(5,2),                  -- Relationship Erosion Index (0-100)
  risco_comercial NUMERIC(5,2),
  score_final   NUMERIC(5,2),
  sinais        JSONB DEFAULT '{}',            -- detalhamento dos componentes
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (vinculo_id, data)
);
CREATE INDEX IF NOT EXISTS idx_cs_scores_data ON cs_scores (data DESC);

-- ── 7. CONFIG (cursor de ingestão, chave/valor) ─────────────────────────────
-- Mesmo padrão de gam_config. Guarda coisas como 'ingestao_ultima_execucao'
-- e 'ingestao_data_inicio' (a coleta não faz carga retroativa — decisão do PRD).
CREATE TABLE IF NOT EXISTS cs_config (
  chave       TEXT PRIMARY KEY,
  valor       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Fim do schema. Nenhuma tabela existente foi tocada.
-- ============================================================================
