// CALL SHEET v0.1 — a presence bouncer for SillyTavern group chats.
// Companion to the TABLE READ preset.
//
// It is NOT a speaker selector. Native reply order (Natural Order, List,
// Pooled, Manual) keeps choosing who speaks; CALL SHEET only vetoes a drafted
// speaker who is not in the scene and cues someone who is. This is the
// vocalia-architecture-analysis §7 blueprint, taken at its laziest:
//   - one generate_interceptor, fail-open, nothing else touched
//   - presence lives in chat metadata, so it survives context trimming
//   - no message format, no attribution markup, no colour — SillyTavern's
//     ch_name stamp and Names Behavior already cover attribution
//   - native muting, talkativeness, Force Talk, and auto-mode keep working
//
// Presence is edited by hand: /present, /absent, /callsheet. Deterministic on
// purpose — same trade the preset makes everywhere else. Inference (reading
// arrivals and exits out of the prose) is the v0.2 candidate, not the default.

'use strict';

const MOD = 'call-sheet';

/* ── pure core (node-testable, no ST globals) ──────────────────────────── */

// Whole-word name mention, matching Natural Order's contract: "Misaka Mikoto"
// activates on "Misaka" or "Mikoto", never on "Misa".
function mentioned(name, text) {
    if (!name || !text) return false;
    return name.split(/\s+/).filter(Boolean).some(w =>
        new RegExp('(^|\\W)' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\W|$)')
            .test(text));
}

// Pick a replacement for an absent drafted speaker. Mentions in the last
// message win (so the preset's Mic Pass keeps steering); otherwise random
// among those present, preferring anyone but the last message's author.
function choosePresent(eligible, lastText, lastAuthor, rng = Math.random) {
    const others = eligible.filter(n => n !== lastAuthor);
    const pool = others.length ? others : eligible;
    if (!pool.length) return null;
    const called = pool.filter(n => mentioned(n, lastText));
    const from = called.length ? called : pool;
    return from[Math.floor(rng() * from.length)];
}

/* ── SillyTavern glue ──────────────────────────────────────────────────── */

function ctx() { return SillyTavern.getContext(); }

function group(c) {
    return (c.groups || []).find(g => g.id === c.groupId) || null;
}

function nameOf(c, avatar) {
    const ch = (c.characters || []).find(ch => ch.avatar === avatar);
    return ch ? ch.name : null;
}

function memberNames(c, { unmutedOnly = false } = {}) {
    const g = group(c);
    if (!g) return [];
    const muted = new Set(g.disabled_members || []);
    return (g.members || [])
        .filter(a => !unmutedOnly || !muted.has(a))
        .map(a => nameOf(c, a))
        .filter(Boolean);
}

// The sheet: array of present member names in chat metadata. First touch
// seeds it with the whole cast, which makes the extension a no-op until
// someone is marked /absent — safe to install and forget.
function sheet(c) {
    const meta = c.chatMetadata;
    if (!Array.isArray(meta[MOD])) {
        meta[MOD] = memberNames(c);
        save(c);
    }
    return meta[MOD];
}

function save(c) {
    try { (c.saveMetadataDebounced || c.saveMetadata).call(c); }
    catch (e) { console.error(`[${MOD}] metadata save failed`, e); }
}

function toast(kind, msg, title) {
    if (typeof toastr !== 'undefined') toastr[kind](msg, title);
}

/* ── the interceptor ───────────────────────────────────────────────────── */

