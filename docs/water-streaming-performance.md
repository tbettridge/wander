# Regional water streaming performance

The regional handoff profile now measures worker response arrival, water-field
preparation, terrain staging, frame gaps, final publication, and the following
draw. Measuring only the final terrain swap concealed the largest stall.

## Reproduction

Run the local server and open:

```text
/tests/water-handoff-profile.html?large=1&adjacent=1&live=1
```

The fixture alternates seed 4242 between adjacent nine-plan windows at the
default terrain reach (213 chunks). It checks 81 shared terrain samples on
each of three handoffs. Add `&scenery=1` to include normal water and grass
updates. Add `&coldReset=1` to compare the previous full texture reset with
the incremental streaming refresh.

## Measured regression

Before these changes, the live fixture recorded:

| Work | Three runs, milliseconds |
| --- | --- |
| Construct next World / WaterField | 721, 735, 777 |
| Start staged terrain | 72, 72, 75 |
| Longest frame interval | 808, 825, 867 |
| Final terrain handoff | 6.9, 6.7, 6.4 |

The preparation path cloned, hashed, froze and serialized roughly 25 MB of
regional descriptors synchronously. Full water texture resets introduced an
additional spike: the comparison fixture measured 95–100 ms in the scenery
update after a handoff. The grass worker also received a fresh structured
clone of the complete descriptor graph.

After the changes, the same live fixture recorded:

| Work | Three runs, milliseconds |
| --- | --- |
| Adopt prepared World / WaterField | 0.3, 0.3, 0.1 |
| Start staged terrain | 4.3, 6.7, 4.3 |
| Longest frame interval | 41.7, 58.3, 50.0 |
| Final terrain handoff | 9.6, 9.3, 9.3 |

The longest interval fell by roughly 93–95%. Several preparation frames
still exceeded 33 ms: this removes the large freeze, but does not establish
stutter-free rendering on every frame. Terrain sample checks and both window
hashes (`f17b084f` and `6edace2a`) matched the baseline. The scenery-inclusive
run also checked that water coverage and the visible grass anchor survived
each handoff. Its longest frame intervals were 41.7, 49.7 and 50.0 ms, while
incremental scenery updates peaked at 6.9, 6.3 and 6.8 ms.

## Changes and guarantees

- The planning worker serializes individual plans. The main thread decodes
  and validates them cooperatively before publishing a ready window.
- World adopts the validated field without repeating its construction.
  Terrain and grass workers reuse prepared serialized data.
- Water depth and grass clipmap coverage remain visible during incremental
  refreshes. Full landscape resets retain the cold-start behavior.
- Terrain/collision publication remains atomic. There is no speculative
  reuse of chunks whose distant trail dependencies may have changed.
- Geometry, plan hashes, validation, terrain resolution and scenery quality
  remain unchanged. Stale or cancelled preparation cannot publish a window.

Validation: the full suite passed (739 passed, zero failed, six existing
TODOs), followed by 12 passing focused streaming/encoding tests including
the final checksum-corruption and disposal cases. The normal regional game
also reached `READY — CLICK TO WALK` with the prepared-field startup path.

These desktop measurements are a regression fixture, not a guarantee of a
particular frame rate in the full game or on XR/mobile hardware. In particular,
the fixture excludes NPC navigation, the full lighting stack and distant
terrain rendering. Walking and device validation remain necessary.
