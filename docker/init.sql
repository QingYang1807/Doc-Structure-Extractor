CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS extraction_jobs (
  id            SERIAL PRIMARY KEY,
  template      TEXT NOT NULL,
  text_preview  TEXT NOT NULL,
  raw_text      TEXT NOT NULL,
  fields        JSONB NOT NULL,
  raw_json      JSONB NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  custom_fields JSONB,
  field_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
