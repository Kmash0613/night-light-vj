# ランタイム（Three.js）

要件定義書 §5, §9 参照。

## Phase 1（実装済み・実機での確認待ち）

写真1枚・手作業マスク（`../mask-editor/` で作成）で、MIDI Note On による光点の加算合成明滅を確認する。
カメラは固定（移動なし）。ブルームは光点レイヤーのみに適用され、背景写真にはかからない
（three.js の selective bloom = "darken non-bloomed" 手法。`main.js` 参照）。

- Three.js は `index.html` の importmap で CDN (unpkg) から読み込む。ビルド不要
- `../config/midi-mapping.json` を起動時に `fetch` する。`file://` では動かないため、
  ローカルサーバー経由（`python -m http.server`）か GitHub Pages 経由で開くこと
- 写真・光点データは `<input type="file">` でローカル読み込みし、どこにも送信しない
- 明滅エンベロープ: `env = velocity/127 * exp(-t/tau)`。クラスタは複数トラックが乗る場合、
  各トラックのエンベロープの最大値をそのクラスタの値として採用する
- MIDIが鳴っていない間もゼロにはならず、点ごとに位相をずらしたアンビエントな明滅
  （「呼吸する街」§1）をベースに乗せ、MIDIがその上に加算される。「Light Points」パネルの
  `ambient breathing` スライダーで量を調整（0でMIDIのみの明滅に戻る）
- `renderer.toneMapping` は `NoToneMapping`。背景写真のマテリアルは `toneMapped` が
  デフォルトtrueのため、ここにフィルミックトーンマッピングをかけると `OutputPass` の
  カラーマネジメントと二重適用され彩度・コントラストが落ちるので使わない

未実装（Phase 2以降）: 深度ディスプレイスメント、カメラ移動、DOF、カラーグレーディング、
`camera_kick` / `hue_shift` / `bloom_spike` / `scene_cut` ロールの反映。

## 今後の着手順序

1. ~~**Phase 1**: 光点の加算合成明滅を確認~~ → 実装済み
2. **Phase 2**: 深度マップ1枚を手動投入し、ディスプレイスメントとカメラ移動を実装
3. **Phase 3**: バッチツール（`../batch/`）の出力（`index.json`）を読み込めるようにする
4. **Phase 4**: 複数シーン管理・先読み・自動カメラパス選択
