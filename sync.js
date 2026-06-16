const fetch = require('node-fetch');
const { getDb, save, isSynced, markSynced, insertGame, getStats } = require('./db');

const BASE = 'https://api.chess.com/pub/player';
const HEADERS = { 'User-Agent': 'chess-analyzer/1.0 (github.com/heversonbenatti)' };

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${url}`);
  return res.json();
}

async function getArchives(username) {
  const data = await fetchJson(`${BASE}/${username}/games/archives`);
  return data.archives ?? [];
}

async function getGamesForArchive(archiveUrl) {
  const data = await fetchJson(archiveUrl);
  return data.games ?? [];
}

async function sync(username, { force = false } = {}) {
  const db = await getDb();

  console.log(`\n🔍 Buscando archives de "${username}"...`);
  const archives = await getArchives(username);
  console.log(`   ${archives.length} archive(s) encontrado(s).`);

  let totalNew = 0;
  let totalSkipped = 0;

  for (const archiveUrl of archives) {
    const label = archiveUrl.split('/games/')[1]; // ex: 2023/01

    if (!force && isSynced(db, archiveUrl)) {
      console.log(`   ⏭  ${label} — já sincronizado, pulando.`);
      totalSkipped++;
      continue;
    }

    process.stdout.write(`   ⬇  ${label} — buscando jogos... `);
    const games = await getGamesForArchive(archiveUrl);
    let inserted = 0;

    for (const game of games) {
      insertGame(db, game);
      inserted++;
    }

    markSynced(db, archiveUrl);
    save();
    totalNew += inserted;
    console.log(`${inserted} jogo(s) salvos.`);
  }

  console.log(`\n✅ Sync concluído!`);
  console.log(`   Archives novos processados : ${archives.length - totalSkipped}`);
  console.log(`   Archives pulados (já sync) : ${totalSkipped}`);
  console.log(`   Jogos salvos nessa rodada  : ${totalNew}`);

  // Estatísticas rápidas
  console.log(`\n📊 Resumo por time_class:`);
  const stats = getStats(db, username);
  if (stats.length > 0) {
    const cols = stats[0].columns;
    const rows = stats[0].values;
    console.log(`   ${'Tipo'.padEnd(12)} ${'Total'.padStart(6)} ${'Vitórias'.padStart(10)} ${'Derrotas'.padStart(10)} ${'Win%'.padStart(7)}`);
    console.log(`   ${'-'.repeat(50)}`);
    for (const row of rows) {
      const obj = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
      const winRate = obj.total > 0 ? ((obj.wins / obj.total) * 100).toFixed(1) : '0.0';
      console.log(
        `   ${String(obj.time_class ?? 'unknown').padEnd(12)} ` +
        `${String(obj.total).padStart(6)} ` +
        `${String(obj.wins).padStart(10)} ` +
        `${String(obj.losses).padStart(10)} ` +
        `${(winRate + '%').padStart(7)}`
      );
    }
  } else {
    console.log('   Nenhum jogo encontrado para esse usuário.');
  }
}

// CLI
const args = process.argv.slice(2);
const username = args[0];
const force = args.includes('--force');

if (!username) {
  console.error('Uso: node sync.js <username> [--force]');
  console.error('  --force  rebusca todos os archives, mesmo os já sincronizados');
  process.exit(1);
}

sync(username, { force }).catch(err => {
  console.error('\n❌ Erro:', err.message);
  process.exit(1);
});
