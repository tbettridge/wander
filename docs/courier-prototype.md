# Courier: First Post

First Post is the game Wander opens with: a solo courier's round with an open story. The landing page loads it by default; **Wander freely instead** (or `/?courier=off`) opens the open world, and an explicit `?wanderSeed=`, water preview or other development mode keeps its own world. The first visit tells the player the world is being made, once, with real progress; later visits find it in the device's cache and say it is only being opened. The station board for multiplayer sits behind the **Multiplayer** button in the bottom-right corner, and in First Post explains that visits happen in the open world. The debug panel, frame counter and AI status stay hidden until Shift is tapped three times (or `?debug` is given). Live voice mode starts with the round (the Begin click asks for the microphone) unless it was turned off in the debug panel. Preparation validates a connected region, binds six existing adult residents, and finds dry starting ground before enabling desktop or VR entry. The fixed landscape seed is `20260612`.

The prototype uses the normal streamed world, NPC identities, dialogue, pointing, riding, train, item ownership and living-world saves. It adds responsibilities to residents rather than creating a second population. Its save keys, encounters, NPC memories and IndexedDB notebook are separate from normal Wander. **Return to normal Wander** restores the entry URL. **Restart First Post** erases this proof’s progress and notebook; it also prevents unload and late worker saves from recreating the erased state.

## The playable loop

Seven commissions are available independently across two station villages and one rural settlement, the tutorial opening of the round; every other settlement can post its own (see below). None requires the opening job or a previous delivery. The satchel holds three items. Accepting, declining, returning and delivering are explicit actions beside the relevant NPC. Delivered items transfer to the recipient exactly once, create a witnessed memory and affect familiarity and trust. Declining has no penalty; returned jobs can be accepted again. There are no deadlines in this proof.

| Sender | Commission | Recipient |
| --- | --- | --- |
| Dispatcher | First Letter | Gardener |
| Riding guide | Trail Notes | Archivist |
| Gardener | Seeds for the Platform | Dispatcher |
| Potter | A Cup for the Platform | Archivist |
| Poet | Return Manuscript | Dispatcher |
| Archivist | Catalog Copy | Potter |

Briefs include the recipient’s canonical name, community and permanent home address relative to its central well. Residents keep their normal local routines. Directions point toward a real trail marker; physical road posts mark destinations at junctions and along the route. Ask the riding guide for a lesson in horse controls, or the dispatcher or archivist about boarding and riding trains; chosen lessons are kept in the notebook. Foot travel, the independent loan horse and regional trains use the existing systems. The train route diagram is hidden in First Post, while boarding, seat and stop information remain available.

The cup accumulates rough handling only while moving with sprint/gallop input; five seconds or a player jump chips it. Train motion does not damage it. A chipped cup remains deliverable and receives a different acknowledgement.

## The story: a fixed scaffold, placed where the courier goes

The story is a lattice of beats (`src/courierstory.mjs`). Three glitches (a record that repeats, a memory two people share, a thing older than its maker) can be found in any order; any two compared let the courier see a pattern; a resident then names it in their own words; once two residents of different temperaments have reacted, a page turns up that knows the courier's own road; and a resident near the courier asks for them and reads everything back before handing over the last letter. The first tell (the FP-17 dispatch sheet) and the last letter's final line are authored and the same for everyone. Until the courier holds the dispatch sheet, it is the only paper a stand shows.

Each beat can be shown by two interchangeable tells. A tell is authored facts, not prose: the sentences that carry the clue, the anchor phrases that must survive, and who could plausibly have written it, by role and always ending in anyone. A **story seed** is drawn once when a new First Post begins and kept in the save, so each playthrough fills the beats differently and a given save always replays the same. `?storySeed=N` pins it for a new run.

**Progress belongs to the courier; papers are placed locally.** The director (`src/courierdirector.mjs`) looks at a settlement when the courier arrives, or again after a rest once the story has moved, and offers at most one new paper: the missing half of something begun first, then the later beats, and only then a new glitch. It casts a resident who lives there, records the placement in the save so it never re-rolls, and pins it to the board or has the writer hand it over in person (they wait by their own front door). A paper left unread follows the courier as a copy two arrivals later, at most three copies at once. Villages, towns and stations always offer something when the story needs it; a farmstead or hamlet may be quiet, never twice running. Near the three tutorial villages the director leaves their own accounts to them.

Every settlement the courier reaches gets a Post & Errands board (a plainer post at farmsteads and hamlets), roads signed to its three nearest neighbours with name boards on the way in and walking times on the fingerpost, and residents who can give those directions. Signed roads reach as far as the trail graph, about 20 km from the start. Settlements also post their own commissions: a letter or parcel from someone there to someone in a place the courier has already been. When the story has a fresh half of a glitch to place, its recipient becomes the writer and shows it on delivery, so carrying is the quick road to the story; a courier who takes no jobs still reaches the ending.

Anyone can be shown what the courier carries and answers in their own temperament (afraid, relieved, denying or curious). Nobody has the word "simulation": said to a resident, they ask what it means, keep the courier's answer, and may use the word from then on.

Residents' letters and accounts are written by the model in the writer's voice from the authored facts, in the background while the courier walks over. `validateStoryWork` rejects anything that drops an anchor, borrows another tell's clue, adds a number or a name the facts do not give, or uses a word this world does not have; the authored version is used whenever generation is unavailable or rejected. The edition read first is saved and never regenerated. The turn toward the courier is built from their real recorded arrivals and deliveries, as collected pages only; pages the player wrote are never touched.

