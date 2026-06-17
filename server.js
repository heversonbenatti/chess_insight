const express = require('express');
const path = require('path');
const { getDb } = require('./db');
const Chess = require('chess.js').Chess;

const app = express();
const PORT = 3000;

// Cache global: gameIndex -> { moves: [], positions: [fen0, fen1, ...] }
let gamePositions = {};
let gamesIndex = []; // Array de PGNs para manter ordem

function stripPgnHeaders(pgn) {
  if (!pgn) return '';
  return pgn
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*\[.*\]$/gm, '')
    .trim();
}

function extractPgnMoves(pgn) {
  if (!pgn) return [];
  let body = stripPgnHeaders(pgn);
  body = body.replace(/\{[^}]*\}/g, '');
  body = body.replace(/\([^)]*\)/g, '');
  body = body.replace(/\$\d+/g, '');
  body = body.replace(/1-0|0-1|1\/2-1\/2|\*/g, '');
  body = body.replace(/\s+/g, ' ');
  
  const tokens = body.split(/\s+/).filter(Boolean);
  const moves = [];
  for (const token of tokens) {
    if (/^\d+\.{1,3}$/.test(token)) continue;
    if (token && !token.match(/^\d+$/)) {
      moves.push(token);
    }
  }
  return moves;
}

function movesMatchPrefix(moves, prefix) {
  if (moves.length < prefix.length) return false;
  return prefix.every((move, index) => moves[index] === move);
}

// Pré-calcula FENs para todas as posições em todos os jogos
async function initializeGamePositions() {
  const db = await getDb();
  const rows = db.exec(`SELECT pgn FROM games ORDER BY rowid`);
  
  if (!rows.length || !rows[0].values.length) {
    console.log('⚠️  Nenhum jogo encontrado no banco');
    return;
  }

  const allGames = rows[0].values.map(row => row[0]);
  console.log(`📊 Pré-calculando FENs para ${allGames.length} jogos...`);
  
  let totalPositions = 0;
  for (let i = 0; i < allGames.length; i++) {
    const pgn = allGames[i];
    const moves = extractPgnMoves(pgn);
    
    const chess = new Chess();
    const positions = [chess.fen()]; // Posição inicial
    
    for (const move of moves) {
      const result = chess.move(move, { sloppy: true });
      if (!result) break; // Move inválido
      positions.push(chess.fen());
    }
    
    gamePositions[i] = { moves, positions };
    totalPositions += positions.length;
    
    if ((i + 1) % 100 === 0) {
      console.log(`  ✓ ${i + 1}/${allGames.length} jogos processados`);
    }
  }
  
  gamesIndex = allGames;
  console.log(`✅ Pré-cálculo concluído: ${allGames.length} jogos, ${totalPositions} posições armazenadas\n`);
}

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

  const includePgn = req.query.include_pgn === '1' || req.query.include_pgn === 'true';

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

app.get('/api/game-detail', async (req, res) => {
  const { uuid, username } = req.query;
  if (!uuid) return res.status(400).json({ error: 'uuid obrigatório' });
  if (!username) return res.status(400).json({ error: 'username obrigatório' });

  const db = await getDb();
  const rows = db.exec(
    `SELECT uuid, url, pgn, fen, time_class, time_control, played_at, eco,
      white_username, white_rating, white_result,
      black_username, black_rating, black_result
    FROM games WHERE uuid = ?`,
    [uuid]
  );

  if (!rows.length || !rows[0].values.length) {
    return res.status(404).json({ error: 'partida não encontrada' });
  }

  const cols = rows[0].columns;
  const game = Object.fromEntries(cols.map((c, i) => [c, rows[0].values[0][i]]));
  const u = username.toLowerCase();
  game.player_color =
    game.white_username?.toLowerCase() === u ? 'white' :
    game.black_username?.toLowerCase() === u ? 'black' : null;
  
  game.moves = extractPgnMoves(game.pgn);

  res.json(game);
});

