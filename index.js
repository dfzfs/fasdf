/* Chat Review - SillyTavern extension
 * Rate AI messages (thumbs, stars, reason). Only rated messages are marked
 * in the prompt, so unrated messages cost no extra tokens.
 * UI text is Korean. Everything the model reads is English. */

const MODULE_NAME = 'chat_review';
const EXTRA_KEY = 'chat_review';
const MARKER_HEAD = "[User's review of this reply";

const defaultSettings = Object.freeze({
    enabled: true,
    maxMarkers: 10,      // max rated messages of this chat to mark in the prompt
    maxNotes: 5,         // max character/global feedback notes in the prompt
    maxReasonChars: 200, // reason length sent to the model
    excerptChars: 80,    // excerpt length of a rated reply inside notes
    include: 'both',     // 'both' | 'up' | 'down'
    globalNotes: [],
});

let draft = null;        // review being edited in the popup
let activePopup = null;

/* ------------------------------------------------------------------ helpers */

const ctx = () => SillyTavern.getContext();

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extensionSettings[MODULE_NAME];
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clamp(text, max) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

function makeExcerpt(mes, max) {
    return clamp(String(mes ?? '').replace(/<[^>]*>/g, ' '), max);
}

function makeId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function passesFilter(item, settings) {
    if (settings.include === 'up') return item.vote === 'up';
    if (settings.include === 'down') return item.vote === 'down';
    return true;
}

function badgeText(r) {
    const icon = r.vote === 'up' ? '👍' : r.vote === 'down' ? '👎' : '';
    const stars = r.stars ? `★${r.stars}` : '';
    return `${icon} ${stars}`.trim() || '📝';
}

const SCOPE_LABEL = { chat: '이 채팅', character: '이 캐릭터', global: '전체 공통' };

/* ------------------------------------------------- model-facing text (English) */

