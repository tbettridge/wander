#!/usr/bin/env python3
"""Align WANDER orthographic animal renders to the supplied model sheets.

The comparison deliberately normalizes overall silhouette height and the hoof
baseline/centre. Remaining red/cyan disagreement therefore represents actual
proportion or anatomical landmark error rather than camera framing.
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


REFERENCE_CROPS = {
    "fox": {
        "front": (190, 38, 615, 505),
        "left": (650, 38, 1370, 510),
        "back": (200, 535, 615, 985),
        "right": (600, 540, 1370, 985),
    },
    "whitetail": {
        "front": (190, 32, 610, 535),
        "left": (650, 35, 1370, 540),
        "back": (190, 550, 610, 1050),
        "right": (650, 550, 1370, 1050),
    },
    "moose": {
        "front": (95, 15, 655, 520),
        "left": (650, 15, 1380, 520),
        "back": (90, 535, 660, 1045),
        "right": (650, 535, 1380, 1045),
    },
}


def largest_component(mask: np.ndarray) -> np.ndarray:
    height, width = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    best: list[tuple[int, int]] = []
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        queue = deque([(y, x)])
        seen[y, x] = True
        component: list[tuple[int, int]] = []
        while queue:
            cy, cx = queue.popleft()
            component.append((cy, cx))
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    queue.append((ny, nx))
        if len(component) > len(best):
            best = component
    result = np.zeros_like(mask, dtype=bool)
    if best:
        ys, xs = zip(*best)
        result[np.asarray(ys), np.asarray(xs)] = True
    return result


def fill_holes(mask: np.ndarray) -> np.ndarray:
    inverse = ~mask
    height, width = mask.shape
    exterior = np.zeros_like(mask, dtype=bool)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        for y in (0, height - 1):
            if inverse[y, x] and not exterior[y, x]:
                exterior[y, x] = True
                queue.append((y, x))
    for y in range(height):
        for x in (0, width - 1):
            if inverse[y, x] and not exterior[y, x]:
                exterior[y, x] = True
                queue.append((y, x))
    while queue:
        cy, cx = queue.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < height and 0 <= nx < width and inverse[ny, nx] and not exterior[ny, nx]:
                exterior[ny, nx] = True
                queue.append((ny, nx))
    return ~exterior


def silhouette(image: Image.Image) -> np.ndarray:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32)
    corners = np.concatenate((rgb[:16, :16].reshape(-1, 3), rgb[:16, -16:].reshape(-1, 3)))
    background = np.median(corners, axis=0)
    difference = np.linalg.norm(rgb - background, axis=2)
    saturation = rgb.max(axis=2) - rgb.min(axis=2)
    luminance = rgb.mean(axis=2)
    background_luminance = float(background.mean())
    raw = (difference > 30) & ((saturation > 16) | (luminance < background_luminance - 28))
    closed = Image.fromarray(raw.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    component = largest_component(np.asarray(closed) > 0)
    return fill_holes(component)


def bounds(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        raise RuntimeError("No animal silhouette found")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def hoof_centre(mask: np.ndarray) -> float:
    left, top, right, bottom = bounds(mask)
    band_top = bottom - max(4, int((bottom - top) * 0.075))
    ys, xs = np.nonzero(mask & (np.indices(mask.shape)[0] >= band_top))
    return float(xs.mean()) if len(xs) else (left + right) * 0.5


def compare(species: str, view: str, render_path: Path, reference_path: Path, output_dir: Path) -> None:
    render = Image.open(render_path).convert("RGB")
    reference = Image.open(reference_path).convert("RGB").crop(REFERENCE_CROPS[species][view])
    render_mask = silhouette(render)
    reference_mask = silhouette(reference)
    rx0, ry0, rx1, ry1 = bounds(render_mask)
    sx0, sy0, sx1, sy1 = bounds(reference_mask)

    reference_object = reference.crop((sx0, sy0, sx1, sy1)).convert("RGBA")
    reference_object_mask = Image.fromarray(reference_mask[sy0:sy1, sx0:sx1].astype(np.uint8) * 255)
    scale = (ry1 - ry0) / max(1, sy1 - sy0)
    size = (max(1, round((sx1 - sx0) * scale)), max(1, ry1 - ry0))
    reference_object = reference_object.resize(size, Image.Resampling.LANCZOS)
    reference_object_mask = reference_object_mask.resize(size, Image.Resampling.NEAREST)

    scaled_mask = np.asarray(reference_object_mask) > 0
    reference_foot = hoof_centre(scaled_mask)
    render_foot = hoof_centre(render_mask)
    paste_x = round(render_foot - reference_foot)
    paste_y = ry1 - size[1]

    aligned_reference_mask = np.zeros(render_mask.shape, dtype=bool)
    source_x0 = max(0, -paste_x)
    source_y0 = max(0, -paste_y)
    target_x0 = max(0, paste_x)
    target_y0 = max(0, paste_y)
    copy_w = min(size[0] - source_x0, render.width - target_x0)
    copy_h = min(size[1] - source_y0, render.height - target_y0)
    if copy_w > 0 and copy_h > 0:
        aligned_reference_mask[target_y0:target_y0 + copy_h, target_x0:target_x0 + copy_w] = \
            scaled_mask[source_y0:source_y0 + copy_h, source_x0:source_x0 + copy_w]

    alpha = np.asarray(reference_object_mask, dtype=np.uint8)
    reference_object.putalpha(Image.fromarray((alpha.astype(np.float32) * 0.52).astype(np.uint8)))
    overlay = render.convert("RGBA")
    overlay.alpha_composite(reference_object, (paste_x, paste_y))

    difference = np.full((render.height, render.width, 3), 244, dtype=np.uint8)
    difference[render_mask] = (20, 190, 210)
    difference[aligned_reference_mask] = (225, 65, 70)
    difference[render_mask & aligned_reference_mask] = (42, 42, 48)

    union = np.count_nonzero(render_mask | aligned_reference_mask)
    intersection = np.count_nonzero(render_mask & aligned_reference_mask)
    iou = intersection / max(1, union)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{species}-{view}"
    overlay.save(output_dir / f"{stem}-overlay.png")
    Image.fromarray(difference).save(output_dir / f"{stem}-difference.png")
    print(f"{stem}: IoU={iou:.3f} render={rx1-rx0}x{ry1-ry0} ref-scale={scale:.3f} paste=({paste_x},{paste_y})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("species", choices=REFERENCE_CROPS)
    parser.add_argument("view", choices=("front", "left", "back", "right"))
    parser.add_argument("render", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    compare(args.species, args.view, args.render, args.reference, args.output)


if __name__ == "__main__":
    main()
