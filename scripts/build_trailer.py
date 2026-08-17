#!/usr/bin/env python3
"""Assemble the approved WANDER trailer from locally captured WebM shots."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "trailer" / "raw"
MUSIC = ROOT / "trailer" / "audio" / "Beneath_the_Ancient_Boughs.mp3"
WORK = ROOT / "trailer" / "work"
OUTPUT = ROOT / "trailer" / "output"
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
FFPROBE = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"
FONT = Path("/System/Library/Fonts/HelveticaNeue.ttc")
WIDTH, HEIGHT, FPS = 1920, 1080, 60

SHOTS = [
    ("01_mountain_reveal", 10.0),
    ("02_trail_walk", 6.0),
    ("03a_env_taiga", 2.0),
    ("03b_env_desert", 2.0),
    ("03c_env_jungle", 2.0),
    ("03d_env_coast", 2.0),
    ("04a_crossing_stones", 1.0),
    ("04b_plank_bridge_zoom", 4.0),
    ("05_wildlife", 5.0),
    ("06_village", 7.0),
    ("07_village_life", 7.0),
    ("08_npc_journey", 8.0),
    ("09_npc_memory", 5.0),
    ("10_market", 10.0),
    ("11_player_train", 5.0),
    ("12_cave_exit", 7.0),
    ("12b_great_tree", 3.0),
]

TITLE_DURATION = 4.0
END_DURATION = 6.0
TOTAL_DURATION = sum(duration for _shot_id, duration in SHOTS) + END_DURATION

CAPTIONS = [
    (4.0, 10.0, "An infinite world, shaped as you explore."),
    (10.0, 16.0, "Follow any trail. Climb any horizon."),
    (16.0, 24.0, "Forests. Deserts. Mountains. Coasts."),
    (24.0, 29.0, "The landscape is made to be crossed."),
    (29.0, 34.0, "Wildlife roams, watches, and reacts."),
    (34.0, 41.0, "Villages belong to the land around them."),
    (41.0, 48.0, "People work, travel, trade, and gather."),
    (48.0, 56.0, "Every character has needs, plans, and destinations."),
    (56.0, 61.0, "They remember what happened—and who was there."),
    (61.0, 71.0, "In village markets, people meet, trade, and share the day."),
    (71.0, 76.0, "Step aboard. Walk the cars. Find a seat."),
    (76.0, 86.0, "Above ground or below, another wonder is waiting."),
]


def run(command: list[str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, check=True)


def probe(path: Path) -> dict:
    result = subprocess.run(
        [FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def spaced_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont,
                center_x: int, y: int, spacing: int, fill: tuple[int, ...]) -> None:
    widths = [draw.textlength(character, font=font) for character in text]
    total = sum(widths) + spacing * max(0, len(text) - 1)
    x = center_x - total / 2
    for character, width in zip(text, widths):
        draw.text((x, y), character, font=font, fill=fill)
        x += width + spacing


def title_art(path: Path, ending: bool = False) -> None:
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    title_font = ImageFont.truetype(str(FONT), 88 if not ending else 82, index=0)
    sub_font = ImageFont.truetype(str(FONT), 23, index=0)
    title_y = 420 if not ending else 398
    spaced_text(draw, "WANDER", title_font, WIDTH // 2, title_y, 18, (242, 246, 245, 246))
    subtitle = "A WORLD THAT KEEPS LIVING." if ending else "AN INFINITE PROCEDURAL WORLD"
    spaced_text(draw, subtitle, sub_font, WIDTH // 2, title_y + 122, 7, (202, 216, 211, 220))
    image.save(path)


def caption_art(path: Path, text: str) -> None:
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(FONT), 42, index=0)
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=1)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    padding_x, padding_y = 28, 18
    x0 = (WIDTH - text_width) / 2 - padding_x
    y0 = 904 - padding_y
    x1 = (WIDTH + text_width) / 2 + padding_x
    y1 = y0 + text_height + padding_y * 2
    draw.rounded_rectangle((x0, y0, x1, y1), radius=17, fill=(5, 10, 12, 145))
    draw.text(((WIDTH - text_width) / 2, y0 + padding_y - bbox[1]), text, font=font,
              fill=(247, 249, 248, 255), stroke_width=1, stroke_fill=(0, 0, 0, 175))
    image.save(path)


def normalize_shot(shot_id: str, duration: float) -> Path:
    source = RAW / f"{shot_id}.webm"
    if not source.exists():
        raise FileNotFoundError(f"Missing raw shot: {source}")
    target = WORK / f"{shot_id}.mp4"
    data = probe(source)
    has_audio = any(stream.get("codec_type") == "audio" for stream in data.get("streams", []))
    video_filter = (
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,fps={FPS},"
        "tpad=stop_mode=clone:stop_duration=0.5,format=yuv420p"
    )
    command = [FFMPEG, "-y", "-hide_banner", "-loglevel", "warning", "-i", str(source)]
    if not has_audio:
        command += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    command += ["-t", f"{duration:.3f}", "-vf", video_filter, "-map", "0:v:0"]
    command += ["-map", "0:a:0" if has_audio else "1:a:0"]
    if has_audio:
        # MediaRecorder begins and ends on encoded packet boundaries, so a raw
        # take can be a few frames shorter than its authored beat. Pad only the
        # tail, then trim to the exact edit duration below; this preserves sync
        # and prevents dozens of tiny deficits accumulating in the master.
        command += ["-af", "apad=pad_dur=0.5"]
    command += [
        "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "17",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", "-shortest", str(target),
    ]
    run(command)
    return target


def make_card(art: Path, target: Path, duration: float, ending: bool = False) -> Path:
    fade_out = max(0.0, duration - 0.9)
    filter_graph = (
        f"[0:v][1:v]overlay=0:0:format=auto,fade=t=in:st=0:d=0.8,"
        f"fade=t=out:st={fade_out:.2f}:d=0.9,format=yuv420p[v]"
    )
    run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "warning",
        "-f", "lavfi", "-i", f"color=c=#05090b:s={WIDTH}x{HEIGHT}:r={FPS}:d={duration}",
        "-loop", "1", "-i", str(art),
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-filter_complex", filter_graph, "-map", "[v]", "-map", "2:a:0",
        "-t", f"{duration:.3f}", "-r", str(FPS), "-c:v", "libx264", "-preset", "medium",
        "-crf", "17", "-c:a", "aac", "-b:a", "192k", "-shortest", str(target),
    ])
    return target


def add_opening_title(source: Path, art: Path, target: Path) -> Path:
    """Composite the title over the vista so scenery begins at 0:00."""
    title_fade_out = TITLE_DURATION - 0.9
    filter_graph = (
        f"[1:v]format=rgba,fade=t=in:st=0:d=0.8:alpha=1,"
        f"fade=t=out:st={title_fade_out:.2f}:d=0.9:alpha=1[title];"
        f"[0:v][title]overlay=0:0:format=auto:enable='between(t,0,{TITLE_DURATION})',"
        "format=yuv420p[v]"
    )
    run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "warning",
        "-i", str(source), "-loop", "1", "-i", str(art),
        "-filter_complex", filter_graph, "-map", "[v]", "-map", "0:a:0",
        "-t", f"{SHOTS[0][1]:.3f}", "-r", str(FPS), "-c:v", "libx264",
        "-preset", "medium", "-crf", "17", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-shortest", str(target),
    ])
    return target


def write_srt(path: Path) -> None:
    def stamp(seconds: float) -> str:
        milliseconds = round(seconds * 1000)
        hours, milliseconds = divmod(milliseconds, 3_600_000)
        minutes, milliseconds = divmod(milliseconds, 60_000)
        secs, milliseconds = divmod(milliseconds, 1000)
        return f"{hours:02}:{minutes:02}:{secs:02},{milliseconds:03}"

    blocks = []
    for index, (start, end, text) in enumerate(CAPTIONS, 1):
        blocks.append(f"{index}\n{stamp(start)} --> {stamp(end)}\n{text}\n")
    path.write_text("\n".join(blocks), encoding="utf-8")


def main() -> int:
    if not Path(FFMPEG).exists() or not Path(FFPROBE).exists():
        raise RuntimeError("ffmpeg and ffprobe are required")
    if not MUSIC.exists():
        raise FileNotFoundError(f"Missing trailer music: {MUSIC}")
    WORK.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    missing = [shot_id for shot_id, _ in SHOTS if not (RAW / f"{shot_id}.webm").exists()]
    if missing:
        raise FileNotFoundError(f"Capture is incomplete; missing: {', '.join(missing)}")

    title_png, end_png = WORK / "title.png", WORK / "end.png"
    title_art(title_png)
    title_art(end_png, ending=True)
    normalized = [normalize_shot(shot_id, duration) for shot_id, duration in SHOTS]
    opening_clip = add_opening_title(
        normalized[0], title_png, WORK / "01_mountain_reveal_titled.mp4",
    )
    end_clip = make_card(end_png, WORK / "99_end.mp4", END_DURATION, ending=True)

    concat_path = WORK / "concat.txt"
    concat_path.write_text("".join(
        f"file '{path.as_posix()}'\n" for path in [opening_clip, *normalized[1:], end_clip]
    ))
    clean = WORK / "wander_trailer_clean.mp4"
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "warning", "-f", "concat", "-safe", "0",
         "-i", str(concat_path), "-c", "copy", "-movflags", "+faststart", str(clean)])

    caption_paths = []
    for index, (_start, _end, text) in enumerate(CAPTIONS):
        path = WORK / f"caption_{index:02}.png"
        caption_art(path, text)
        caption_paths.append(path)
    final = OUTPUT / "WANDER_official_trailer_1080p60.mp4"
    command = [FFMPEG, "-y", "-hide_banner", "-loglevel", "warning", "-i", str(clean)]
    for path in caption_paths:
        command += ["-loop", "1", "-i", str(path)]
    command += ["-i", str(MUSIC)]
    music_input_index = len(caption_paths) + 1
    filters = []
    current = "0:v"
    for index, (start, end, _text) in enumerate(CAPTIONS, 1):
        output = f"v{index}"
        filters.append(f"[{current}][{index}:v]overlay=0:0:format=auto:enable='between(t,{start},{end})'[{output}]")
        current = output
    filters.append(
        f"[{current}]fade=t=in:st=0:d=0.4,"
        f"fade=t=out:st={TOTAL_DURATION - 0.8:.2f}:d=0.8,format=yuv420p[vout]"
    )
    filters.extend([
        f"[0:a]volume=0.8,afade=t=in:st=0:d=0.5,"
        f"afade=t=out:st={TOTAL_DURATION - 1:.2f}:d=1[game]",
        f"[{music_input_index}:a]aresample=48000,atrim=duration={TOTAL_DURATION:.3f},"
        f"asetpts=PTS-STARTPTS,volume=0.64,afade=t=in:st=0:d=0.6,"
        f"afade=t=out:st={TOTAL_DURATION - 1.5:.2f}:d=1.5[music]",
        "[game][music]amix=inputs=2:duration=shortest:dropout_transition=0:normalize=0,"
        "alimiter=limit=0.95[aout]",
    ])
    command += [
        "-filter_complex", ";".join(filters), "-map", "[vout]", "-map", "[aout]",
        "-t", f"{TOTAL_DURATION:.3f}", "-r", str(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-shortest", str(final),
    ]
    run(command)

    srt = OUTPUT / "WANDER_official_trailer.srt"
    write_srt(srt)
    edit_manifest = {
        "title": "WANDER — Official Trailer",
        "durationSeconds": TOTAL_DURATION,
        "resolution": f"{WIDTH}x{HEIGHT}",
        "fps": FPS,
        "music": MUSIC.name,
        "audio": "music with captured procedural game ambience",
        "shots": [{"id": shot_id, "durationSeconds": duration} for shot_id, duration in SHOTS],
        "captions": [
            {"start": start, "end": end, "text": text} for start, end, text in CAPTIONS
        ],
        "output": final.name,
    }
    (OUTPUT / "WANDER_official_trailer_edit.json").write_text(
        json.dumps(edit_manifest, indent=2) + "\n", encoding="utf-8"
    )
    data = probe(final)
    duration = float(data.get("format", {}).get("duration", 0))
    if not TOTAL_DURATION - 0.2 <= duration <= TOTAL_DURATION + 0.2:
        raise RuntimeError(f"Unexpected final duration: {duration:.3f}s")
    print(f"Built {final} ({duration:.3f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
