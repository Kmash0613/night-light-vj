# 夜景写真VJシステム

夜景写真から抽出した光点を、YAMAHA SEQTRAK からの MIDI に同期して明滅させる VJ システム。
写真は単眼深度推定で疑似3D化し、仮想カメラが空間内を移動することで奥行きのある映像を生成する。

詳細な要件は [`docs/requirements.md`](docs/requirements.md) を参照。

## 構成

```
night-light-vj/
  docs/requirements.md    # 要件定義書
  midi-monitor/           # Phase 0: MIDI実測ツール（実装済み・すぐ使える）
  config/                 # MIDIマッピング設定（JSON外出し）
  batch/                  # Phase 3: バッチ前処理ツール（Python, 未実装・雛形のみ）
  runtime/                # Phase 1-4: リアルタイム描画ランタイム（Three.js, 未実装・雛形のみ）
```

## 実装フェーズ（要件定義書 §9）

- [x] **Phase 0 — MIDI実測**: `midi-monitor/` — SEQTRAKの全メッセージをログし、トラック別のノート/CC番号を確定する。**他のフェーズより先に完了させる。**
- [ ] **Phase 1 — 光点明滅の最小構成**: 写真1枚・手作業マスクでMIDI Note Onによる加算合成明滅を確認
- [ ] **Phase 2 — 深度による3D化**: 深度マップ1枚でディスプレイスメント・カメラ移動を実装
- [ ] **Phase 3 — バッチツール**: Phase 1〜2の手作業を自動化（`batch/`）
- [ ] **Phase 4 — ライブラリ化**: 複数シーン管理・先読み・カメラパス自動選択

## Phase 0: MIDIモニターの使い方

1. Yamaha Steinberg USB Driver をインストールし、SEQTRAK をUSB-Cで接続する
   （Windows では Bluetooth MIDI は使用不可。ポート排他が問題になる場合は loopMIDI を利用する）
2. Chrome で `midi-monitor/index.html` を開く
   - `file://` で Web MIDI がブロックされる場合は、`midi-monitor/` で
     `python -m http.server 8000` を実行し `http://localhost:8000/` を開く
3. SEQTRAK の各トラックを個別に鳴らし、「チャンネル / ノート集計」テーブルで
   ノート番号・チャンネル・ベロシティ範囲を確認する
4. 各行の「トラック名」欄に KICK / SNARE 等の名前を入力する
5. 「マッピング設定の下書きを書き出し」で実測に基づく JSON を出力し、
   `config/midi-mapping.schema.json` の形式に沿って `config/midi-mapping.json` を作成する
   （`config/midi-mapping.example.json` を参考に手直しする）

## 設計上の原則（要件定義書 §11）

1. 推定より確定情報を使う（MIDIから取れる情報を音声解析で推定しない）
2. 前処理はすべて自動化する
3. 深度の破綻はカメラ振幅で隠す
4. マッピングは設定ファイルに外出しする