The save stays bounded however far the courier walks: only settlements holding a paper are recorded, finished commissions shrink to a count, and residents remember only the latest few things they were shown or taught. `node scripts/walk-courier-story.mjs --seed 7 --policy no-jobs` prints one walk through the lattice; `tests/courierdirector.mjs` walks 500 seeds under six policies (no jobs, every job, random, three villages only, never revisiting, farmsteads only), with and without the tutorial villages, and checks the ending is always reached, replays are identical, placements never re-roll and the save stays under 24 KB after 2,000 arrivals.

The player’s collected evidence is separate from each resident’s knowledge. A resident knows local public accounts, its own witnessed parcel events, anything it wrote, and evidence explicitly shared by the player. A sender cannot know that a parcel was delivered elsewhere until informed. Current daily whereabouts continue to use Wander’s existing knowledge rules; a permanent home address does not promise that someone is there now.

A save made before this story existed upgrades in place: its accounts, comparisons and hypothesis become beats, its story seed is derived from its run, and if the poet had already given the old ending, that page is kept and the story carries on.

## Signed roads and finding a village

Every signed road has its own posts (`src/courierroads.mjs`): one at each fork, one about 55 m past it to confirm the branch, and fills so no stretch goes more than about 220 m without a post. A post the ground will not take is slid along the road and to either side rather than dropped. Roads that pass the same spot share one post with an arm per destination, and a fork post stands where the road in arrives at the junction, so it names every way on from there; reading it (E) says which way each arm points. The trail network keeps a least-bad path even across open sea; a signed road charges heavily for sea and goes round by land. A road that would wind far beyond the straight distance (more than 2.5 times, or 3 km more) is not signed, and residents say the water is in the way and name the train if both places have a station.

A village can be found before it is seen (`src/villagebeacons.mjs`, `src/villagebeaconsystem.js`). Every church strikes the hour, its bell synthesised from a cast bell's partials (`src/bellsound.mjs`) and heard up to 2.4 km off: quieter, duller and later the further away, and panned to the side the tower is on. Each village has its own note. Two or three chimneys smoke in every settlement, the same for every player and changing every two game hours, in plumes sized in metres so they still read at several hundred metres and dark at night. Each Post & Errands board has a 12 m mast (9 m at farmsteads and hamlets) with a larger pennant and a lantern at its head that glows at dusk, seen from about 2 km. Hamlets and farmsteads have no church, so their smoke and mast are what mark them.

## NPC creativity

Tell the poet about an actual recorded journey, optionally sharing only the selected notebook page’s text. Completed deliveries are also included in that disclosure, but a delivery is not required. The poet produces one saved edition with an introduction identifying the account shared. Re-reading never generates a new version.

When the existing AI preference and provider permit generation, a low-priority background request uses a fresh scoped session and a constrained JSON result. Unknown event references and invalid output are rejected. Disabled, unavailable, failed or timed-out generation returns an authored poem. Text is expressive material; it cannot create evidence, accept jobs or change canonical world state. The published edition is cached in the proof’s world save.

## Notebook and controls

| Action | Desktop | VR |
| --- | --- | --- |
| Open or close journey book | N; Escape also closes | Right grip |
| Talk to nearby resident | T | Right B; or Talk in the book |
| Read public accounts | E near a reading stand; or Questions in the book | Questions in the book near a stand |
| Select, write or draw | Mouse and keyboard | Right trigger ray; on-panel keyboard |
| Mount or dismount | R | Left Y |
| Board or leave regional train | Walk through an open doorway | Walk through an open doorway |
| Sit or stand near a seat | E | Right B |

Text pages support drawing, erasing, undo, deletion and new pages. Only chosen directions, accepted briefs, read accounts and the finished poem enter the collected pages. Drawings store normalized vector strokes; there is no generated map, route pin or GPS position.

The book captures locomotion, turning, horse steering, jumps, and train interaction. It retains the previous foot, saddle or seat control ownership when closed. Train movement and headset tracking continue while reading. Train travel is still recorded while the book is open.

Notebook pages autosave in IndexedDB. A storage failure leaves edits accessible and offers JSON export. Desktop **Print / Save as PDF** opens an A5 journey book with a cover, text, vector drawings, collected material and extra blank pages. VR edits use the same notebook; return to desktop to print or download.

## Verification

Run `npm test` for the complete repository suite. Focused courier tests cover independent orders, declined commissions, skipped communities, satchel capacity, remote handoff rejection, ownership and duplicate rewards, returns, knowledge separation, evidence copying, cargo handling, persistence, cached poems, stale generation after reset, provider failures, timeouts, fresh sessions and save suspension.

Run `npm run playtest:courier` with Playwright installed; `WANDER_PLAYWRIGHT_PATH` can point to the bundled Playwright module. The script runs a local server and rendered Chrome, exercises all six offer interfaces, public reading, story comparisons, handoffs, notebook drawing, PDF creation, reload, scene-space keyboard/hit selection, native horse motion, native train boarding/carrying and reset. It writes screenshots, a PDF and a JSON report into a temporary artifact directory. Remote scenes are arranged using debug teleports; train schedule checks use bounded native simulation steps.

Physical headset interaction and comfort, a complete first-time human journey between communities, live paid-provider creative quality, and repeated human playtests still require evaluation. The software controller adapter checks do not establish headset usability. Co-op, timed commissions, boats, balloons, NPC escorting, multiple creative editions and later story revelations are outside this proof.
