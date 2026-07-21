#!/usr/bin/env python3
"""Prepare transparent, tightly cropped model-sheet views for the animal lab.

The source sheets remain the artist's references. This script removes their
paper background, isolates the connected animal silhouette, and emits one
same-orientation RGBA image per orthographic view. The lab can then align the
reference to its exact render baseline and measure both silhouettes.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from animal_compare import REFERENCE_CROPS, bounds, largest_component, silhouette


def export_sheet(species: str, source_path: Path, output_dir: Path) -> None:
    source = Image.open(source_path).convert("RGBA")
    source_alpha = np.asarray(source, dtype=np.uint8)[:, :, 3]
    has_useful_alpha = float((source_alpha < 8).mean()) > 0.25
    for view, crop_box in REFERENCE_CROPS[species].items():
        crop = source.crop(crop_box)
        crop_pixels = np.asarray(crop, dtype=np.uint8)
        if has_useful_alpha:
            # Background-removed sheets retain softer fur/antler edges. Use a
            # confident alpha core to reject labels and drop shadows, then keep
            # only the antialiased pixels immediately connected to that core.
            core = largest_component(crop_pixels[:, :, 3] > 96)
            expanded = np.asarray(
                Image.fromarray(core.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(7)),
            ) > 0
            alpha_source = np.where(expanded, crop_pixels[:, :, 3], 0).astype(np.uint8)
            mask = alpha_source > 80
        else:
            mask = silhouette(crop.convert("RGB"))
            alpha_source = mask.astype(np.uint8) * 255
        x0, y0, x1, y1 = bounds(mask)
        rgb = crop_pixels[y0:y1, x0:x1, :3]
        alpha = alpha_source[y0:y1, x0:x1]
        rgba = np.dstack((rgb, alpha))
        output_path = output_dir / f"{species}-{view}.png"
        Image.fromarray(rgba, "RGBA").save(output_path, optimize=True)
        print(f"wrote {output_path} ({x1 - x0}x{y1 - y0})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fox", required=True, type=Path)
    parser.add_argument("--whitetail", required=True, type=Path)
    parser.add_argument("--moose", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    export_sheet("fox", args.fox, args.output)
    export_sheet("whitetail", args.whitetail, args.output)
    export_sheet("moose", args.moose, args.output)


if __name__ == "__main__":
    main()
