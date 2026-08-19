# CALL SHEET

A presence bouncer for SillyTavern group chats. Companion to the TABLE READ preset.

Natural Order doesn't know a character left the room three scenes ago; it will happily draft them from a name-mention or a talkativeness roll. CALL SHEET keeps a list of who is actually in the scene, and when SillyTavern drafts someone who isn't, it vetoes that generation and cues someone who is.

It is deliberately **not a speaker selector**. Native reply order keeps choosing; muting, talkativeness, Force Talk, and auto-mode keep working. CALL SHEET only answers one question the native strategies can't: *is this person even here?*

## Commands

- `/absent Rin` — Rin has left the scene. Drafts of her get rerouted until she's back.
- `/present Rin` — she's back.
- `/present` — everyone on set (also the state a fresh chat starts in, so installing this changes nothing until you first use `/absent`).
- `/callsheet` — show who's in the scene.

Presence lives in chat metadata, per chat, surviving context trimming and summarisation.

## How rerouting picks a stand-in

Mentions of a present member in the last message win — so a preset that steers by naming (TABLE READ's Mic Pass) keeps steering. Otherwise: random among present, unmuted members, preferring anyone but the last speaker. Swipes, regenerates, continues, and quiet generations are never rerouted.

## Install

Extensions → Install Extension → this repo's URL.

## Assumptions to verify in play (v0.1 has never run in a live group)

1. During a group draft, `getContext().characterId` points at the member being generated. If it doesn't, the veto misfires — test first in a two-member group with one member `/absent`.
2. `/trigger "Name"` fired ~150ms after `abort(true)` starts the replacement cleanly. If it races, the fix is an event-driven handoff off `GENERATION_STOPPED`, not a longer delay.

## Not in v0.1, on purpose

Presence inference from prose (the model or a sidecar declaring arrivals and exits), a panel UI, graded presence (earshot, adjacent room), per-member cooldowns. Manual and deterministic first; inference when manual proves annoying, and only then.

## License

MIT.
