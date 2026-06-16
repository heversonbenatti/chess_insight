const express = require('express');
const path = require('path');
const { getDb } = require('./db');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Retorna lista de usernames distintos no banco
app.get('/api/players', async (req, res) => {
  const db = await getDb();
  const rows = db.exec(`
    SELECT DISTINCT lower(white_username) as username FROM games
    UNION
    SELECT DISTINCT lower(black_username) FROM games
    ORDER BY username
  `);
  const players = rows.length ? rows[0].values.map(r => r[0]).filter(Boolean) : [];
  res.json(players);
});

// Retorna jogos com filtros
app.get('/api/games', async (req, res) => {
  const db = await getDb();
  const {
    username,
    time_class,
    color,           // 'white' | 'black'
    result,          // 'win' | 'loss' | 'draw'
    date_from,       // YYYY-MM-DD
    date_to,         // YYYY-MM-DD
    rating_min,
    rating_max,
    limit = 100,
    offset = 0,
  } = req.query;

  if (!username) return res.status(400).json({ error: 'username obrigatório' });

  const u = username.toLowerCase();
  const conditions = [];
  const params = [];

  // Jogador deve estar em uma das sides
  if (color === 'white') {
    conditions.push(`lower(white_username) = ?`);
    params.push(u);
  } else if (color === 'black') {
    conditions.push(`lower(black_username) = ?`);
    params.push(u);
  } else {
    conditions.push(`(lower(white_username) = ? OR lower(black_username) = ?)`);
    params.push(u, u);
  }

  if (time_class) {
    conditions.push(`time_class = ?`);
    params.push(time_class);
  }

  if (date_from) {
    conditions.push(`played_at >= ?`);
    params.push(Math.floor(new Date(date_from).getTime() / 1000));
  }
  if (date_to) {
    conditions.push(`played_at <= ?`);
    params.push(Math.floor(new Date(date_to + 'T23:59:59').getTime() / 1000));
  }

  // Rating do jogador pesquisado
  const ratingExpr = `CASE WHEN lower(white_username) = '${u}' THEN white_rating ELSE black_rating END`;
  if (rating_min) {
    conditions.push(`(${ratingExpr}) >= ?`);
    params.push(Number(rating_min));
  }
  if (rating_max) {
    conditions.push(`(${ratingExpr}) <= ?`);
    params.push(Number(rating_max));
  }

  // Resultado do ponto de vista do jogador pesquisado
  if (result) {
    const winResults  = `('win')`;
    const lossResults = `('checkmated','timeout','resigned','abandoned')`;
    const drawResults = `('draw','stalemate','agreed','repetition','insufficient','timevsinsufficient','50move')`;
    const resultSet   = result === 'win' ? winResults : result === 'loss' ? lossResults : drawResults;
    conditions.push(`(
      (lower(white_username) = '${u}' AND white_result IN ${resultSet}) OR
      (lower(black_username) = '${u}' AND black_result IN ${resultSet})
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countRows = db.exec(`SELECT COUNT(*) FROM games ${where}`, params);
  const total = countRows[0]?.values[0][0] ?? 0;

  // Dados
  const query = `
    SELECT
      uuid, url, time_class, time_control, played_at, eco,
      white_username, white_rating, white_result,
      black_username, black_rating, black_result,
      CASE WHEN lower(white_username) = '${u}' THEN 'white' ELSE 'black' END as player_color,
      CASE
        WHEN lower(white_username) = '${u}' AND white_result = 'win' THEN 'win'
        WHEN lower(black_username) = '${u}' AND black_result = 'win' THEN 'win'
        WHEN lower(white_username) = '${u}' AND white_result IN ('checkmated','timeout','resigned','abandoned') THEN 'loss'
        WHEN lower(black_username) = '${u}' AND black_result IN ('checkmated','timeout','resigned','abandoned') THEN 'loss'
        ELSE 'draw'
      END as player_result,
      ${ratingExpr} as player_rating
    FROM games ${where}
    ORDER BY played_at DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.exec(query, [...params, Number(limit), Number(offset)]);
  const cols = rows[0]?.columns ?? [];
  const games = (rows[0]?.values ?? []).map(row =>
    Object.fromEntries(cols.map((c, i) => [c, row[i]]))
  );

  res.json({ total, games });
});

// Stats agregadas do jogador
app.get('/api/stats', async (req, res) => {
  const db = await getDb();
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username obrigatório' });
  const u = username.toLowerCase();

  const rows = db.exec(`
    SELECT
      time_class,
      COUNT(*) as total,
      SUM(CASE
        WHEN lower(white_username) = '${u}' AND white_result = 'win' THEN 1
        WHEN lower(black_username) = '${u}' AND black_result = 'win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE
        WHEN lower(white_username) = '${u}' AND white_result IN ('checkmated','timeout','resigned','abandoned') THEN 1
        WHEN lower(black_username) = '${u}' AND black_result IN ('checkmated','timeout','resigned','abandoned') THEN 1 ELSE 0 END) as losses,
      MIN(CASE WHEN lower(white_username) = '${u}' THEN white_rating ELSE black_rating END) as rating_min,
      MAX(CASE WHEN lower(white_username) = '${u}' THEN white_rating ELSE black_rating END) as rating_max
    FROM games
    WHERE lower(white_username) = '${u}' OR lower(black_username) = '${u}'
    GROUP BY time_class
    ORDER BY total DESC
  `);

  const cols = rows[0]?.columns ?? [];
  const stats = (rows[0]?.values ?? []).map(row =>
    Object.fromEntries(cols.map((c, i) => [c, row[i]]))
  );

  res.json(stats);
});

app.listen(PORT, () => {
  console.log(`\n♟  Chess Analyzer rodando em http://localhost:${PORT}\n`);
});