globalThis.callSheetInterceptor = async function (chat, _contextSize, abort, type) {
    try {
        ensureCommands();
        const c = ctx();
        if (!c.groupId) return;          // solo chat: none of our business
        if (type !== 'normal') return;   // never reroute swipes, regens, continues, quiet gens

        // ASSUMPTION (verify in play): during a group draft, getContext()
        // .characterId points at the member being generated. If this reads
        // wrong, the veto misfires — check first in a two-member group.
        const speaker = c.characters?.[c.characterId]?.name;
        if (!speaker) return;

        const present = sheet(c);
        if (!present.length) return;             // empty sheet = stand down
        if (present.includes(speaker)) return;   // right person, pass

        const eligible = memberNames(c, { unmutedOnly: true })
            .filter(n => present.includes(n));
        const last = chat.filter(m => !m.is_system).at(-1);
        const cue = choosePresent(eligible, last?.mes || '', last?.name || '');
        if (!cue || cue === speaker) return;     // nobody to hand it to: fail open

        abort(true);
        toast('info', `${speaker} isn't in the scene — cueing ${cue}.`, 'CALL SHEET');
        // ponytail: fixed delay so the aborted generation unwinds before the
        // replacement starts; switch to event-driven handoff if this races.
        setTimeout(() => {
            try {
                const run = c.executeSlashCommandsWithOptions || c.executeSlashCommands;
                run.call(c, `/trigger ${JSON.stringify(cue)}`);
            } catch (e) { console.error(`[${MOD}] trigger failed`, e); }
        }, 150);
    } catch (e) {
        console.error(`[${MOD}]`, e);            // interceptors fail open by design
    }
};

/* ── slash commands ────────────────────────────────────────────────────── */

let commandsRegistered = false;

function findMember(c, raw) {
    const q = (raw || '').trim().toLowerCase();
    if (!q) return null;
    return memberNames(c).find(n => n.toLowerCase() === q)
        || memberNames(c).find(n => n.toLowerCase().startsWith(q))
        || null;
}

function setPresence(raw, isPresent) {
    const c = ctx();
    if (!c.groupId) { toast('warning', 'Not a group chat.', 'CALL SHEET'); return ''; }
    const s = sheet(c);

    if (!raw?.trim()) {                          // bare /present = everyone on set
        if (isPresent) {
            c.chatMetadata[MOD] = memberNames(c);
            save(c);
            toast('info', 'Everyone is on set.', 'CALL SHEET');
        } else {
            toast('warning', '/absent needs a name.', 'CALL SHEET');
        }
        return '';
    }

    const name = findMember(c, raw);
    if (!name) { toast('warning', `No group member matches "${raw}".`, 'CALL SHEET'); return ''; }

    const has = s.includes(name);
    if (isPresent && !has) s.push(name);
    if (!isPresent && has) s.splice(s.indexOf(name), 1);
    save(c);
    toast('info', `${name} is ${isPresent ? 'in the scene' : 'out of the scene'}.`, 'CALL SHEET');
    return '';
}

function ensureCommands() {
    if (commandsRegistered) return;
    const c = ctx();
    const reg = c.registerSlashCommand;
    if (typeof reg !== 'function') return;       // router still works without them
    reg('present', (_a, name) => setPresence(name, true), [],
        '<span class="monospace">(name)</span> – CALL SHEET: mark a member as in the scene; no name = everyone', true, true);
    reg('absent', (_a, name) => setPresence(name, false), [],
        '<span class="monospace">(name)</span> – CALL SHEET: mark a member as out of the scene', true, true);
    reg('callsheet', () => {
        const c2 = ctx();
        toast('info', sheet(c2).join(', ') || '(nobody)', 'On set');
        return '';
    }, [], '– CALL SHEET: show who is in the scene', true, true);
    commandsRegistered = true;
}

if (typeof window !== 'undefined') {
    try { ensureCommands(); } catch { /* retried on first interception */ }
}

/* ── node self-check: `node index.js` ──────────────────────────────────── */

if (typeof window === 'undefined') {
    const assert = require('assert');
    assert(mentioned('Mika', 'ask Mika about it'));
    assert(!mentioned('Mika', 'asked Mikael'));                    // whole word only
    assert(mentioned('Misaka Mikoto', 'fine, Misaka.'));           // either word activates
    assert(!mentioned('Misaka Mikoto', 'the misakan delegation')); // no partials
    assert.equal(choosePresent([], 'x', 'y'), null);
    assert.equal(choosePresent(['A'], '', 'A'), 'A');              // sole option, even as last author
    assert.equal(choosePresent(['A', 'B'], 'over to B then', 'A', () => 0), 'B'); // mention wins
    assert.equal(choosePresent(['A', 'B'], 'nothing here', 'B', () => 0), 'A');   // skips last author
    assert.equal(choosePresent(['A', 'B', 'C'], 'C knows', 'A', () => 0.99), 'C');
    console.log('call-sheet: self-checks pass');
}
