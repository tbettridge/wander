"""Lay out saved lab screenshots and the supplied sheet; no model pixels are retouched."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json
import math

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT.parents[1] / 'assets' / 'animal-references'
BG = '#d9d2c2'
INK = '#382d23'
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'

def font(size):
    return ImageFont.truetype(FONT, size)

def model_patch(filename, report, view):
    index = ['left', 'front', 'back', 'right', 'quarter'].index(view)
    b = report['views'][view]['bounds']
    x, y = (index % 3) * 480, (index // 3) * 510 + 30
    rect = (math.floor(x + b['left'] * .75) - 2,
            math.floor(y + b['top'] * .75) - 2,
            math.ceil(x + b['right'] * .75) + 2,
            math.ceil(y + b['bottom'] * .75) + 2)
    return Image.open(ROOT / filename).convert('RGB').crop(rect)

def place(canvas, patch, centre, baseline, height):
    w = round(patch.width * height / patch.height)
    patch = patch.resize((w, height), Image.Resampling.LANCZOS)
    canvas.paste(patch, (round(centre-w/2), baseline-height), patch if patch.mode == 'RGBA' else None)

before = json.loads((ROOT / 'before.json').read_text())
after = json.loads((ROOT / 'after.json').read_text())
previous = json.loads((ROOT / '10-before-hindquarter-feedback.json').read_text())
canvas = Image.new('RGB', (1500, 980), BG)
d = ImageDraw.Draw(canvas)
for col, title in enumerate(['ORIGINAL', 'REFERENCE', 'REFINED']):
    d.text((col*500+24, 22), title, font=font(24), fill=INK)
for row, view in enumerate(['left', 'front']):
    baseline = 465 + row * 455
    place(canvas, model_patch('before.png', before, view), 250, baseline, 365)
    ref = Image.open(ASSETS / f'horse-{view}.png').convert('RGBA')
    ref = ref.crop(ref.getbbox())
    place(canvas, ref, 750, baseline, 365)
    place(canvas, model_patch('after.png', after, view), 1250, baseline, 365)
    name = 'Left profile' if view == 'left' else 'Front'
    for col, report in [(0, before), (2, after)]:
        score = report['views'][view]['metrics']['iou'] * 100
        d.text((col*500+24, baseline+15), f'{name} · overlap {score:.1f}%', font=font(18), fill=INK)
    d.text((524, baseline+15), name, font=font(18), fill=INK)
canvas.save(ROOT / 'before-reference-after.png')

# Match the user's rear-quarter crop using the same palomino coat and pose.
focus = Image.new('RGB', (1040, 590), BG)
d = ImageDraw.Draw(focus)
for col, (filename, report, title) in enumerate([
    ('validation-palomino.png', previous, 'BEFORE YOUR FEEDBACK'),
    ('after-palomino.png', after, 'BEVELLED TAPERED MUSCLES'),
]):
    patch = model_patch(filename, report, 'right')
    patch = patch.crop((0, 0, round(patch.width*.46), patch.height))
    place(focus, patch, col*520+260, 554, 450)
    d.text((col*520+24, 24), title, font=font(21), fill=INK)
focus.save(ROOT / 'hindquarters-before-after.png')

# Compare the last delivered taper with the fuller version requested in the
# supplied anatomy photographs. Uniform height keeps the added volume visible.
last = json.loads((ROOT / '18-before-muscle-volume-feedback.json').read_text())
volume = Image.new('RGB', (1040, 1060), BG)
d = ImageDraw.Draw(volume)
for row, view in enumerate(['right', 'front']):
    for col, (filename, report, title) in enumerate([
        ('18-before-muscle-volume-palomino.png', last, 'PREVIOUS'),
        ('after-palomino.png', after, 'FULLER MUSCLES'),
    ]):
        patch = model_patch(filename, report, view)
        if view == 'right':
            patch = patch.crop((0, 0, round(patch.width*.46), patch.height))
        else:
            patch = patch.crop((0, round(patch.height*.44), patch.width, patch.height))
        place(volume, patch, col*520+260, row*510+510, 410)
        d.text((col*520+24, row*510+24), title, font=font(21), fill=INK)
        d.text((col*520+24, row*510+55), 'Thigh / gaskin' if row == 0 else 'Shoulder / forearm', font=font(16), fill=INK)
volume.save(ROOT / 'muscle-volume-before-after.png')
