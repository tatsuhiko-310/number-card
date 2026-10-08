# NUMBER WAR

1〜8のカードとチップで駆け引きする2人対戦カードゲームのWebアプリです。
claude.ai のアーティファクト版をもとに、**サーバー不要の静的サイト**として実装しました。

- **CPUと練習**：ブラウザだけで遊べます
- **オンライン対戦**：「部屋を作る」で表示される4桁の部屋コードを相手に伝え、別の端末から入室して対戦します。
  通信はブラウザ同士の直接通信（WebRTC）です

## 遊び方（公開方法）

`public/` フォルダの中身を静的ホスティングに置くだけで動きます。

### GitHub Pages
1. リポジトリの **Settings → Pages → Build and deployment → Source** で「GitHub Actions」を選ぶ
2. 既定ブランチに push する（または Actions タブから「Deploy to GitHub Pages」を手動実行）
3. `https://<ユーザー名>.github.io/<リポジトリ名>/` で遊べます

※ 非公開リポジトリで GitHub Pages を使うには有料プランが必要です。

### 手元で確認する
```bash
cd public
python3 -m http.server 8080
# → http://localhost:8080
```
`index.html` をダブルクリックで直接開くと、ブラウザの制限でBGMが鳴らないことがあります。上記のように簡易サーバー経由で開いてください。

## オンライン対戦のしくみ

```
 ホスト（部屋を作った人）のブラウザ ◀── WebRTC 直接通信 ──▶ ゲストのブラウザ
            │                                             │
            └──── 最初の接続先探しだけ PeerJS 公開サーバー ─────┘
```

- 部屋を作った人（ホスト）のブラウザが対戦の共有データを持ち、相手からの読み書きに応えます。
  **対戦中はホストのページを閉じないでください。**
- 手札・山札などの非公開データは各自のブラウザ内（localStorage）にだけ保存され、相手には送られません。
- 部屋コードから相手を見つけるためだけに、PeerJS の無料公開サーバー（0.peerjs.com）を使います。
  直接つながらないネットワークでは、PeerJS の中継サーバー（TURN）経由で通信します。
- 途中でページを閉じたり再読み込みしても、同じブラウザで同じ部屋番号を入力して「部屋に入る」を押せば続きから再開できます
  （相手は自動で再接続します）。
- 自前の PeerServer を使う場合は、URL に `?peer=https://example.com:9000/` のように指定します。

## 構成

```
public/index.html          ゲーム本体（画面・ルール・CPU・オンライン進行）
public/net-shim.js         オンライン対戦の通信レイヤー（WebRTC / PeerJS）
public/warp.css            画面デザイン（紺の宇宙＋ワープのテーマ）
public/warp-fx.js          演出（ワープ背景・タイトル起動・ラウンド開始・勝敗・JACKPOT・HACK・SPIKE・試合終了／演出カタログ FX-01〜11）
public/vendor/peerjs.min.js PeerJS 1.5.5（MIT License）
public/assets/             カード画像・BGM・フォント（Inter / JetBrains Mono、OFL）
.github/workflows/pages.yml GitHub Pages への公開
```

アーティファクト版の `window.claude`（db / room / user）と同じ形のAPIを `net-shim.js` が提供するため、
ゲーム本体の対戦ロジックはアーティファクト版のままです。
