-- Files indexed and their content hashes
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  language    TEXT NOT NULL,
  hash        TEXT NOT NULL,
  indexed_at  INTEGER NOT NULL
);

-- All symbols extracted from files
CREATE TABLE IF NOT EXISTS symbols (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path    TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  signature    TEXT,
  docstring    TEXT,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  parent_id    INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  rails_kind   TEXT,
  rails_meta   TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

-- Import map: which names each file imports and from where
CREATE TABLE IF NOT EXISTS imports (
  file_path     TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  local_name    TEXT NOT NULL,
  exported_name TEXT NOT NULL,
  source_path   TEXT NOT NULL,
  PRIMARY KEY (file_path, local_name)
);

CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source_path, exported_name);

-- Call graph
CREATE TABLE IF NOT EXISTS call_edges (
  caller_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_name  TEXT NOT NULL,
  callee_id    INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  PRIMARY KEY (caller_id, callee_name)
);

CREATE INDEX IF NOT EXISTS idx_edges_callee_id ON call_edges(callee_id);
CREATE INDEX IF NOT EXISTS idx_edges_callee_name ON call_edges(callee_name);

-- FTS5 virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, signature, docstring,
  content='symbols',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, signature, docstring)
  VALUES (new.id, new.name, new.signature, new.docstring);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, docstring)
  VALUES('delete', old.id, old.name, old.signature, old.docstring);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, docstring)
  VALUES('delete', old.id, old.name, old.signature, old.docstring);
  INSERT INTO symbols_fts(rowid, name, signature, docstring)
  VALUES (new.id, new.name, new.signature, new.docstring);
END;
