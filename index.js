// CALL SHEET v0.2 — a presence bouncer for SillyTavern group chats.
// Companion to the TABLE READ preset.
//
// It is NOT a speaker selector. Native reply order (Natural Order, List,
// Pooled, Manual) keeps choosing who speaks; CALL SHEET only vetoes a drafted
// speaker who is not in the scene and cues someone who is:
//   - one generate_interceptor, fail-open, nothing else touched
//   - presence lives in chat metadata, so it survives context trimming
//   - no message format, no attribution markup, no colour
//   - native muting, talkativeness, Force Talk, and auto-mode keep working
//
// v0.2 adds:
//   - a panel in the extensions drawer: the cast, who is on set, one click to
//     change it, and a log of what the prose moved
//   - presence inference from prose via [ENTER|Name] / [EXIT|Name] markers
//     emitted by the writing model (TABLE READ's "Entrances & Exits" module),
//     parsed out of the message and hidden from the chat by preset regex.
//
// Why markers rather than reading the prose itself: a heuristic that guesses
// arrivals from narration is wrong in both directions — it misses "she was
// already at the table" and it fires on "I wish Rin were here". A marker is
// the model stating the fact, and it costs one short line. When the model
// forgets one, the panel is one click away, which is the honest fallback.

'use strict';

const MOD = 'call-sheet';
const DEFAULTS = { reroute: true, infer: true, announce: true };

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

// [ENTER|Rin] / [EXIT|Rin Hoshino] anywhere in the message, one per line.
// Tolerant of the decorations models add to bracket lines: leading bullets,
// wrapping asterisks, a trailing pipe, a missing close bracket. Same tolerance
// the tracker grammar needed for exactly the same reason.
const CUE = /\[\s*(ENTER|EXIT)\s*\|\s*([^|\]\r\n]+?)\s*\|?\s*(?:\]|$)/gim;

function parseCues(text) {
    if (!text) return [];
    const out = [];
    for (const m of text.matchAll(CUE)) {
        const name = m[2].replace(/^[\s*_>-]+|[\s*_]+$/g, '');
        if (name) out.push({ verb: m[1].toUpperCase(), name });
    }
    return out;
}

// Models write "Rin" for "Rin Hoshino", and occasionally the reverse. Resolve
// against the real member list; an unresolvable cue is dropped, never invented.
function resolveName(raw, members) {
    const q = (raw || '').trim().toLowerCase();
    if (!q) return null;
    return members.find(n => n.toLowerCase() === q)
        || members.find(n => n.toLowerCase().startsWith(q))
        || members.find(n => mentioned(n, raw))
        || null;
}

