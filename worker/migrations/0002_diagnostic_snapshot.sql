-- Series temporales de diagnóstico (ventana típica 12h; podés podar con job o al insertar)
CREATE TABLE IF NOT EXISTS diagnostic_snapshot (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'scheduled',
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_created ON diagnostic_snapshot (created_at DESC);
