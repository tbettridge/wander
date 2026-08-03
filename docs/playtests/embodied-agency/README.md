# Embodied NPC agency — human playtest

## Goal and pass criteria

Run five independent 15-minute sessions with people who have not read the feature spec.

The Phase 7 gate passes when:

- at least 4/5 participants correctly infer the broad purpose of at least 5/7 vignettes without opening dialogue;
- at least 4/5 rate unsolicited NPC interactions **rare but noticeable** during free play;
- nobody sees dialogue open automatically or an NPC forcibly stop the player.

Do not teach participants the expected answers before their session. Test recognition, not recall.

## One-time setup

1. From the repository root, run `npm run playtest`.
2. Open `http://localhost:8474/` in a desktop browser.
3. Open the response form in a second tab: `http://localhost:8474/docs/playtests/embodied-agency/participant-form.html`.
4. In WANDER, expand the top-right debug panel, then **Living World population**.
5. Confirm these switches are on: intent props, NPC initiation, travel groups, and situated actions.
6. Let the world run until the population status says residents have spawned.

Use a fresh private/incognito window for each participant. This prevents the previous participant's cooldowns, memories, and encounters from affecting the next session.

## Session script — 15 minutes

### 0:00–1:00 · Introduction

Read this verbatim:

> This is a walking game prototype. Please explore naturally and say aloud what you think people in the world are doing and why. There are no right answers, and we are testing the game rather than you. For the first part, do not press T or open conversations. If somebody approaches or prompts you, you may respond or decline as you prefer.

Explain movement controls only. Do not mention letters, trades, groups, or situated actions.

### 1:00–8:00 · Unscripted walk

- Let the participant walk without guidance.
- Count every unsolicited NPC offer they notice.
- Record any automatic dialogue opening or moment where control is taken away.
- Do not use the playtest-scene control yet.
- At 8:00, ask: “So far, how would you describe how often people tried to get your attention?” Record the answer before showing the choices.

### 8:00–14:00 · Seven recognition vignettes

For each vignette:

1. Ask the participant to look away briefly.
2. In **Living World population → playtest scene**, choose the named scene and press **load playtest scene**.
3. Collapse the debug panel so its label cannot cue the participant.
4. Let the participant watch for up to 40 seconds without pressing T.
5. Ask: “What do you think this person or group is doing, and what makes you think that?”
6. Enter the answer verbatim in the response form. Do not correct them.

Run the scenes in a different order for each participant:

- letter delivery
- parcel journey
- repair work
- trade offer
- travelling pair
- map consultation
- waiting for train

If the debug status says a scene is unavailable, wait for residents to finish spawning and try once more. Mark it **not shown** if it still fails; do not count it correct.

### 14:00–15:00 · Debrief

Ask:

1. “Did people trying to get your attention feel intrusive, rare but noticeable, or too easy to miss?”
2. “Did any character seem to open a conversation automatically?”
3. “Did anybody stop or move you against your will?”
4. “Which character behavior felt most alive?”
5. “Which behavior was confusing or artificial?”

After all seven answers are locked, use the rubric below to mark correctness.

## Broad-purpose scoring rubric

Accept ordinary synonyms; exact nouns are not required.

| Scene | Count as correct when the answer communicates |
|---|---|
| Letter delivery | delivering/carrying mail, a message, or a letter |
| Parcel journey | carrying or delivering a package/parcel/load |
| Repair work | fixing, maintaining, or repairing something |
| Trade offer | selling, trading, or offering goods |
| Travelling pair | accompanying or intentionally travelling/walking together |
| Map consultation | navigating, checking directions, or consulting a route/map |
| Waiting for train | waiting for a train/departure on the platform |

Appearance-only answers such as “holding a basket” do not pass unless the participant also infers a broad purpose.

## Save and score

1. Press **Download response JSON** in the form after each session.
2. Put the five JSON files in any convenient folder.
3. From the repo, run:

   `npm run playtest:score -- /path/response-1.json /path/response-2.json /path/response-3.json /path/response-4.json /path/response-5.json`

The command prints every participant's score and the aggregate gates. Exit code `0` means all human-playtest gates passed; exit code `2` means at least one gate needs iteration.

## What to do with failures

- If a prop scene fails repeatedly, improve silhouette, scale, grip, or aftermath—not dialogue.
- If map/repair/train scenes fail, improve the pose and spatial anchor cue.
- If interaction pressure fails high, increase cooldown or lower initiation range/frequency.
- If interaction pressure fails low, improve the approach/prompt cue before increasing frequency.
- Treat automatic dialogue or forced movement as a release blocker.
