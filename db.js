const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'chess.db');

let _db = null;

async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  _db.run(`
    CREATE TABLE IF NOT EXISTS games (
      uuid        TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      pgn         TEXT,
      fen         TEXT,
      time_class  TEXT,
      time_control TEXT,
      rules       TEXT,
      eco         TEXT,
      played_at   INTEGER,

      white_username TEXT,
      white_uuid     TEXT,
      white_rating   INTEGER,
      white_result   TEXT,
      white_id       TEXT,

      black_username TEXT,
      black_uuid     TEXT,
      black_rating   INTEGER,
      black_result   TEXT,
      black_id       TEXT
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS synced_archives (
      archive_url TEXT PRIMARY KEY,
      synced_at   INTEGER NOT NULL
    )
  `);

  save();
  return _db;
}

function save() {
  if (!_db) return;
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function isSynced(db, archiveUrl) {
  const stmt = db.prepare('SELECT 1 FROM synced_archives WHERE archive_url = ?');
  const result = stmt.getAsObject([archiveUrl]);
  stmt.free();
  return Object.keys(result).length > 0;
}

function markSynced(db, archiveUrl) {
  db.run(
    'INSERT OR REPLACE INTO synced_archives (archive_url, synced_at) VALUES (?, ?)',
    [archiveUrl, Date.now()]
  );
}

function insertGame(db, game) {
  db.run(`
    INSERT OR IGNORE INTO games (
      uuid, url, pgn, fen, time_class, time_control, rules, eco, played_at,
      white_username, white_uuid, white_rating, white_result, white_id,
      black_username, black_uuid, black_rating, black_result, black_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    game.uuid,
    game.url,
    game.pgn ?? null,
    game.fen ?? null,
    game.time_class ?? null,
    game.time_control ?? null,
    game.rules ?? null,
    game.eco ?? null,
    game.end_time ?? null,
    game.white?.username ?? null,
    game.white?.uuid ?? null,
    game.white?.rating ?? null,
    game.white?.result ?? null,
    game.white?.['@id'] ?? null,
    game.black?.username ?? null,
    game.black?.uuid ?? null,
    game.black?.rating ?? null,
    game.black?.result ?? null,
    game.black?.['@id'] ?? null,
  ]);
}

function getStats(db, username) {
  const u = username.toLowerCase();
  const rows = db.exec(`
    SELECT
      time_class,
      COUNT(*) as total,
      SUM(CASE
        WHEN LOWER(white_username) = '${u}' AND white_result = 'win' THEN 1
        WHEN LOWER(black_username) = '${u}' AND black_result = 'win' THEN 1
        ELSE 0
      END) as wins,
      SUM(CASE
        WHEN LOWER(white_username) = '${u}' AND white_result IN ('checkmated','timeout','resigned','abandoned') THEN 1
        WHEN LOWER(black_username) = '${u}' AND black_result IN ('checkmated','timeout','resigned','abandoned') THEN 1
        ELSE 0
      END) as losses
    FROM games
    WHERE LOWER(white_username) = '${u}' OR LOWER(black_username) = '${u}'
    GROUP BY time_class
    ORDER BY total DESC
  `);
  return rows;
}

module.exports = { getDb, save, isSynced, markSynced, insertGame, getStats };
