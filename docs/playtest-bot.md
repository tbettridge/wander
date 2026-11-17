# First Post playtest bot

`scripts/playbot-courier.mjs` plays whole rounds of First Post in a headless
browser, the way a patient player who follows the book would, and writes a
report of anything that stopped it: softlocks, stuck routes, page errors and
story dead ends, each with a screenshot.

It plays the real game, not the story walker. It types to people instead of
speaking, answers the Y/N prompts, presses E at boards and stands, N for the
book and T to talk, and moves by holding W, A, D and Shift. Nothing calls the
AI gateway: every request off the local server gets a 503, so all dialogue is
the authored kind.

## Setup, once

```sh
npm run playbot:setup
```

This installs into `.playbot/` (git-ignored): `playwright-core`, a headless
Chromium build (`@sparticuz/chromium`, Linux only), and copies of three and
Tone for sandboxes that cannot reach unpkg. On a Mac or Windows machine the
bot falls back to your installed Chrome. You can also point it at any
Chromium with `PLAYBOT_CHROMIUM=/path/to/chrome` and at any Playwright with
`WANDER_PLAYWRIGHT_PATH`.

## Running it

```sh
npm run playbot -- --seeds 1,2,3
npm run playbot -- --seed-range 1-10 --minutes 45
```

| Option | Default | What it does |
|---|---|---|
| `--seeds 1,2,3` | `1` | Story seeds to play (`?storySeed=`), one fresh browser context each. |
| `--seed-range 1-10` | | A range instead of a list. |
| `--policy jobs` | `jobs` | `jobs` carries post it passes; `no-jobs` follows only the story. |
| `--travel mixed` | `mixed` | `walk` moves every metre on foot. `mixed` walks short legs whole, and on long legs walks the first and last `--walk-limit / 2` metres and hops the middle. |
| `--walk-limit 1500` | `1500` | Metres a leg may be before mixed travel hops part of it. |
| `--speed 3` | `3` | Game clock multiple. The game caps a frame at 0.1 s, so this mostly makes days pass faster. |
| `--minutes 60` | `60` | Wall-clock budget per seed. |
| `--out dir` | `playbot-reports/<time>` | Where the report goes. |
| `--headed` | | Show the window (needs a display). |
| `--draw` | | Draw every frame. By default the bot skips WebGL drawing except for screenshots, because software rendering in a headless sandbox takes seconds per frame. |
| `--milestone-shots` | | Also screenshot each milestone (Ada arrives, first delivery, the pattern…). Off by default because a software-drawn screenshot can take a minute or more; findings and the ending are always photographed. |
| `--attach http://127.0.0.1:9333` | | Developer option: play in a page that is already loaded in a Chromium started with `--remote-debugging-port`, instead of loading a fresh one. Saves the four-minute load while working on the bot itself. |

Each seed takes three or four minutes to load in a cloud sandbox, then plays
until the last letter, the budget runs out, or thirty decisions in a row
change nothing. The exit code is 1 when there were findings.

## How it plays

After Ada's welcome (wait for her to walk over, T, up to four typed replies,
Y on A Note Across the Village), it repeats one decision, in this order:

1. If the book has a thread ready to compare, or the larger pattern to
   consider, open the book and do it.
2. If someone has asked for the courier at the end, find them and choose
   **Show what I found**.
3. Collect a paper someone has written to hand over in person (**Take:**).
4. Read papers pinned up at a stand.
5. Deliver whatever is in the satchel (the **Deliver** button or the Y prompt).
6. Read the tutorial stands in A, B and H while they still have unread
   accounts.
7. While the story is asking what people make of it, choose **More to ask**
   and then **Show what I carry** to the nearest residents.
8. With `--policy jobs`, pick up post from senders in the village it is in.
9. Otherwise walk to the nearest settlement it has not visited yet, by the
   trail network, and read its board if it has one.

Long legs (over 220 m) use the game's own `courierRoute` over the nav graph,
sampled every 10 m along the trails, as long as that route is no more than
three times the straight distance plus 400 m. Otherwise, and for every short
leg, the bot plans its own way across open ground: an A* search over a 0.5 m
grid that asks the game's structure collision (`collides`) whether the
courier would fit at each cell, in stretches of 150 m. The planner tests each
cell at the floor height of any building it is inside and again at knee
height, and opens the doors of the houses at either end of a plan (and no
others, so it never routes through a stranger's house). When the courier
starts a leg indoors and the goal is outside that house, it first walks out
through the nearer door. People are walked to until they are inside the
game's talk range (6.5 m); a goal that sits inside furniture or a wall is
reached when the courier is close enough, not exactly on it.

Every story seed is played in the same generated world (Ravenkeld, Oakgate,
Holtwick and the rest are always in the same place); seeds change only the
story.

The steering lives in `scripts/playbot/page-agent.js`. It turns toward the
next point and holds W (and Shift when far off). When it has not made progress
for four seconds of game time (not wall time, so a slow machine does not
look like a stuck courier) it backs off, then jumps and sidesteps, and now and then
skips a point. If a leg still fails it plans a fresh way round from where it
stands and tries once more. If that fails too, it records a `stuck-route`
finding with a screenshot (marked “too slow” when it was still creeping
forward but ran out of time) and hops to the end of the leg, so one bad corner
does not end the round. Those rescue hops count as hopped kilometres.

## Reading the report

`report.md` has one row per seed and then every finding. `report.json` holds
the same and more; each seed's folder has `run.json` (the full decision log,
every travel leg, and the final story state) and the screenshots.

The row shows how far the story got (beats done out of eight), how many
papers and deliveries, how many places it reached, and how many kilometres it
walked, rode and hopped. Hopped kilometres are debug teleports
(`controls.place`) along the real route; everything else used the game's own
movement.

Findings by kind:

| Kind | Means |
|---|---|
| `welcome` | Ada's welcome did not go as designed (she never came, T did nothing, no errand, Y did not take it). |
| `stuck-route` | Walking a leg stalled or ran out of time, even after a fresh way round. The screenshot shows where; `detail.leg` gives from, to and the route. The bot then hops past it and carries on. |
| `missing-person` | Someone the story sends the courier to was not near their home or village. |
| `cannot-talk` | Standing beside someone, T did not open a conversation. |
| `cannot-read` | E at a board opened nothing. |
| `delivery` / `collect` | A Deliver or Accept did not change the job's state. |
| `book` | The book did not offer the step the story said was ready. |
| `dead-end` | The story needed something that is not there: a board, a person's address, a button, a place to go next. |
| `softlock` | Twelve decisions in a row changed nothing the story counts. Thirty ends the run. |
| `page-error` | An uncaught exception or `console.error` from the page, with a count. |
| `save-size` | The story save grew past 24 KB. |
| `bot-error` | The bot itself broke. Worth reading, but not a game bug until shown to be one. |

A finding is a lead, not a verdict. The bot is a stubborn but simple player:
a `stuck-route` can be a real hole in the trail network or the steering
failing on a bridge, so look at the screenshot before filing it.

## What it cannot test

- Voice conversations, and anything the AI gateway would say.
- Frame rate or smoothness. Drawing is skipped between screenshots, so no
  timing number from a run means anything.
- Whether the writing is good, or whether a hint is clear to a person.
- Train rides and the loan horse, for now: long legs are walked or hopped.
