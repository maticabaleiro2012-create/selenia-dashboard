-- Selenia structured knowledge + insight queue (D1)
CREATE TABLE IF NOT EXISTS knowledge_entry (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  relationships_json TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  promoted_at INTEGER
);

CREATE TABLE IF NOT EXISTS roadmap_item (
  id TEXT PRIMARY KEY,
  category TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  owner_team TEXT,
  deps_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_insight (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  summary TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  promoted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_insight_status ON conversation_insight (status);
CREATE INDEX IF NOT EXISTS idx_roadmap_status ON roadmap_item (status);
