# CALL SHEET

A presence bouncer for SillyTavern group chats. Companion to the TABLE READ preset.

Natural Order doesn't know a character left the room three scenes ago; it will happily draft them from a name-mention or a talkativeness roll. CALL SHEET keeps a list of who is actually in the scene, and when SillyTavern drafts someone who isn't, it vetoes that generation and cues someone who is.

It is deliberately **not a speaker selector**. Native reply order keeps choosing; muting, talkativeness, Force Talk, and auto-mode keep working. CALL SHEET only answers one question the native strategies can't: *is this person even here?*

## The panel

Extensions drawer → **CALL SHEET**. The whole cast, who's on set, and one click to move anyone on or off. `All in` / `All out` for scene changes. Three switches: rerouting, prose inference, and move announcements. A short log shows what the last few replies moved, so you can see inference working (or not).

Slash commands do the same thing: `/present Rin`, `/absent Rin`, bare `/present` for everyone, `/callsheet` to look.

Presence lives in chat metadata, per chat, surviving context trimming and summarisation.

## Presence from prose

With TABLE READ's `⋯ ✚ Entrances & Exits` module enabled, the writing model records staged arrivals and departures as marker lines at the end of a reply:

```
[ENTER|Rin Hoshino]
[EXIT|Mika]
```

CALL SHEET parses them and moves the sheet. A bundled preset regex hides the lines from the chat while leaving them in the stored message and the outgoing prompt, so nothing is visible and the model can still see who it staged.

**Why markers rather than reading the prose itself.** A heuristic that guesses arrivals from narration is wrong in both directions: it misses "she was already at the table" and it fires on "I wish Rin were here". A marker is the model *stating* the fact, and it costs one short line. Names are resolved against the real cast — "Rin" finds "Rin Hoshino", "Tanaka" finds "Aoi Tanaka", and a name nobody has is dropped rather than invented. When the model forgets a marker, the panel is one click away; that's the honest fallback, not a bug to engineer around.

Turn inference off in the panel if you'd rather drive presence entirely by hand.

## How rerouting picks a stand-in

Mentions of a present member in the last message win — so a preset that steers by naming (TABLE READ's Mic Pass) keeps steering. Otherwise: random among present, unmuted members, preferring anyone but the last speaker. Swipes, regenerates, continues, and quiet generations are never rerouted.

## Install

Extensions → Install Extension → this repo's URL.

## Assumptions to verify in play (never run in a live group)

1. During a group draft, `getContext().characterId` points at the member being generated. If it doesn't, the veto misfires — test first in a two-member group with one member `/absent`.
2. `/trigger "Name"` fired ~150ms after `abort(true)` starts the replacement cleanly. If it races, the fix is an event-driven handoff off `GENERATION_STOPPED`, not a longer delay.
3. Models actually emit the markers when they stage a door, and don't emit them for people merely discussed. Watch the panel log for the first session.

## Not in v0.2, on purpose

Graded presence (earshot, adjacent room), per-member cooldowns, a sidecar model computing presence, presence-aware speaker *selection*. Manual and marker-driven first.

## License

MIT.