app.get('/api/position-moves', async (req, res) => {
  const { username, color, moves = '[]' } = req.query;
  if (!username) return res.status(400).json({ error: 'username obrigatório' });
  
  let movesList = [];
  try {
    movesList = JSON.parse(moves);
  } catch (e) {
    return res.status(400).json({ error: 'moves deve ser JSON válido' });
  }

  const db = await getDb();
  const u = username.toLowerCase();
  
  // Se cache não foi inicializado, calcula FEN agora
  if (Object.keys(gamePositions).length === 0) {
    await initializeGamePositions();
  }
  
  // Busca todas as partidas do jogador com essa cor
  const rows = db.exec(
    color === 'white'
      ? `SELECT pgn FROM games WHERE lower(white_username) = ? ORDER BY rowid`
      : color === 'black'
      ? `SELECT pgn FROM games WHERE lower(black_username) = ? ORDER BY rowid`
      : `SELECT pgn FROM games WHERE lower(white_username) = ? OR lower(black_username) = ? ORDER BY rowid`,
    color && color !== '' ? [u] : [u, u]
  );

  if (!rows.length || !rows[0].values.length) {
    return res.json({ 
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 
      next_moves: [], 
      opponent_moves: [] 
    });
  }

  const games = rows[0].values.map(row => row[0]);
  
  // Se movesList está vazio, retorna posição inicial
  if (movesList.length === 0) {
    const chess = new Chess();
    const currentFen = chess.fen();
    
    const nextMovesCounts = {};
    const opponentMovesCounts = {};
    
    for (const pgn of games) {
      const idx = gamesIndex.indexOf(pgn);
      if (idx < 0) continue;
      
      const data = gamePositions[idx];
      if (!data || !data.moves.length) continue;
      
      const nextMoveIsPlayer = (color === 'white');
      
      if (nextMoveIsPlayer && data.moves[0]) {
        nextMovesCounts[data.moves[0]] = (nextMovesCounts[data.moves[0]] || 0) + 1;
      }
      if (!nextMoveIsPlayer && data.moves[0]) {
        opponentMovesCounts[data.moves[0]] = (opponentMovesCounts[data.moves[0]] || 0) + 1;
      }
    }
    
    const nextMoves = Object.entries(nextMovesCounts)
      .map(([move, count]) => ({ move, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    const opponentMoves = Object.entries(opponentMovesCounts)
      .map(([move, count]) => ({ move, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    return res.json({ fen: currentFen, next_moves: nextMoves, opponent_moves: opponentMoves });
  }
  
  // Calcula a posição após a sequência de movimentos (usando Chess para pegar FEN)
  const chess = new Chess();
  for (const move of movesList) {
    const result = chess.move(move, { sloppy: true });
    if (!result) break;
  }
  const currentFen = chess.fen();
  
  // Conta próximos movimentos do jogador (usando cache de FENs)
  const nextMovesCounts = {};
  const opponentMovesCounts = {};
  
  for (const pgn of games) {
    const idx = gamesIndex.indexOf(pgn);
    if (idx < 0) continue;
    
    const data = gamePositions[idx];
    if (!data || !data.moves.length) continue;
    
    // Verifica se essa partida tem a sequência de movimentos
    if (!movesMatchPrefix(data.moves, movesList)) continue;
    
    // Pega o resto dos movimentos da partida
    const remainingMoves = data.moves.slice(movesList.length);
    if (remainingMoves.length === 0) continue;
    
    // Próximo movimento é do "jogador" se movesList.length é par (brancas) ou ímpar (pretas)
    const nextMoveIsPlayer = (movesList.length % 2 === 0 && color === 'white') || 
                              (movesList.length % 2 === 1 && color === 'black');
    
    if (nextMoveIsPlayer && remainingMoves[0]) {
      nextMovesCounts[remainingMoves[0]] = (nextMovesCounts[remainingMoves[0]] || 0) + 1;
    }
    if (!nextMoveIsPlayer && remainingMoves[0]) {
      opponentMovesCounts[remainingMoves[0]] = (opponentMovesCounts[remainingMoves[0]] || 0) + 1;
    }
  }
  
  const nextMoves = Object.entries(nextMovesCounts)
    .map(([move, count]) => ({ move, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  
  const opponentMoves = Object.entries(opponentMovesCounts)
    .map(([move, count]) => ({ move, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  
  res.json({ fen: currentFen, next_moves: nextMoves, opponent_moves: opponentMoves });
});

app.get('/api/move-stats', async (req, res) => {
  const { uuid, username, selected_index = '-1' } = req.query;
  if (!uuid) return res.status(400).json({ error: 'uuid obrigatório' });
  if (!username) return res.status(400).json({ error: 'username obrigatório' });

  const db = await getDb();
  const gameRows = db.exec(
    `SELECT uuid, pgn, white_username, black_username FROM games WHERE uuid = ?`,
    [uuid]
  );
  if (!gameRows.length || !gameRows[0].values.length) {
    return res.status(404).json({ error: 'partida não encontrada' });
  }

  const gameRow = gameRows[0].values[0];
  const cols = gameRows[0].columns;
  const game = Object.fromEntries(cols.map((c, i) => [c, gameRow[i]]));
  const u = username.toLowerCase();
  const playerColor =
    game.white_username?.toLowerCase() === u ? 'white' :
    game.black_username?.toLowerCase() === u ? 'black' : null;

  if (!playerColor) {
    return res.status(400).json({ error: 'username não corresponde ao jogador da partida' });
  }

  const selectedIndex = Number(selected_index);
  const gameMoves = extractPgnMoves(game.pgn);
  console.log(`[move-stats] game=${uuid.slice(0,8)}... moves=${gameMoves.length} index=${selectedIndex}`);

  const nextMovePrefix = (index) => {
    if (index < 0) return [];
    return gameMoves.slice(0, index + 1);
  };

  const playerMovePrefix = (() => {
    if (selectedIndex < 0) {
      return playerColor === 'white' ? [] : gameMoves.slice(0, 1);
    }
    const moveColor = selectedIndex % 2 === 0 ? 'white' : 'black';
    if (moveColor === playerColor) {
      return gameMoves.slice(0, selectedIndex);
    }
    const nextIndex = selectedIndex + 1;
    if (gameMoves.length > nextIndex) {
      return gameMoves.slice(0, nextIndex);
    }
    return [];
  })();

  const opponentMovePrefix = (() => {
    if (selectedIndex < 0) {
      return [];
    }
    const moveColor = selectedIndex % 2 === 0 ? 'white' : 'black';
    if (moveColor === playerColor) {
      return gameMoves.slice(0, selectedIndex + 1);
    }
    return gameMoves.slice(0, selectedIndex);
  })();

  const countNextMoves = (prefix, targetColor) => {
    const rows = db.exec(
      `SELECT pgn, white_username, black_username FROM games
       WHERE lower(white_username) = ? OR lower(black_username) = ?`,
      [u, u]
    );

    const counts = {};
    if (!rows.length) return [];

    for (const row of rows[0].values) {
      const line = Object.fromEntries(rows[0].columns.map((c, i) => [c, row[i]]));
      const rowPlayerColor =
        line.white_username?.toLowerCase() === u ? 'white' : 'black';
      if (rowPlayerColor !== playerColor) continue;

      const moves = extractPgnMoves(line.pgn);
      if (!movesMatchPrefix(moves, prefix)) continue;

      const turn = prefix.length % 2 === 0 ? 'white' : 'black';
      if (turn !== targetColor) continue;
      if (moves.length <= prefix.length) continue;

      const nextMove = moves[prefix.length];
      counts[nextMove] = (counts[nextMove] || 0) + 1;
    }

    return Object.entries(counts)
      .map(([move, count]) => ({ move, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  };

  const playerMoves = countNextMoves(playerMovePrefix, playerColor);
  const opponentMoves = countNextMoves(
    opponentMovePrefix,
    playerColor === 'white' ? 'black' : 'white'
  );
  console.log(`[move-stats-result] player_moves=${playerMoves.length} opponent_moves=${opponentMoves.length}`);

  res.json({
    player_moves: playerMoves,
    opponent_moves: opponentMoves,
    selected_index: selectedIndex,
    prefix_length: Math.max(playerMovePrefix.length, opponentMovePrefix.length),
  });
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
  
  // Pré-calcula FENs após servidor iniciar
  initializeGamePositions().catch(err => {
    console.error('❌ Erro ao pré-calcular FENs:', err);
  });
});
