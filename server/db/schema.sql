-- Horários em UTC (ISO 8601). Valores financeiros como TEXT decimal.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  ticker TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',       -- JSON: nomes usados para checar relevância
  cik TEXT,
  ir_rss_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_benchmark INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,          -- provedor:id externo (ou hash da URL)
  provider TEXT NOT NULL,                   -- finnhub, sec, rss, csv, mock
  outlet TEXT,                              -- veículo que publicou
  url TEXT,
  url_canonical TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  content_level TEXT NOT NULL,              -- title_only | summary | full
  published_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,              -- quando o sistema encontrou
  updated_at TEXT,
  content_hash TEXT NOT NULL,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(url_canonical);
CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles(published_at);

CREATE TABLE IF NOT EXISTS article_versions (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  seen_at TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  content_hash TEXT NOT NULL,
  UNIQUE(article_id, content_hash)
);

CREATE TABLE IF NOT EXISTS article_tickers (
  article_id INTEGER NOT NULL REFERENCES articles(id),
  ticker TEXT NOT NULL,
  relevance TEXT NOT NULL,                  -- high | low
  PRIMARY KEY (article_id, ticker)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  title TEXT NOT NULL,
  representative_article_id INTEGER NOT NULL REFERENCES articles(id),
  first_published_at TEXT NOT NULL,
  last_published_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  article_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,                     -- ok | insufficient | low_relevance
  status_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ticker ON events(ticker, first_published_at);

CREATE TABLE IF NOT EXISTS event_articles (
  event_id INTEGER NOT NULL REFERENCES events(id),
  article_id INTEGER NOT NULL REFERENCES articles(id),
  role TEXT NOT NULL,                       -- original | repeat | followup
  PRIMARY KEY (event_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_event_articles_article ON event_articles(article_id);

CREATE TABLE IF NOT EXISTS bars (
  ticker TEXT NOT NULL,
  timeframe TEXT NOT NULL,                  -- 1Min | 1Day
  ts TEXT NOT NULL,                         -- início da barra (UTC)
  adjusted INTEGER NOT NULL,                -- 0 = bruto (execuções), 1 = ajustado (indicadores)
  open TEXT NOT NULL, high TEXT NOT NULL, low TEXT NOT NULL, close TEXT NOT NULL,
  volume TEXT NOT NULL,
  feed TEXT NOT NULL,
  fetched_at TEXT NOT NULL,                 -- quando o dado ficou disponível para o sistema
  PRIMARY KEY (ticker, timeframe, adjusted, ts)
);

CREATE TABLE IF NOT EXISTS jev_classifications (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  ticker TEXT NOT NULL,
  cache_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,                      -- bullish | bearish
  prob_bullish REAL, prob_bearish REAL,
  confidence REAL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_text TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  cost_usd TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jev_event ON jev_classifications(event_id);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY,
  session_date TEXT NOT NULL,
  ticker TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,                  -- só dados disponíveis até aqui
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL,                     -- ok | no_events | error | budget
  input_json TEXT NOT NULL,                 -- pacote exato enviado (snapshot)
  output_json TEXT,
  error TEXT,
  cost_usd TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL,
  UNIQUE(session_date, ticker, model, prompt_version)
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY,
  analysis_run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  ticker TEXT NOT NULL,
  session_date TEXT NOT NULL,
  made_at TEXT NOT NULL,
  horizon INTEGER NOT NULL,
  direction TEXT,                           -- up | down | NULL (sem previsão)
  strength INTEGER NOT NULL DEFAULT 0,      -- 0..3, escala experimental
  sufficient_data INTEGER NOT NULL,
  supporting_event_ids TEXT NOT NULL DEFAULT '[]',
  counter_evidence TEXT NOT NULL DEFAULT '[]',
  limitations TEXT NOT NULL DEFAULT '[]',
  explanation TEXT,
  eval_status TEXT NOT NULL DEFAULT 'pending', -- pending | evaluated | unavailable
  eval_start_at TEXT, eval_end_at TEXT,
  eval_start_price TEXT, eval_end_price TEXT,
  eval_return TEXT, eval_benchmark_return TEXT,
  eval_correct INTEGER,
  evaluated_at TEXT,
  UNIQUE(analysis_run_id, horizon)
);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  horizon_sessions INTEGER NOT NULL,
  initial_capital TEXT NOT NULL,
  config_json TEXT NOT NULL,                -- parâmetros fixados (modelos, instruções, custos, regras)
  started_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_rounds (
  id INTEGER PRIMARY KEY,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  session_date TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  decided_at TEXT,
  status TEXT NOT NULL,                     -- running | done | missed | error
  summary_json TEXT,
  UNIQUE(experiment_id, session_date)
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES decision_rounds(id),
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,                     -- buy | no_trade
  reason TEXT NOT NULL,
  prediction_id INTEGER REFERENCES predictions(id),
  rank INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(round_id, ticker)
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  ticker TEXT NOT NULL,
  quantity TEXT NOT NULL,
  cost_basis TEXT NOT NULL,                 -- inclui comissão e custos da entrada
  entry_order_id INTEGER NOT NULL UNIQUE,
  entry_session TEXT NOT NULL,
  planned_exit_session TEXT NOT NULL,
  planned_exit_at TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  status TEXT NOT NULL,                     -- open | closed
  closed_at TEXT,
  proceeds TEXT,
  realized_pnl TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  decision_id INTEGER REFERENCES decisions(id),
  position_id INTEGER REFERENCES positions(id),
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,                       -- buy | sell
  notional_reserved TEXT,                   -- compras: valor reservado do caixa
  quantity TEXT,                            -- vendas: quantidade
  not_before TEXT NOT NULL,                 -- só executa com preço de barra que começa a partir daqui
  expires_at TEXT,
  status TEXT NOT NULL,                     -- pending | filled | expired | cancelled
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_decision ON orders(decision_id, side) WHERE decision_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_position_sell ON orders(position_id, side) WHERE position_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  experiment_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity TEXT NOT NULL,
  ref_price TEXT NOT NULL,                  -- abertura da barra de 1 minuto usada
  ref_bar_ts TEXT NOT NULL,
  fill_price TEXT NOT NULL,                 -- ref ± meio spread ± slippage
  gross_amount TEXT NOT NULL,               -- quantidade × fill_price
  commission TEXT NOT NULL,
  spread_cost TEXT NOT NULL,
  slippage_cost TEXT NOT NULL,
  executed_at TEXT NOT NULL,                -- = início da barra de referência
  recorded_at TEXT NOT NULL,
  price_source TEXT NOT NULL,
  approximation TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_ledger (
  id INTEGER PRIMARY KEY,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- deposit | buy | sell | commission | dividend
  amount TEXT NOT NULL,                     -- positivo entra, negativo sai
  ref_type TEXT,
  ref_id INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS corporate_actions (
  id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- split | cash_dividend
  ex_date TEXT NOT NULL,
  ratio TEXT,                               -- split: novas ações por ação antiga
  amount_per_share TEXT,                    -- dividendo
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(ticker, kind, ex_date)
);

CREATE TABLE IF NOT EXISTS corporate_action_applications (
  action_id INTEGER NOT NULL REFERENCES corporate_actions(id),
  position_id INTEGER NOT NULL REFERENCES positions(id),
  applied_at TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (action_id, position_id)
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  session_date TEXT NOT NULL,
  cash TEXT NOT NULL,
  positions_value TEXT NOT NULL,
  equity TEXT NOT NULL,
  invested_fraction TEXT NOT NULL,
  stale_prices INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, session_date)
);

CREATE TABLE IF NOT EXISTS api_costs (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,                    -- jev | analyst | validation
  ref TEXT,
  cost_usd TEXT NOT NULL,
  tokens_in INTEGER, tokens_out INTEGER
);

CREATE TABLE IF NOT EXISTS job_state (
  name TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  info_json TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labeled_samples (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  ticker TEXT NOT NULL,
  human_label TEXT NOT NULL,                -- bullish | bearish | ambiguous | irrelevant
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(event_id, ticker)
);

-- Até onde a coleta de barras está completa. O simulador só usa uma barra
-- quando todas as anteriores já foram buscadas (evita pular uma barra ainda não recebida).
CREATE TABLE IF NOT EXISTS bar_coverage (
  ticker TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  adjusted INTEGER NOT NULL,
  covered_from TEXT NOT NULL,
  covered_until TEXT NOT NULL,
  PRIMARY KEY (ticker, timeframe, adjusted)
);
