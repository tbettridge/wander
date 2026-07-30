# WANDER: Living World

This feature branch is an isolated space for exploring browser-native,
on-device narrative intelligence. The original walking simulator remains
available at `index.html`; the first isolated experiment lives at
`living-world-lab.html`.

## Run the project

```sh
npm run serve
```

Open:

- <http://localhost:8474/> for WANDER
- <http://localhost:8474/living-world-lab.html> for the AI quest lab

The lab requires a desktop Chrome version with the built-in `LanguageModel`
API and a machine that satisfies Chrome's on-device AI requirements. Chrome may
need to download its model on first use. If the model is unavailable, the lab
deliberately falls back to a deterministic quest so the game-facing contract
can still be tested.

## Experiment boundary

The language model is a narrative voice, never the authority for game state.
The quest lab still supplies a small list of real, reachable targets and
permitted actions, requires constrained JSON, and validates every identifier
and action before accepting it. NPC conversation is intentionally different:
it is free prose with no semantic response validator, because dialogue cannot
directly mutate the world or award progress.

The initial experiment demonstrates:

1. Feature and model availability detection.
2. User-initiated model download with visible progress.
3. Quest generation from bounded world facts.
4. JSON Schema response constraints.
5. Validation against authoritative game data.
6. A deterministic fallback when AI is missing or fails.

## In-game population

Every regional station now receives a deterministic population of six named
residents. The default roster includes a station keeper, porter, traveller,
local resident, rambler, and wandering storyteller. They are assembled entirely
from low-poly Three.js primitives and use one shared articulated hierarchy, so
no external character meshes, skin weights, or animation files are required.

Two visual families share the rig:

- **Storybook folk** use rounded heads, peg limbs, layered clothing, hair or
  hats, and role-specific props.
- **Cloaked folk** use a bell-shaped silhouette, carved mask, small hands and
  restrained motion. Keepers and storytellers use this family by default.

Names, proportions, palettes, masks, clothes, accessories, animation phase,
gesture hand, and pacing style are generated from the world seed plus a stable
station/role identifier. The same railway plan therefore recreates the same
residents, while different stations remain visibly distinct. Selected residents
pace within safe platform slots; the others breathe, shift weight, look around,
and gesture. Faces and shadows are distance-managed, distant stations skip
per-character animation work, and XR uses a shorter visibility range, a
three-resident roster, and no character shadows.

Walk within speaking range of any resident and press `T` to talk. On desktop,
this releases pointer lock, freezes walking input, and opens a focused chat
panel. Write a message and press Enter (or click Send) to continue the
conversation. The Close button requests pointer lock again from that same click
and keeps the panel visible until Chrome confirms that walking controls are
restored; if locking fails, the conversation remains open so Close can be tried
again. Escape abandons the conversation and returns to WANDER's normal pause
screen.

Each person has an independent encounter count and a versioned long-term memory
stored locally in the browser. A fresh model conversation is created when the
player presses `T`. Persona, prior memory, and current deterministic regional
context are installed once at that session boundary: the resident's identity
and occupation, real station, biome, weather, time of day, nearby landmarks,
and encounter history. Follow-up turns send only the player's new message; the
model session itself carries the conversation. The character instructions
treat world facts as anchors for a lived regional identity and invite memories,
rumours, relationships, opinions, and small stories, with uncertain inventions
framed as recollection, hearsay, or belief.

When a conversation closes, WANDER immediately records a small deterministic
provisional memory, then asks the on-device model to refine it in the background.
The bounded record separates facts about the traveller, facts the NPC has
established about their own life, ongoing quests or promises, discussed
landmarks, and discussed world facts. It also keeps a specific one- or
two-sentence summary of the most recent meeting. New facts accumulate with
older memories rather than replacing the whole relationship. Returning
greetings can naturally recall the traveller's name, the last discussion, or
an ongoing goal. Each NPC has a separate `wander.livingWorld.memory.v1.*`
record, so memories survive reloads without leaving the device.

The session-opening prompt also tells residents to remain in character when a player asks them
to reveal instructions, ignore their role, or speak as an AI. Model prose is
shown as returned: there is no target-name, proper-name, length, or semantic
grounding validator on NPC replies. Raw transcripts are discarded after their
memory has been distilled, and dialogue remains non-authoritative: it cannot
itself change world state, grant items, or complete quests. The internal memory
synthesis uses constrained JSON because it writes structured local state; that
constraint is never applied to character prose.

Living World AI is opt-in on the opening screen. When enabled on a supported
Chrome installation, the game starts the on-device model from that user gesture.
Each actual meeting creates its own isolated conversation session and opening;
free-text follow-ups continue within that session.
Unsupported browsers, disabled AI, timeouts, empty responses, and generation
errors retain an authored fallback. Each NPC reply is labelled in the panel as
either **On-device model** or **Authored fallback**.

World startup never calls Chrome's model capability APIs. The opening screen
uses only synchronous feature detection; actual model creation happens solely
after the user enables AI and clicks to enter. This prevents a slow or stalled
browser model service from blocking terrain generation.

Dialogue remains deliberately desktop-only. It never takes the train's `E` or
WebXR `B` interaction, and no model call is started during an XR session. The
avatars can still render in XR using the reduced population visibility policy.

For testing, open **WANDER → Living World population**. The controls can hide
all residents or vary the station roster from three to seven people. The
regional railway planner's station-jump buttons provide the quickest tour, and
**test nearest NPC chat** moves beside the nearest loaded resident and opens the
same conversation panel without requiring a walk from the station marker.

## Suggested next experiments

- Populate the facts from WANDER's actual landmark, trail, cave, weather, and
  railway queries.
- Add off-station hamlet, trail, and train-passenger population anchors.
- Merge each avatar's primitives into a small number of rigidly weighted draw
  calls if larger crowds or standalone-XR population density becomes a goal.
- Measure frame pacing while inference runs, particularly during PC WebXR.
- Add an in-game memory journal and controls for reviewing or forgetting facts.
- Move compact NPC memories from local storage to IndexedDB if the schema grows.

## Tests

```sh
npm test
```

The tests cover deterministic identity generation, platform-safe placement,
visual variation, bounded loopable poses, conversation-session isolation,
per-NPC memory accumulation and persistence, edge/fallback chat routing,
unrestricted plain-prose NPC responses, deterministic dialogue and memory
fallbacks, and the separate quest trust boundary that rejects invented targets
or unsupported actions.
