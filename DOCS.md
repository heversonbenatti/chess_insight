# chess-analyzer — Docs

## O que faz
Baixa partidas do Chess.com via API e salva num SQLite local (`chess.db`).

## Uso
```bash
npm install
node sync.js <username>          # sync incremental (pula meses já baixados)
node sync.js <username> --force  # rebaixa tudo
```

## Arquivos
| Arquivo | Função |
|---|---|
| `sync.js` | CLI — busca archives, chama a API mês a mês, imprime resumo no final |
| `db.js` | Toda lógica do banco (criar tabelas, inserir, checar sync, estatísticas) |
| `chess.db` | Gerado automaticamente na primeira execução |

## Banco de dados

**`games`** — uma linha por partida  
Campos: `uuid` (PK), `url`, `pgn`, `fen`, `time_class`, `time_control`, `rules`, `eco`, `played_at` + `white_*` / `black_*` (username, uuid, rating, result, id)

**`synced_archives`** — controla quais meses já foram baixados  
Campos: `archive_url` (PK), `synced_at`

## Dependências
- `sql.js` — SQLite em pure JS (sem compilação nativa)
- `node-fetch@2` — fetch com `require()` (CommonJS)

## Pontos de expansão óbvios
- Análise por abertura: `eco` está salvo como URL, o nome fica no último segmento
- Filtrar por `time_class` (`bullet`, `blitz`, `rapid`, `daily`)
- Resultados possíveis em `*_result`: `win`, `checkmated`, `timeout`, `resigned`, `abandoned`, `draw`, `stalemate`, `agreed`
- PGN completo está salvo — dá pra passar pro Stockfish depois
