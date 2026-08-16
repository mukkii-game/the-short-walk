# 音素材のクレジット

## 効果音

すべて [効果音ラボ](https://soundeffect-lab.info/) の素材を加工して使用しています。

[利用規約](https://soundeffect-lab.info/agreement/)により、**クレジット表記・報告は不要**（任意）、
商用利用可、改変可です。ただし**改変した素材そのものの再配布は禁止**されているため、
このリポジトリを公開する場合は `assets/sfx/*.wav` を配布物に含めてよいか
規約を確認してください（ゲームの一部として組み込む利用は問題ありません）。

| 出力ファイル | 元素材 | 元URL |
|---|---|---|
| `step_r.wav` `step_l.wav` | 砂利の上を歩く | https://soundeffect-lab.info/sound/various/mp3/walk-gravel1.mp3 |
| `step_jump.wav` | 踏み込む | https://soundeffect-lab.info/sound/battle/mp3/step-into1.mp3 |
| `wind_loop.wav` | 風が吹く1 | https://soundeffect-lab.info/sound/environment/mp3/wind1.mp3 |
| `horn.wav` | 大型船の汽笛1 | https://soundeffect-lab.info/sound/machine/mp3/ship-big-whistle1.mp3 |
| `warn.wav` | 宇宙基地サイレン | https://soundeffect-lab.info/sound/battle/mp3/base-siren1.mp3 |
| `beam.wav` | ビーム砲3 | https://soundeffect-lab.info/sound/battle/mp3/beamgun3.mp3 |
| `zap.wav` | ビームガン | https://soundeffect-lab.info/sound/battle/mp3/beamgun-shot1.mp3 |

加工内容（`tools/prepare-audio.html` で再現可能）:
先頭の無音除去とアタック位置の整合、連続歩行からの1歩ずつの切り出し、
ループの継ぎ目のクロスフェード、音量の統一、16bit wav 化。

元の mp3 は `.tmp/src/` にあります（git 管理外）。

## まだ合成音のもの

- メトロノームのクリック（`click` / `click_accent`）— **意図的に合成音のまま**。立ち上がりの鋭さが最優先
- 提示・追従フェーズのBGM — ラウンドごとにテンポが変わるため、テンポ追従する合成音を使用
- 結果ジングル（`survive` / `dead` / `fanfare`）— 未差し替え
