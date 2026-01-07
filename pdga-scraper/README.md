# 日本在住PDGA登録選手の年間PDGAランキング作成コマンド

日本在住のPDGA有効会員を PDGA 検索結果から取得し、
プロ部門の年間ポイントおよび年間賞金のランキングと、
アマ部門の年間ポイントランキングを作成するためのコマンド

## 前提
- Node.js 22+

## セットアップ
```bash
cd pdga-scraper
npm install
```

## 使い方
```bash
# デフォルト設定（0ページ目から全ページ巡回、1秒待機）
node scrape_players.js

# 例: 最初の5ページだけ、1.2秒待機で取得
node scrape_players.js --maxPages 5 --delayMs 1200

# 取得済みリストに指定年 Season Totals (Pro Totals) の Points / Prize を付与
node add_totals.js players.json players_2025_with_totals.json 2025 --delayMs 1200 --concurrency 1

# 成績ファイルからプロ/アマ別ランキングを出力
node ranking.js players_2025_with_totals.json
```

## コマンド概要
- `scrape_players.js`: 日本在住のPDGA有効会員を検索し、`players.json` を生成。
- `add_totals.js`: `players.json` に指定年の Points / Prize を付与したJSONを別名で生成。
- `ranking.js`: 成績入りJSONから Pro/Am 別の points/prize ランキングをテキスト出力。

## 主なオプション
- `scrape_players.js`: `--out` 出力先（デフォルト: `players.json`）、`--maxPages`、`--delayMs`、`--startPage`
- `add_totals.js`: 位置引数 `<in> <out> <year>`（year 必須）、オプションは `--delayMs`, `--concurrency`
- `ranking.js`: 位置引数 `<in>`（例: `players_2025_with_totals.json`）

## 出力
- `scrape_players.js`: `players.json` に生成日時・検索クエリ・選手一覧を保存（`pdgaNumber` 昇順、重複排除）。
- `add_totals.js`: 指定年の `points` / `prize` を付与したJSONを別名で保存（points/prizeが両方nullの選手は除外）。
- `ranking.js`: 入力ファイル名の4桁を年として、Pro/Am ごとに points/prize ランキングのテキストファイルを出力。

## ログ
- 標準エラーに進捗を出力します（例: `page=2 rows=25 added=25 totalUnique=50 hasNext=true`）。