function describeReview(r, settings) {
    const parts = [];
    if (r.vote === 'up') parts.push('liked');
    if (r.vote === 'down') parts.push('disliked');
    if (r.stars) parts.push(`${r.stars}/5`);
    const head = parts.join(', ');
    const reason = clamp(r.reason, settings.maxReasonChars).replace(/"/g, "'");
    return { head, reason };
}

function buildMarker(r, settings) {
    const { head, reason } = describeReview(r, settings);
    return `${MARKER_HEAD}${head ? `: ${head}` : ''}${reason ? ` — reason: "${reason}"` : ''}]`;
}

function buildNoteLine(n, settings) {
    const { head, reason } = describeReview(n, settings);
    const excerpt = clamp(n.excerpt, settings.excerptChars).replace(/"/g, "'");
    return `- Reply "${excerpt}": ${head || 'rated'}${reason ? ` — reason: "${reason}"` : ''}`;
}

/* ------------------------------------------------------------- note storage */

function currentCharacterIndex() {
    const { characterId, groupId } = ctx();
    if (groupId) return null;
    if (characterId === undefined || characterId === null || characterId === '') return null;
    return characterId;
}

function getCharacterNotes() {
    const idx = currentCharacterIndex();
    if (idx === null) return [];
    const { characters } = ctx();
    const notes = characters[idx]?.data?.extensions?.[MODULE_NAME]?.notes;
    return Array.isArray(notes) ? notes : [];
}

async function setCharacterNotes(notes) {
    const idx = currentCharacterIndex();
    if (idx === null) return;
    const { writeExtensionField, characters } = ctx();
    await writeExtensionField(Number(idx), MODULE_NAME, { notes });
    const ch = characters[idx];
    if (ch) {
        ch.data ??= {};
        ch.data.extensions ??= {};
        ch.data.extensions[MODULE_NAME] = { notes };
    }
}

async function addNote(scope, note) {
    if (scope === 'global') {
        getSettings().globalNotes.push(note);
        ctx().saveSettingsDebounced();
    } else if (scope === 'character') {
        await setCharacterNotes([...getCharacterNotes(), note]);
    }
}

async function removeNoteById(id) {
    if (!id) return;
    const settings = getSettings();
    const before = settings.globalNotes.length;
    settings.globalNotes = settings.globalNotes.filter((n) => n.id !== id);
    if (settings.globalNotes.length !== before) ctx().saveSettingsDebounced();

    const charNotes = getCharacterNotes();
    if (charNotes.some((n) => n.id === id)) {
        await setCharacterNotes(charNotes.filter((n) => n.id !== id));
    }
}

/* ------------------------------------------------------------ review CRUD */

async function saveReview(mesId, data) {
    const { chat, saveChat, getCurrentChatId } = ctx();
    const msg = chat[mesId];
    if (!msg) throw new Error('message not found');
    msg.extra ??= {};

    const old = msg.extra[EXTRA_KEY];
    if (old?.noteId) await removeNoteById(old.noteId);

    const review = {
        vote: data.vote ?? null,
        stars: data.stars || 0,
        reason: String(data.reason ?? '').slice(0, 500),
        scope: data.scope,
        ts: Date.now(),
        noteId: null,
    };

    if (review.scope === 'character' || review.scope === 'global') {
        const note = {
            id: makeId(),
            vote: review.vote,
            stars: review.stars,
            reason: review.reason,
            excerpt: makeExcerpt(msg.mes, 200),
            chatId: getCurrentChatId(),
            charName: ctx().name2,
            ts: review.ts,
        };
        await addNote(review.scope, note);
        review.noteId = note.id;
    }

    msg.extra[EXTRA_KEY] = review;
    await saveChat();
    scheduleDecorate();
}

async function deleteReview(mesId) {
    const { chat, saveChat } = ctx();
    const msg = chat[mesId];
    const old = msg?.extra?.[EXTRA_KEY];
    if (!old) return;
    if (old.noteId) await removeNoteById(old.noteId);
    delete msg.extra[EXTRA_KEY];
    await saveChat();
    scheduleDecorate();
}

/* ------------------------------------------------------- prompt interceptor */

globalThis.chatReviewInterceptor = async function (chat, contextSize, abort, type) {
    try {
        if (type === 'quiet') return;
        const settings = getSettings();
        if (!settings.enabled) return;

        // 1) Mark rated messages of this chat (newest first, capped)
        let marked = 0;
        for (let i = chat.length - 1; i >= 0 && marked < settings.maxMarkers; i--) {
            const m = chat[i];
            const r = m?.extra?.[EXTRA_KEY];
            if (!r || m.is_user || !passesFilter(r, settings)) continue;
            if (String(m.mes).includes(MARKER_HEAD)) continue;
            // Replace with a copy so the real message is never modified
            chat[i] = { ...m, mes: `${m.mes}\n${buildMarker(r, settings)}` };
            marked++;
        }

        // 2) Character / global feedback notes from other chats
        if (settings.maxNotes > 0) {
            const currentChatId = ctx().getCurrentChatId();
            const notes = [...settings.globalNotes, ...getCharacterNotes()]
                .filter((n) => n.chatId !== currentChatId && passesFilter(n, settings))
                .sort((a, b) => b.ts - a.ts)
                .slice(0, settings.maxNotes);

            if (notes.length) {
                const lines = notes.map((n) => buildNoteLine(n, settings));
                const block = [
                    'Past feedback the user gave on earlier replies. Use it to match their preferences. Do not mention this block.',
                    ...lines,
                ].join('\n');
                const noteMsg = {
                    is_user: false,
                    is_system: false,
                    name: 'System',
                    send_date: Date.now(),
                    mes: block,
                };
                chat.splice(Math.max(chat.length - 1, 0), 0, noteMsg);
            }
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] interceptor error`, err);
    }
};

/* ---------------------------------------------------------- message buttons */

let decorateScheduled = false;
function scheduleDecorate() {
    if (decorateScheduled) return;
    decorateScheduled = true;
    setTimeout(() => {
        decorateScheduled = false;
        try { decorateMessages(); } catch (err) { console.error(`[${MODULE_NAME}]`, err); }
    }, 200);
}

function decorateMessages() {
    const { chat } = ctx();
    document.querySelectorAll('#chat .mes').forEach((el) => {
        if (el.getAttribute('is_user') === 'true' || el.getAttribute('is_system') === 'true') return;
        const buttons = el.querySelector('.extraMesButtons');
        if (!buttons) return;

        let btn = buttons.querySelector('.cr-btn');
        if (!btn) {
            btn = document.createElement('div');
            btn.classList.add('mes_button', 'cr-btn', 'fa-solid', 'fa-star');
            btn.title = '이 답변 평가하기';
            buttons.appendChild(btn);
        }

        const mesId = Number(el.getAttribute('mesid'));
        const review = chat[mesId]?.extra?.[EXTRA_KEY];
        btn.classList.toggle('cr-active', !!review);

        const nameEl = el.querySelector('.ch_name');
        if (!nameEl) return;
        let badge = nameEl.querySelector('.cr-badge');
        if (!review) {
            badge?.remove();
            return;
        }
        const text = badgeText(review);
        if (!badge) {
            badge = document.createElement('span');
            badge.classList.add('cr-badge');
            nameEl.appendChild(badge);
        }
        if (badge.textContent !== text) badge.textContent = text;
        const tip = review.reason ? `${SCOPE_LABEL[review.scope] ?? ''}: ${review.reason}` : (SCOPE_LABEL[review.scope] ?? '');
        if (badge.title !== tip) badge.title = tip;
    });
}

/* ------------------------------------------------------------- review popup */

function buildFormHtml(mesId) {
    const charOk = currentCharacterIndex() !== null;
    if (!charOk && draft.scope === 'character') draft.scope = 'chat';
    const sel = (v) => (draft.scope === v ? 'selected' : '');
    const stars = [1, 2, 3, 4, 5]
        .map((n) => `<span class="cr-star ${n <= draft.stars ? 'cr-on' : ''}" data-star="${n}">${n <= draft.stars ? '★' : '☆'}</span>`)
        .join('');
    return `
    <div class="cr-form">
        <h3>메시지 #${mesId} 평가</h3>
        <div class="cr-row">
            <button class="menu_button cr-vote ${draft.vote === 'up' ? 'cr-on' : ''}" data-vote="up">👍 좋아요</button>
            <button class="menu_button cr-vote ${draft.vote === 'down' ? 'cr-on' : ''}" data-vote="down">👎 싫어요</button>
        </div>
        <div class="cr-row">${stars}</div>
        <textarea class="text_pole cr-reason" maxlength="500" placeholder="이유를 적어 주세요 (선택)">${escapeHtml(draft.reason)}</textarea>
        <div class="cr-row">
            <label>저장 범위
                <select class="text_pole cr-scope">
                    <option value="chat" ${sel('chat')}>이 채팅만</option>
                    <option value="character" ${sel('character')} ${charOk ? '' : 'disabled'}>이 캐릭터 (다른 채팅에도 적용)</option>
                    <option value="global" ${sel('global')}>전체 공통</option>
                </select>
            </label>
        </div>
        <div class="cr-row">
            <button class="menu_button cr-save"><i class="fa-solid fa-check"></i> 저장</button>
            <button class="menu_button cr-delete"><i class="fa-solid fa-trash"></i> 평가 삭제</button>
        </div>
    </div>`;
}

function syncForm() {
    const root = document.querySelector('.cr-form');
    if (!root || !draft) return;
    root.querySelectorAll('.cr-vote').forEach((b) => b.classList.toggle('cr-on', b.dataset.vote === draft.vote));
    root.querySelectorAll('.cr-star').forEach((b) => {
        const on = Number(b.dataset.star) <= draft.stars;
        b.classList.toggle('cr-on', on);
        b.textContent = on ? '★' : '☆';
    });
}

function closePopup() {
    const { POPUP_RESULT } = ctx();
    activePopup?.complete(POPUP_RESULT.AFFIRMATIVE);
}

async function openReviewPopup(mesId) {
    const { chat, Popup, POPUP_TYPE } = ctx();
    const msg = chat[mesId];
    if (!msg) return;
    const old = msg.extra?.[EXTRA_KEY];
    draft = {
        mesId,
        vote: old?.vote ?? null,
        stars: old?.stars ?? 0,
        reason: old?.reason ?? '',
        scope: old?.scope ?? 'chat',
    };
    const popup = new Popup(buildFormHtml(mesId), POPUP_TYPE.TEXT, '', { okButton: '닫기' });
    activePopup = popup;
    await popup.show();
    activePopup = null;
    draft = null;
}

async function onSave() {
    if (!draft) return;
    const reason = draft.reason.trim();
    if (!draft.vote && !draft.stars && !reason) {
        toastr.warning('좋아요/싫어요, 별점, 이유 중 하나는 입력해 주세요.');
        return;
    }
    try {
        await saveReview(draft.mesId, { vote: draft.vote, stars: draft.stars, reason, scope: draft.scope });
        toastr.success('평가를 저장했어요.');
        closePopup();
    } catch (err) {
        console.error(`[${MODULE_NAME}]`, err);
        toastr.error('평가 저장에 실패했어요. 콘솔(F12)을 확인해 주세요.');
    }
}

async function onDelete() {
    if (!draft) return;
    try {
        await deleteReview(draft.mesId);
        toastr.info('평가를 삭제했어요.');
        closePopup();
    } catch (err) {
        console.error(`[${MODULE_NAME}]`, err);
        toastr.error('평가 삭제에 실패했어요.');
    }
}

/* ---------------------------------------------------------- history popup */

function renderHistoryInner() {
    const { chat } = ctx();
    const settings = getSettings();

    const chatRows = [];
    chat.forEach((m, i) => {
        const r = m?.extra?.[EXTRA_KEY];
        if (!r) return;
        chatRows.push(`
        <div class="cr-hrow">
            <div>
                <b>#${i}</b> ${escapeHtml(badgeText(r))} <span class="cr-hsub">[${SCOPE_LABEL[r.scope] ?? ''}]</span>
                <div class="cr-hsub">${escapeHtml(makeExcerpt(m.mes, 80))}</div>
                ${r.reason ? `<div class="cr-hsub">이유: ${escapeHtml(r.reason)}</div>` : ''}
            </div>
            <button class="menu_button cr-del-review" data-mes="${i}" title="삭제"><i class="fa-solid fa-trash"></i></button>
        </div>`);
    });

    const noteRow = (n) => `
        <div class="cr-hrow">
            <div>
                ${escapeHtml(badgeText(n))} <span class="cr-hsub">${escapeHtml(n.charName ?? '')}</span>
                <div class="cr-hsub">${escapeHtml(clamp(n.excerpt, 80))}</div>
                ${n.reason ? `<div class="cr-hsub">이유: ${escapeHtml(n.reason)}</div>` : ''}
            </div>
            <button class="menu_button cr-del-note" data-id="${escapeHtml(n.id)}" title="삭제"><i class="fa-solid fa-trash"></i></button>
        </div>`;

    const section = (title, rows) => `<h4>${title}</h4>${rows.length ? rows.join('') : '<div class="cr-empty">기록이 없어요.</div>'}`;

    return [
        section('이 채팅의 평가', chatRows),
        section('이 캐릭터 노트', getCharacterNotes().map(noteRow)),
        section('전체 공통 노트', settings.globalNotes.map(noteRow)),
    ].join('');
}

async function openHistoryPopup() {
    const { Popup, POPUP_TYPE } = ctx();
    const popup = new Popup(`<div class="cr-history">${renderHistoryInner()}</div>`, POPUP_TYPE.TEXT, '', { okButton: '닫기', wide: true });
    await popup.show();
}

function refreshHistory() {
    const box = document.querySelector('.cr-history');
    if (box) box.innerHTML = renderHistoryInner();
}

/* ------------------------------------------------------------ settings panel */

function createSettingsUI() {
    const html = `
    <div id="${MODULE_NAME}_settings" class="extension_settings cr-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chat Review (챗 리뷰)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="${MODULE_NAME}_enabled" type="checkbox" />
                    <span>사용</span>
                </label>
                <div class="cr-setting-row"><span>이 채팅에서 표시할 최대 평가 수</span><input id="${MODULE_NAME}_maxMarkers" type="number" class="text_pole" min="0" max="50" /></div>
                <div class="cr-setting-row"><span>캐릭터/전체 노트 최대 개수</span><input id="${MODULE_NAME}_maxNotes" type="number" class="text_pole" min="0" max="30" /></div>
                <div class="cr-setting-row"><span>이유 최대 글자수</span><input id="${MODULE_NAME}_maxReasonChars" type="number" class="text_pole" min="0" max="500" /></div>
                <div class="cr-setting-row"><span>노트 발췌 글자수</span><input id="${MODULE_NAME}_excerptChars" type="number" class="text_pole" min="0" max="200" /></div>
                <div class="cr-setting-row">
                    <span>포함할 평가</span>
                    <select id="${MODULE_NAME}_include" class="text_pole">
                        <option value="both">좋아요 + 싫어요</option>
                        <option value="up">좋아요만</option>
                        <option value="down">싫어요만</option>
                    </select>
                </div>
                <div class="cr-setting-row">
                    <button id="${MODULE_NAME}_history" class="menu_button"><i class="fa-solid fa-list"></i> 평가 기록 보기 / 삭제</button>
                </div>
            </div>
        </div>
    </div>`;
    document.getElementById('extensions_settings2').insertAdjacentHTML('beforeend', html);

    const settings = getSettings();
    const { saveSettingsDebounced } = ctx();

    const enabled = document.getElementById(`${MODULE_NAME}_enabled`);
    enabled.checked = settings.enabled;
    enabled.addEventListener('change', () => {
        settings.enabled = enabled.checked;
        saveSettingsDebounced();
    });

    for (const [key, min, max] of [['maxMarkers', 0, 50], ['maxNotes', 0, 30], ['maxReasonChars', 0, 500], ['excerptChars', 0, 200]]) {
        const input = document.getElementById(`${MODULE_NAME}_${key}`);
        input.value = settings[key];
        input.addEventListener('change', () => {
            const v = Math.min(max, Math.max(min, parseInt(input.value, 10) || 0));
            input.value = v;
            settings[key] = v;
            saveSettingsDebounced();
        });
    }

    const include = document.getElementById(`${MODULE_NAME}_include`);
    include.value = settings.include;
    include.addEventListener('change', () => {
        settings.include = include.value;
        saveSettingsDebounced();
    });

    document.getElementById(`${MODULE_NAME}_history`).addEventListener('click', openHistoryPopup);
}

/* ------------------------------------------------------------------- events */

function onDocClick(e) {
    const t = e.target?.closest?.('.cr-btn, .cr-vote, .cr-star, .cr-save, .cr-delete, .cr-del-review, .cr-del-note');
    if (!t) return;

    if (t.classList.contains('cr-btn')) {
        const mesId = Number(t.closest('.mes')?.getAttribute('mesid'));
        if (!Number.isNaN(mesId)) openReviewPopup(mesId);
    } else if (t.classList.contains('cr-vote') && draft) {
        draft.vote = draft.vote === t.dataset.vote ? null : t.dataset.vote;
        syncForm();
    } else if (t.classList.contains('cr-star') && draft) {
        const n = Number(t.dataset.star);
        draft.stars = draft.stars === n ? 0 : n;
        syncForm();
    } else if (t.classList.contains('cr-save')) {
        onSave();
    } else if (t.classList.contains('cr-delete')) {
        onDelete();
    } else if (t.classList.contains('cr-del-review')) {
        deleteReview(Number(t.dataset.mes)).then(refreshHistory);
    } else if (t.classList.contains('cr-del-note')) {
        removeNoteById(t.dataset.id).then(refreshHistory);
    }
}

function init() {
    const { eventSource, event_types } = ctx();
    createSettingsUI();

    document.addEventListener('click', onDocClick);
    document.addEventListener('input', (e) => {
        if (draft && e.target?.classList?.contains('cr-reason')) draft.reason = e.target.value;
    });
    document.addEventListener('change', (e) => {
        if (draft && e.target?.classList?.contains('cr-scope')) draft.scope = e.target.value;
    });

    const chatEl = document.getElementById('chat');
    if (chatEl) new MutationObserver(scheduleDecorate).observe(chatEl, { childList: true, subtree: true });

    for (const name of ['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MORE_MESSAGES_LOADED']) {
        if (event_types[name]) eventSource.on(event_types[name], scheduleDecorate);
    }
    scheduleDecorate();
    console.log(`[${MODULE_NAME}] Loaded`);
}

(function boot() {
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.APP_READY, init);
})();
