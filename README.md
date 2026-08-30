# 夜景写真VJシステム

夜景写真から抽出した光点を、YAMAHA SEQTRAK からの MIDI に同期して明滅させる VJ システム。
写真は単眼深度推定で疑似3D化し、仮想カメラが空間内を移動することで奥行きのある映像を生成する。

詳細な要件は [`docs/requirements.md`](docs/requirements.md) を参照。

## 構成

```
night-light-vj/
  index.html              # 全ツールへのリンク（GitHub Pagesのトップページ）
  docs/requirements.md    # 要件定義書
  midi-monitor/           # Phase 0: MIDI実測ツール
  mask-editor/             # Phase 1: 光点マスクの手作業作成ツール（任意、runtime/は自動抽出が既定）
  runtime/                 # Phase 1-4: リアルタイム描画ランタイム（Three.js）
  config/                  # MIDIマッピング設定（JSON外出し）
  batch/                   # Phase 3: バッチ前処理ツール（Python, 未実装・雛形のみ）
```

## 実装フェーズ（要件定義書 §9）

- [x] **Phase 0 — MIDI実測**: `midi-monitor/` — SEQTRAKの全メッセージをログし、トラック別のノート/CC番号を確定する。実測結果は [`config/midi-mapping.json`](config/midi-mapping.json) に確定済み。
- [x] **Phase 1 — 輝度マップによる明滅の最小構成**（実装済み・実機での確認待ち）: `runtime/` に写真を読み込むと輝度マップを自動生成し、MIDI Note Onに応じて写真そのものの明るさを上げ下げする（個別の光点は打たない）。手動でマップの元データを作りたい場合は `mask-editor/`（任意）。カメラは固定（移動なし）。
- [ ] **Phase 2 — 深度による3D化**: 深度マップ1枚でディスプレイスメント・カメラ移動を実装
- [ ] **Phase 3 — バッチツール**: Phase 1〜2の手作業を自動化（`batch/`）
- [ ] **Phase 4 — ライブラリ化**: 複数シーン管理・先読み・カメラパス自動選択

## Phase 0: MIDIモニターの使い方

Web MIDI API はローカルにファイルを置くか、通常のWebサーバーから配信する必要がある
（サンドボックスされた埋め込みページ内では `Permissions-Policy` によりブロックされる）。
このリポジトリには GitHub Pages への自動デプロイ設定（`.github/workflows/pages.yml`）が
含まれているため、リポジトリ設定で Pages を有効化すれば、クローン不要でURLから直接使える。

**GitHub Pages を有効にする（初回のみ）**
1. GitHubの当該リポジトリ → Settings → Pages
2. "Build and deployment" の Source を "GitHub Actions" に設定
3. `midi-monitor/` に変更をpushすると自動デプロイされ、
   `https://<owner>.github.io/<repo>/` で公開される

**使い方**
1. Yamaha Steinberg USB Driver をインストールし、SEQTRAK をUSB-Cで接続する
   （Windows では Bluetooth MIDI は使用不可。ポート排他が問題になる場合は loopMIDI を利用する）
2. Chrome で公開URL（または `midi-monitor/index.html`）を開く
   - ローカルで `file://` から開くとWeb MIDIがブロックされる場合がある。その場合は
     `midi-monitor/` で `python -m http.server 8000` を実行し `http://localhost:8000/` を開く
3. SEQTRAK の各トラックを個別に鳴らし、「チャンネル / ノート集計」テーブルで
   ノート番号・チャンネル・ベロシティ範囲を確認する
4. 各行の「トラック名」欄に KICK / SNARE 等の名前を入力する
5. 「マッピング設定の下書きを書き出し」で実測に基づく JSON を出力し、
   `config/midi-mapping.schema.json` の形式に沿って `config/midi-mapping.json` を作成する
   （`config/midi-mapping.example.json` を参考に手直しする）

## Phase 1: 輝度マップによる明滅 の使い方

写真も光点データもブラウザ内だけで処理され、どこにも送信されない（サーバーにアップロードしない）。
個別の光点（パーティクル）は打たず、写真自体の明るさを輝度マップに応じて上げ下げする方式。

1. **公開URL の `runtime/` を開く**
   - 左パネルで夜景写真を読み込む（写真がまだ無ければ「サンプルを読み込む」でも可）
   - 読み込むと同時に、写真の輝度が高い場所（ネオン等）から「輝度マップ」を自動生成する
     （「Auto Extract」パネル）。`top %` / `min area` / `max regions` / `clusters` を変えて
     「再抽出」で調整できる
   - SEQTRAKを接続してノートを鳴らすと、`config/midi-mapping.json` の `cluster` に対応した
     マップ上の場所だけ、写真の明るさが指数減衰（`tau`）で上下する
   - 「Cluster Envelopes」のメーターで各クラスタのMIDIエンベロープを確認できる
   - 「Brightness」の `ambient breathing` で、MIDIが鳴っていない間の明滅（呼吸）の強さを、
     `bright gain` で明滅全体の強さを調整する
   - 「Bloom」のスライダーで、明るくなった場所が光る度合いを調整する（SEQTRAKのFX LEVELノブでも
     `strength` を操作できる — チェックボックスでON/OFF切り替え）
2. **手動で光点を配置したい場合は `mask-editor/` を使う**（任意）
   - 写真をクリックして光点を配置し、クラスタを割り当てる（数字キー `0`〜`7` でも切り替え可能）
   - 「points.json を書き出し」→ `runtime/` の「光点データ（手動、任意）」欄から読み込むと、
     自動抽出の代わりに使える

カメラは固定（移動なし）。深度によるディスプレイスメントとカメラ移動はPhase 2で追加する。

## 設計上の原則（要件定義書 §11）

1. 推定より確定情報を使う（MIDIから取れる情報を音声解析で推定しない）
2. 前処理はすべて自動化する
3. 深度の破綻はカメラ振幅で隠す
4. マッピングは設定ファイルに外出しする
