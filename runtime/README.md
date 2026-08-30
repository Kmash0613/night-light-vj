# ランタイム（Three.js）

要件定義書 §5, §9 参照。

## Phase 1（実装済み・実機での確認待ち）

写真1枚で、MIDI Note On による輝度の明滅を確認する。カメラは固定（移動なし）。

**設計方針: 個別の光点（パーティクル）は打たない。** 写真から「輝度マップ」（重み画像）を作り、
MIDIノートに応じてそのマップの値が乗っている場所だけ、元の写真そのものの明るさを上げ下げする。
マップが0の場所（暗い背景など）は変化しない。

**クラスタ分けは今は無し。** 検出した領域はすべて同じ1チャンネルの重みマップに含まれ、
`config/midi-mapping.json` の `name: "KICK"` のトラックのNote Onに一律に連動する
（見つからない場合は `cluster_trigger` 全体をKICK扱いにフォールバックする）。
トラックごとに別々の場所を光らせるクラスタ分けは、動作が安定してから改めて検討する。

### 輝度マップの生成（要件定義書 §4 の簡易版・ブラウザ内実装）

写真を読み込むと自動で実行される（`extractLuminanceMask()` in `main.js`）。

1. 輝度（`0.2126R+0.7152G+0.0722B`）を計算し、上位 `top %` の明るいピクセルを閾値化
2. 4連結の連結成分ラベリングでピクセル塊（領域）に分解し、`min area` 未満のノイズを除去
3. 面積の大きい順に `max regions` 個までに間引く
4. 各領域のピクセルを、1チャンネルの重みマップ（RGBAキャンバスのRチャンネルのみ使用、
   重みは閾値からの超過量で0-1）に焼き込む

「Auto Extract」パネルの「再抽出」でパラメータを変えて再実行できる。
`mask-editor/` で作った `points.json` を読み込むと、各点を中心にソフトな円を同じ形式へ
スタンプしてマップを作る（自動抽出の代わりに手動データを使いたいとき用。`cluster` の値は
今は無視される）。

### 明滅・呼吸（背景シェーダー内で完結）

背景メッシュは独自の `ShaderMaterial`（`map`=元の写真, `maskMap`=輝度マップ）。
フラグメントシェーダーで、写真の各画素の明るさに `factor = 1 + brightGain * weight * (kickEnvelope + ambient)`
を掛ける（`weight` はその画素のマップ値）。`factor` は1を中心に上下するので、明るくも暗くもなる。

- KICKエンベロープ: `env = velocity/127 * exp(-t/tau)`。`name: "KICK"` にマッチする
  トラックが複数あれば最大値を採用する（CPU側で計算しシェーダーへuniform渡し）
- アンビエント呼吸はシェーダー側で `-ambientAmount 〜 +ambientAmount` の符号付きサイン波として計算し、
  UV座標をハッシュした位相を使うので、画面上の場所（マス目単位）ごとにバラバラの位相で明滅する。
  KICKが無い間も明るく/暗くの両方向にはっきり振れる。「Brightness」パネルの `ambient breathing` で
  量を調整（0でKICKが無いときは写真のまま静止）
- `bright gain` は明滅の強さ全体のゲイン

### ブルーム

selective bloomではなく通常の `UnrealBloomPass`（画面全体の輝度がthresholdを超えた画素が光る）。
KICKやambientで明るくなった場所（またはもともと明るい場所）がしきい値を超えれば自然に光る。
「Bloom」パネルのスライダーで調整（SEQTRAKのFX LEVEL CCでも `strength` を操作可能）。

### 色まわり

- `renderer.toneMapping` は `NoToneMapping`。背景シェーダーは手動で sRGB→linear変換してから
  明るさを掛け、`OutputPass` が最後に linear→sRGB に戻す（二重トーンマッピングを避ける）

### その他

- Three.js は `index.html` の importmap で CDN (unpkg) から読み込む。ビルド不要
- `../config/midi-mapping.json` を起動時に `fetch` する。`file://` では動かないため、
  ローカルサーバー経由（`python -m http.server`）か GitHub Pages 経由で開くこと
- 写真・光点データは `<input type="file">` でローカル読み込みし、どこにも送信しない

未実装（Phase 2以降）: 深度ディスプレイスメント、カメラ移動、DOF、カラーグレーディング、
`camera_kick` / `hue_shift` / `bloom_spike` / `scene_cut` ロールの反映、トラック別のクラスタ分け。

## 今後の着手順序

1. ~~**Phase 1**: KICKに連動した輝度マップの明滅を確認~~ → 実装済み
2. KICK一本での動作が安定したら、トラック別クラスタ（SNARE/HIHAT/PERC等）を再導入する
3. **Phase 2**: 深度マップ1枚を手動投入し、ディスプレイスメントとカメラ移動を実装
   （輝度マップの領域選択も、実際の深度値ベースに置き換える）
4. **Phase 3**: バッチツール（`../batch/`）の出力（`index.json`）を読み込めるようにする
5. **Phase 4**: 複数シーン管理・先読み・自動カメラパス選択
