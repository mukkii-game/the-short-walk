# -*- coding: utf-8 -*-
"""LPC素材から群衆スプライトシートを合成する。

    python tools/build_sprites.py

assets/sprites/lpc/ の部位シートを重ね、色替えして
assets/sprites/crowd.png（横9フレーム × 縦バリエーション）を書き出す。

行0 = 先導者（白）
行1 = プレイヤー（赤い上着。暗くしない）
行2以降 = 群衆（肌・服・ズボン・髪の組み合わせ。暗く沈める）

元素材: Universal LPC Spritesheet Character Generator
ライセンス: CC-BY-SA 3.0 / GPL 3.0（assets/sprites/CREDITS.md を参照）
"""
import os
import random
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'assets', 'sprites', 'lpc')
OUT = os.path.join(HERE, '..', 'assets', 'sprites', 'crowd.png')

ROW_WALK_R = 11        # LPC universal layout: 右向き歩行
FRAMES = 9             # フレーム0=直立、1..8=歩行ループ
CELL = 64
NPC_VARIANTS = 54      # 群衆のバリエーション数

random.seed(20260816)


def load(name):
    return Image.open(os.path.join(SRC, name)).convert('RGBA')


def walk_row(im):
    return im.crop((0, ROW_WALK_R * CELL, FRAMES * CELL, (ROW_WALK_R + 1) * CELL))


def tint(im, rgb):
    """白ベースの素材に色を乗せる（乗算）"""
    out = im.copy()
    px = out.load()
    for y in range(out.size[1]):
        for x in range(out.size[0]):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (r * rgb[0] // 255, g * rgb[1] // 255, b * rgb[2] // 255, a)
    return out


def darken(im, f):
    return tint(im, (int(255 * f), int(255 * f), int(255 * f)))


SKINS = ['light', 'olive', 'brown', 'black']
HAIRS = [None, 'hair_plain.png', 'hair_buzz.png', 'hair_natural.png']

# 群衆の服。くすんだ労働着の色域
SHIRTS = [
    (168, 158, 138), (128, 118, 104), (96, 106, 124), (142, 122, 100),
    (106, 96, 86), (86, 92, 102), (134, 138, 128), (114, 104, 122),
    (152, 140, 118), (92, 84, 76),
]
PANTS = [(70, 66, 62), (56, 60, 68), (88, 78, 64), (48, 48, 52)]

bodies = {s: walk_row(load('body_%s.png' % s)) for s in SKINS}
heads = {s: walk_row(load('head_%s.png' % s)) for s in SKINS}
shirt_w = walk_row(load('shirt_white.png'))
pants_w = walk_row(load('pants_white.png'))
shoes = walk_row(load('shoes_black.png'))
hairs = {h: walk_row(load(h)) for h in HAIRS if h}


def compose(skin, shirt_rgb, pants_rgb, hair, dark=None):
    out = Image.new('RGBA', (FRAMES * CELL, CELL), (0, 0, 0, 0))
    for layer in (bodies[skin], heads[skin], tint(pants_w, pants_rgb),
                  shoes, tint(shirt_w, shirt_rgb)):
        out.paste(layer, (0, 0), layer)
    if hair:
        out.paste(hairs[hair], (0, 0), hairs[hair])
    if dark:
        out = darken(out, dark)
    return out


def whiten(im):
    """先導者用。輪郭の陰影だけ残して全身を白に飛ばす"""
    out = im.copy()
    px = out.load()
    for y in range(out.size[1]):
        for x in range(out.size[0]):
            r, g, b, a = px[x, y]
            if a:
                lum = (r * 299 + g * 587 + b * 114) // 1000
                v = 215 + lum * 40 // 255      # 215〜255: ほぼ白、陰影はうっすら
                px[x, y] = (v, v, min(255, v + 6), a)
    return out


rows = []
# 行0: 先導者。全身まっしろ
rows.append(whiten(compose('light', (240, 240, 240), (230, 230, 230), None)))
# 行1: プレイヤー。赤い上着に青いズボン、明るいまま
rows.append(compose('olive', (198, 74, 58), (58, 92, 128), 'hair_plain.png'))
# 行2以降: 群衆。暗く沈める
for i in range(NPC_VARIANTS):
    skin = random.choice(SKINS)
    rows.append(compose(
        skin,
        random.choice(SHIRTS),
        random.choice(PANTS),
        random.choice(HAIRS),
        dark=random.uniform(0.52, 0.74),
    ))

sheet = Image.new('RGBA', (FRAMES * CELL, CELL * len(rows)), (0, 0, 0, 0))
for i, r in enumerate(rows):
    sheet.paste(r, (0, i * CELL), r)
sheet.save(OUT, optimize=True)
print('wrote %s  (%dx%d, %d rows)' % (OUT, sheet.size[0], sheet.size[1], len(rows)))