// Fold cues into a presence list. Last cue for a name wins, so a member who
// enters and leaves within one reply ends up out, which is what the prose said.
function applyCues(present, cues, members) {
    const set = new Set(present);
    const moved = [];
    for (const { verb, name } of cues) {
        const real = resolveName(name, members);
        if (!real) continue;
        const wantIn = verb === 'ENTER';
        if (set.has(real) === wantIn) continue;
        wantIn ? set.add(real) : set.delete(real);
        moved.push({ name: real, in: wantIn });
    }
    return { present: members.filter(n => set.has(n)), moved };
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

function avatarOf(c, name) {
    const ch = (c.characters || []).find(ch => ch.name === name);
    return ch ? ch.avatar : null;
}

function settings() {
    const c = ctx();
    const s = c.extensionSettings;
    s[MOD] = Object.assign({}, DEFAULTS, s[MOD] || {});
    return s[MOD];
}

function saveSettings() {
    try { ctx().saveSettingsDebounced(); }
    catch (e) { console.error(`[${MOD}] settings save failed`, e); }
}

// The sheet: present member names in chat metadata. First touch seeds the
// whole cast, so installing changes nothing until something marks someone out.
function sheet(c) {
    const meta = c.chatMetadata;
    if (!Array.isArray(meta[MOD])) {
        meta[MOD] = memberNames(c);
        save(c);
    }
    return meta[MOD];
}

function setSheet(c, names) {
    c.chatMetadata[MOD] = names;
    save(c);
    render();
}

function save(c) {
    try { (c.saveMetadataDebounced || c.saveMetadata).call(c); }
    catch (e) { console.error(`[${MOD}] metadata save failed`, e); }
}

function toast(kind, msg, title) {
    if (typeof toastr !== 'undefined') toastr[kind](msg, title);
}

/* ── inference ─────────────────────────────────────────────────────────── */

// Last few moves, for the panel. Not persisted — it is a glance, not a record.
let recent = [];

function ingest(text) {
    if (!settings().infer) return;
    const c = ctx();
    if (!c.groupId || !text) return;
    const cues = parseCues(text);
    if (!cues.length) return;

    const members = memberNames(c);
    const { present, moved } = applyCues(sheet(c), cues, members);
    if (!moved.length) return;

    setSheet(c, present);
    recent = moved.concat(recent).slice(0, 6);
    if (settings().announce) {
        toast('info', moved.map(m => `${m.name} ${m.in ? 'enters' : 'leaves'}`).join(' · '),
            'CALL SHEET');
    }
}

function ingestMessage(id) {
    const c = ctx();
    const m = c.chat?.[id] ?? c.chat?.at(-1);
    if (m && !m.is_user && !m.is_system) ingest(m.mes);
}

/* ── the interceptor ───────────────────────────────────────────────────── */

globalThis.callSheetInterceptor = async function (chat, _contextSize, abort, type) {
    try {
        const c = ctx();
        if (!c.groupId) return;          // solo chat: none of our business
        if (type !== 'normal') return;   // never reroute swipes, regens, continues, quiet gens
        if (!settings().reroute) return;

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

/* ── panel ─────────────────────────────────────────────────────────────── */

const PANEL = `
<div class="call-sheet-drawer">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>CALL SHEET</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="call-sheet-body"></div>
      <label class="checkbox_label"><input type="checkbox" id="cs-reroute">
        <span>Reroute drafts of absent members</span></label>
      <label class="checkbox_label"><input type="checkbox" id="cs-infer">
        <span>Read [ENTER|…] / [EXIT|…] from replies</span></label>
      <label class="checkbox_label"><input type="checkbox" id="cs-announce">
        <span>Announce moves</span></label>
      <div class="call-sheet-hint">Click a name to move them on or off set.</div>
    </div>
  </div>
</div>`;

function render() {
    const $body = $('.call-sheet-body');
    if (!$body.length) return;
    const c = ctx();

    const s = settings();
    $('#cs-reroute').prop('checked', s.reroute);
    $('#cs-infer').prop('checked', s.infer);
    $('#cs-announce').prop('checked', s.announce);

    if (!c.groupId) {
        $body.html('<div class="call-sheet-hint">Open a group chat.</div>');
        return;
    }

    const g = group(c);
    const muted = new Set(g?.disabled_members || []);
    const present = new Set(sheet(c));

    const rows = memberNames(c).map(name => {
        const av = avatarOf(c, name);
        const on = present.has(name);
        const isMuted = av && muted.has(av);
        return `<div class="call-sheet-row ${on ? 'on' : 'off'}" data-name="${escapeHtml(name)}"
                     title="${on ? 'In the scene — click to send them out' : 'Out of the scene — click to bring them in'}">
                  <i class="fa-solid ${on ? 'fa-circle-dot' : 'fa-circle'}"></i>
                  <span class="call-sheet-name">${escapeHtml(name)}</span>
                  ${isMuted ? '<span class="call-sheet-tag">muted</span>' : ''}
                </div>`;
    }).join('');

    const log = recent.length
        ? `<div class="call-sheet-log">${recent.map(m =>
            `${escapeHtml(m.name)} ${m.in ? 'in' : 'out'}`).join(' · ')}</div>`
        : '';

    $body.html(`
      <div class="call-sheet-count">${present.size} of ${memberNames(c).length} on set</div>
      <div class="call-sheet-list">${rows}</div>
      <div class="call-sheet-actions">
        <div class="menu_button" data-cs-all="in">All in</div>
        <div class="menu_button" data-cs-all="out">All out</div>
      </div>${log}`);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function mountPanel() {
    if ($('.call-sheet-drawer').length) return;
    const host = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(host).length) return;
    $(host).append(PANEL);

    $(document).on('click', '.call-sheet-row', function () {
        const c = ctx();
        if (!c.groupId) return;
        const name = $(this).data('name');
        const present = new Set(sheet(c));
        present.has(name) ? present.delete(name) : present.add(name);
        setSheet(c, memberNames(c).filter(n => present.has(n)));
    });

    $(document).on('click', '[data-cs-all]', function () {
        const c = ctx();
        if (!c.groupId) return;
        setSheet(c, $(this).data('cs-all') === 'in' ? memberNames(c) : []);
    });

    $(document).on('change', '#cs-reroute, #cs-infer, #cs-announce', function () {
        const key = this.id.replace('cs-', '');
        settings()[key] = this.checked;
        saveSettings();
    });

    render();
}

/* ── slash commands ────────────────────────────────────────────────────── */

let commandsRegistered = false;

function setPresence(raw, isPresent) {
    const c = ctx();
    if (!c.groupId) { toast('warning', 'Not a group chat.', 'CALL SHEET'); return ''; }

    if (!raw?.trim()) {
        if (isPresent) { setSheet(c, memberNames(c)); toast('info', 'Everyone is on set.', 'CALL SHEET'); }
        else toast('warning', '/absent needs a name.', 'CALL SHEET');
        return '';
    }

    const name = resolveName(raw, memberNames(c));
    if (!name) { toast('warning', `No group member matches "${raw}".`, 'CALL SHEET'); return ''; }

    const present = new Set(sheet(c));
    isPresent ? present.add(name) : present.delete(name);
    setSheet(c, memberNames(c).filter(n => present.has(n)));
    toast('info', `${name} is ${isPresent ? 'in the scene' : 'out of the scene'}.`, 'CALL SHEET');
    return '';
}

function ensureCommands() {
    if (commandsRegistered) return;
    const reg = ctx().registerSlashCommand;
    if (typeof reg !== 'function') return;       // router still works without them
    reg('present', (_a, name) => setPresence(name, true), [],
        '<span class="monospace">(name)</span> – CALL SHEET: mark a member as in the scene; no name = everyone', true, true);
    reg('absent', (_a, name) => setPresence(name, false), [],
        '<span class="monospace">(name)</span> – CALL SHEET: mark a member as out of the scene', true, true);
    reg('callsheet', () => {
        toast('info', sheet(ctx()).join(', ') || '(nobody)', 'On set');
        return '';
    }, [], '– CALL SHEET: show who is in the scene', true, true);
    commandsRegistered = true;
}

/* ── wiring ────────────────────────────────────────────────────────────── */

function boot() {
    const c = ctx();
    ensureCommands();
    mountPanel();

    const es = c.eventSource, T = c.eventTypes || c.event_types || {};
    if (!es) return;
    const on = (evt, fn) => evt && es.on(evt, fn);
    on(T.MESSAGE_RECEIVED, ingestMessage);
    on(T.MESSAGE_SWIPED, ingestMessage);
    on(T.MESSAGE_EDITED, ingestMessage);
    on(T.CHAT_CHANGED, () => { recent = []; render(); });
    on(T.GROUP_UPDATED, render);
    on(T.GROUP_MEMBER_DRAFTED, render);
}

if (typeof window !== 'undefined') {
    jQuery(() => {
        try { boot(); } catch (e) { console.error(`[${MOD}] boot failed`, e); }
        // The drawer can mount after us; retry once, cheaply.
        setTimeout(() => { try { mountPanel(); } catch { /* nothing to do */ } }, 2000);
    });
}

/* ── node self-check: `node index.js` ──────────────────────────────────── */

if (typeof window === 'undefined') {
    const assert = require('assert');
    const CAST = ['Rin Hoshino', 'Mika', 'Aoi Tanaka'];

    assert(mentioned('Mika', 'ask Mika about it'));
    assert(!mentioned('Mika', 'asked Mikael'));
    assert(mentioned('Misaka Mikoto', 'fine, Misaka.'));
    assert(!mentioned('Misaka Mikoto', 'the misakan delegation'));

    assert.equal(choosePresent([], 'x', 'y'), null);
    assert.equal(choosePresent(['A'], '', 'A'), 'A');
    assert.equal(choosePresent(['A', 'B'], 'over to B then', 'A', () => 0), 'B');
    assert.equal(choosePresent(['A', 'B'], 'nothing here', 'B', () => 0), 'A');
    assert.equal(choosePresent(['A', 'B', 'C'], 'C knows', 'A', () => 0.99), 'C');

    // cue parsing, including the decorations models actually emit
    assert.deepEqual(parseCues('prose\n[ENTER|Rin]'), [{ verb: 'ENTER', name: 'Rin' }]);
    assert.deepEqual(parseCues('* [EXIT|Mika]*'), [{ verb: 'EXIT', name: 'Mika' }]);
    assert.deepEqual(parseCues('[enter | Aoi Tanaka |'), [{ verb: 'ENTER', name: 'Aoi Tanaka' }]);
    assert.equal(parseCues('she entered the room').length, 0);   // prose is never a cue
    assert.equal(parseCues('[SCENE|dusk|bar]').length, 0);       // other bracket lines ignored

    // resolution against the real cast
    assert.equal(resolveName('Rin', CAST), 'Rin Hoshino');
    assert.equal(resolveName('rin hoshino', CAST), 'Rin Hoshino');
    assert.equal(resolveName('Tanaka', CAST), 'Aoi Tanaka');     // surname via whole-word
    assert.equal(resolveName('Kenji', CAST), null);              // strangers never invented

    // folding
    let r = applyCues(['Mika'], parseCues('[ENTER|Rin]'), CAST);
    assert.deepEqual(r.present, ['Rin Hoshino', 'Mika']);        // kept in cast order
    assert.deepEqual(r.moved, [{ name: 'Rin Hoshino', in: true }]);
    r = applyCues(['Rin Hoshino'], parseCues('[ENTER|Rin]'), CAST);
    assert.equal(r.moved.length, 0);                             // already in: no-op
    r = applyCues(['Mika'], parseCues('[ENTER|Rin]\n[EXIT|Rin]'), CAST);
    assert.deepEqual(r.present, ['Mika']);                       // last cue wins
    r = applyCues(['Mika'], parseCues('[EXIT|Kenji]'), CAST);
    assert.equal(r.moved.length, 0);                             // unresolvable dropped

    console.log('call-sheet: self-checks pass');
}
