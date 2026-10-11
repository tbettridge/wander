# Courier: First Post

First Post is an optional solo proof of Wander’s courier loop and open story structure. Choose **Courier: First Post** on the start screen, or open `/?courier=first-post`. Preparation validates a connected region, binds six existing adult residents, and finds dry starting ground before enabling desktop or VR entry. The fixed landscape seed is `20260612`.

The prototype uses the normal streamed world, NPC identities, dialogue, pointing, riding, train, item ownership and living-world saves. It adds responsibilities to residents rather than creating a second population. Its save keys, encounters, NPC memories and IndexedDB notebook are separate from normal Wander. **Return to normal Wander** restores the entry URL. **Restart First Post** erases this proof’s progress and notebook; it also prevents unload and late worker saves from recreating the erased state.

## The playable loop

Six commissions are available independently across two station villages and one rural settlement. None requires the opening job or a previous delivery. The satchel holds three items. Accepting, declining, returning and delivering are explicit actions beside the relevant NPC. Delivered items transfer to the recipient exactly once, create a witnessed memory and affect familiarity and trust. Declining has no penalty; returned jobs can be accepted again. There are no deadlines in this proof.

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

## Open story threads

The first mystery consists of six immutable accounts in three threads: an old receipt matching a present dispatch, two people recalling the same private childhood incident, and an old catalog bearing a supposedly new maker’s mark. Each account has two fixed copies in different communities. Reading a copy records one piece of evidence; another copy never counts as a new clue.

Compare both accounts in any thread. Comparing any two threads enables an optional first hypothesis about repeating records and recollections. No particular NPC, commission, delivery order or community is required. Every commission can be declined, and any single community can be skipped. The first hypothesis preserves uncertainty; the larger simulation narrative and ending are later work.

The player’s collected evidence is separate from each resident’s knowledge. A resident knows local public accounts, its own witnessed parcel events, and evidence explicitly shared by the player. A sender cannot know that a parcel was delivered elsewhere until informed. Current daily whereabouts continue to use Wander’s existing knowledge rules; a permanent home address does not promise that someone is there now.

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
