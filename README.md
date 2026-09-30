# ナンバーデュエル

1〜8のカードとチップで駆け引きする2人対戦カードゲームのWebアプリです。
claude.ai のアーティファクト版をもとに、単体で動くWebアプリとして実装しました。

- **CPUと練習**：ブラウザだけで遊べます
- **オンライン対戦**：「部屋を作る」で表示される4桁の部屋コードを相手に伝え、別の端末から入室して対戦します

## 起動方法

```bash
npm install
npm start
# → http://localhost:3000
```

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `DATA_FILE` | `data/store.json` | 対戦データの保存先（再起動しても途中の試合を再開できます） |

Docker の場合：

```bash
docker build -t number-duel .
docker run -p 3000:3000 -v $(pwd)/data:/app/data number-duel
```

## 構成

```
server.js            静的ファイル配信 + WebSocket(/ws)による対戦データの共有
public/index.html    ゲーム本体（画面・ルール・CPU・オンライン進行）
public/net-shim.js   オンライン対戦用の通信レイヤー（サーバーとWebSocketで通信）
public/assets/       カード画像・BGM
```

- アーティファクト版の `window.claude`（db / room / user）と同じ形のAPIを `net-shim.js` が提供するため、ゲーム本体の対戦ロジックはアーティファクト版のままです。
- プレイヤーの識別はブラウザに保存される秘密トークンで行います（公開IDはそのハッシュ）。
- 手札・山札などの非公開データ（`data/users/<ID>/…`）は本人しか読み書きできないようサーバー側で制限しています。
- 最終更新から24時間たった試合データは自動で削除されます。
