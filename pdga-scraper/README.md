# PDGA JP Pro/Current Scraper

日本の現役プロ選手（Status=Current, Class=P, Country=JP）を PDGA 検索結果から取得し、`players_jp_pro_current.json` を生成するシンプルな CLI スクリプトです。

## 前提
- Node.js 18+（`fetch` が利用できる環境）

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
```

主なオプション:
- `--out <path>`: 出力先ファイル（デフォルト: `players_jp_pro_current.json`）
- `--maxPages <n>`: 取得ページ数の上限（0ページ目から開始）
- `--delayMs <n>`: ページ間の待機時間ミリ秒（デフォルト: 1000）
- `--startPage <n>`: 開始ページ（0始まり）

## 出力
- `players_jp_pro_current.json` に生成日時・検索クエリ・選手一覧を保存。
- 選手は `pdgaNumber` 昇順で、重複は自動排除。

## ログ
- 標準エラーに進捗を出力します（例: `page=2 rows=25 added=25 totalUnique=50 hasNext=true`）。***
