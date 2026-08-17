# マルチプレイサーバ

方式: ラウンド単位のロックステップ。ラウンド中は通信ゼロ、
終わったら各自が最終ズレを1つ提出し、サーバが順位を切って判決を配る。
リズム判定は全て各端末のローカル時計基準なので、回線差でプレイ感覚は狂わない。

## ローカルで試す

```bash
cd server
npm install
node node-server.js        # ws://localhost:8787
```

ゲームを localhost で開けば自動でこのサーバに繋がる。

## 本番に出す（Cloudflare Workers・無料枠）

```bash
cd server
npx wrangler login         # 初回のみ。Cloudflareアカウントが要る
npx wrangler deploy
```

出てきた URL（例 `short-walk.あなたの名前.workers.dev`）を
`js/net.js` の `SERVER` の `wss://short-walk.CHANGE-ME.workers.dev` に書き込んで
git push すれば、公開サイトの「ミンナデ」が動くようになる。

## プロトコル

| 方向 | メッセージ | 内容 |
|---|---|---|
| ← | `joined {playerId}` | 入室完了 |
| ← | `lobby {players, hostId}` | ロビーの顔ぶれ |
| → | `start` | ホストが開始（1人でも可、残りはNPC） |
| ← | `start {players, npcPlan, targets}` | 全員へ。NPCの計画表つき |
| → | `result {round, dev}` | ラウンドの最終ズレを提出 |
| ← | `verdict {round, devs, eliminated}` | 判決。処刑対象と全員のズレ |
| ← | `gameend` | 決着 |

NPCの各ラウンドの最終ズレは開始時に全クライアントへ同じ値が配られる。
クライアントはNPCを「その値に到着するように」歩かせるので、
見た目と判決が食い違わない。ロジック本体は `roomlogic.js`（Node/Worker共用）。
