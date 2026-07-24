let currentUser = null, currentDashboardId = null;
let storiesList = [], story = null, bIdx = 0;
let pState = { bId: null, vars: {}, config: {}, usage: {}, slot: 1 };
let authMode = 'signin';
let recoveryUserRecord = null;

/* Number of save slots per story per user. Change this one value to allow more/fewer saves. */
window.MAX_SAVE_SLOTS = 3;

/* Build a normalized play-state object shared by New Game, Continue, and Test Block. */
window.createPlayState = function(opts) {
    opts = opts || {};
    return {
        bId: opts.bId || null,
        vars: opts.vars || JSON.parse(JSON.stringify(story.globalVars)),
        config: opts.config || story.varConfig,
        usage: opts.usage || {},
        slot: (opts.slot != null) ? opts.slot : 0,
        firedEvents: opts.firedEvents || {},
        cooldowns: opts.cooldowns || {},
        usesLeft: opts.usesLeft || {},
        equipped: opts.equipped || { weapon: null, armor: null },
        history: opts.history || []
    };
};

/* ---- In-play navigation: Back / Restart ---- */
window.pushHistory = function() {
    if (!pState.history) pState.history = [];
    pState.history.push(JSON.stringify({
        bId: pState.bId, vars: pState.vars, usage: pState.usage,
        equipped: pState.equipped, cooldowns: pState.cooldowns,
        usesLeft: pState.usesLeft, firedEvents: pState.firedEvents
    }));
    if (pState.history.length > 100) pState.history.shift();
};
window.playBack = function() {
    if (!pState.history || pState.history.length === 0) return;
    const snap = JSON.parse(pState.history.pop());
    pState.bId = snap.bId; pState.vars = snap.vars; pState.usage = snap.usage;
    pState.equipped = snap.equipped; pState.cooldowns = snap.cooldowns;
    pState.usesLeft = snap.usesLeft; pState.firedEvents = snap.firedEvents;
    window.renderStep();
};
window.playRestart = function() {
    if (!confirm('Restart from the beginning? Progress in this session will be lost (saved games are untouched).')) return;
    let entry = null;
    if (story.startBlock) entry = story.blocks.find(b => b.id === story.startBlock);
    if (!entry) entry = story.blocks.find(b => b.id.toLowerCase().includes('starting'));
    pState = window.createPlayState({ bId: entry ? entry.id : story.blocks[0].id, slot: pState.slot });
    window.renderStep();
};

/* =========================================================
   UTILITY HELPERS (added)
========================================================= */
// Escape a string so it can be used literally inside a RegExp.
window.escapeRegExp = function(str) {
    return String(str).replace(/[^A-Za-z0-9_ ]/g, function(ch) { return '\\' + ch; });
};
// Escape a string for safe insertion into HTML.
window.escapeHtml = function(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function(s) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s];
    });
};
// Restrict variable / stat names to safe characters.
window.sanitizeVarName = function(name) {
    return String(name == null ? '' : name).replace(/[^A-Za-z0-9_ ]/g, '').trim();
};
// Hash a password (SHA-256 when available, weak fallback otherwise). Never stores plaintext.
async function hashPassword(pw) {
    const str = String(pw);
    if (window.crypto && crypto.subtle) {
        try {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
            return 'sha256$' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) { /* fall through to weak hash */ }
    }
    let h = 5381;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) + str.charCodeAt(i); h |= 0; }
    return 'weak$' + (h >>> 0).toString(16);
}

/* ---- Unsaved-changes tracking ---- */
window._editorDirty = false;
window.markDirty = function() { window._editorDirty = true; };
window.clearDirty = function() { window._editorDirty = false; };
window.leaveEditor = function() {
    if (window._editorDirty && !confirm('You have unsaved changes. Leave the editor and discard them?')) return;
    window.clearDirty();
    window.showScreen('dash-screen');
    if (window.refreshLibrary) refreshLibrary();
};
window.addEventListener('beforeunload', function(e) {
    const ed = document.getElementById('edit-screen');
    if (ed && ed.classList.contains('active') && window._editorDirty) {
        e.preventDefault();
        e.returnValue = '';
    }
});
['input', 'change'].forEach(function(evt) {
    document.addEventListener(evt, function(e) {
        const ed = document.getElementById('edit-screen');
        if (ed && ed.classList.contains('active')) window._editorDirty = true;
    });
});

/* ---- Tips / help mode ----
   Hints are always rendered as <div class="cyoa-hint"> and shown/hidden purely
   via the `tips-on` class on #edit-screen, so toggling needs no re-render.
   Defaults ON for first-time users; the choice is remembered in localStorage. */
window.tip = function(text) { return '<div class="cyoa-hint">' + text + '</div>'; };
window.applyTipsState = function() {
    const ed = document.getElementById('edit-screen');
    if (!ed) return;
    const on = localStorage.getItem('cyoa_tips') !== 'off'; // default ON
    ed.classList.toggle('tips-on', on);
    const btn = document.getElementById('btn-tips');
    if (btn) {
        btn.innerText = on ? '💡 Tips: On' : '💡 Tips: Off';
        btn.style.opacity = on ? '1' : '0.65';
    }
};
window.toggleTips = function() {
    const on = localStorage.getItem('cyoa_tips') !== 'off';
    localStorage.setItem('cyoa_tips', on ? 'off' : 'on');
    window.applyTipsState();
};

/* =========================================================
   UNDO/REDO STACK
========================================================= */
window.undoStack = [];
window.redoStack = [];
window.isRestoring = false;

window.saveSnapshot = function() {
    if (window.isRestoring || !story) return;
    const currentState = JSON.stringify({ story, bIdx });
    if (window.undoStack.length > 0 && window.undoStack[window.undoStack.length - 1] === currentState) return;

    window.undoStack.push(currentState);
    if (window.undoStack.length > 10) window.undoStack.shift();
    window.redoStack = [];
    if (window.renderUndoRedoButtons) window.renderUndoRedoButtons();
};

window.undo = function() {
    if (window.undoStack.length === 0) return;
    window.isRestoring = true;
    window.redoStack.push(JSON.stringify({ story, bIdx }));
    const prevState = JSON.parse(window.undoStack.pop());
    story = prevState.story;
    bIdx = prevState.bIdx;
    window.renderEditor();
    if (window.renderUndoRedoButtons) window.renderUndoRedoButtons();
    window.isRestoring = false;
};

window.redo = function() {
    if (window.redoStack.length === 0) return;
    window.isRestoring = true;
    window.undoStack.push(JSON.stringify({ story, bIdx }));
    const nextState = JSON.parse(window.redoStack.pop());
    story = nextState.story;
    bIdx = nextState.bIdx;
    window.renderEditor();
    if (window.renderUndoRedoButtons) window.renderUndoRedoButtons();
    window.isRestoring = false;
};

window.renderUndoRedoButtons = function() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) {
        undoBtn.disabled = window.undoStack.length === 0;
        undoBtn.style.opacity = window.undoStack.length === 0 ? '0.4' : '1';
        undoBtn.style.cursor = window.undoStack.length === 0 ? 'not-allowed' : 'pointer';
    }
    if (redoBtn) {
        redoBtn.disabled = window.redoStack.length === 0;
        redoBtn.style.opacity = window.redoStack.length === 0 ? '0.4' : '1';
        redoBtn.style.cursor = window.redoStack.length === 0 ? 'not-allowed' : 'pointer';
    }
};

document.addEventListener('mousedown', (e) => {
    const ed = document.getElementById('edit-screen');
    if (!ed || !ed.classList.contains('active')) return;
    if (e.target.closest('#btn-undo') || e.target.closest('#btn-redo')) return;

    if (e.target.closest('button') || e.target.closest('.block-menu-item') || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        window.saveSnapshot();
    }
});

document.addEventListener('focusin', (e) => {
    const ed = document.getElementById('edit-screen');
    if (!ed || !ed.classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        window.saveSnapshot();
    }
});

document.addEventListener('keydown', function(e) {
    const ed = document.getElementById('edit-screen');
    if (!ed || !ed.classList.contains('active')) return;
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') {
            e.preventDefault();
            window.undo();
        } else if (e.key === 'y') {
            e.preventDefault();
            window.redo();
        }
    }
});



/* UI CLEANUP INJECTION */
const styleCleanup = document.createElement('style');
styleCleanup.innerHTML = `
    button, .btn-s, .btn-d {
        white-space: nowrap !important;
        
        
        box-sizing: border-box;
        transition: background 0.2s, transform 0.1s;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 8px 14px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
    }
    button:active {
        transform: scale(0.98);
    }
    input[type="text"], input[type="number"], input[type="password"], select, textarea {
        box-sizing: border-box;
        max-width: 100%;
        padding: 8px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        font-size: 0.8rem;
        background: #fff;
    }
    input[type="text"]:focus, input[type="number"]:focus, input[type="password"]:focus, select:focus, textarea:focus {
        outline: none;
        border-color: #6366f1;
        box-shadow: 0 0 0 2px rgba(99,102,241,0.2);
    }
    .choice-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 15px;
        background: #f1f5f9;
        padding: 20px;
        border-radius: 8px;
        border: 1px solid #e2e8f0;
    }
    .effect-row, .condition-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        background: #ffffff;
        padding: 10px;
        border-radius: 6px;
        border: 1px solid #cbd5e1;
        margin-top: 6px;
    }
    .effect-row > select, .condition-row > select, 
    .effect-row > input, .condition-row > input {
        flex: 1 1 auto;
        min-width: 80px;
    }
    .effect-row > button, .condition-row > button {
        flex: 0 0 auto;
        padding: 6px 12px;
    }
    .card-title {
        font-size: 0.9rem;
        color: #1e293b;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
    }
    .sub-panel {
        background: #ffffff;
        padding: 15px;
        border-radius: 8px;
        border: 1px solid #e2e8f0;
        grid-column: 1 / -1;
    }
    label {
        font-weight: 600;
        color: #475569;
        font-size: 0.8rem;
        display: block;
        margin-bottom: 4px;
    }
    .checkbox-line {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: normal;
        cursor: pointer;
    }
    .btn-d {
        background: #fee2e2;
        color: #ef4444;
        border: 1px solid #fca5a5;
    }
    .btn-d:hover { background: #fca5a5; color: #b91c1c; }

    .btn-s {
        background: #e0e7ff;
        color: #4338ca;
        border: 1px solid #c7d2fe;
    }
    .btn-s:hover { background: #c7d2fe; color: #312e81; }

    .btn-primary {
        background: #4f46e5;
        color: white;
        border: none;
    }
    .btn-primary:hover { background: #4338ca; }
`;
document.head.appendChild(styleCleanup);


/* =========================================================
   1. RELATIONAL DB SCHEMA & SETUP
========================================================= */
const DB_NAME = 'StoryEngineRelationalDB';
const DB_VERSION = 3;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('Users')) {
                const s = db.createObjectStore('Users', { keyPath: 'User_ID', autoIncrement: true });
                s.createIndex('UserName', 'UserName', { unique: true });
            }
            if (!db.objectStoreNames.contains('Dashboards')) {
                const s = db.createObjectStore('Dashboards', { keyPath: 'Dashboard_ID', autoIncrement: true });
                s.createIndex('User_ID', 'User_ID', { unique: false });
            }
            if (!db.objectStoreNames.contains('Stories')) {
                const s = db.createObjectStore('Stories', { keyPath: 'Story_ID', autoIncrement: true });
                s.createIndex('Dashboard_ID', 'Dashboard_ID', { unique: false });
            }
            if (!db.objectStoreNames.contains('StoryBlocks')) {
                const s = db.createObjectStore('StoryBlocks', { keyPath: 'StoryBlock_ID', autoIncrement: true });
                s.createIndex('Story_ID', 'Story_ID', { unique: false });
            }
            if (!db.objectStoreNames.contains('ExtraTexts')) {
                const s = db.createObjectStore('ExtraTexts', { keyPath: 'ExtraText_ID', autoIncrement: true });
                s.createIndex('StoryBlock_ID', 'StoryBlock_ID', { unique: false });
            }
            if (!db.objectStoreNames.contains('Choices')) {
                const s = db.createObjectStore('Choices', { keyPath: 'Choice_ID', autoIncrement: true });
                s.createIndex('StoryBlock_ID', 'StoryBlock_ID', { unique: false });
            }
            if (!db.objectStoreNames.contains('Variables')) {
                const s = db.createObjectStore('Variables', { keyPath: 'Variable_ID', autoIncrement: true });
                s.createIndex('Story_ID', 'Story_ID', { unique: false });
            }
            if (!db.objectStoreNames.contains('ChoiceEffects')) {
                const s = db.createObjectStore('ChoiceEffects', { keyPath: 'Effect_ID', autoIncrement: true });
                s.createIndex('Choice_ID', 'Choice_ID', { unique: false });
            }
            if (!db.objectStoreNames.contains('GameSaves')) {
                const s = db.createObjectStore('GameSaves', { keyPath: 'Save_ID', autoIncrement: true });
                s.createIndex('User_ID', 'User_ID', { unique: false });
                s.createIndex('Story_ID', 'Story_ID', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbReq(req) {
    return new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

/* =========================================================
   2. AUTHENTICATION, RECOVERY & DASHBOARD
========================================================= */
async function getOrCreateDashboard(userId) {
    const db = await openDB();
    const tx = db.transaction('Dashboards', 'readwrite');
    const store = tx.objectStore('Dashboards');
    let d = await idbReq(store.index('User_ID').get(userId));
    if (!d) {
        const id = await idbReq(store.add({ User_ID: userId }));
        d = await idbReq(store.get(id));
    }
    return d.Dashboard_ID;
}

window.toggleAuthMode = function() {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    document.getElementById('auth-mode-label').innerText = authMode === 'signin' ? 'Sign In' : 'Create Account';
    document.getElementById('signup-fields').style.display = authMode === 'signin' ? 'none' : 'block';
    document.getElementById('auth-toggle-btn').innerText = authMode === 'signin' ? 'Switch to Sign Up' : 'Switch to Sign In';
    document.getElementById('auth-toggle-text').innerText = authMode === 'signin' ? 'Need an account?' : 'Already have an account?';
    document.getElementById('forgot-pw-btn').style.display = authMode === 'signin' ? 'block' : 'none';
    hideAuthMessages();
};

window.handleAuthSubmit = async function() {
    const user = document.getElementById('auth-user').value.trim();
    const pass = document.getElementById('auth-password').value;
    const sq = document.getElementById('auth-sq').value.trim();
    const sa = document.getElementById('auth-sa').value.trim();
    hideAuthMessages();
    if (!user || !pass) return showAuthError('Username and password are required!');
    try {
        const hashed = await hashPassword(pass);
        const db = await openDB();
        const tx = db.transaction('Users', 'readwrite');
        const store = tx.objectStore('Users');
        let existing = await idbReq(store.index('UserName').get(user));
        if (authMode === 'signin') {
            if (!existing) return showAuthError('User not found. Switch to Sign Up!');
            if (existing.Password === hashed) {
                // Password matches the stored hash.
            } else if (existing.Password === pass) {
                // Legacy plaintext password: upgrade it transparently on this successful login.
                existing.Password = hashed;
                try {
                    const dbUp = await openDB();
                    await idbReq(dbUp.transaction('Users', 'readwrite').objectStore('Users').put(existing));
                } catch (e) { console.error('Password upgrade failed', e); }
            } else {
                return showAuthError('Incorrect password!');
            }
        } else {
            if (existing) return showAuthError('Username taken. Switch to Sign In!');
            if (!sq || !sa) return showAuthError('Security Question and Answer are required for signup!');
            const uid = await idbReq(store.add({ UserName: user, Password: hashed, SecurityQuestion: sq, SecurityAnswer: sa.toLowerCase() }));
            existing = await idbReq(store.get(uid));
        }
        currentUser = existing;
        currentDashboardId = await getOrCreateDashboard(currentUser.User_ID);
        localStorage.setItem('s_session', currentUser.User_ID);
        document.getElementById('dash-username').innerText = `User: ${currentUser.UserName}`;
        await refreshLibrary();
        showScreen('dash-screen');
    } catch (e) {
        console.error(e);
        showAuthError('Database error. Check console.');
    }
};

window.startPasswordRecovery = function() {
    hideAuthMessages();
    document.getElementById('standard-auth-fields').style.display = 'none';
    document.getElementById('recovery-fields').style.display = 'block';
    document.getElementById('auth-mode-label').innerText = 'Reset Password';
};

window.cancelRecovery = function() {
    hideAuthMessages();
    document.getElementById('standard-auth-fields').style.display = 'block';
    document.getElementById('recovery-fields').style.display = 'none';
    document.getElementById('sq-container').style.display = 'none';
    document.getElementById('auth-mode-label').innerText = 'Sign In';
    recoveryUserRecord = null;
};

window.fetchSecurityQuestion = async function() {
    const user = document.getElementById('recovery-user').value.trim();
    hideAuthMessages();
    if (!user) return showAuthError('Please enter a username.');
    try {
        const db = await openDB();
        const tx = db.transaction('Users', 'readonly');
        const store = tx.objectStore('Users');
        recoveryUserRecord = await idbReq(store.index('UserName').get(user));
        if (!recoveryUserRecord) return showAuthError('Username not found.');
        if (!recoveryUserRecord.SecurityQuestion) return showAuthError('This old account does not have a security question set.');
        document.getElementById('display-sq').innerText = `Q: ${recoveryUserRecord.SecurityQuestion}`;
        document.getElementById('sq-container').style.display = 'block';
        document.getElementById('fetch-sq-btn').style.display = 'none';
        document.getElementById('recovery-user').disabled = true;
    } catch (e) {
        console.error(e);
        showAuthError('Error accessing database.');
    }
};

window.resetPassword = async function() {
    const sa = document.getElementById('recovery-sa').value.trim().toLowerCase();
    const newPass = document.getElementById('new-password').value;
    hideAuthMessages();
    if (!sa || !newPass) return showAuthError('Please answer the question and provide a new password.');
    if (sa !== recoveryUserRecord.SecurityAnswer) return showAuthError('Incorrect Security Answer!');
    try {
        const hashedNew = await hashPassword(newPass);
        const db = await openDB();
        const tx = db.transaction('Users', 'readwrite');
        const store = tx.objectStore('Users');
        recoveryUserRecord.Password = hashedNew;
        await idbReq(store.put(recoveryUserRecord));
        showAuthSuccess('Password reset successfully! You can now log in.');
        setTimeout(() => {
            window.cancelRecovery();
            document.getElementById('auth-user').value = recoveryUserRecord.UserName;
            document.getElementById('auth-password').value = '';
        }, 2000);
    } catch (e) {
        console.error(e);
        showAuthError('Error saving new password.');
    }
};

function showAuthError(msg) {
    document.getElementById('auth-success').style.display = 'none';
    const err = document.getElementById('auth-error');
    err.innerText = msg;
    err.style.display = 'block';
}

function showAuthSuccess(msg) {
    document.getElementById('auth-error').style.display = 'none';
    const suc = document.getElementById('auth-success');
    suc.innerText = msg;
    suc.style.display = 'block';
}

function hideAuthMessages() {
    document.getElementById('auth-error').style.display = 'none';
    document.getElementById('auth-success').style.display = 'none';
}

window.handleLogout = function() {
    localStorage.removeItem('s_session');
    location.reload();
};

window.onload = async () => {
    const fileIn = document.getElementById('file-in');
    if (fileIn) fileIn.addEventListener('change', window.importStory);
    const uid = localStorage.getItem('s_session');
    if (!uid) return;
    try {
        const db = await openDB();
        const user = await idbReq(db.transaction('Users').objectStore('Users').get(parseInt(uid)));
        if (user) {
            currentUser = user;
            currentDashboardId = await getOrCreateDashboard(user.User_ID);
            document.getElementById('dash-username').innerText = `User: ${currentUser.UserName}`;
            await refreshLibrary();
            showScreen('dash-screen');
        }
    } catch (e) {
        console.error(e);
    }
};

/* =========================================================
   3. SHREDDER/ADAPTER (Memory Object <-> Relational DB)
========================================================= */
async function refreshLibrary() {
    const db = await openDB();
    const tx = db.transaction('Stories', 'readonly');
    storiesList = await idbReq(tx.objectStore('Stories').index('Dashboard_ID').getAll(currentDashboardId)) || [];
    document.getElementById('story-list').innerHTML = storiesList.map((s, i) => `
        <div class="card" style="display:flex; justify-content:space-between; align-items:center;">
            <div><strong>${window.escapeHtml(s.Story_Title)}</strong></div>
            <div style="display:flex; gap:8px;">
                <button class="btn-p" onclick="startPlay(${i})" title="Play this story (New Game or Continue)">▶ Play</button>
                <button class="btn-s" onclick="loadEditor(${i})" title="Open this story in the editor">✏ Edit</button>
                <button class="btn-s" style="background:#dcfce7; color:#166534;" onclick="duplicateStory(${i})" title="Make a copy of this story">📋 Duplicate</button>
                <button class="btn-d" style="width:auto; margin:0;" onclick="deleteStory(${i})" title="Permanently delete this story and its saves">🗑 Delete</button>
            </div>
        </div>
    `).join('') || "<p>No stories yet.</p>";
}

async function loadStoryFromDB(storyId) {
    const db = await openDB();

    // Fire ALL reads in separate transactions to avoid IndexedDB auto-commit
    // killing the transaction mid-await between nested async calls.
    function txGet(store, key) {
        return idbReq(db.transaction(store, 'readonly').objectStore(store).get(key));
    }
    function txGetAllByIndex(store, index, key) {
        return idbReq(db.transaction(store, 'readonly').objectStore(store).index(index).getAll(key));
    }

    const dbStory = await txGet('Stories', storyId);
    const [blocks, vars] = await Promise.all([
        txGetAllByIndex('StoryBlocks', 'Story_ID', storyId),
        txGetAllByIndex('Variables', 'Story_ID', storyId)
    ]);

    // Prefetch all extras, choices, and effects in parallel
    const extrasArr = await Promise.all(blocks.map(b => txGetAllByIndex('ExtraTexts', 'StoryBlock_ID', b.StoryBlock_ID)));
    const choicesArr = await Promise.all(blocks.map(b => txGetAllByIndex('Choices', 'StoryBlock_ID', b.StoryBlock_ID)));
    const allChoices = choicesArr.flat();
    const effectsArr = await Promise.all(allChoices.map(c => txGetAllByIndex('ChoiceEffects', 'Choice_ID', c.Choice_ID)));

    // Map effects back to choices by index
    const effectsByChoiceIdx = {};
    allChoices.forEach((c, idx) => { effectsByChoiceIdx[c.Choice_ID] = effectsArr[idx]; });

    let memStory = {
        id: dbStory.Story_ID,
        title: dbStory.Story_Title,
        startBlock: dbStory.Start_Block_Name || '',
        useDayCycle: !!dbStory.UseDayCycle,
        isRPG: !!dbStory.Is_RPG,
        rpgStats: JSON.parse(dbStory.RPG_Stats_JSON || '["HP","MaxHP","Atk","Def","Dex","Agi"]'),
        rpgItems: JSON.parse(dbStory.RPG_Items_JSON || '{}'),
        blockGroups: JSON.parse(dbStory.Block_Groups_JSON || '["Ungrouped"]'),
        dailyEvents: JSON.parse(dbStory.Daily_Events_JSON || '[]'),
        statEvents: JSON.parse(dbStory.Stat_Events_JSON || '[]'),
        globalVars: {},
        varConfig: {},
        blocks: []
    };

    for (let v of vars) {
        memStory.globalVars[v.Var_Name] = { type: v.Var_Type, val: v.Default_Value, stats: JSON.parse(v.Char_Stats_JSON || '{}') };
        if (v.Is_HUD) memStory.varConfig[v.Var_Name] = true;
    }

    for (let bIdx2 = 0; bIdx2 < blocks.length; bIdx2++) {
        const b = blocks[bIdx2];
        let memBlock = { id: b.Block_Name, text: b.Block_Text, group: b.Block_Group || 'Ungrouped', notes: b.Block_Notes || '', choices: [], extraTexts: [] };

        for (let e of extrasArr[bIdx2]) {
            let parsedReqs = [];
            if (e.Reqs_JSON) {
                parsedReqs = JSON.parse(e.Reqs_JSON);
            } else if (e.Req_Var) {
                parsedReqs.push({ var: e.Req_Var, op: '>=', val: e.Req_Min });
                if (e.Req_Max !== undefined && e.Req_Max < 999999) parsedReqs.push({ var: e.Req_Var, op: '<=', val: e.Req_Max });
            }
            memBlock.extraTexts.push({ var: e.Req_Var, reqMin: e.Req_Min, reqMax: e.Req_Max, reqs: parsedReqs, reqLogic: e.Req_Logic || 'AND', text: e.Text_Content });
        }

        for (let c of choicesArr[bIdx2]) {
            let memChoice = {
                id: c.Choice_Key || c.Choice_ID.toString(),
                txt: c.Choice_Text,
                next: c.Next_Block_Name,
                hideLocked: c.Hide_Locked,
                lockedMode: c.Locked_Mode || (c.Hide_Locked ? 'hide' : 'show'),
                maxUses: c.Max_Uses,
                showUsage: c.Show_Usage,
                persistFlag: c.Persist_Flag,
                promptChar: c.Prompt_Char,
                lockedMsg: c.Locked_Msg,
                timeAdd: c.Time_Add !== undefined ? c.Time_Add : (c.Passes_Time === false ? 0 : 1),
                forceNextDay: !!c.Force_Next_Day,
                passTime: c.Passes_Time !== false,
                effects: [],
                reqs: [],
                reqLogic: c.Req_Logic || 'AND',
                conditionalNext: c.Conditional_Next_JSON ? JSON.parse(c.Conditional_Next_JSON) : []
            };

            if (c.Reqs_JSON) {
                memChoice.reqs = JSON.parse(c.Reqs_JSON);
            } else if (c.Req_Var) {
                memChoice.reqs.push({ var: c.Req_Var, op: '>=', val: c.Req_Min });
                if (c.Req_Max !== undefined && c.Req_Max < 999999) memChoice.reqs.push({ var: c.Req_Var, op: '<=', val: c.Req_Max });
            }

            for (let eff of (effectsByChoiceIdx[c.Choice_ID] || [])) {
                memChoice.effects.push({
                    type: eff.Effect_Type,
                    var: eff.Variable_Name,
                    amt: (eff.Amount !== undefined && eff.Amount !== null) ? Number(eff.Amount) : 0
                });
            }

            memBlock.choices.push(memChoice);
        }
        memStory.blocks.push(memBlock);
    }

    memStory.blocks.forEach(bk => {
        if (!memStory.blockGroups) memStory.blockGroups = ['Ungrouped'];
        if (!memStory.blockGroups.includes(bk.group)) memStory.blockGroups.push(bk.group);
    });
    return memStory;
}


async function saveStoryToDB(storyObj) {
    const db = await openDB();

    // Helper: each call opens its own transaction to avoid auto-commit on await
    function txGet(store, key) {
        return idbReq(db.transaction(store, 'readonly').objectStore(store).get(key));
    }
    function txGetAllByIndex(store, index, key) {
        return idbReq(db.transaction(store, 'readonly').objectStore(store).index(index).getAll(key));
    }
    function txDelete(store, key) {
        return idbReq(db.transaction(store, 'readwrite').objectStore(store).delete(key));
    }
    function txPut(store, obj) {
        return idbReq(db.transaction(store, 'readwrite').objectStore(store).put(obj));
    }
    function txAdd(store, obj) {
        return idbReq(db.transaction(store, 'readwrite').objectStore(store).add(obj));
    }

    // 1. Upsert the story record
    let sObj = {
        Story_Title: storyObj.title,
        Dashboard_ID: currentDashboardId,
        UseDayCycle: !!storyObj.useDayCycle,
        Is_RPG: !!storyObj.isRPG,
        RPG_Stats_JSON: JSON.stringify(storyObj.rpgStats || []),
        RPG_Items_JSON: JSON.stringify(storyObj.rpgItems || {}),
        Block_Groups_JSON: JSON.stringify(storyObj.blockGroups || ['Ungrouped']),
        Daily_Events_JSON: JSON.stringify(storyObj.dailyEvents || []),
        Stat_Events_JSON: JSON.stringify(storyObj.statEvents || []),
        Start_Block_Name: storyObj.startBlock || ''
    };
    if (storyObj.id) sObj.Story_ID = storyObj.id;
    const sid = await txPut('Stories', sObj);
    storyObj.id = sid;

    // 2. Delete old variables
    const oldVars = await txGetAllByIndex('Variables', 'Story_ID', sid);
    await Promise.all(oldVars.map(v => txDelete('Variables', v.Variable_ID)));

    // 3. Delete old blocks + their children
    const oldBlocks = await txGetAllByIndex('StoryBlocks', 'Story_ID', sid);
    for (let b of oldBlocks) {
        const [oldExtras, oldChoices] = await Promise.all([
            txGetAllByIndex('ExtraTexts', 'StoryBlock_ID', b.StoryBlock_ID),
            txGetAllByIndex('Choices', 'StoryBlock_ID', b.StoryBlock_ID)
        ]);
        await Promise.all(oldExtras.map(e => txDelete('ExtraTexts', e.ExtraText_ID)));
        for (let c of oldChoices) {
            const oldEffs = await txGetAllByIndex('ChoiceEffects', 'Choice_ID', c.Choice_ID);
            await Promise.all(oldEffs.map(e => txDelete('ChoiceEffects', e.Effect_ID)));
            await txDelete('Choices', c.Choice_ID);
        }
        await txDelete('StoryBlocks', b.StoryBlock_ID);
    }

    // 4. Write new variables
    await Promise.all(Object.keys(storyObj.globalVars).map(vName => {
        let v = storyObj.globalVars[vName];
        return txAdd('Variables', {
            Story_ID: sid, Var_Name: vName, Var_Type: v.type,
            Default_Value: v.val, Is_HUD: !!storyObj.varConfig[vName],
            Char_Stats_JSON: JSON.stringify(v.stats || {})
        });
    }));

    // 5. Write new blocks, extraTexts, choices, effects
    for (let b of storyObj.blocks) {
        const bid = await txAdd('StoryBlocks', {
            Story_ID: sid, Block_Name: b.id, Block_Text: b.text, Block_Group: b.group || 'Ungrouped', Block_Notes: b.notes || ''
        });
        if (b.extraTexts) {
            await Promise.all(b.extraTexts.map(ext => txAdd('ExtraTexts', {
                StoryBlock_ID: bid, Req_Var: ext.var||'', Req_Min: ext.reqMin||0,
                Req_Max: ext.reqMax||0, Text_Content: ext.text,
                Reqs_JSON: JSON.stringify(ext.reqs || []), Req_Logic: ext.reqLogic || 'AND'
            })));
        }
        for (let c of b.choices) {
            const cid = await txAdd('Choices', {
                StoryBlock_ID: bid, Choice_Key: (c.id != null ? String(c.id) : ''),
                Choice_Text: c.txt, Next_Block_Name: c.next||'',
                Reqs_JSON: JSON.stringify(c.reqs || []), Req_Logic: c.reqLogic || 'AND',
                Conditional_Next_JSON: JSON.stringify(c.conditionalNext || []),
                Hide_Locked: !!c.hideLocked, Locked_Mode: c.lockedMode || (c.hideLocked ? 'hide' : 'show'), Max_Uses: c.maxUses||0,
                Show_Usage: c.showUsage !== false, Persist_Flag: c.persistFlag||'',
                Prompt_Char: c.promptChar||'', Locked_Msg: c.lockedMsg||'',
                Passes_Time: c.passTime !== false,
                Time_Add: c.timeAdd !== undefined ? c.timeAdd : 1,
                Force_Next_Day: !!c.forceNextDay
            });
            if (c.effects) {
                await Promise.all(c.effects.filter(eff => eff.var).map(eff => txAdd('ChoiceEffects', {
                    Choice_ID: cid, Variable_Name: eff.var,
                    Effect_Type: eff.type, Amount: eff.amt || 0
                })));
            }
        }
    }
    return sid;
}


window.deleteStory = async function(index) {
    if(!confirm("Delete this story and all relationships?")) return;
    const sid = storiesList[index].Story_ID;
    const db = await openDB();

    // Use a fresh transaction per operation to avoid IndexedDB auto-committing
    // across awaits (the same pattern used by save/loadStoryFromDB).
    function txGetAllByIndex(store, idx, key) {
        return idbReq(db.transaction(store, 'readonly').objectStore(store).index(idx).getAll(key));
    }
    function txDelete(store, key) {
        return idbReq(db.transaction(store, 'readwrite').objectStore(store).delete(key));
    }

    // Blocks and their children (extra texts, choices, effects)
    const oldBlocks = await txGetAllByIndex('StoryBlocks', 'Story_ID', sid);
    for (let b of oldBlocks) {
        const [oldExt, oldC] = await Promise.all([
            txGetAllByIndex('ExtraTexts', 'StoryBlock_ID', b.StoryBlock_ID),
            txGetAllByIndex('Choices', 'StoryBlock_ID', b.StoryBlock_ID)
        ]);
        await Promise.all(oldExt.map(e => txDelete('ExtraTexts', e.ExtraText_ID)));
        for (let c of oldC) {
            const oldE = await txGetAllByIndex('ChoiceEffects', 'Choice_ID', c.Choice_ID);
            await Promise.all(oldE.map(e => txDelete('ChoiceEffects', e.Effect_ID)));
            await txDelete('Choices', c.Choice_ID);
        }
        await txDelete('StoryBlocks', b.StoryBlock_ID);
    }

    // Variables belonging to the story
    const oldVars = await txGetAllByIndex('Variables', 'Story_ID', sid);
    await Promise.all(oldVars.map(v => txDelete('Variables', v.Variable_ID)));

    // Save games belonging to the story (previously orphaned)
    const oldSaves = await txGetAllByIndex('GameSaves', 'Story_ID', sid);
    await Promise.all(oldSaves.map(s => txDelete('GameSaves', s.Save_ID)));

    // The story record itself
    await txDelete('Stories', sid);

    await refreshLibrary();
};

window.duplicateStory = async function(index) {
    let clone = await loadStoryFromDB(storiesList[index].Story_ID);
    clone.id = null;
    clone.title += " (Copy)";
    await saveStoryToDB(clone);
    await refreshLibrary();
};

/* =========================================================
   4. EDITOR UI & FUNCTIONALITY
========================================================= */
window.renderVarTable = function() {
    window.activeVarFilter = window.activeVarFilter || 'stat';
    window.activeVarSearchTerm = window.activeVarSearchTerm || '';

    let varHTML = `<div class="cyoa-hint">Variables are your story's memory. <b>Stats</b> are numbers, <b>Items</b> are things you carry, <b>Flags</b> are on/off switches, and <b>NPCs</b> are names. Tick <b>HUD</b> to show one in the player's backpack.</div><div style="display:flex; flex-direction:column; gap:10px; margin-bottom:15px; background:#f1f5f9; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
        <div style="display:flex; gap:10px; align-items:center;">
            <label style="font-size:0.8rem; font-weight:bold; color:#334155;">View:</label>
            <select style="flex:1;  font-size:0.8rem; border-radius:4px; border:1px solid #94a3b8;" onchange="window.activeVarFilter=this.value; window.renderVarTable();">
                <option value="stat" ${window.activeVarFilter==='stat'?'selected':''}>Stats</option>
                <option value="item" ${window.activeVarFilter==='item'?'selected':''}>Items</option>
                <option value="flag" ${window.activeVarFilter==='flag'?'selected':''}>Flags</option>
                <option value="npc" ${window.activeVarFilter==='npc'?'selected':''}>NPCs</option>
            </select>
        </div>
        <input type="text" id="main-var-search" placeholder="Search ${window.activeVarFilter}s..." value="${window.activeVarSearchTerm}" oninput="window.activeVarSearchTerm=this.value; window.filterMainVarTable()" style=" font-size:0.8rem; border-radius:4px; border:1px solid #94a3b8; width:100%; box-sizing:border-box;">
    </div>`;

    for (let key in story.globalVars) {
        const v = story.globalVars[key];
        let effType = v.type === 'char' ? 'npc' : v.type; 
        if (effType !== window.activeVarFilter) continue;

        const color = window.getTypeColor(effType);

        let rpgModHTML = '';
        if (story.isRPG && (effType === 'item' || effType === 'flag')) {
            rpgModHTML = window.renderRPGModifierUI(key, effType);
        }

        varHTML += `<div class="main-var-card" data-var-name="${key.toLowerCase()}" style="background:white; border-radius:8px; padding:12px; margin-bottom:12px; border-left: 5px solid ${color}; box-shadow: 0 2px 4px rgba(0,0,0,0.1); color: #333;"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;"><span style="font-size:0.8rem; font-weight:bold; color:${color}; text-transform:uppercase;">${effType}</span><label style="font-size:0.8rem; display:flex; align-items:center; gap:4px; cursor:pointer; color:#666;"><input type="checkbox" title="Show this variable in the player's backpack during play" ${story.varConfig[key] ? 'checked' : ''} onchange="toggleVarVis('${key}', this.checked)"> HUD</label></div><div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;"><input style="flex:1.5;  font-size:0.8rem; border:1px solid #ddd; border-radius:4px;" value="${key}" onchange="renameVar('${key}', this.value)"><div style="flex:1;">${window.renderVarInput(key, v)}</div><button title="Find everywhere this variable is used" onclick="window.findVarUsage('${key}')" style="background:#e0e7ff; color:#4338ca; border:none; border-radius:4px; padding:6px 10px;">🔍</button><button title="Delete this variable and remove it everywhere" onclick="deleteVar('${key}')" style="background:#fee2e2; color:#ef4444; border:none; border-radius:4px; padding:6px 10px;">✕</button></div>${effType === 'npc' ? window.renderNPCSubVars(key, v) : ''}${rpgModHTML}</div>`;
    }

    varHTML += `<button class="btn-p"  style="width:100%; margin-bottom:15px; font-size:0.8rem; padding:10px;" onclick="addTypedVar(window.activeVarFilter)">+ Add Custom ${window.activeVarFilter.toUpperCase()}</button>`;

    let eventHTML = '';
    eventHTML = `<div style="display:inline-block; margin-bottom:15px; padding:6px 12px; background:#f8fafc; border-radius:20px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.1);"><label style="font-size:0.75rem; font-weight:bold; cursor:pointer; display:flex; align-items:center; gap:6px; color:#334155; margin:0;"><input type="checkbox" ${story.useDayCycle ? 'checked' : ''} onchange="toggleDayCycle(this.checked)" style="margin:0;"> 🌙 Enable Day/Night Cycle</label></div><div class="cyoa-hint">Adds a clock (TimeOfDay 1-6) and a Day counter. Choices can then advance time, and you can schedule events by day below.</div>`;

    if (story.useDayCycle) {
        eventHTML += `<div style="margin-top:10px; background:#fef3c7; padding:15px; border-radius:8px; border:1px solid #fde68a; box-shadow:0 2px 4px rgba(0,0,0,0.05);"><h4 style="margin:0 0 12px 0; font-size:0.9rem; color:#b45309; display:flex; align-items:center; gap:6px;">📅 Scheduled Daily Events</h4>`;
        (story.dailyEvents || []).forEach((ev, i) => {
            ev.type = ev.type || 'var';
            let actionHTML = '';
            if (ev.type === 'var') {
                actionHTML = `
                    <div style="display:flex; gap:6px; align-items:center;">
                        <span style="font-size:0.85rem; font-weight:bold; color:#78350f;">Set Var:</span>
                        <select style="flex:1;  font-size:0.85rem; border-radius:4px; border:1px solid #fcd34d;" onchange="updateDailyEvent(${i}, 'varName', this.value)">
                            <option value="">- Select Variable -</option>
                            ${Object.keys(story.globalVars).map(v => `<option value="${v}" ${ev.varName===v?'selected':''}>${v}</option>`).join('')}
                        </select>
                        <span style="font-size:0.85rem; font-weight:bold; color:#78350f;">=</span>
                        <input type="number" style="min-width:60px; max-width:120px;  font-size:0.85rem; border-radius:4px; border:1px solid #fcd34d;" value="${ev.val !== undefined ? ev.val : 1}" onchange="updateDailyEvent(${i}, 'val', parseInt(this.value))">
                    </div>
                `;
            } else {
                actionHTML = `
                    <div style="display:flex; gap:6px; align-items:center;">
                        <span style="font-size:0.85rem; font-weight:bold; color:#78350f;">Jump To:</span>
                        <select style="flex:1;  font-size:0.85rem; border-radius:4px; border:1px solid #fcd34d;" onchange="updateDailyEvent(${i}, 'blockName', this.value)">
                            <option value="">- Select Block -</option>
                            ${story.blocks.map(b => `<option value="${b.id}" ${ev.blockName===b.id?'selected':''}>${b.id}</option>`).join('')}
                        </select>
                    </div>
                `;
            }
            eventHTML += `<div style="background:#fffbeb; padding:10px; border-radius:6px; border:1px solid #fcd34d; margin-bottom:10px; position:relative;">
                <button style="position:absolute; top:8px; right:8px; width:24px; height:24px; padding:0; display:flex; align-items:center; justify-content:center; font-size:0.8rem; background:#fee2e2; color:#ef4444; border:none; border-radius:4px; cursor:pointer;" onclick="removeDailyEvent(${i})" title="Remove Event">✕</button>

                <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:8px; padding-right:28px;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-size:0.85rem; font-weight:bold; color:#92400e;">Trigger on Day:</span>
                        <input type="number" min="1" style="min-width:60px; max-width:120px;  font-size:0.8rem; font-weight:bold; color:#b45309; border-radius:4px; border:1px solid #fcd34d; text-align:center;" value="${ev.day}" onchange="updateDailyEvent(${i}, 'day', parseInt(this.value))">
                    </div>

                    <select style=" font-size:0.85rem; border-radius:4px; border:1px solid #fcd34d; background:#fef3c7; color:#92400e; font-weight:bold;" onchange="updateDailyEvent(${i}, 'type', this.value)">
                        <option value="var" ${ev.type==='var'?'selected':''}>Action: Update Variable</option>
                        <option value="block" ${ev.type==='block'?'selected':''}>Action: Force Block Jump</option>
                    </select>
                </div>

                <div style="background:white; padding:8px; border-radius:4px; border:1px dashed #fcd34d;">
                    ${actionHTML}
                </div>
            </div>`;
        });
        eventHTML += `<button style="background:#d97706; color:white; border:none; border-radius:6px; padding:8px; width:100%; font-size:0.8rem; font-weight:bold; cursor:pointer; transition:0.2s;" onmouseover="this.style.background='#b45309'" onmouseout="this.style.background='#d97706'" onclick="addDailyEvent()">+ Add Daily Event</button></div>`;
    }

    
    // STAT EVENTS
    eventHTML += `<div style="margin-top:15px; background:#eff6ff; padding:15px; border-radius:8px; border:1px solid #bfdbfe; box-shadow:0 2px 4px rgba(0,0,0,0.05);"><h4 style="margin:0 0 12px 0; font-size:0.9rem; color:#1e40af; display:flex; align-items:center; gap:6px;">⚡ Stat-Based Events</h4>`;
    (story.statEvents || []).forEach((ev, i) => {
        ev.type = ev.type || 'var';
        ev.reqOp = ev.reqOp || '>=';
        let actionHTML = '';
        if (ev.type === 'var') {
            actionHTML = `
                <div style="display:flex; gap:6px; align-items:center;">
                    <span style="font-size:0.85rem; font-weight:bold; color:#1e40af;">Set Var:</span>
                    <select style="flex:1; font-size:0.85rem; border-radius:4px; border:1px solid #93c5fd;" onchange="updateStatEvent(${i}, 'varName', this.value)">
                        <option value="">- Select Variable -</option>
                        ${Object.keys(story.globalVars).map(v => `<option value="${v}" ${ev.varName===v?'selected':''}>${v}</option>`).join('')}
                    </select>
                    <span style="font-size:0.85rem; font-weight:bold; color:#1e40af;">=</span>
                    <input type="number" style="min-width:60px; max-width:120px; font-size:0.85rem; border-radius:4px; border:1px solid #93c5fd;" value="${ev.val !== undefined ? ev.val : 1}" onchange="updateStatEvent(${i}, 'val', parseInt(this.value))">
                </div>
            `;
        } else {
            actionHTML = `
                <div style="display:flex; gap:6px; align-items:center;">
                    <span style="font-size:0.85rem; font-weight:bold; color:#1e40af;">Jump To:</span>
                    <select style="flex:1; font-size:0.85rem; border-radius:4px; border:1px solid #93c5fd;" onchange="updateStatEvent(${i}, 'blockName', this.value)">
                        <option value="">- Select Block -</option>
                        ${story.blocks.map(b => `<option value="${b.id}" ${ev.blockName===b.id?'selected':''}>${b.id}</option>`).join('')}
                    </select>
                </div>
            `;
        }

        eventHTML += `<div style="background:#f8fafc; padding:10px; border-radius:6px; border:1px solid #93c5fd; margin-bottom:10px; position:relative;">
            <button style="position:absolute; top:8px; right:8px; width:24px; height:24px; padding:0; display:flex; align-items:center; justify-content:center; font-size:0.8rem; background:#fee2e2; color:#ef4444; border:none; border-radius:4px; cursor:pointer;" onclick="removeStatEvent(${i})" title="Remove Event">✕</button>

            <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:8px; padding-right:28px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span style="font-size:0.85rem; font-weight:bold; color:#1e40af;">If</span>
                    <select style="font-size:0.8rem; border-radius:4px; border:1px solid #93c5fd; color:#1e40af;" onchange="updateStatEvent(${i}, 'reqVar', this.value)">
                        <option value="">- Stat -</option>
                        ${Object.keys(story.globalVars).map(v => `<option value="${v}" ${ev.reqVar===v?'selected':''}>${v}</option>`).join('')}
                    </select>
                    <select style="font-size:0.8rem; border-radius:4px; border:1px solid #93c5fd; color:#1e40af; font-weight:bold;" onchange="updateStatEvent(${i}, 'reqOp', this.value)">
                        <option value=">=" ${ev.reqOp==='>='?'selected':''}>&ge;</option>
                        <option value="<=" ${ev.reqOp==='<='?'selected':''}>&le;</option>
                        <option value="==" ${ev.reqOp==='=='?'selected':''}>=</option>
                        <option value=">" ${ev.reqOp==='>'?'selected':''}>&gt;</option>
                        <option value="<" ${ev.reqOp==='<'?'selected':''}>&lt;</option>
                    </select>
                    <input type="number" style="min-width:60px; max-width:80px; font-size:0.8rem; border-radius:4px; border:1px solid #93c5fd; text-align:center;" value="${ev.reqVal !== undefined ? ev.reqVal : 1}" onchange="updateStatEvent(${i}, 'reqVal', parseInt(this.value))">
                </div>

                <select style="font-size:0.85rem; border-radius:4px; border:1px solid #93c5fd; background:#eff6ff; color:#1e40af; font-weight:bold;" onchange="updateStatEvent(${i}, 'type', this.value)">
                    <option value="var" ${ev.type==='var'?'selected':''}>Action: Set Variable</option>
                    <option value="block" ${ev.type==='block'?'selected':''}>Action: Jump to Block</option>
                </select>

                <label style="font-size:0.75rem; color:#475569; display:flex; align-items:center; gap:4px; cursor:pointer; margin:0;"><input type="checkbox" ${ev.fireOnce !== false ? 'checked' : ''} onchange="updateStatEvent(${i}, 'fireOnce', this.checked)" style="margin:0;"> Fire Only Once</label>
            </div>

            <div style="background:white; padding:8px; border-radius:4px; border:1px dashed #93c5fd;">
                ${actionHTML}
            </div>
        </div>`;
    });
    eventHTML += `<button style="background:#2563eb; color:white; border:none; border-radius:6px; padding:8px; width:100%; font-size:0.8rem; font-weight:bold; cursor:pointer; transition:0.2s;" onmouseover="this.style.background='#1d4ed8'" onmouseout="this.style.background='#2563eb'" onclick="addStatEvent()">+ Add Stat Event</button></div>`;

    document.getElementById('ed-var-table').innerHTML = varHTML;
    const edEventsTable = document.getElementById('ed-events-table');
    if (edEventsTable) {
        edEventsTable.innerHTML = eventHTML || '<div style="color:#94a3b8; font-size:0.8rem; font-style:italic; text-align:center; margin-top:20px;">No events scheduled.</div>';
    }

    window.filterMainVarTable();
};

window.filterMainVarTable = function() {
    const input = document.getElementById('main-var-search');
    if (!input) return;
    const term = input.value.toLowerCase();
    document.querySelectorAll('.main-var-card').forEach(el => {
        el.style.display = el.getAttribute('data-var-name').includes(term) ? 'block' : 'none';
    });
};

window.addStatEvent = function() {
    if(!story.statEvents) story.statEvents = [];
    story.statEvents.push({id: 'se_' + Date.now() + '_' + Math.floor(Math.random()*10000), reqVar: '', reqOp: '>=', reqVal: 1, type: 'var', varName: '', val: 1, blockName: '', fireOnce: true});
    window.renderEditor();
};
window.updateStatEvent = function(i, f, v) { story.statEvents[i][f] = v; window.renderEditor(); };
window.removeStatEvent = function(i) { story.statEvents.splice(i,1); window.renderEditor(); };

window.checkStatEvents = function() {
    if (!story.statEvents || !story.statEvents.length) return false;
    if (!pState.firedEvents) pState.firedEvents = {};

    let jumped = false;
    for (let i = 0; i < story.statEvents.length; i++) {
        let ev = story.statEvents[i];
        let evKey = ev.id || ('statEv_' + i);
        if (ev.fireOnce !== false && pState.firedEvents[evKey]) continue;
        if (!ev.reqVar || !pState.vars[ev.reqVar]) continue;

        let cur = pState.vars[ev.reqVar].val;
        let req = ev.reqVal;
        let pass = false;
        if (ev.reqOp === '>=') pass = cur >= req;
        if (ev.reqOp === '<=') pass = cur <= req;
        if (ev.reqOp === '==') pass = cur === req;
        if (ev.reqOp === '>') pass = cur > req;
        if (ev.reqOp === '<') pass = cur < req;

        if (pass) {
            if (ev.fireOnce !== false) pState.firedEvents[evKey] = true;

            if (ev.type === 'var' && ev.varName && pState.vars[ev.varName]) {
                pState.vars[ev.varName].val = ev.val;
            } else if (ev.type === 'block' && ev.blockName) {
                if (pState.bId !== ev.blockName) {
                    pState.bId = ev.blockName;
                    jumped = true;
                }
            }
        }
    }
    return jumped;
};

window.addDailyEvent = function() {
    if(!story.dailyEvents) story.dailyEvents = [];
    story.dailyEvents.push({day: 2, type: 'var', varName: '', val: 1, blockName: ''});
    window.renderEditor();
};
window.updateDailyEvent = function(i, f, v) { story.dailyEvents[i][f] = v; window.renderEditor(); };
window.removeDailyEvent = function(i) { story.dailyEvents.splice(i,1); window.renderEditor(); };


window.renderRPGStats = function() {
    if (!story.isRPG) return '';
    if (!story.rpgStats) story.rpgStats = ['HP', 'MaxHP', 'Atk', 'Def', 'Dex', 'Agi'];

    let html = `<div style="margin-top:20px; background:#fdf2f8; padding:15px; border-radius:8px; border:1px solid #fbcfe8; box-shadow:0 2px 4px rgba(0,0,0,0.05);">
        <h4 style="margin:0 0 12px 0; font-size:0.85rem; color:#be185d; display:flex; align-items:center; gap:6px;">📊 RPG Custom Stats</h4>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap:8px; margin-bottom:15px;">`;

    (story.rpgStats || []).forEach((st, i) => {
        html += `<div style="background:white; padding:6px 10px; border-radius:6px; font-size:0.85rem; font-weight:600; color:#831843; border:1px solid #f9a8d4; display:flex; justify-content:space-between; align-items:center; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${st}</span>
            <button style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:0.9rem; font-weight:bold; padding:0 0 0 5px; line-height:1;" onclick="removeRPGStat(${i})" title="Remove Stat">×</button>
        </div>`;
    });

    html += `</div>
        <div style="display:flex; gap:8px; align-items:stretch;">
            <select id="add-rpg-stat-sel" style="flex:1; padding:8px 10px; font-size:0.8rem; border:1px solid #fbcfe8; border-radius:6px; outline:none; color:#475569; background:white;">
                <option value="">-- Preset Stats --</option>
                <option value="Mana">Mana</option>
                <option value="MaxMana">MaxMana</option>
                <option value="MagicAtk">MagicAtk</option>
                <option value="MagicDef">MagicDef</option>
                <option value="Luck">Luck</option>
                <option value="Charisma">Charisma</option>
                <option value="Stamina">Stamina</option>
                <option value="Custom">>> Custom Stat...</option>
            </select>
            <button style="background:#be185d; color:white; border:none; border-radius:6px; padding:0 15px; font-size:0.8rem; font-weight:bold; cursor:pointer; transition:0.2s;" onmouseover="this.style.background='#9d174d'" onmouseout="this.style.background='#be185d'" onclick="addRPGStat()">Add</button>
        </div>
    </div>`;
    return html;
};

window.addRPGStat = function() {
    const sel = document.getElementById('add-rpg-stat-sel').value;
    if (!sel) return;
    let statName = sel;
    if (sel === 'Custom') {
        statName = prompt("Enter custom stat name (e.g. Speed, Intellect):");
        if (!statName) return;
    }
    statName = statName.trim().replace(/[^a-zA-Z0-9_]/g, '');
    if (statName && !story.rpgStats.includes(statName)) {
        story.rpgStats.push(statName);
        if (!story.globalVars[statName]) {
            story.globalVars[statName] = { type: 'stat', val: statName.includes('Max') ? 100 : 10, stats: null };
        }
        window.renderEditor();
    }
};

window.removeRPGStat = function(i) {
    let st = story.rpgStats[i];
    if(confirm(`Remove stat '${st}' from RPG System?\n(The Variable will remain, but will be removed from Item Modifiers)`)) {
        story.rpgStats.splice(i, 1);
        window.renderEditor();
    }
};

window.renderRPGModifierUI = function(key, effType) {
    if (!story.rpgItems) story.rpgItems = {};
    let isRPGItem = !!story.rpgItems[key];

    let labelTxt = effType === 'flag' ? '⚡ Active Effect / Aura?' : '⚔️ RPG Modifier?';

    let html = `<div style="margin-top:10px; padding-top:10px; border-top:1px dashed #cbd5e1;">`;
    html += `<label style="font-size:0.85rem; font-weight:bold; color:#4f46e5; display:flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" ${isRPGItem ? 'checked' : ''} onchange="toggleRPGItem('${key}', this.checked, '${effType}')"> ${labelTxt}</label>`;

    if (isRPGItem) {
        let item = story.rpgItems[key];
        if (!item.stats) item.stats = {};

        html += `<div style="margin-top:8px; padding:10px; background:#e0e7ff; border-radius:6px; border:1px solid #c7d2fe;">`;

        if (effType === 'item') {
            html += `<div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                <span style="font-size:0.8rem; font-weight:bold; color:#3730a3;">Item Type:</span>
                <select style=" font-size:0.8rem; border-radius:4px; border:1px solid #a5b4fc; flex:1;" onchange="updateRPGItem('${key}', 'type', this.value)">
                    <option value="weapon" ${item.type==='weapon'?'selected':''}>Weapon</option>
                    <option value="armor" ${item.type==='armor'?'selected':''}>Armor</option>
                    <option value="consumable" ${item.type==='consumable'?'selected':''}>Consumable (Destroyed on use)</option>
                    <option value="useable" ${item.type==='useable'?'selected':''}>Useable (Limited Uses / Cooldown)</option>
                </select>
            </div>`;
            if (item.type === 'consumable' || item.type === 'useable') {
                html += `<div style="display:flex; gap:10px; margin-bottom:10px;">
                    <label style="flex:1; font-size:0.8rem; color:#3730a3; font-weight:bold;">Max Uses (0=Stack/Inf)
                        <input type="number" min="0" value="${item.maxUses || 0}" style="width:100%;  margin-top:4px; border:1px solid #a5b4fc; border-radius:4px;" onchange="updateRPGItem('${key}', 'maxUses', parseInt(this.value)||0)">
                    </label>
                    <label style="flex:1; font-size:0.8rem; color:#3730a3; font-weight:bold;">Cooldown (Phases)
                        <input type="number" min="0" value="${item.cooldown || 0}" style="width:100%;  margin-top:4px; border:1px solid #a5b4fc; border-radius:4px;" onchange="updateRPGItem('${key}', 'cooldown', parseInt(this.value)||0)">
                    </label>
                </div>`;
            }
        } else {
            html += `<div style="font-size:0.8rem; color:#3730a3; margin-bottom:10px; font-style:italic;">This modifier will apply to the player's stats permanently as long as this Flag is turned ON (Value > 0).</div>`;
        }

        html += `<div style="display:flex; flex-direction:column; gap:4px; margin-bottom:10px;">`;
        let hasStats = false;
        for (let st in item.stats) {
            if (item.stats[st] !== 0) {
                hasStats = true;
                let valStr = item.stats[st] > 0 ? `+${item.stats[st]}` : item.stats[st];
                let col = item.stats[st] > 0 ? '#10b981' : '#ef4444';
                html += `<div style="display:flex; justify-content:space-between; align-items:center; background:white;  border-radius:4px; border:1px solid #cbd5e1; font-size:0.8rem; font-weight:bold;">
                    <span>${st} <span style="color:${col}; margin-left:6px;">${valStr}</span></span>
                    <button style="background:none; border:none; color:#ef4444; cursor:pointer; font-weight:bold; padding:0;" onclick="removeRPGItemStat('${key}', '${st}')">✕</button>
                </div>`;
            }
        }
        if (!hasStats) {
            html += `<div style="font-size:0.8rem; color:#64748b; font-style:italic; padding-bottom:6px;">No stat modifiers yet.</div>`;
        }
        html += `</div>`;

        let statOptions = Object.keys(story.globalVars)
            .filter(k => story.globalVars[k].type === 'stat')
            .map(s => `<option value="${s}">${s}</option>`)
            .join('');

        html += `<div style="display:flex; gap:5px; align-items:center;">
            <select id="rpg_mod_stat_${key}" style="flex:1;  font-size:0.8rem; border-radius:4px; border:1px solid #a5b4fc;">
                <option value="">- Stat -</option>
                ${statOptions}
            </select>
            <input type="number" id="rpg_mod_val_${key}" value="1" style="min-width:60px; max-width:100px;  font-size:0.8rem; border-radius:4px; border:1px solid #a5b4fc; text-align:center;">
            <button style="background:#4f46e5; color:white; border:none; border-radius:4px;  font-size:0.8rem; cursor:pointer; font-weight:bold;" onclick="addRPGItemStatUI('${key}')">Add</button>
        </div>`;

        html += `</div>`;
    }
    html += `</div>`;
    return html;
};

window.toggleRPGItem = function(key, isChecked, effType) {
    if (!story.rpgItems) story.rpgItems = {};
    if (isChecked) {
        story.rpgItems[key] = { type: effType === 'flag' ? 'passive' : 'weapon', stats: {} };
    } else {
        delete story.rpgItems[key];
    }
    window.renderEditor();
};

window.updateRPGItem = function(k, f, v) {
    if (story.rpgItems[k]) {
        story.rpgItems[k][f] = v;
        window.renderEditor();
    }
};

window.addRPGItemStatUI = function(key) {
    const sel = document.getElementById(`rpg_mod_stat_${key}`);
    const input = document.getElementById(`rpg_mod_val_${key}`);
    if (!sel || !input || !sel.value) return;
    const val = parseInt(input.value) || 0;
    if (val !== 0) {
        if (!story.rpgItems[key].stats) story.rpgItems[key].stats = {};
        let current = story.rpgItems[key].stats[sel.value] || 0;
        story.rpgItems[key].stats[sel.value] = val; // Just set or overwrite
        window.renderEditor();
    }
};

window.removeRPGItemStat = function(key, stat) {
    if (story.rpgItems[key] && story.rpgItems[key].stats) {
        delete story.rpgItems[key].stats[stat];
        window.renderEditor();
    }
};

window.renderVarInput = function(key, v) {

    const style = `width:100%;  font-size:0.8rem; border:1px solid #ddd; border-radius:4px;`;
    if (v.type === 'char' || v.type === 'npc') return `<input style="${style}" type="text" value="${v.val}" onchange="story.globalVars['${key}'].val=this.value">`;
    if (v.type === 'flag') return `<select style="${style}" onchange="story.globalVars['${key}'].val=parseInt(this.value)"><option value="0" ${v.val===0?'selected':''}>Off</option><option value="1" ${v.val===1?'selected':''}>On</option></select>`;
    return `<input style="${style}" type="number" value="${v.val}" onchange="story.globalVars['${key}'].val=parseInt(this.value)">`;
};

window.renderEditor = function() {
    const titleInput = document.getElementById('ed-title');
    if (titleInput) { titleInput.value = story.title; titleInput.oninput = (e) => story.title = e.target.value; }
    const b = story.blocks[bIdx];
    const blockIdInput = document.getElementById('ed-blk-id');
    if (blockIdInput) { 
        blockIdInput.value = b.id; 
        blockIdInput.onchange = (e) => window.syncBlockId(e.target.value); 

        if (!document.getElementById('ed-blk-group-container')) {
            const ctr = document.createElement('div');
            ctr.id = 'ed-blk-group-container';
            ctr.style.display = 'flex'; ctr.style.flexWrap = 'wrap'; ctr.style.gap = '8px'; ctr.style.flex = '1';
            ctr.style.alignItems = 'center';
            ctr.style.marginLeft = '15px';
            ctr.innerHTML = `<span style="font-size:0.85rem; font-weight:bold; margin-right:5px; color:#475569;">Folder:</span>
                             <select id="ed-blk-group" style=" font-size:0.85rem; border-radius:4px; border:1px solid #cbd5e1;" onchange="changeBlockGroup(this.value)" title="Move this block into a folder"></select>
                             <button class="btn-s" style="font-size:0.8rem;" onclick="createBlockGroup()" title="Create a new folder (block group)">+ Add Folder</button>
                             <button class="btn-s" style="font-size:0.8rem;" onclick="window.duplicateBlock()" title="Make a copy of this block">⧉ Duplicate Block</button>
                             <button class="btn-s" style="font-size:0.8rem;" onclick="playtestCurrentBlock()" title="Play from this block. Does not save your story.">▶️ Test Block</button>
                             <button class="btn-s" style="font-size:0.8rem;" onclick="window.showStoryboard()" title="See your whole story as a flowchart">🗺️ Storyboard</button>
                             <button class="btn-s" style="font-size:0.8rem;" onclick="window.validateStory()" title="Check for broken links, unreachable blocks, and dead ends">✅ Validate</button>
                             <button id="btn-set-start" class="btn-s" style="background:#f59e0b; color:white; border:none; padding:4px 12px; border-radius:4px; cursor:pointer; font-size:0.8rem;" onclick="window.setStartBlock()" title="Mark this block as where New Game begins">⭐ Set as Start</button>
                             <button id="btn-tips" class="btn-s" style="font-size:0.8rem;" onclick="window.toggleTips()" title="Show or hide the helper hints throughout the editor">💡 Tips: On</button>
                             <div style="display:flex; gap:5px; margin-left:15px; border-left:2px solid #cbd5e1; padding-left:15px;">
                                 <button id="btn-undo" class="btn-s" style="padding:4px 8px; cursor:pointer; min-width:40px; margin:0;" onclick="window.undo()" title="Undo (Ctrl+Z)">↩️</button>
                                 <button id="btn-redo" class="btn-s" style="padding:4px 8px; cursor:pointer; min-width:40px; margin:0;" onclick="window.redo()" title="Redo (Ctrl+Y)">↪️</button>
                             </div>`;
            blockIdInput.parentNode.insertBefore(ctr, blockIdInput.nextSibling);
        }

        const grpSel = document.getElementById('ed-blk-group');
        if (grpSel) {
            let safeGroups = story.blockGroups || ['Ungrouped'];
            let currentGroup = b.group || 'Ungrouped';
            if (!safeGroups.includes(currentGroup)) {
                safeGroups.push(currentGroup);
                story.blockGroups = safeGroups;
            }
            grpSel.innerHTML = safeGroups.map(g => `<option value="${g}" ${currentGroup === g ? 'selected' : ''}>${g}</option>`).join('');
        }

        const startBtn = document.getElementById('btn-set-start');
        if (startBtn) {
            const isStart = story.startBlock && story.startBlock === b.id;
            startBtn.innerText = isStart ? '⭐ Start Block' : '⭐ Set as Start';
            startBtn.style.background = isStart ? '#16a34a' : '#f59e0b';
        }
    }
    document.getElementById('ed-blk-text').value = b.text;
    document.getElementById('ed-blk-text').oninput = (e) => b.text = e.target.value;
    const notesEl = document.getElementById('ed-blk-notes');
    if (notesEl) { notesEl.value = b.notes || ''; notesEl.oninput = (e) => { b.notes = e.target.value; }; }
    window.renderVariableHelper();
    window.renderVarTable();
    window.renderChoices();
    window.renderExtraTextEditor();
    
    if (!document.getElementById('block-search-input')) {
        document.getElementById('ed-blocks-menu').innerHTML = `
            <div style="margin-bottom: 10px;">
                <input type="text" id="block-search-input" placeholder="Search blocks..." oninput="updateBlockSearch()" style="width:100%;  box-sizing:border-box; border-radius:4px; border:1px solid #ccc;">
            </div>
            <div id="block-list-container"></div>
        `;
    }
    window.updateBlockSearch();
    window.applyTipsState();
};

window.getLogicUI = function(prefix, i, obj, type, updateFunc) {
    if (type === 'flag') return `<div class="range-container" style="flex:1;"><span style="font-size:0.8rem; color:#64748b; margin-right:4px;">Is:</span><select style="border:none; flex:1; font-weight:bold; background:transparent;" onchange="${updateFunc}('${i}', 'reqMin', parseInt(this.value)); ${updateFunc}('${i}', 'reqMax', parseInt(this.value));"><option value="1" ${obj.reqMin === 1 ? 'selected' : ''}> On</option><option value="0" ${obj.reqMin === 0 ? 'selected' : ''}> Off</option></select></div>`;
    return `<div class="range-container"><input type="number" class="range-input" value="${obj.reqMin || 0}" onchange="${updateFunc}('${i}', 'reqMin', parseInt(this.value))"><span style="color:#94a3b8; font-weight:bold; font-size:0.8rem;">to</span><input type="number" class="range-input" value="${obj.reqMax || 0}" onchange="${updateFunc}('${i}', 'reqMax', parseInt(this.value))"></div>`;
};


window.evaluateReqLogic = function(reqs, reqLogic, vars) {
    if (!reqs || reqs.length === 0) return true;
    let results = [];

    for (let r of reqs) {
        if (!r.var || !vars[r.var]) { results.push(false); continue; }
        let cur = vars[r.var].val;
        let t = vars[r.var].type;
        let rMet = true;
        if (t === 'flag') { if (cur !== r.val) rMet = false; }
        else if (t === 'char' || t === 'npc') {
            if (r.op === '==' && cur != r.val) rMet = false;
            if (r.op === '!=' && cur == r.val) rMet = false;
        } else {
            if (r.op === 'has' && cur < 1) rMet = false;
            if (r.op === '>=' && cur < r.val) rMet = false;
            if (r.op === '<=' && cur > r.val) rMet = false;
            if (r.op === '==' && cur != r.val) rMet = false;
            if (r.op === '!=' && cur == r.val) rMet = false;
            if (r.op === '>' && cur <= r.val) rMet = false;
            if (r.op === '<' && cur >= r.val) rMet = false;
        }
        results.push(rMet);
    }

    if (reqLogic === 'OR') return results.some(res => res === true);
    return results.every(res => res === true);
};
window.checkLogic = function(val, min, max) { return val >= (min || 0) && val <= (max === undefined ? 999999 : max); };


window.updateBlockSearch = function() {
    if (!document.getElementById('block-search-input')) return;
    const term = document.getElementById('block-search-input').value.toLowerCase();
    let mappedBlocks = story.blocks.map((blk, i) => ({ blk, originalIndex: i }));
    mappedBlocks.sort((a, b) => a.blk.id.localeCompare(b.blk.id));

    let groups = story.blockGroups || ['Ungrouped'];
    window.expandedGroups = window.expandedGroups || {'Ungrouped': true};

    let listHtml = '';
    groups.forEach(grp => {
        let grpBlocks = mappedBlocks.filter(m => (m.blk.group || 'Ungrouped') === grp && m.blk.id.toLowerCase().includes(term));
        if (grpBlocks.length === 0 && term !== '') return; 

        let isExpanded = term !== '' || window.expandedGroups[grp]; 

        listHtml += `<div style="background:#334155; color:white; padding:6px 10px; margin-top:8px; border-radius:4px; cursor:pointer; font-size:0.8rem; font-weight:bold; display:flex; justify-content:space-between; align-items:center;" onclick="toggleGroup('${grp}')">
            <span>📁 ${grp} <span style="font-size:0.8rem; color:#94a3b8; margin-left:4px;">(${grpBlocks.length})</span></span>
            <div style="display:flex; gap:8px; align-items:center;">
                <button onclick="event.stopPropagation(); addBlock('${grp}')" style="background:#475569; color:white; border:1px solid #64748b; border-radius:4px; font-size:0.8rem;  cursor:pointer; transition: 0.2s;" onmouseover="this.style.background='#64748b'" onmouseout="this.style.background='#475569'">+ Block</button>
                <span style="width:12px; text-align:center;">${isExpanded ? '▼' : '▶'}</span>
            </div>
        </div>`;

        if (isExpanded) {
            listHtml += `<div style="padding-left:10px; border-left:2px solid #cbd5e1; margin-left:5px;">`;
            listHtml += grpBlocks.map(m => `
                <div class="block-menu-item" style="display:flex; justify-content:space-between; align-items:center; background:${m.originalIndex === bIdx ? 'var(--p)' : '#f1f5f9'}; color:${m.originalIndex === bIdx ? 'white' : 'black'}; margin-top:4px;  border-radius:4px; border:1px solid #e2e8f0;">
                    <span onclick="setActiveBlock(${m.originalIndex})" style="flex-grow:1; cursor:pointer; font-size:0.85rem;">${m.blk.id}</span>
                    ${story.blocks.length > 1 ? `<span class="remove-blk-btn" onclick="removeBlock(${m.originalIndex})" style="cursor:pointer; font-weight:bold; padding:0 5px; color:${m.originalIndex === bIdx ? '#fca5a5' : '#ef4444'};">×</span>` : ''}
                </div>
            `).join('');
            if (grpBlocks.length === 0) listHtml += `<div style="font-size:0.8rem; color:#94a3b8; padding:5px;">No blocks.</div>`;
            listHtml += `</div>`;
        }
    });

    document.getElementById('block-list-container').innerHTML = listHtml;
};

window.toggleGroup = function(grp) {
    window.expandedGroups[grp] = !window.expandedGroups[grp];
    window.updateBlockSearch();
};

window.changeBlockGroup = function(grp) {
    story.blocks[bIdx].group = grp;
    window.updateBlockSearch();
};

window.createBlockGroup = function() {
    let n = prompt("Enter new Folder name:");
    if (n && n.trim()) {
        n = n.trim().replace(/[^a-zA-Z0-9_ \-]/g, '');
        if (!story.blockGroups) story.blockGroups = ['Ungrouped'];
        if (!story.blockGroups.includes(n)) {
            story.blockGroups.push(n);
            story.blocks[bIdx].group = n;
            window.renderEditor();
        }
    }
};

window.renderExtraTextEditor = function() {
    const b = story.blocks[bIdx];
    const vOpt = Object.keys(story.globalVars).map(v => `<option value="${v}">${v}</option>`).join('');

    let html = `<h4>Conditional Text</h4><div class="cyoa-hint">Extra paragraphs that appear only when their conditions are met. Great for reactive descriptions (e.g. show a hint only until an item is taken).</div>`;
    if (b.extraTexts) {
        b.extraTexts.forEach((extra, i) => {
            if (!extra.reqs) {
                extra.reqs = [];
                if (extra.var) {
                    extra.reqs.push({ var: extra.var, op: '>=', val: extra.reqMin });
                    if (extra.reqMax !== undefined && extra.reqMax < 999999) { extra.reqs.push({ var: extra.var, op: '<=', val: extra.reqMax }); }
                }
            }



        let logicSelect = '';
            if (extra.reqs && extra.reqs.length > 1) {
                logicSelect = `<select style="margin-left: 10px;  font-size: 0.65rem; border:1px solid #cbd5e1; border-radius:4px;" onchange="updateExtraText(${i}, 'reqLogic', this.value)">
                    <option value="AND" ${extra.reqLogic !== 'OR' ? 'selected' : ''}>ALL (AND)</option>
                    <option value="OR" ${extra.reqLogic === 'OR' ? 'selected' : ''}>ANY (OR)</option>
                </select>`;
            }

            let reqsHTML = `<div style="padding:15px; margin-bottom:15px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;">
                <label style="font-size:0.8rem; font-weight:bold; color:#475569; display:flex; align-items:center;">Conditions ${logicSelect}</label>`;

            if (extra.reqs) {
                extra.reqs.forEach((r, rIdx) => {
                    let t = story.globalVars[r.var]?.type;
                    let ops = '', vals = '';
                    if (t === 'flag') {
                        ops = `<select style="flex:1; border: 1px solid #ddd; border-radius: 4px;" onchange="updateExtraReq(${i}, ${rIdx}, 'val', parseInt(this.value))">
                            <option value="1" ${r.val===1?'selected':''}>Is On</option>
                            <option value="0" ${r.val===0?'selected':''}>Is Off</option>
                        </select>`;
                    } else if (t === 'char' || t === 'npc') {
                        ops = `<select style="flex:1; border: 1px solid #ddd; border-radius: 4px;" onchange="updateExtraReq(${i}, ${rIdx}, 'op', this.value)">
                            <option value="==" ${r.op==='=='?'selected':''}>Is</option>
                            <option value="!=" ${r.op==='!='?'selected':''}>Is Not</option>
                        </select>`;
                        vals = `<input type="text" style="flex:1; width:50px; border: 1px solid #ddd; border-radius: 4px; " value="${r.val}" onchange="updateExtraReq(${i}, ${rIdx}, 'val', this.value)">`;
                    } else {
                        ops = `<select style="flex:1; border: 1px solid #ddd; border-radius: 4px;" onchange="updateExtraReq(${i}, ${rIdx}, 'op', this.value)">
                            <option value="has" ${r.op==='has'?'selected':''}>Has</option>
                            <option value=">=" ${r.op==='>='?'selected':''}>&ge;</option>
                            <option value="<=" ${r.op==='<='?'selected':''}>&le;</option>
                            <option value="==" ${r.op==='=='?'selected':''}>==</option>
                            <option value="!=" ${r.op==='!='?'selected':''}>!=</option>
                        </select>`;
                        if (r.op !== 'has') vals = `<input type="number" style="flex:1; width:50px; border: 1px solid #ddd; border-radius: 4px; " value="${r.val}" onchange="updateExtraReq(${i}, ${rIdx}, 'val', parseInt(this.value))">`;
                    }
                    reqsHTML += `<div class="effect-row">
                        <select style="flex:1; border: 1px solid #ddd; border-radius: 4px; " onchange="updateExtraReq(${i}, ${rIdx}, 'var', this.value)">
                            <option value="">- Var -</option>
                            ${Object.keys(story.globalVars).map(v => `<option value="${v}" ${r.var === v ? 'selected' : ''}>${v}</option>`).join('')}
                        </select>
                        ${r.var ? ops : ''} ${r.var && vals ? vals : ''}
                        <button class="btn-d" style="width:auto; margin:0; " onclick="removeExtraReq(${i}, ${rIdx})">🗑</button>
                    </div>`;
                });
            }
            reqsHTML += `<button class="btn-s" style="margin-top:8px; font-size:0.8rem;  width:100%;" onclick="addExtraReq(${i})">+ Add Condition</button></div>`;

            html += `<div class="card" style="border-left: 4px solid var(--p); background: #fcfcfc; margin-bottom: 15px;">
                ${reqsHTML}
                <textarea rows="2" style="width:100%; margin-top:5px; padding: 8px; border-radius: 4px; border: 1px solid #ddd;" placeholder="Text to show if conditions are met..." oninput="updateExtraText(${i}, 'text', this.value)">${extra.text || ''}</textarea>
                <div style="display:flex; justify-content: flex-end; margin-top: 8px;">
                    <button class="btn-d" style="width: auto; padding: 5px 10px;" onclick="removeExtraText(${i})">Remove Conditional Text Block</button>
                </div>
            </div>`;
        });
    }
    html += `<button class="btn-s" style="width: 100%;" onclick="addExtraTextField()">+ Add Conditional Text</button>`;
    document.getElementById('extra-text-container').innerHTML = html;
};

window.addExtraReq = function(eIdx) {
    if (!story.blocks[bIdx].extraTexts[eIdx].reqs) story.blocks[bIdx].extraTexts[eIdx].reqs = [];
    story.blocks[bIdx].extraTexts[eIdx].reqs.push({ var: '', op: 'has', val: 1 });
    window.renderEditor();
};
window.updateExtraReq = function(eIdx, rIdx, field, val) {
    let r = story.blocks[bIdx].extraTexts[eIdx].reqs[rIdx];
    r[field] = val;
    if (field === 'var') {
        let t = story.globalVars[val]?.type;
        if (t === 'flag') { r.op = '=='; r.val = 1; }
        else if (t === 'char' || t === 'npc') { r.op = '=='; r.val = ''; }
        else { r.op = 'has'; r.val = 1; }
    }
    window.renderEditor();
};
window.removeExtraReq = function(eIdx, rIdx) {
    story.blocks[bIdx].extraTexts[eIdx].reqs.splice(rIdx, 1);
    window.renderEditor();
};

window.addReq = function(cIdx) {
    if(!story.blocks[bIdx].choices[cIdx].reqs) story.blocks[bIdx].choices[cIdx].reqs = [];
    story.blocks[bIdx].choices[cIdx].reqs.push({ var: '', op: 'has', val: 1 });
    window.renderEditor();
};
window.updateReq = function(cIdx, rIdx, field, val) {
    let r = story.blocks[bIdx].choices[cIdx].reqs[rIdx];
    r[field] = val;
    if(field === 'var') {
        let t = story.globalVars[val]?.type;
        if(t === 'flag') { r.op = '=='; r.val = 1; }
        else if(t === 'char' || t === 'npc') { r.op = '=='; r.val = ''; }
        else { r.op = 'has'; r.val = 1; }
    }
    window.renderEditor();
};
window.removeReq = function(cIdx, rIdx) {
    story.blocks[bIdx].choices[cIdx].reqs.splice(rIdx, 1);
    window.renderEditor();
};

window.renderChoices = function() {

    const b = story.blocks[bIdx];
    const vOpt = Object.keys(story.globalVars).map(v => `<option value="${v}">${v}</option>`).join('');
    const cOpt = Object.keys(story.globalVars).filter(k => (story.globalVars[k].type === 'char' || story.globalVars[k].type === 'npc')).map(v => `<option value="${v}">${v}</option>`).join('');
    document.getElementById('ed-choices').innerHTML = b.choices.map((c, i) => {
        
        
        
        let effectsHTML = `<div class="sub-panel" style="background:#f1f5f9; padding:10px; border-radius:6px; border:1px dashed #cbd5e1;">
            <label style="font-size:0.8rem; font-weight:bold; color:#475569; display:flex; align-items:center;">Give & Take Effects</label>
            <div class="cyoa-hint">Change a variable when this choice is picked (e.g. Give Key +1, or Take HP 5).</div>`;
        (c.effects || []).forEach((eff, eIdx) => {
            effectsHTML += `<div class="effect-row">
                <select style="min-width:60px; max-width:120px;  border:1px solid #ddd; border-radius:4px;" onchange="updateChoiceEffect(${i}, ${eIdx}, 'type', this.value)">
                    <option value="give" ${eff.type === 'give' ? 'selected' : ''}>Give</option>
                    <option value="take" ${eff.type === 'take' ? 'selected' : ''}>Take</option>
                </select>
                <select style="flex:1;  border:1px solid #ddd; border-radius:4px;" onchange="updateChoiceEffect(${i}, ${eIdx}, 'var', this.value)">
                    <option value="">- Var -</option>
                    ${Object.keys(story.globalVars).map(v => `<option value="${v}" ${eff.var === v ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
                <input type="number" style="min-width:60px; max-width:120px;  border:1px solid #ddd; border-radius:4px;" value="${eff.amt || 0}" oninput="story.blocks[bIdx].choices[${i}].effects[${eIdx}].amt = parseInt(this.value)||0" onblur="window.renderChoices()">
                <button class="btn-d" style="width:auto; margin:0; " onclick="removeChoiceEffect(${i}, ${eIdx})">🗑</button>
            </div>`;
        });
        effectsHTML += `<button class="btn-s" style="margin-top:8px; font-size:0.8rem;  width:100%;" onclick="addChoiceEffect(${i})">+ Add Effect</button></div>`;
        let logicSelect = '';
        if (c.reqs && c.reqs.length > 1) {
            logicSelect = `<select style="margin-left: 10px;  font-size: 0.65rem; border:1px solid #cbd5e1; border-radius:4px;" onchange="updateChoice(${i}, 'reqLogic', this.value)">
                    <option value="AND" ${c.reqLogic !== 'OR' ? 'selected' : ''}>ALL (AND)</option>
                    <option value="OR" ${c.reqLogic === 'OR' ? 'selected' : ''}>ANY (OR)</option>
                </select>`;
        }
        


        let reqsHTML = '';
        let branchHTML = `
        <div class="sub-panel" style="background:#f8fafc; padding:10px; border-radius:6px; border:1px dashed #cbd5e1; margin-top:10px; grid-column: span 2;">
            <label style="font-size:0.8rem; font-weight:bold; color:#475569; display:flex; align-items:center; margin-bottom:5px;">Path Destinations & Conditions</label>
            <div class="cyoa-hint">Where this choice leads. Add a condition to lock it, or add a conditional path to send players to different blocks based on their stats or items.</div>

            <div class="effect-row" style="display:flex; flex-direction:column; gap:5px; margin-top:5px; background:#fff; padding:8px; border:1px solid #e2e8f0; border-radius:4px;">
                <div style="display:flex; align-items:center; gap:5px;">
                    <span style="font-size:0.75rem; font-weight:bold; color:#64748b; min-width:85px;">Default Path:</span>
                    <span style="font-size:0.7rem; color:#475569; margin-left:auto;">${(c.reqs && c.reqs.length > 1) ? `Logic: <select style="border:none; background:transparent; font-weight:bold; color:#475569; font-size:0.75rem; cursor:pointer;" onchange="updateChoice(${i}, 'reqLogic', this.value)"><option value="AND" ${c.reqLogic==='AND'?'selected':''}>AND</option><option value="OR" ${c.reqLogic==='OR'?'selected':''}>OR</option></select>` : ''}</span>
                    <button class="btn-s" style="width:auto; margin:0; padding:2px 6px; font-size:0.7rem;" onclick="addReq(${i})">+ Add Condition</button>
                </div>`;

        let defaultReqsHTML = '';
        (c.reqs || []).forEach((r, rIdx) => {
            let t = story.globalVars[r.var]?.type;
            let ops = '', vals = '';
            if(t === 'flag') {
                ops = `<select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:2px;" onchange="updateReq(${i}, ${rIdx}, 'val', parseInt(this.value))"><option value="1" ${r.val===1?'selected':''}>Is On</option><option value="0" ${r.val===0?'selected':''}>Is Off</option></select>`;
            } else if(t === 'char' || t === 'npc') {
                ops = `<select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:2px;" onchange="updateReq(${i}, ${rIdx}, 'op', this.value)"><option value="==" ${r.op==='=='?'selected':''}>Is</option><option value="!=" ${r.op==='!='?'selected':''}>Is Not</option></select>`;
                vals = `<input type="text" style="flex:1; width:50px; border:1px solid #ddd; border-radius:4px; padding:2px;" value="${r.val}" onchange="updateReq(${i}, ${rIdx}, 'val', this.value)">`;
            } else {
                ops = `<select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:2px;" onchange="updateReq(${i}, ${rIdx}, 'op', this.value)">
                    <option value="has" ${r.op==='has'?'selected':''}>Has</option>
                    <option value=">=" ${r.op==='>='?'selected':''}>&ge;</option>
                    <option value="<=" ${r.op==='<='?'selected':''}>&le;</option>
                    <option value="==" ${r.op==='=='?'selected':''}>==</option>
                    <option value="!=" ${r.op==='!='?'selected':''}>&ne;</option>
                    <option value=">" ${r.op==='>'?'selected':''}>&gt;</option>
                    <option value="<" ${r.op==='<'?'selected':''}>&lt;</option>
                </select>`;
                if(r.op !== 'has') vals = `<input type="number" style="flex:1; width:50px; border:1px solid #ddd; border-radius:4px; padding:2px;" value="${r.val}" onchange="updateReq(${i}, ${rIdx}, 'val', parseInt(this.value))">`;
            }
            defaultReqsHTML += `<div style="display:flex; gap:5px; margin-top:4px; align-items:center; background:#f8fafc; padding:4px; border:1px solid #e2e8f0; border-radius:4px;">
                <span style="font-size:0.7rem; color:#475569;">Req:</span>
                <select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:2px;" onchange="updateReq(${i}, ${rIdx}, 'var', this.value)"><option value="">- Var -</option>${Object.keys(story.globalVars).map(v => `<option value="${v}" ${r.var === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
                ${r.var ? ops : ''}
                ${r.var && vals ? vals : ''}
                <button class="btn-d" style="width:auto; margin:0; padding:2px 6px;" onclick="removeReq(${i}, ${rIdx})">✕</button>
            </div>`;
        });
        branchHTML += defaultReqsHTML;

        branchHTML += `
                <div style="display:flex; align-items:center; gap:5px; margin-top:4px;">
                    <span style="font-size:0.75rem; font-weight:bold; color:#64748b;">Go to:</span>
                    <select style="flex:1.5; border:1px solid #ddd; border-radius:4px; padding:4px;" onchange="updateChoice(${i}, 'next', this.value)">
                        <option value="">Stay here...</option>
                        ${story.blocks.map(bl => `<option value="${bl.id}" ${bl.id === c.next ? 'selected' : ''}>→ ${bl.id}</option>`).join('')}
                    </select>
                    <select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:4px;" onchange="updateChoice(${i}, 'persistFlag', this.value)">
                        <option value="">Set Flag: None</option>
                        ${Object.keys(story.globalVars).map(v => `<option value="${v}" ${c.persistFlag === v ? 'selected' : ''}>${v}</option>`).join('')}
                    </select>
                    <select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:4px;" onchange="updateChoice(${i}, 'promptChar', this.value)">
                        <option value="">Rename: None</option>
                        ${Object.keys(story.globalVars).filter(k => story.globalVars[k].type === 'char' || story.globalVars[k].type === 'npc').map(v => `<option value="${v}" ${c.promptChar === v ? 'selected' : ''}>${v}</option>`).join('')}
                    </select>
                </div>
            </div>`;

        (c.conditionalNext || []).forEach((rule, rIdx) => {
            let pathReqsHTML = '';
            (rule.reqs || []).forEach((r, reqIdx) => {
                let t = story.globalVars[r.var]?.type;
                let ops = '', vals = '';
                if(t === 'flag') {
                    ops = `<select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:2px;" onchange="window.updateBranchReq(${i}, ${rIdx}, ${reqIdx}, 'val', parseInt(this.value))"><option value="1" ${r.val===1?'selected':''}>Is On</option><option value="0" ${r.val===0?'selected':''}>Is Off</option></select>`;
                } else if(t === 'char' || t === 'npc') {
                    ops = `<select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:2px;" onchange="window.updateBranchReq(${i}, ${rIdx}, ${reqIdx}, 'op', this.value)"><option value="==" ${r.op==='=='?'selected':''}>Is</option><option value="!=" ${r.op==='!='?'selected':''}>Is Not</option></select>`;
                    vals = `<input type="text" style="flex:1; width:50px; border:1px solid #ddd; border-radius:4px; padding:2px;" value="${r.val}" onchange="window.updateBranchReq(${i}, ${rIdx}, ${reqIdx}, 'val', this.value)">`;
                } else {
                    ops = `<select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:2px;" onchange="window.updateBranchReq(${i}, ${rIdx}, ${reqIdx}, 'op', this.value)">
                        <option value="has" ${r.op==='has'?'selected':''}>Has</option>
                        <option value=">=" ${r.op==='>='?'selected':''}>&ge;</option>
                        <option value="<=" ${r.op==='<='?'selected':''}>&le;</option>
                        <option value="==" ${r.op==='=='?'selected':''}>==</option>
                        <option value="!=" ${r.op==='!='?'selected':''}>&ne;</option>
                        <option value=">" ${r.op==='>'?'selected':''}>&gt;</option>
                        <option value="<" ${r.op==='<'?'selected':''}>&lt;</option>
                    </select>`;
                    if(r.op !== 'has') vals = `<input type="number" style="flex:1; width:50px; border:1px solid #ddd; border-radius:4px; padding:2px;" value="${r.val}" onchange="window.updateBranchReq(${i}, ${rIdx}, ${reqIdx}, 'val', parseInt(this.value))">`;
                }
                pathReqsHTML += `<div style="display:flex; gap:5px; margin-top:4px; align-items:center; background:#f8fafc; padding:4px; border:1px solid #e2e8f0; border-radius:4px;">
                    <span style="font-size:0.7rem; color:#475569;">Req:</span>
                    <select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:2px;" onchange="window.updateBranchReq(${i}, ${rIdx}, ${reqIdx}, 'var', this.value)"><option value="">- Var -</option>${Object.keys(story.globalVars).map(v => `<option value="${v}" ${r.var === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
                    ${r.var ? ops : ''}
                    ${r.var && vals ? vals : ''}
                    <button class="btn-d" style="width:auto; margin:0; padding:2px 6px;" onclick="window.removeBranchReq(${i}, ${rIdx}, ${reqIdx})">✕</button>
                </div>`;
            });

            let ruleLogicSelect = (rule.reqs && rule.reqs.length > 1) ? `Logic: <select style="border:none; background:transparent; font-weight:bold; color:#475569; font-size:0.75rem; cursor:pointer;" onchange="window.updateChoiceBranch(${i}, ${rIdx}, 'reqLogic', this.value)"><option value="AND" ${rule.reqLogic==='AND'?'selected':''}>AND</option><option value="OR" ${rule.reqLogic==='OR'?'selected':''}>OR</option></select>` : '';

            branchHTML += `
            <div class="effect-row" style="display:flex; flex-direction:column; gap:5px; margin-top:8px; background:#fff; padding:8px; border:1px dashed #cbd5e1; border-radius:4px;">
                <div style="display:flex; align-items:center; gap:5px;">
                    <span style="font-size:0.75rem; font-weight:bold; color:#f59e0b; min-width:85px;">If / Else If:</span>
                    <span style="font-size:0.7rem; color:#475569; margin-left:auto;">${ruleLogicSelect}</span>
                    <button class="btn-s" style="width:auto; margin:0; padding:2px 6px; font-size:0.7rem;" onclick="window.addBranchReq(${i}, ${rIdx})">+ Add Condition</button>
                </div>
                ${pathReqsHTML}
                <div style="display:flex; align-items:center; gap:5px; margin-top:4px;">
                    <span style="font-size:0.75rem; font-weight:bold; color:#64748b;">Go to:</span>
                    <select style="flex:1.5; border:1px solid #ddd; border-radius:4px; padding:4px;" onchange="window.updateChoiceBranch(${i}, ${rIdx}, 'next', this.value)">
                        <option value="">- Block -</option>
                        ${story.blocks.map(b2 => `<option value="${b2.id}" ${rule.next === b2.id ? 'selected' : ''}>→ ${b2.id}</option>`).join('')}
                    </select>
                    <select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:4px;" onchange="window.updateChoiceBranch(${i}, ${rIdx}, 'persistFlag', this.value)">
                        <option value="">Set Flag: None</option>
                        ${Object.keys(story.globalVars).map(v => `<option value="${v}" ${(rule.persistFlag || '') === v ? 'selected' : ''}>${v}</option>`).join('')}
                    </select>
                    <select style="flex:1; border:1px solid #ddd; border-radius:4px; padding:4px;" onchange="window.updateChoiceBranch(${i}, ${rIdx}, 'promptChar', this.value)">
                        <option value="">Rename: None</option>
                        ${Object.keys(story.globalVars).filter(k => story.globalVars[k].type === 'char' || story.globalVars[k].type === 'npc').map(v => `<option value="${v}" ${(rule.promptChar || '') === v ? 'selected' : ''}>${v}</option>`).join('')}
                    </select>
                    <button class="btn-d" style="width:auto; margin:0; padding:4px 8px;" onclick="window.removeChoiceBranch(${i}, ${rIdx})">🗑 Path</button>
                </div>
            </div>`;
        });

        branchHTML += `<button class="btn-s" style="margin-top:8px; font-size:0.8rem; width:100%;" onclick="window.addChoiceBranch(${i})">+ Add Conditional Path</button></div>`;

        return `<div class="card" style="border: 1px solid #ddd; background:#fafafa; margin-top:10px;">
    <div style="display:flex; justify-content:flex-end; gap:6px; margin-bottom:6px;">
        <button class="btn-s" title="Move this choice up" onclick="moveChoice(${i}, -1)" style="padding:2px 9px;">▲</button>
        <button class="btn-s" title="Move this choice down" onclick="moveChoice(${i}, 1)" style="padding:2px 9px;">▼</button>
        <button class="btn-s" title="Duplicate this choice" onclick="duplicateChoice(${i})" style="padding:2px 9px;">⧉ Duplicate</button>
    </div>
    <input value="${c.txt}" oninput="updateChoice(${i}, 'txt', this.value)" placeholder="Choice Text" style="width:100%; margin-bottom:10px; font-weight:bold;">
    <div class="choice-grid">
        ${effectsHTML}
        ${reqsHTML}
        ${branchHTML}

        <details class="adv-choice">
        <summary>Advanced options</summary>
        <div class="cyoa-hint">Optional extras — skip these for a simple choice.</div>

        <div style="margin-top:8px;"><label style="font-size:0.8rem; font-weight:bold;">Max Uses</label>
        <div class="cyoa-hint">How many times this choice can be picked. 0 = unlimited; set 1 for one-time actions like taking an item.</div>
        <div style="display:flex; gap:15px; align-items:center; flex-wrap:wrap;">
            <input type="number" title="How many times this choice can be clicked. 0 means unlimited." style="max-width:80px;" value="${c.maxUses || 0}" onchange="updateChoice(${i}, 'maxUses', parseInt(this.value))">
            <label class="checkbox-line" title="Show the remaining uses on the button, e.g. (2 left)">Show Count <input type="checkbox" ${c.showUsage !== false ? 'checked' : ''} onchange="updateChoice(${i}, 'showUsage', this.checked)"></label>
            <label class="checkbox-line" style="align-items:center;" title="What happens to this choice when its requirements aren't met">When locked:
                <select style="margin-left:6px; width:auto; padding:4px 26px 4px 8px;" onchange="setLockedMode(${i}, this.value)">
                    <option value="show" ${(c.lockedMode||(c.hideLocked?'hide':'show'))==='show'?'selected':''}>Show (let player try)</option>
                    <option value="lock" ${(c.lockedMode||(c.hideLocked?'hide':'show'))==='lock'?'selected':''}>Show locked (greyed)</option>
                    <option value="hide" ${(c.lockedMode||(c.hideLocked?'hide':'show'))==='hide'?'selected':''}>Hide completely</option>
                </select>
            </label>
        </div>
        <div class="cyoa-hint"><b>Show</b>: looks normal, reveals the locked message when clicked. <b>Show locked</b>: greyed out but still shows the message. <b>Hide</b>: invisible until unlocked.</div>
        </div>

        ${story.useDayCycle ? `<div style="display:flex; flex-direction:column; gap:4px; margin-top:8px; padding:5px; background:#f1f5f9; border-radius:4px;"><label style="font-size:0.8rem; font-weight:bold; color:#334155;">Time Progression</label><div class="cyoa-hint">Advances the clock when this choice is taken. Phases: 1 Early morning, 2 Morning, 3 Noon, 4 Afternoon, 5 Evening, 6 Night.</div><div style="display:flex; gap:10px; align-items:center;"><label title="Time Phases: 1=Early Morning, 2=Morning, 3=Noon, 4=Afternoon, 5=Evening, 6=Night" style="font-size:0.8rem; cursor:help;">Add Time Phases: <input type="number" title="Time Phases: 1=Early Morning, 2=Morning, 3=Noon, 4=Afternoon, 5=Evening, 6=Night" style="min-width:60px; max-width:100px; padding:4px;" value="${c.timeAdd !== undefined ? c.timeAdd : (c.passTime===false?0:1)}" onchange="updateChoice(${i}, 'timeAdd', parseInt(this.value))"></label><label style="font-size:0.8rem; display:flex; align-items:center; gap:6px;" title="Skip straight to the next morning">Force Next Day <input type="checkbox" ${c.forceNextDay ? 'checked' : ''} onchange="updateChoice(${i}, 'forceNextDay', this.checked)"></label></div></div>` : ''}

        <div class="sub-panel" style="margin-top:8px;"><label style="font-size:0.8rem; color:#64748b; font-weight:bold;">Custom Locked Message</label><div class="cyoa-hint">Shown if a player clicks this choice without meeting its requirements.</div><input title="Message shown when a locked choice is clicked" style="width:100%; font-size:0.85rem;" placeholder="Default: Locked!" value="${c.lockedMsg || ''}" oninput="updateChoice(${i}, 'lockedMsg', this.value)"></div>
        </details>
    </div>

    <button class="btn-d" onclick="removeChoice(${i})" style="margin-top:10px; width:100%;">Remove Choice</button>
</div>`;
    }).join('');
};


window.calcRPGStats = function() {
    let res = {};
    Object.keys(pState.vars).forEach(st => {
        if (pState.vars[st].type === 'stat') {
            let base = pState.vars[st].val;
            let wName = (pState.equipped && pState.equipped.weapon && pState.vars[pState.equipped.weapon] && pState.vars[pState.equipped.weapon].val > 0) ? pState.equipped.weapon : null;
            let aName = (pState.equipped && pState.equipped.armor && pState.vars[pState.equipped.armor] && pState.vars[pState.equipped.armor].val > 0) ? pState.equipped.armor : null;
            let w = (wName && story.rpgItems && story.rpgItems[wName]) ? story.rpgItems[wName] : null;
            let a = (aName && story.rpgItems && story.rpgItems[aName]) ? story.rpgItems[aName] : null;

            let wMod = (w && w.stats && w.stats[st]) ? w.stats[st] : 0;
            let aMod = (a && a.stats && a.stats[st]) ? a.stats[st] : 0;

            let passiveMod = 0;
            for (let pk in pState.vars) {
                if (pState.vars[pk].type === 'flag' && pState.vars[pk].val > 0) {
                    let pm = story.rpgItems && story.rpgItems[pk];
                    if (pm && pm.stats && pm.stats[st]) passiveMod += pm.stats[st];
                }
            }

            res[st] = base + wMod + aMod + passiveMod;
        }
    });
    return res;
};

window.openInventoryModal = function() {
    if (!document.getElementById('rpg-inv-modal')) {
        const m = document.createElement('div');
        m.id = 'rpg-inv-modal';
        m.style.cssText = "display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:9999; justify-content:center; align-items:center;";
        m.innerHTML = `<div style="background:white; padding:20px; border-radius:8px; width:90%; max-width:400px; max-height:80vh; overflow-y:auto; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
            <h3 style="margin-top:0; color:#1e293b;">🎒 Inventory & Stats</h3>
            <div id="rpg-stats-display" style="background:#f1f5f9; padding:10px; margin-bottom:15px; border-radius:6px; font-weight:bold; font-size:0.8rem; border:1px solid #cbd5e1;"></div>
            <div id="rpg-equip-display" style="margin-bottom:10px; background:#e0e7ff; padding:10px; border-radius:6px; border:1px solid #c7d2fe;"></div>
            <div id="rpg-passives-display" style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom:15px;"></div>
            <h4 style="margin-bottom:5px; color:#1e293b;">Your Items</h4>
            <div id="rpg-items-list" style="display:flex; flex-direction:column; gap:5px;"></div>
            <button class="btn-d" onclick="document.getElementById('rpg-inv-modal').style.display='none'; renderStep();" style="width:100%; margin-top:15px; background:#475569;">Close</button>
        </div>`;
        document.body.appendChild(m);
    }

    if(!pState.equipped) pState.equipped = {weapon: null, armor: null};

    let st = window.calcRPGStats();
    let statKeys = Object.keys(st);
    let statsHtml = statKeys.map(s => {
        if (s.startsWith('Max')) return ''; // Hide Max vars from independent listing
        let val = st[s] || 0;
        let maxVar = 'Max' + s;
        if (statKeys.includes(maxVar)) {
            return `<div style="flex:1; min-width:30%; margin-bottom:5px; color:#0f172a;">${s}: <span style="color:#ef4444;">${val}/${st[maxVar]||0}</span></div>`;
        } else {
            return `<div style="flex:1; min-width:30%; margin-bottom:5px; color:#0f172a;">${s}: <span style="color:#0369a1;">${val}</span></div>`;
        }
    }).join('');
    document.getElementById('rpg-stats-display').innerHTML = `<div style="display:flex; flex-wrap:wrap;">${statsHtml || 'No stats configured.'}</div>`;

    let w = pState.equipped.weapon || "None";
    let a = pState.equipped.armor || "None";
    document.getElementById('rpg-equip-display').innerHTML = `
        <div style="font-size:0.85rem; margin-bottom:6px; display:flex; justify-content:space-between;"><strong>Weapon:</strong> <span>${w} ${w!=='None'?`<button style="font-size:0.8rem; padding:2px 4px; cursor:pointer; background:#ef4444; color:white; border:none; border-radius:3px;" onclick="unequipItem('weapon')">Unequip</button>`:''}</span></div>
        <div style="font-size:0.85rem; display:flex; justify-content:space-between;"><strong>Armor:</strong> <span>${a} ${a!=='None'?`<button style="font-size:0.8rem; padding:2px 4px; cursor:pointer; background:#ef4444; color:white; border:none; border-radius:3px;" onclick="unequipItem('armor')">Unequip</button>`:''}</span></div>
    `;

    
    let passivesHtml = '';
    for (let k in pState.vars) {
        if (pState.vars[k].type === 'flag' && pState.vars[k].val > 0 && story.rpgItems && story.rpgItems[k]) {
            let itm = story.rpgItems[k];
            let statsText = [];
            if (itm.stats) {
                for (let s in itm.stats) {
                    if (itm.stats[s] !== 0) statsText.push(`${itm.stats[s]>0?'+':''}${itm.stats[s]} ${s}`);
                }
            }
            if (statsText.length > 0) {
                passivesHtml += `<span style="background:#fef3c7; color:#b45309;  border-radius:4px; font-size:0.8rem; border:1px solid #fde68a; font-weight:bold; box-shadow:0 1px 2px rgba(0,0,0,0.05);">⚡ ${k} (${statsText.join(', ')})</span>`;
            }
        }
    }
    document.getElementById('rpg-passives-display').innerHTML = passivesHtml;

    let itemsHtml = '';
    for (let k in pState.vars) {
        if (pState.vars[k].type === 'item' && pState.vars[k].val > 0 && story.rpgItems && story.rpgItems[k]) {
            let itm = story.rpgItems[k];
            let count = pState.vars[k].val;
            let actionBtn = '';
            if (itm.type === 'weapon' || itm.type === 'armor') {
                let isEq = (pState.equipped.weapon === k || pState.equipped.armor === k);
                if (!isEq) {
                    actionBtn = `<button style="padding:4px 10px; font-size:0.8rem; background:#3b82f6; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="equipItem('${k}', '${itm.type}')">Equip</button>`;
                } else {
                    actionBtn = `<span style="font-size:0.8rem; color:#10b981; font-weight:bold;">Equipped</span>`;
                }
            } else if (itm.type === 'consumable') {
                actionBtn = `<button style="padding:4px 10px; font-size:0.8rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="useRPGItem('${k}')">Use</button>`;
            }

            let statsText = [];
            if (itm.stats) {
                for (let s in itm.stats) {
                    if (itm.stats[s] !== 0) {
                        statsText.push(`${itm.stats[s]>0?'+':''}${itm.stats[s]} ${s}`);
                    }
                }
            }

            itemsHtml += `<div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:8px; border-radius:4px; border:1px solid #cbd5e1;">
                <div>
                    <div style="font-weight:bold; font-size:0.8rem;">${k} <span style="font-size:0.8rem; color:#64748b; font-weight:normal;">x${count}</span></div>
                    <div style="font-size:0.8rem; color:#475569;">${statsText.join(' | ')}</div>
                </div>
                ${actionBtn}
            </div>`;
        }
    }
    document.getElementById('rpg-items-list').innerHTML = itemsHtml || '<div style="font-size:0.8rem; color:#64748b; padding:10px; text-align:center;">No RPG items in inventory.</div>';

    document.getElementById('rpg-inv-modal').style.display = 'flex';
};

window.equipItem = function(itemName, type) {
    pState.equipped[type] = itemName;
    window.renderInventory();
};
window.unequipItem = function(type) {
    pState.equipped[type] = null;
    window.renderInventory();
};

window.renderStep = function() {
    if (window.clearMsg) window.clearMsg();
    // Guard against event chains that jump between blocks forever.
    window._stepGuard = (window._stepGuard || 0) + 1;
    if (window._stepGuard < 100 && window.checkStatEvents()) {
        window.renderStep();
        window._stepGuard = 0;
        return;
    }
    if (window._stepGuard >= 100) {
        window.showToast('Event loop detected — stopping to avoid a freeze. Check your stat/daily events.', 'bad');
    }
    window._stepGuard = 0;

    const b = story.blocks.find(bl => bl.id === pState.bId);
    if (!b) return;

    let combinedText = b.text;
    if (b.extraTexts) {
        b.extraTexts.forEach(extra => {
            if (extra.reqs && extra.reqs.length > 0) {
                if (window.evaluateReqLogic(extra.reqs, extra.reqLogic, pState.vars)) combinedText += "\n\n" + extra.text;
            } else if (extra.var) {
                const cur = pState.vars[extra.var]?.val || 0;
                if (window.checkLogic(cur, extra.reqMin, extra.reqMax)) combinedText += "\n\n" + extra.text;
            } else { combinedText += "\n\n" + extra.text; }
        });
    }

    for (let k in pState.vars) {
        const v = pState.vars[k];
        combinedText = combinedText.replace(new RegExp('{' + window.escapeRegExp(k) + '}', 'g'), v.val);
    }

    document.getElementById('p-title').innerText = story.title;
    document.getElementById('p-text').innerHTML = window.parseMarkdown(combinedText);
    
    window.renderInventory();

    const choiceContainer = document.getElementById('p-choices');
    choiceContainer.innerHTML = '';
    
    b.choices.forEach(c => {
        const times = pState.usage[c.id] || 0;
        if (c.maxUses > 0 && times >= c.maxUses) return;

        let met = false;

        // 1. Evaluate Default Path requirements
        if (!c.reqs || c.reqs.length === 0) {
            met = true;
        } else {
            if (window.evaluateReqLogic(c.reqs, c.reqLogic || 'AND', pState.vars)) met = true;
        }

        // 2. Evaluate Conditional Paths requirements
        if (c.conditionalNext && c.conditionalNext.length > 0) {
            for (let rule of c.conditionalNext) {
                if (rule.reqs && rule.reqs.length > 0) {
                    if (window.evaluateReqLogic(rule.reqs, rule.reqLogic || 'AND', pState.vars)) {
                        met = true;
                        break;
                    }
                } else if (rule.var) {
                    function _localComp(left, op, right) {
                        const lNum = Number(left); const rNum = Number(right);
                        const bN = !Number.isNaN(lNum) && !Number.isNaN(rNum);
                        const a = bN ? lNum : String(left ?? ''); const b = bN ? rNum : String(right ?? '');
                        switch(op) { case '==':return a==b; case '!=':return a!=b; case '>':return a>b; case '<':return a<b; case '>=':return a>=b; case '<=':return a<=b; default:return false; }
                    }
                    const vObj = pState.vars[rule.var];
                    const curVal = (vObj && typeof vObj === 'object' && 'val' in vObj) ? vObj.val : vObj;
                    if (_localComp(curVal, rule.op, rule.val)) {
                        met = true;
                        break;
                    }
                }
                // An empty conditional path (no conditions) does NOT enable the choice on
                // its own — this matches the click handler, which ignores empty branches.
            }
        }

        // Backward compat for reqVar
        if (!met && c.reqVar && (!c.reqs || c.reqs.length === 0)) {
            const cur = pState.vars[c.reqVar]?.val || 0;
            met = window.checkLogic(cur, c.reqMin, c.reqMax);
        }

        const isAlreadyPersistent = c.persistFlag && pState.vars[c.persistFlag]?.val === 1;
        if (isAlreadyPersistent) met = true;

        const lockMode = c.lockedMode || (c.hideLocked ? 'hide' : 'show');
        if (!met && lockMode === 'hide') return;

        const btn = document.createElement('button');
        btn.className = 'choice-btn' + (!met && lockMode === 'lock' ? ' locked' : '');

        let label = c.txt; for(let k in pState.vars) { label = label.replace(new RegExp('{' + window.escapeRegExp(k) + '}', 'g'), pState.vars[k].val); }
        if (c.maxUses > 0 && c.showUsage !== false) label += ` (${c.maxUses - times} left)`;
        btn.innerText = label;

        btn.onclick = () => {
            if (!met) return window.msg(c.lockedMsg || "Locked!", true);
            window.pushHistory();

            function getVarValue(varName) {
                const v = pState.vars?.[varName];
                if (v && typeof v === 'object' && 'val' in v) return v.val;
                return v;
            }

            function compareValues(left, op, right) {
                const lNum = Number(left);
                const rNum = Number(right);
                const bothNumeric = !Number.isNaN(lNum) && !Number.isNaN(rNum);
                const a = bothNumeric ? lNum : String(left ?? '');
                const b = bothNumeric ? rNum : String(right ?? '');

                switch (op) {
                    case '==': return a == b;
                    case '!=': return a != b;
                    case '>': return a > b;
                    case '<': return a < b;
                    case '>=': return a >= b;
                    case '<=': return a <= b;
                    default: return false;
                }
            }

            let nextBlockId = c.next;
            let activePromptChar = c.promptChar;
            let activePersistFlag = c.persistFlag;

            // Check if the default path conditions are met.
            // If they are, use the default destination and skip conditionals.
            // If they aren't, walk the conditional paths in order — first match wins.
            const defaultReqsMet = (!c.reqs || c.reqs.length === 0)
                ? true
                : window.evaluateReqLogic(c.reqs, c.reqLogic || 'AND', pState.vars);

            if (!defaultReqsMet) {
                for (const rule of (c.conditionalNext || [])) {
                    let branchMet = false;
                    if (rule.reqs && rule.reqs.length > 0) {
                        branchMet = window.evaluateReqLogic(rule.reqs, rule.reqLogic || 'AND', pState.vars);
                    } else if (rule.var) {
                        const currentValue = getVarValue(rule.var);
                        branchMet = compareValues(currentValue, rule.op, rule.val);
                    } else {
                        branchMet = false;
                    }

                    if (branchMet && rule.next) {
                        nextBlockId = rule.next;
                        if (rule.persistFlag !== undefined && rule.persistFlag !== '') activePersistFlag = rule.persistFlag;
                        if (rule.promptChar !== undefined && rule.promptChar !== '') activePromptChar = rule.promptChar;
                        break;
                    }
                }
            }

            if (activePromptChar && pState.vars[activePromptChar]) { 
                const n = prompt(`Name:`, pState.vars[activePromptChar].val); 
                if (n) pState.vars[activePromptChar].val = n.trim(); 
            }

            let wasPersistent = !!(activePersistFlag && pState.vars[activePersistFlag] && pState.vars[activePersistFlag].val === 1);

            // Effects always fire regardless of persistFlag state.
            // wasPersistent only gates the persistFlag-setting logic below.
            if (c.effects) {
                c.effects.forEach(eff => {
                    if (eff.var && pState.vars[eff.var]) {
                        const before = pState.vars[eff.var].val || 0;
                        if (eff.type === 'take') {
                            const after = Math.max(0, before - (eff.amt || 0));
                            pState.vars[eff.var].val = after;
                            if (after !== before) window.showToast(`- ${before - after} ${eff.var}`, 'bad');
                        } else if (eff.type === 'give') {
                            const after = before + (eff.amt || 0);
                            pState.vars[eff.var].val = after;
                            if (after !== before) window.showToast(`+ ${eff.amt || 0} ${eff.var}`, 'good');
                        }
                    }
                });
            }

            if (!wasPersistent && activePersistFlag && pState.vars[activePersistFlag]) {
                pState.vars[activePersistFlag].val = 1;
            }

            if (story.useDayCycle && pState.vars['TimeOfDay']) {
                let timeAdd = c.timeAdd !== undefined ? c.timeAdd : (c.passTime === false ? 0 : 1);
                if (timeAdd > 0) window.tickCooldowns(timeAdd);
                let forceNextDay = !!c.forceNextDay;

                if (!pState.vars['Day']) {
                    pState.vars['Day'] = { type: 'stat', val: 1, stats: null };
                }

                let oldDay = pState.vars['Day'].val;

                if (forceNextDay) {
                    pState.vars['TimeOfDay'].val = 1;
                    pState.vars['Day'].val += 1;
                } else if (timeAdd > 0) {
                    pState.vars['TimeOfDay'].val += timeAdd;
                    while (pState.vars['TimeOfDay'].val > 6) {
                        pState.vars['TimeOfDay'].val -= 6;
                        pState.vars['Day'].val += 1;
                    }
                }

                window._forcedBlock = null;
                if (pState.vars['Day'].val > oldDay) {
                    let currentDay = pState.vars['Day'].val;
                    for (let d = oldDay + 1; d <= currentDay; d++) {
                        (story.dailyEvents || []).forEach(ev => {
                            if (ev.day === d) {
                                if (ev.type === 'block' && ev.blockName) {
                                    window._forcedBlock = ev.blockName;
                                } else if ((!ev.type || ev.type === 'var') && ev.varName && pState.vars[ev.varName]) {
                                    pState.vars[ev.varName].val = ev.val;
                                }
                            }
                        });
                    }
                }
            }

            pState.usage[c.id] = (pState.usage[c.id] || 0) + 1;

            if (nextBlockId) pState.bId = nextBlockId;

            if (window._forcedBlock) {
                pState.bId = window._forcedBlock;
                window._forcedBlock = null;
            }
            window.renderStep();
        };
        choiceContainer.appendChild(btn);
    });

    // Ending / dead-end handling + Back button state
    if (!choiceContainer.children.length) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top:24px; text-align:center;';
        if (!b.choices || b.choices.length === 0) {
            wrap.innerHTML = '<div style="font-size:1.15rem; font-weight:bold; color:#475569; letter-spacing:1px; margin-bottom:14px;">— THE END —</div>';
            const rb = document.createElement('button');
            rb.className = 'btn-p'; rb.innerText = '⟳ Play Again'; rb.onclick = window.playRestart;
            wrap.appendChild(rb);
        } else {
            wrap.innerHTML = '<div style="font-size:0.95rem; color:#94a3b8; font-style:italic; margin-bottom:12px;">No available options right now.</div>';
            const bb = document.createElement('button');
            bb.className = 'btn-s'; bb.innerText = '↩ Go Back'; bb.onclick = window.playBack;
            if (pState.history && pState.history.length) wrap.appendChild(bb);
        }
        choiceContainer.appendChild(wrap);
    }

    const backBtn = document.getElementById('btn-play-back');
    if (backBtn) {
        const has = pState.history && pState.history.length > 0;
        backBtn.disabled = !has;
        backBtn.style.opacity = has ? '1' : '0.45';
        backBtn.style.cursor = has ? 'pointer' : 'not-allowed';
    }
};

window.addExtraTextField = function() {
    if (!story.blocks[bIdx].extraTexts) story.blocks[bIdx].extraTexts = [];
    story.blocks[bIdx].extraTexts.push({ reqs: [], reqLogic: 'AND', text: '' });
    window.renderEditor();
};
window.updateExtraText = function(i, field, val) { story.blocks[bIdx].extraTexts[i][field] = val; };
window.removeExtraText = function(i) { story.blocks[bIdx].extraTexts.splice(i, 1); window.renderEditor(); };


window.addChoiceEffect = function(cIdx) {
    if (!story.blocks[bIdx].choices[cIdx].effects) story.blocks[bIdx].choices[cIdx].effects = [];
    story.blocks[bIdx].choices[cIdx].effects.push({ type: 'give', var: '', amt: 1 });
    window.renderChoices();
};
window.updateChoiceEffect = function(cIdx, eIdx, field, val) {
    story.blocks[bIdx].choices[cIdx].effects[eIdx][field] = val;
    if (field !== 'amt') window.renderChoices();
};
window.removeChoiceEffect = function(cIdx, eIdx) {
    story.blocks[bIdx].choices[cIdx].effects.splice(eIdx, 1);
    window.renderChoices();
};
window.addChoice = function() {
    story.blocks[bIdx].choices.push({ id: Date.now().toString(), txt: 'New Choice', next: '', conditionalNext: [], effects: [], reqs: [], hideLocked: false, maxUses: 0, showUsage: true, persistFlag: '', promptChar: '', lockedMsg: '', timeAdd: 1, forceNextDay: false });
    window.renderChoices();
};

window.addChoiceBranch = function(cIdx) {
    if (!story.blocks[bIdx].choices[cIdx].conditionalNext) story.blocks[bIdx].choices[cIdx].conditionalNext = [];
    story.blocks[bIdx].choices[cIdx].conditionalNext.push({ reqLogic: 'AND', reqs: [], next: '', persistFlag: '', promptChar: '' });
    window.renderChoices();
};
window.updateChoiceBranch = function(cIdx, rIdx, field, value) {
    story.blocks[bIdx].choices[cIdx].conditionalNext[rIdx][field] = value;
};
window.removeChoiceBranch = function(cIdx, rIdx) {
    story.blocks[bIdx].choices[cIdx].conditionalNext.splice(rIdx, 1);
    window.renderChoices();
};
window.addBranchReq = function(cIdx, rIdx) {
    if (!story.blocks[bIdx].choices[cIdx].conditionalNext[rIdx].reqs) story.blocks[bIdx].choices[cIdx].conditionalNext[rIdx].reqs = [];
    story.blocks[bIdx].choices[cIdx].conditionalNext[rIdx].reqs.push({ var: '', op: '>=', val: 1 });
    window.renderChoices();
};
window.updateBranchReq = function(cIdx, rIdx, reqIdx, field, val) {
    story.blocks[bIdx].choices[cIdx].conditionalNext[rIdx].reqs[reqIdx][field] = val;
    window.renderChoices();
};
window.removeBranchReq = function(cIdx, rIdx, reqIdx) {
    story.blocks[bIdx].choices[cIdx].conditionalNext[rIdx].reqs.splice(reqIdx, 1);
    window.renderChoices();
};
window.updateChoice = function(idx, f, v) { story.blocks[bIdx].choices[idx][f] = v; };
window.setLockedMode = function(i, v) {
    const c = story.blocks[bIdx].choices[i];
    c.lockedMode = v;
    c.hideLocked = (v === 'hide'); // keep legacy flag in sync
    window.markDirty();
    window.renderChoices();
};
window.removeChoice = function(i) { story.blocks[bIdx].choices.splice(i, 1); window.markDirty(); window.renderChoices(); };
window.duplicateChoice = function(i) {
    const copy = JSON.parse(JSON.stringify(story.blocks[bIdx].choices[i]));
    copy.id = Date.now().toString() + Math.floor(Math.random() * 100000);
    story.blocks[bIdx].choices.splice(i + 1, 0, copy);
    window.markDirty();
    window.renderChoices();
};
window.moveChoice = function(i, dir) {
    const arr = story.blocks[bIdx].choices;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    window.markDirty();
    window.renderChoices();
};
window.duplicateBlock = function() {
    const src = story.blocks[bIdx];
    const copy = JSON.parse(JSON.stringify(src));
    let base = src.id + '_copy', name = base, n = 2;
    while (story.blocks.some(b => b.id === name)) { name = base + n; n++; }
    copy.id = name;
    (copy.choices || []).forEach(ch => { ch.id = Date.now().toString() + Math.floor(Math.random() * 100000); });
    story.blocks.splice(bIdx + 1, 0, copy);
    bIdx = bIdx + 1;
    window.markDirty();
    window.renderEditor();
    window.showToast('Block duplicated as "' + name + '"', 'good');
};

window.renderNPCSubVars = function(charKey, v) {
    let subHTML = `<div style="background:#f8fafc; border:1px dashed #cbd5e1; margin-top:10px; padding:10px; border-radius:6px;">`;
    for (let sKey in v.stats) {
        subHTML += `<div style="display:flex; gap:5px; margin-bottom:6px; align-items:center;"><input style="flex:1; font-size:0.85rem; " value="${sKey}" onchange="renameNPCStat('${charKey}', '${sKey}', this.value)"><input style="min-width:60px; max-width:100px; font-size:0.85rem; " type="number" value="${v.stats[sKey]}" onchange="story.globalVars['${charKey}'].stats['${sKey}']=parseInt(this.value)"><button onclick="deleteNPCStat('${charKey}', '${sKey}')" style="background:none; border:none; color:#94a3b8;">✕</button></div>`;
    }
    subHTML += `<button class="btn-s" style="width:100%; font-size:0.8rem;" onclick="addNPCStat('${charKey}')">+ Add Stat</button></div>`;
    return subHTML;
};

window.renderVariableHelper = function() { 
    let html = `<div style="margin-top:8px; display:flex; align-items:center; gap:10px; background:#f0f9ff; padding:8px; border-radius:6px; border:1px solid #bae6fd;">
        <label style="font-size:0.8rem; font-weight:bold; color:#0369a1;">Story Text Tools:</label>
        <button class="btn-s" style="font-size:0.8rem; padding:4px 10px; margin:0;" onclick="openVariableInsertModal()">➕ Insert Variable</button>
        <span style="font-size:0.8rem; color:#64748b; margin-left:10px;">Format: **bold**, *italic*, [color:red]text[/color]</span>
    </div>`; 
    document.getElementById('var-helper-container').innerHTML = html; 
};

window.insertVarFilter = 'stat';

window.openVariableInsertModal = function() {
    const m = document.createElement('div');
    m.id = 'var-insert-modal';
    m.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:10000; display:flex; justify-content:center; align-items:center;";

    m.innerHTML = `<div style="background:white; padding:20px; border-radius:8px; width:350px; max-height:80vh; display:flex; flex-direction:column; box-shadow:0 4px 20px rgba(0,0,0,0.5);">
        <h3 style="margin-top:0; color:#1e293b;">Insert Variable</h3>
        <p style="font-size:0.85rem; color:#475569; margin-top:0; margin-bottom:10px;">Select a variable to inject it dynamically into your story text.</p>

        <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:10px; background:#f1f5f9; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
            <div style="display:flex; gap:10px; align-items:center;">
                <label style="font-size:0.8rem; font-weight:bold; color:#334155;">View:</label>
                <select style="flex:1;  font-size:0.8rem; border-radius:4px; border:1px solid #94a3b8;" onchange="window.insertVarFilter=this.value; window.renderInsertVarList();">
                    <option value="stat">Stats</option>
                    <option value="item">Items</option>
                    <option value="flag">Flags</option>
                    <option value="npc">NPCs</option>
                </select>
            </div>
            <input type="text" id="insert-var-search" placeholder="Search variables..." oninput="window.filterInsertVarList()" style=" font-size:0.8rem; border-radius:4px; border:1px solid #94a3b8; width:100%; box-sizing:border-box;">
        </div>

        <div id="insert-var-list" style="overflow-y:auto; flex:1; padding-right:5px; border-top:1px solid #e2e8f0; padding-top:10px;">
            <!-- Populated dynamically -->
        </div>
        <button class="btn-d" style="width:100%; margin-top:15px; background:#64748b;" onclick="document.getElementById('var-insert-modal').remove()">Cancel</button>
    </div>`;
    document.body.appendChild(m);
    window.renderInsertVarList();
};

window.renderInsertVarList = function() {
    let html = '';
    for (let k in story.globalVars) {
        const v = story.globalVars[k];
        const effType = v.type === 'char' ? 'npc' : v.type;
        if (effType !== window.insertVarFilter) continue;

        const color = window.getTypeColor(effType);
        html += `<div class="insert-var-item" data-var-name="${k.toLowerCase()}" style="padding:10px; margin-bottom:5px; background:#f8fafc; border-left:4px solid ${color}; border-radius:4px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; transition:0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'" onclick="insertVarAtCursor('{${k}}'); document.getElementById('var-insert-modal').remove();">
            <span style="font-weight:bold; font-size:0.85rem;">${k}</span>
            <span style="font-size:0.8rem; color:#64748b; text-transform:uppercase;">${effType}</span>
        </div>`;
    }
    document.getElementById('insert-var-list').innerHTML = html || '<p style="font-size:0.8rem; color:#94a3b8; text-align:center;">No variables found in this category.</p>';
    window.filterInsertVarList();
};

window.filterInsertVarList = function() {
    const input = document.getElementById('insert-var-search');
    if(!input) return;
    const term = input.value.toLowerCase();
    document.querySelectorAll('.insert-var-item').forEach(el => {
        el.style.display = el.getAttribute('data-var-name').includes(term) ? 'flex' : 'none';
    });
};

window.insertVarAtCursor = function(val) {
    const txt = document.getElementById('ed-blk-text');
    const start = txt.selectionStart;
    txt.value = txt.value.substring(0, start) + val + txt.value.substring(txt.selectionEnd);
    story.blocks[bIdx].text = txt.value;
    txt.focus();
};

window.getTypeColor = function(t) { return { item: '#f59e0b', stat: '#3b82f6', flag: '#10b981', char: '#a855f7', npc: '#a855f7' }[t] || '#ccc'; };

window.addTypedVar = function(type) {
    let n = window.sanitizeVarName(prompt("Name (letters, numbers, spaces, underscores)"));
    if (!n) return;
    if (story.globalVars[n]) { alert('A variable named "' + n + '" already exists.'); return; }
    story.globalVars[n] = { type, val: (type==='char'||type==='npc')?'Stranger':0, stats: (type==='char'||type==='npc')?{}:null };
    window.markDirty();
    window.renderEditor();
};

window.addNPCStat = function(charKey) {
    let s = window.sanitizeVarName(prompt("Stat Name"));
    if(s) { story.globalVars[charKey].stats[s] = 0; window.markDirty(); window.renderVarTable(); }
};

/* Update every reference to a variable when it is renamed. */
window.renameVarRefs = function(oldK, newK) {
    const tokenRe = new RegExp('{' + window.escapeRegExp(oldK) + '}', 'g');
    const swapText = t => (typeof t === 'string') ? t.replace(tokenRe, '{' + newK + '}') : t;

    (story.blocks || []).forEach(b => {
        b.text = swapText(b.text);
        (b.extraTexts || []).forEach(ex => {
            ex.text = swapText(ex.text);
            if (ex.var === oldK) ex.var = newK;
            (ex.reqs || []).forEach(r => { if (r.var === oldK) r.var = newK; });
        });
        (b.choices || []).forEach(c => {
            c.txt = swapText(c.txt);
            if (c.persistFlag === oldK) c.persistFlag = newK;
            if (c.promptChar === oldK) c.promptChar = newK;
            (c.effects || []).forEach(e => { if (e.var === oldK) e.var = newK; });
            (c.reqs || []).forEach(r => { if (r.var === oldK) r.var = newK; });
            (c.conditionalNext || []).forEach(rule => {
                if (rule.persistFlag === oldK) rule.persistFlag = newK;
                if (rule.promptChar === oldK) rule.promptChar = newK;
                (rule.reqs || []).forEach(r => { if (r.var === oldK) r.var = newK; });
            });
        });
    });
    (story.dailyEvents || []).forEach(ev => { if (ev.varName === oldK) ev.varName = newK; });
    (story.statEvents || []).forEach(ev => {
        if (ev.varName === oldK) ev.varName = newK;
        if (ev.reqVar === oldK) ev.reqVar = newK;
    });
    // RPG item stat-modifier keys reference stat names too
    Object.keys(story.rpgItems || {}).forEach(itemKey => {
        const st = story.rpgItems[itemKey].stats;
        if (st && st[oldK] !== undefined) { st[newK] = st[oldK]; delete st[oldK]; }
    });
    (story.rpgStats || []).forEach((s, i) => { if (s === oldK) story.rpgStats[i] = newK; });
};

/* Clear every reference to a variable when it is deleted. */
window.removeVarRefs = function(k) {
    const tokenRe = new RegExp('{' + window.escapeRegExp(k) + '}', 'g');
    const stripText = t => (typeof t === 'string') ? t.replace(tokenRe, '') : t;

    (story.blocks || []).forEach(b => {
        b.text = stripText(b.text);
        (b.extraTexts || []).forEach(ex => {
            ex.text = stripText(ex.text);
            if (ex.var === k) ex.var = '';
            if (ex.reqs) ex.reqs = ex.reqs.filter(r => r.var !== k);
        });
        (b.choices || []).forEach(c => {
            c.txt = stripText(c.txt);
            if (c.persistFlag === k) c.persistFlag = '';
            if (c.promptChar === k) c.promptChar = '';
            if (c.effects) c.effects = c.effects.filter(e => e.var !== k);
            if (c.reqs) c.reqs = c.reqs.filter(r => r.var !== k);
            (c.conditionalNext || []).forEach(rule => {
                if (rule.persistFlag === k) rule.persistFlag = '';
                if (rule.promptChar === k) rule.promptChar = '';
                if (rule.reqs) rule.reqs = rule.reqs.filter(r => r.var !== k);
            });
        });
    });
    (story.dailyEvents || []).forEach(ev => { if (ev.varName === k) ev.varName = ''; });
    (story.statEvents || []).forEach(ev => {
        if (ev.varName === k) ev.varName = '';
        if (ev.reqVar === k) ev.reqVar = '';
    });
    Object.keys(story.rpgItems || {}).forEach(itemKey => {
        const st = story.rpgItems[itemKey].stats;
        if (st && st[k] !== undefined) delete st[k];
    });
    if (story.rpgStats) story.rpgStats = story.rpgStats.filter(s => s !== k);
};

window.renameVar = function(oldK, newK) {
    newK = window.sanitizeVarName(newK);
    if (newK && newK !== oldK && story.globalVars[newK]) {
        alert('A variable named "' + newK + '" already exists.');
        window.renderEditor();
        return;
    }
    if (newK && oldK !== newK) {
        story.globalVars[newK] = story.globalVars[oldK];
        story.varConfig[newK] = story.varConfig[oldK];
        delete story.globalVars[oldK];
        delete story.varConfig[oldK];
        if (story.rpgItems && story.rpgItems[oldK]) {
            story.rpgItems[newK] = story.rpgItems[oldK];
            delete story.rpgItems[oldK];
        }
        window.renameVarRefs(oldK, newK);
        window.markDirty();
        window.renderEditor();
    }
};

window.deleteVar = function(k) {
    if(confirm(`Delete "${k}" and remove it from every choice, condition, event and text that uses it?`)) {
        delete story.globalVars[k];
        delete story.varConfig[k];
        if(story.rpgItems) delete story.rpgItems[k];
        window.removeVarRefs(k);
        window.markDirty();
        window.renderEditor();
    }
};

window.renameNPCStat = function(cK, oldS, newS) { newS = window.sanitizeVarName(newS) || oldS; story.globalVars[cK].stats[newS] = story.globalVars[cK].stats[oldS]; if (newS !== oldS) delete story.globalVars[cK].stats[oldS]; };
window.deleteNPCStat = function(cK, sK) { delete story.globalVars[cK].stats[sK]; window.renderVarTable(); };

/* List every place a variable is referenced. */
window.findVarUsage = function(k) {
    const hits = [];
    const tok = '{' + k + '}';
    (story.blocks || []).forEach(b => {
        if (typeof b.text === 'string' && b.text.includes(tok)) hits.push('Block "' + b.id + '" — narrative text');
        (b.extraTexts || []).forEach((ex, ei) => {
            if (ex.var === k || (ex.reqs || []).some(r => r.var === k)) hits.push('Block "' + b.id + '" — conditional text #' + (ei + 1) + ' condition');
            if (typeof ex.text === 'string' && ex.text.includes(tok)) hits.push('Block "' + b.id + '" — conditional text #' + (ei + 1) + ' body');
        });
        (b.choices || []).forEach(c => {
            const label = c.txt || '(untitled)';
            if ((c.effects || []).some(e => e.var === k)) hits.push('Block "' + b.id + '" › "' + label + '" — effect');
            if ((c.reqs || []).some(r => r.var === k)) hits.push('Block "' + b.id + '" › "' + label + '" — requirement');
            if (c.persistFlag === k) hits.push('Block "' + b.id + '" › "' + label + '" — set flag');
            if (c.promptChar === k) hits.push('Block "' + b.id + '" › "' + label + '" — rename prompt');
            (c.conditionalNext || []).forEach(rule => { if ((rule.reqs || []).some(r => r.var === k)) hits.push('Block "' + b.id + '" › "' + label + '" — conditional path'); });
            if (typeof c.txt === 'string' && c.txt.includes(tok)) hits.push('Block "' + b.id + '" › "' + label + '" — label text');
        });
    });
    (story.dailyEvents || []).forEach((ev, i) => { if (ev.varName === k) hits.push('Daily event #' + (i + 1)); });
    (story.statEvents || []).forEach((ev, i) => { if (ev.varName === k || ev.reqVar === k) hits.push('Stat event #' + (i + 1)); });
    Object.keys(story.rpgItems || {}).forEach(ik => { const st = story.rpgItems[ik].stats; if (st && st[k] !== undefined) hits.push('RPG item "' + ik + '" — stat modifier'); });

    let m = document.getElementById('usage-modal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'usage-modal';
        m.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:10001; display:flex; justify-content:center; align-items:center;";
        document.body.appendChild(m);
    }
    const body = hits.length
        ? hits.map(h => '<div style="padding:7px 10px; margin-bottom:5px; background:#f8fafc; border-left:3px solid #6366f1; border-radius:4px; font-size:0.85rem;">' + window.escapeHtml(h) + '</div>').join('')
        : '<div style="padding:16px; text-align:center; color:#64748b;">Not used anywhere yet.</div>';
    m.innerHTML = '<div style="background:white; padding:20px; border-radius:10px; width:90%; max-width:520px; max-height:80vh; overflow-y:auto; box-shadow:0 10px 30px rgba(0,0,0,0.4);">'
        + '<div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding-bottom:10px; margin-bottom:12px;">'
        + '<h3 style="margin:0; color:#1e293b;">🔍 Uses of "' + window.escapeHtml(k) + '" (' + hits.length + ')</h3>'
        + '<button class="btn-s" style="padding:4px 12px;" onclick="document.getElementById(\'usage-modal\').remove()">Close</button></div>'
        + body + '</div>';
    m.style.display = 'flex';
};
window.toggleVarVis = function(k, v) { story.varConfig[k] = v; };

window.openEditor = function() {
    const m = document.createElement('div');
    m.id = 'new-story-modal';
    m.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:9999; display:flex; justify-content:center; align-items:center;";
    m.innerHTML = `<div style="background:white; padding:20px; border-radius:8px; width:350px; text-align:center; box-shadow:0 4px 20px rgba(0,0,0,0.5);">
        <h3 style="margin-top:0; color:#1e293b;">Create New Story</h3>
        <input id="ns-title" type="text" placeholder="Story Title..." style="width:100%; padding:10px; margin-bottom:15px; box-sizing:border-box; border:1px solid #cbd5e1; border-radius:4px; font-weight:bold;">
        <p style="font-size:0.85rem; color:#475569; margin-bottom:15px;">Does this story require the <strong>RPG Engine</strong>?<br>(Custom Stats, Items, and Combat System)</p>
        <div style="display:flex; gap:10px;">
            <button class="btn-d" style="flex:1; margin:0; padding:12px; background:#64748b;" onclick="initNewStory(false)">No<br><small style="font-size:0.8rem;">(Visual Novel)</small></button>
            <button class="btn-p" style="flex:1; margin:0; padding:12px; background:#b91c1c;" onclick="initNewStory(true)">Yes<br><small style="font-size:0.8rem;">(Full RPG)</small></button>
        </div>
        <button class="btn-s" style="width:100%; margin-top:10px; background:none; border:none; color:#94a3b8; cursor:pointer;" onclick="document.getElementById('new-story-modal').remove()">Cancel</button>
    </div>`;
    document.body.appendChild(m);
};

window.initNewStory = function(isRPG) {
    const t = document.getElementById('ns-title').value.trim() || 'New Game';
    document.getElementById('new-story-modal').remove();

    story = {
        id: null,
        title: t,
        startBlock: 'starting_room',
        useDayCycle: false,
        isRPG: isRPG,
        dailyEvents: [],
        rpgStats: isRPG ? ['HP', 'MaxHP', 'Atk', 'Def', 'Dex', 'Agi'] : [],
        rpgItems: {},
        blockGroups: ['Ungrouped'],
        globalVars: {},
        varConfig: {},
        blocks: [{ id: 'starting_room', text: 'Start here...', group: 'Ungrouped', choices: [], extraTexts: [] }]
    };

    if (isRPG) {
        story.rpgStats.forEach(stat => {
            story.globalVars[stat] = { type: 'stat', val: stat.includes('HP') ? 100 : 10, stats: null };
        });
        story.varConfig['HP'] = true;
    }

    bIdx = 0;
    window.renderEditor();
    window.clearDirty();
    window.showScreen('edit-screen');
};

window.loadEditor = async function(i) {
    story = await loadStoryFromDB(storiesList[i].Story_ID);
    bIdx = 0;
    window.undoStack = [];
    window.redoStack = [];
    window.renderEditor();
    window.clearDirty();
    window.showScreen('edit-screen');
};

window.setActiveBlock = function(i) { bIdx = i; window.renderEditor(); };
window.syncBlockId = function(newName) {
    const old = story.blocks[bIdx].id;
    newName = String(newName || '').replace(/["'<>]/g, '').trim();
    if (!newName) { window.renderEditor(); return; }
    story.blocks[bIdx].id = newName;
    // Update every reference to the old block id so nothing points at a ghost.
    story.blocks.forEach(blk => {
        (blk.choices || []).forEach(ch => {
            if (ch.next === old) ch.next = newName;
            (ch.conditionalNext || []).forEach(rule => { if (rule.next === old) rule.next = newName; });
        });
    });
    (story.dailyEvents || []).forEach(ev => { if (ev.blockName === old) ev.blockName = newName; });
    (story.statEvents || []).forEach(ev => { if (ev.blockName === old) ev.blockName = newName; });
    if (story.startBlock === old) story.startBlock = newName;
    window.markDirty();
    window.renderEditor();
};

window.setStartBlock = function() {
    if (!story || !story.blocks[bIdx]) return;
    story.startBlock = story.blocks[bIdx].id;
    window.markDirty();
    window.showToast('Start block set to "' + story.blocks[bIdx].id + '"', 'good');
    window.renderEditor();
};

window.addBlock = function(grp) {
    const group = grp || (story.blocks[bIdx] ? story.blocks[bIdx].group : 'Ungrouped');
    story.blocks.push({ id: 'block_' + Date.now(), text: '', group: group, choices: [], extraTexts: [] });
    bIdx = story.blocks.length - 1;
    window.markDirty();
    window.renderEditor();
};

window.removeBlock = function(i) {
    if (story.blocks.length <= 1) { alert("You can't delete the last block."); return; }
    if(confirm("Delete block?")) {
        const removedId = story.blocks[i].id;
        story.blocks.splice(i, 1);
        if (bIdx > i) bIdx--;
        // Clear references to the deleted block so choices/events don't point at a ghost.
        story.blocks.forEach(blk => {
            (blk.choices || []).forEach(ch => {
                if (ch.next === removedId) ch.next = '';
                (ch.conditionalNext || []).forEach(rule => { if (rule.next === removedId) rule.next = ''; });
            });
        });
        (story.dailyEvents || []).forEach(ev => { if (ev.blockName === removedId) ev.blockName = ''; });
        (story.statEvents || []).forEach(ev => { if (ev.blockName === removedId) ev.blockName = ''; });
        if (story.startBlock === removedId) story.startBlock = '';
        if (bIdx >= story.blocks.length) bIdx = story.blocks.length - 1;
        window.markDirty();
        window.renderEditor();
    }
};

window.saveStory = async function() {
    await saveStoryToDB(story);
    await refreshLibrary();
    window.clearDirty();
    window.showToast('Story saved successfully.', 'good');
};


window.parseMarkdown = function(text) {
    let html = String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/\[color:(.*?)\](.*?)\[\/color\]/g, '<span style="color:$1">$2</span>');
    html = html.replace(/\n/g, '<br>');
    return html;
};

window.showToast = function(msg, type='neutral') {
    let tc = document.getElementById('toast-container');
    if (!tc) {
        tc = document.createElement('div');
        tc.id = 'toast-container';
        tc.style.cssText = "position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:10000; display:flex; flex-direction:column; gap:10px; pointer-events:none; align-items:center;";
        document.body.appendChild(tc);
    }
    let toast = document.createElement('div');
    let bg = type === 'good' ? 'rgba(16, 185, 129, 0.9)' : type === 'bad' ? 'rgba(239, 68, 68, 0.9)' : 'rgba(51, 65, 85, 0.9)';
    toast.style.cssText = `background:${bg}; color:white; padding:10px 20px; border-radius:4px; font-size:0.85rem; font-weight:bold; box-shadow:0 4px 6px rgba(0,0,0,0.3); opacity:0; transform:translateY(-20px); transition:all 0.3s ease;`;
    toast.innerText = msg;
    tc.appendChild(toast);

    setTimeout(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; }, 10);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 2500);
};


window.exitPlay = function() {
    if (window.isPlaytesting) {
        window.isPlaytesting = false;
        window.showScreen('edit-screen');
        return;
    }
    window.showScreen('dash-screen');
};

window.playtestCurrentBlock = async function() {
    // Playtest from the in-memory story WITHOUT persisting to the database,
    // so hitting "Test Block" never silently saves work-in-progress.
    pState = window.createPlayState({ bId: story.blocks[bIdx] ? story.blocks[bIdx].id : story.blocks[0].id });
    window.isPlaytesting = true;

    const exitBtn = document.getElementById('btn-play-exit');
    if (exitBtn) {
        exitBtn.innerText = "← Go Back";
        exitBtn.onclick = () => {
            window.isPlaytesting = false;
            window.showScreen('edit-screen');
        };
        exitBtn.style.display = 'inline-block';
    }

    window.showScreen('play-screen');
    window.renderStep();
};


window.switchSidebarTab = function(tabName) {
    document.querySelectorAll('.sidebar-tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.sidebar-tab-btn').forEach(el => {
        el.style.background = 'transparent';
        el.style.color = '#94a3b8';
    });

    const content = document.getElementById('tab-' + tabName);
    if (content) content.style.display = 'block';

    const btn = document.getElementById('btn-tab-' + tabName);
    if (btn) {
        btn.style.background = '#1e293b';
        btn.style.color = 'white';
    }
};

window.showScreen = function(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
};

window.msgTimeout = null;
window.msg = function(m, keepOpen=false) {
    const el = document.getElementById('game-msg');
    if (!el) return;
    el.innerText = m;
    el.style.display = 'block';
    if (window.msgTimeout) clearTimeout(window.msgTimeout);
    if (!keepOpen) {
        window.msgTimeout = setTimeout(() => {
            el.style.display = 'none';
        }, 2000);
    }
}

window.clearMsg = function() {
    const el = document.getElementById('game-msg');
    if (el) el.style.display = 'none';
    if (window.msgTimeout) clearTimeout(window.msgTimeout);
};

window.triggerImport = function() { document.getElementById('file-in').click(); };

window.exportStory = function() {
    if (!story) return;
    const b = new Blob([JSON.stringify(story, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = story.title.replace(/ /g, '_') + '.json';
    a.click();
};

/* Publish the current story as a single self-contained, playable .html file. */
window.publishStory = function() {
    if (!story) return;
    if (!window.__PLAY_JS__ || !window.__PLAY_CSS__) {
        alert('Publish assets not loaded. Make sure publish-assets.js sits next to index.html.');
        return;
    }
    const safeTitle = window.escapeHtml(story.title || 'Adventure');
    const dataJson = JSON.stringify(story)
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

    const html =
'<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>' + safeTitle + '</title>\n<style>\n' + window.__PLAY_CSS__ + '\n</style>\n</head>\n<body>\n' +
'<div id="pub-wrap">\n' +
'  <div id="pub-header">\n' +
'    <div class="pub-title" id="p-title"></div>\n' +
'    <div class="pub-controls">\n' +
'      <button id="btn-back" onclick="pubBack()">↩ Back</button>\n' +
'      <button id="btn-restart" onclick="pubRestart()">⟳ Restart</button>\n' +
'    </div>\n  </div>\n' +
'  <div id="game-msg"></div>\n' +
'  <div class="pub-grid">\n' +
'    <div class="pub-card"><p id="p-text"></p><div id="p-choices"></div></div>\n' +
'    <div class="pub-side"><h3>🎒 Backpack</h3><div id="p-inventory"></div></div>\n' +
'  </div>\n' +
'  <div class="pub-credit">Made with CYOA.C</div>\n' +
'</div>\n' +
'<div id="start-overlay" style="display:none;">\n' +
'  <div class="pub-start-card">\n' +
'    <h1>' + safeTitle + '</h1>\n' +
'    <p>An interactive adventure</p>\n' +
'    <button class="pub-btn-new" onclick="pubNew()">New Game</button>\n' +
'    <button id="btn-continue" class="pub-btn-cont" style="display:none;" onclick="pubContinue()">Continue</button>\n' +
'  </div>\n</div>\n' +
'<script>window.CYOA_STORY = ' + dataJson + ';<\/script>\n' +
'<script>\n' + window.__PLAY_JS__ + '\n<\/script>\n' +
'</body>\n</html>';

    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (story.title || 'adventure').replace(/[^A-Za-z0-9_-]+/g, '_') + '.html';
    a.click();
    window.showToast('Published! Share the downloaded .html file.', 'good');
};

/* Back up the whole library as a single JSON array (restore via Import JSON). */
window.exportAllStories = async function() {
    if (!storiesList || storiesList.length === 0) { alert('No stories to back up yet.'); return; }
    const all = [];
    for (const s of storiesList) {
        all.push(await loadStoryFromDB(s.Story_ID));
    }
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'CYOA_library_backup_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    window.showToast('Backed up ' + all.length + ' ' + (all.length === 1 ? 'story' : 'stories') + '.', 'good');
};

window.importStory = async function(event) {
    window.undoStack = [];
    window.redoStack = [];
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const imp = JSON.parse(e.target.result);
            const nS = Array.isArray(imp) ? imp : [imp];
            for (let s of nS) {
                s.id = null;
                await saveStoryToDB(s);
            }
            await refreshLibrary();
            window.msg("Imported!");
            event.target.value = '';
        } catch (err) { alert("Failed import."); }
    };
    reader.readAsText(file);
};

/* =========================================================
   5. PLAY MODAL & SAVE PROGRESS LOGIC
========================================================= */
async function getStoryUserSaves() {
    const db = await openDB();
    const saves = await idbReq(db.transaction('GameSaves', 'readonly').objectStore('GameSaves').index('Story_ID').getAll(story.id));
    return saves.filter(s => s.User_ID === currentUser.User_ID);
}

window.startPlay = async function(index) {
    story = await loadStoryFromDB(storiesList[index].Story_ID);
    document.getElementById('pm-title').innerText = story.title;
    document.getElementById('play-modal').style.display = 'flex';
    window.pmBackToMain();
};

window.pmClose = function() { document.getElementById('play-modal').style.display = 'none'; };
window.pmBackToMain = function() { document.getElementById('pm-main-view').style.display = 'block'; document.getElementById('pm-slots-view').style.display = 'none'; };

window.pmNewGame = async function() {
    const saves = await getStoryUserSaves();
    if (saves.length >= window.MAX_SAVE_SLOTS) {
        alert("Maximum save slots (" + window.MAX_SAVE_SLOTS + ") reached. Please delete an old save to start a new game.");
        window.pmShowContinue();
        return;
    }
    const usedSlots = saves.map(s => s.SlotNumber || 1);
    let slotNum = 1;
    while(usedSlots.includes(slotNum)) slotNum++;
    let entry = null;
    if (story.startBlock) entry = story.blocks.find(b => b.id === story.startBlock);
    if (!entry) entry = story.blocks.find(b => b.id.toLowerCase().includes('starting'));
    pState = window.createPlayState({ bId: entry ? entry.id : story.blocks[0].id, slot: slotNum });
    window.pmClose();
    window.isPlaytesting = false;

        const exitBtn = document.getElementById('btn-play-exit');
    if (exitBtn) {
        exitBtn.innerText = "← Exit";
        exitBtn.onclick = window.exitPlay;
        exitBtn.style.display = 'inline-block';
    }

    window.showScreen('play-screen');
    window.renderStep();
};

window.pmShowContinue = async function() {
    const saves = await getStoryUserSaves();
    let html = '';
    for (let i = 1; i <= window.MAX_SAVE_SLOTS; i++) {
        const save = saves.find(s => (s.SlotNumber || 1) === i);
        if (save) {
            html += `<div class="slot-row"><div style="flex:1;"><div style="font-weight:bold; font-size:0.9rem; color:var(--p);">Slot ${i}</div><div style="font-size:0.85rem; color:#475569; font-weight:600;">Block: ${save.CurrentBlock}</div><div style="font-size:0.8rem; color:#94a3b8;">${save.Timestamp || 'Legacy Save'}</div></div><div style="display:flex; gap:8px;"><button class="btn-p" style="padding:6px 12px; font-size:0.8rem; border-radius:4px;" onclick="pmLoadGame(${save.Save_ID}, ${i})">Load</button><button class="btn-d" style="padding:6px 10px; margin:0; font-size:0.8rem; border-radius:4px; width:auto;" onclick="pmDeleteSave(${save.Save_ID})">🗑</button></div></div>`;
        } else {
            html += `<div class="slot-row" style="background:#f1f5f9; justify-content:center; color:#94a3b8; font-size:0.85rem;">- Empty Slot ${i} -</div>`;
        }
    }
    document.getElementById('pm-slots-list').innerHTML = html;
    document.getElementById('pm-main-view').style.display = 'none';
    document.getElementById('pm-slots-view').style.display = 'block';
};

window.pmLoadGame = async function(saveId, slotNum) {
    const db = await openDB();
    const save = await idbReq(db.transaction('GameSaves', 'readonly').objectStore('GameSaves').get(saveId));
    if (!save) return;
    pState = window.createPlayState({
        bId: save.CurrentBlock,
        vars: JSON.parse(save.VariablesJSON),
        usage: JSON.parse(save.UsageJSON || '{}'),
        slot: slotNum,
        equipped: JSON.parse(save.EquippedJSON || '{"weapon":null,"armor":null}'),
        firedEvents: JSON.parse(save.FiredEventsJSON || '{}'),
        cooldowns: JSON.parse(save.CooldownsJSON || '{}'),
        usesLeft: JSON.parse(save.UsesLeftJSON || '{}')
    });
    window.pmClose();
    window.isPlaytesting = false;

        const exitBtn = document.getElementById('btn-play-exit');
    if (exitBtn) {
        exitBtn.innerText = "← Exit";
        exitBtn.onclick = window.exitPlay;
        exitBtn.style.display = 'inline-block';
    }

    window.showScreen('play-screen');
    window.renderStep();
};

window.pmDeleteSave = async function(saveId) {
    if (!confirm("Are you sure you want to delete this save? This cannot be undone.")) return;
    const db = await openDB();
    const tx = db.transaction('GameSaves', 'readwrite');
    await idbReq(tx.objectStore('GameSaves').delete(saveId));
    window.pmShowContinue();
};

window.saveGameState = async function() {
    if (!story || !story.id) return;
    try {
        const db = await openDB();
        const saves = await idbReq(db.transaction('GameSaves', 'readonly').objectStore('GameSaves').index('Story_ID').getAll(story.id));
        const userSaves = saves.filter(s => s.User_ID === currentUser.User_ID);

        let slotInfo = Array.from({ length: window.MAX_SAVE_SLOTS }, (_, k) => k + 1).map(i => {
            let s = userSaves.find(x => (x.SlotNumber || 1) === i);
            return `Slot ${i}: ${s ? s.CurrentBlock + ' (' + (s.Timestamp || 'Legacy') + ')' : 'Empty'}`;
        }).join('\n');

        let slotInput = prompt("Enter slot to save to (1-" + window.MAX_SAVE_SLOTS + "):\n\n" + slotInfo, pState.slot || 1);
        if (slotInput === null) return;

        let slotNum = parseInt(slotInput);
        if (isNaN(slotNum) || slotNum < 1 || slotNum > window.MAX_SAVE_SLOTS) {
            alert("Invalid slot number. Must be between 1 and " + window.MAX_SAVE_SLOTS + ".");
            return;
        }

        const existing = userSaves.find(s => (s.SlotNumber || 1) === slotNum);
        if (existing) {
            if (!confirm(`Slot ${slotNum} already contains a save at '${existing.CurrentBlock}'. Overwrite?`)) {
                return;
            }
        }

        pState.slot = slotNum;
        let saveObj = { 
            User_ID: currentUser.User_ID, 
            Story_ID: story.id, 
            SlotNumber: pState.slot, 
            Timestamp: new Date().toLocaleString(), 
            CurrentBlock: pState.bId, 
            VariablesJSON: JSON.stringify(pState.vars), 
            UsageJSON: JSON.stringify(pState.usage), 
            EquippedJSON: JSON.stringify(pState.equipped || {}),
            FiredEventsJSON: JSON.stringify(pState.firedEvents || {}),
            CooldownsJSON: JSON.stringify(pState.cooldowns || {}),
            UsesLeftJSON: JSON.stringify(pState.usesLeft || {})
        };

        if (existing) saveObj.Save_ID = existing.Save_ID;
        // Fresh transaction for the write: the prompt/confirm above yields the event
        // loop, which would auto-commit an earlier transaction.
        await idbReq(db.transaction('GameSaves', 'readwrite').objectStore('GameSaves').put(saveObj));

        const msg = document.getElementById('save-msg');
        if (msg) {
            msg.style.display = 'block';
            setTimeout(() => msg.style.display = 'none', 2000);
        } else {
            alert("Game Saved!");
        }
    } catch (err) {
        console.error("Error saving game:", err);
        alert("Failed to save progress to database.");
    }
};

window.toggleDayCycle = function(enabled) {
    story.useDayCycle = enabled;
    if (enabled && !story.globalVars['TimeOfDay']) {
        story.globalVars['TimeOfDay'] = { type: 'stat', val: 1, stats: null };
        story.varConfig['TimeOfDay'] = true;
    }
    if (enabled && !story.globalVars['Day']) {
        story.globalVars['Day'] = { type: 'stat', val: 1, stats: null };
        story.varConfig['Day'] = true;
    }
    window.renderEditor();
};

window.activeBackpackTab = window.activeBackpackTab || 'items';

window.renderInventory = function() {
    const container = document.getElementById('p-inventory');
    if (!container) return;

    if (!pState.cooldowns) pState.cooldowns = {};
    if (!pState.usesLeft) pState.usesLeft = {};
    if (!pState.equipped) pState.equipped = { weapon: null, armor: null };

    let html = `
        <div style="display:flex; gap:6px; margin-bottom:12px; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;">
            <button class="btn-s" style="flex:1;  ${window.activeBackpackTab==='items'?'background:#4f46e5;color:white;border-color:#4f46e5;':'color:#cbd5e1;'}" onclick="window.activeBackpackTab='items'; window.renderInventory();">Items</button>
            <button class="btn-s" style="flex:1;  ${window.activeBackpackTab==='equip'?'background:#4f46e5;color:white;border-color:#4f46e5;':'color:#cbd5e1;'}" onclick="window.activeBackpackTab='equip'; window.renderInventory();">Equip</button>
            <button class="btn-s" style="flex:1;  ${window.activeBackpackTab==='stats'?'background:#4f46e5;color:white;border-color:#4f46e5;':'color:#cbd5e1;'}" onclick="window.activeBackpackTab='stats'; window.renderInventory();">Stats</button>
        </div>
    `;

    const row = (left, right='') => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
            <div style="font-size:0.85rem; color:white; font-weight:600;">${left}</div>
            <div style="display:flex; align-items:center; gap:8px;">${right}</div>
        </div>
    `;

    if (window.activeBackpackTab === 'items') {
        let hasItems = false;
        for (let k in pState.vars) {
            const v = pState.vars[k];
            if (!pState.config[k]) continue;
            if (v.type !== 'item' || v.val <= 0) continue;

            const itm = story.rpgItems && story.rpgItems[k] ? story.rpgItems[k] : null;
            // Only show consumables, useables, or general items that aren't gear in the item tab (or show gear too but no equip button)
            if (itm && (itm.type === 'weapon' || itm.type === 'armor')) continue; 

            hasItems = true;
            let meta = `<span style="font-size:0.85rem; color:#fbbf24; font-weight:bold;">x${v.val}</span>`;
            let button = '';

            if (itm && (itm.type === 'consumable' || itm.type === 'useable')) {
                const cd = pState.cooldowns[k] || 0;

                if (itm.type === 'useable' && itm.maxUses > 0 && pState.usesLeft[k] === undefined) {
                    pState.usesLeft[k] = itm.maxUses;
                }

                const outOfUses = itm.type === 'useable' && itm.maxUses > 0 && (pState.usesLeft[k] || 0) <= 0;
                const label = cd > 0 ? `CD ${cd}` : outOfUses ? `0 Uses` : 'Use';

                button = `
                    <button
                        class="btn-s"
                        style="padding:4px 10px; margin:0; font-size:0.8rem; border:none; border-radius:4px; ${cd>0 || outOfUses ? 'background:#475569; color:#94a3b8; cursor:not-allowed;' : 'background:#10b981; color:white; cursor:pointer;'}"
                        onclick="${cd>0 || outOfUses ? '' : `window.useRPGItem('${k}')`}"
                    >${label}</button>
                `;

                if (itm.type === 'useable' && itm.maxUses > 0) {
                    meta += ` <span style="font-size:0.8rem; color:#94a3b8;">(${pState.usesLeft[k]}/${itm.maxUses})</span>`;
                }
            }

            html += row(k, `${meta}${button}`);
        }
        if (!hasItems) html += `<div style="font-size:0.8rem; color:#94a3b8; font-style:italic; text-align:center; padding:10px;">No items.</div>`;
    }

    if (window.activeBackpackTab === 'equip') {
        let wName = (pState.equipped && pState.equipped.weapon && pState.vars[pState.equipped.weapon] && pState.vars[pState.equipped.weapon].val > 0) ? pState.equipped.weapon : null;
        let aName = (pState.equipped && pState.equipped.armor && pState.vars[pState.equipped.armor] && pState.vars[pState.equipped.armor].val > 0) ? pState.equipped.armor : null;
        html += row('Weapon', `<span style="color:#fbbf24; font-weight:bold; font-size:0.85rem;">${wName || 'None'}</span> ${wName ? `<button style=" font-size:0.8rem; background:#ef4444; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="window.unequipItem('weapon')">Unequip</button>` : ''}`);
        html += row('Armor', `<span style="color:#fbbf24; font-weight:bold; font-size:0.85rem;">${aName || 'None'}</span> ${aName ? `<button style=" font-size:0.8rem; background:#ef4444; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="window.unequipItem('armor')">Unequip</button>` : ''}`);

        html += `<div style="margin-top:15px; font-size:0.8rem; color:#94a3b8; font-weight:bold; text-transform:uppercase; border-bottom:1px solid #475569; padding-bottom:4px; margin-bottom:8px;">Available Gear</div>`;
        let hasGear = false;
        for (let k in pState.vars) {
            const v = pState.vars[k];
            if (!pState.config[k]) continue;
            const itm = story.rpgItems && story.rpgItems[k] ? story.rpgItems[k] : null;
            if (!itm || v.type !== 'item' || v.val <= 0) continue;
            if (itm.type !== 'weapon' && itm.type !== 'armor') continue;

            const isEquipped = pState.equipped.weapon === k || pState.equipped.armor === k;
            hasGear = true;
            html += row(
                `${k} <span style="font-size:0.8rem; color:#94a3b8;">(${itm.type})</span>`,
                isEquipped
                    ? `<span style="font-size:0.8rem; color:#10b981; font-weight:bold;">Equipped</span>`
                    : `<button style="padding:4px 10px; font-size:0.8rem; font-weight:bold; background:#3b82f6; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="window.equipItem('${k}', '${itm.type}')">Equip</button>`
            );
        }
        if (!hasGear) html += `<div style="font-size:0.8rem; color:#94a3b8; font-style:italic; text-align:center; padding:10px;">No gear available.</div>`;
    }

    if (window.activeBackpackTab === 'stats') {
        const stats = window.calcRPGStats ? window.calcRPGStats() : {};
        const timePhases = { 1: "Early morning", 2: "Morning", 3: "Noon", 4: "Afternoon", 5: "Evening", 6: "Night" };

        // Show Time first if applicable
        if (story.useDayCycle && pState.vars['TimeOfDay']) {
            html += row('Time', `<span style="color:#60a5fa; font-weight:bold;">${timePhases[pState.vars['TimeOfDay'].val] || "Night"}</span>`);
            html += row('Day', `<span style="color:#60a5fa; font-weight:bold;">${pState.vars['Day'] ? pState.vars['Day'].val : 1}</span>`);
        }

        for (let k in pState.vars) {
            const v = pState.vars[k];
            if (k === 'TimeOfDay' || k === 'Day') continue;
            if (k.startsWith('Max')) continue;
            if (!pState.config[k]) continue;

            if (v.type === 'stat') {
                const maxKey = 'Max' + k;
                const val = stats[k] !== undefined ? stats[k] : v.val;
                const txt = pState.vars[maxKey]
                    ? `${val} / ${stats[maxKey] !== undefined ? stats[maxKey] : pState.vars[maxKey].val}`
                    : `${val}`;
                html += row(k, `<span style="color:#10b981; font-weight:bold;">${txt}</span>`);
            } else if (v.type === 'flag') {
                html += row(k, `<span style="color:${v.val > 0 ? '#10b981' : '#94a3b8'}; font-weight:bold;">${v.val > 0 ? 'ON' : 'OFF'}</span>`);
            } else if (v.type === 'char' || v.type === 'npc') {
                html += row(k, `<span style="color:#fbbf24; font-weight:bold;">${v.val}</span>`);
            }
        }
    }

    container.innerHTML = html;
};

window.tickCooldowns = function(amount = 1) {
    if (!pState.cooldowns) pState.cooldowns = {};
    for (let key in pState.cooldowns) {
        if (pState.cooldowns[key] > 0) {
            pState.cooldowns[key] -= amount;
            if (pState.cooldowns[key] < 0) pState.cooldowns[key] = 0;
        }
    }
};

window.useRPGItem = function(itemName) {
    if (!pState || !pState.vars || !story || !story.rpgItems || !story.rpgItems[itemName]) return;

    const itemVar = pState.vars[itemName];
    const itemDef = story.rpgItems[itemName];

    if (!itemVar || itemVar.val <= 0) {
        window.showToast("You don't have any.", "bad");
        return;
    }

    if (itemDef.type !== 'consumable' && itemDef.type !== 'useable') {
        window.showToast("That item can't be used.", "bad");
        return;
    }

    if (!pState.cooldowns) pState.cooldowns = {};
    if (!pState.usesLeft) pState.usesLeft = {};

    if ((pState.cooldowns[itemName] || 0) > 0) {
        window.showToast(`On cooldown (${pState.cooldowns[itemName]})`, "bad");
        return;
    }

    if (itemDef.type === 'useable' && itemDef.maxUses > 0) {
        if (pState.usesLeft[itemName] === undefined) pState.usesLeft[itemName] = itemDef.maxUses;
        if (pState.usesLeft[itemName] <= 0) {
            window.showToast("No uses left.", "bad");
            return;
        }
    }

    if (itemDef.stats) {
        for (let stat in itemDef.stats) {
            if (!pState.vars[stat]) continue;
            pState.vars[stat].val += itemDef.stats[stat];

            const maxStat = 'Max' + stat;
            if (pState.vars[maxStat]) {
                pState.vars[stat].val = Math.min(pState.vars[stat].val, pState.vars[maxStat].val);
            }
            if (pState.vars[stat].val < 0) pState.vars[stat].val = 0;
        }
    }

    if (itemDef.type === 'consumable') {
        itemVar.val -= 1;
        if (itemVar.val < 0) itemVar.val = 0;
    }

    if (itemDef.type === 'useable' && itemDef.maxUses > 0) {
        if (pState.usesLeft[itemName] === undefined) pState.usesLeft[itemName] = itemDef.maxUses;
        pState.usesLeft[itemName] -= 1;
        if (pState.usesLeft[itemName] < 0) pState.usesLeft[itemName] = 0;
    }

    if ((itemDef.cooldown || 0) > 0) {
        pState.cooldowns[itemName] = itemDef.cooldown;
    }

    window.showToast(`Used ${itemName}`, "good");
    window.renderInventory();
    window.renderStep();
};


window.showStoryboard = function() {
    let m = document.getElementById('storyboard-modal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'storyboard-modal';
        m.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.98); z-index:10000; display:flex; flex-direction:column;";

        let header = document.createElement('div');
        header.style.cssText = "padding:15px 20px; background:#1e293b; color:white; display:flex; justify-content:space-between; align-items:center; box-shadow:0 4px 15px rgba(0,0,0,0.5); z-index:2;";
        header.innerHTML = `
            <div style="display:flex; align-items:center; gap:15px;">
                <h2 style="margin:0; font-size:1.2rem; display:flex; align-items:center; gap:10px;">🗺️ Story Flowchart</h2>
                <span style="font-size:0.8rem; color:#94a3b8; background:#334155; padding:4px 10px; border-radius:15px;">Scroll to Zoom • Drag to Pan</span>
            </div>
            <button onclick="document.getElementById('storyboard-modal').style.display='none'" style="background:#ef4444; color:white; border:none; padding:8px 18px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:0.9rem;">Close</button>
        `;
        m.appendChild(header);

        let content = document.createElement('div');
        content.id = 'storyboard-content';
        content.style.cssText = "flex:1; overflow:hidden; position:relative; width:100%; height:100%;";
        m.appendChild(content);

        document.body.appendChild(m);
    }
    m.style.display = 'flex';

    const content = document.getElementById('storyboard-content');
    content.innerHTML = `<div style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); color:#cbd5e1; font-family:monospace; font-size:1.1rem; display:flex; flex-direction:column; align-items:center; gap:10px;">
        <div style="width:30px; height:30px; border:3px solid #cbd5e1; border-top-color:transparent; border-radius:50%; animation:spin 1s linear infinite;"></div>
        Generating flowchart...
    </div>
    <style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>`;

    let defs = ["graph TD"];

    let groupedBlocks = {};
    story.blocks.forEach(b => {
        let g = b.group || 'Ungrouped';
        if (!groupedBlocks[g]) groupedBlocks[g] = [];
        groupedBlocks[g].push(b);
    });

    Object.keys(groupedBlocks).forEach((g, i) => {
        let cleanG = g.replace(/[^a-zA-Z0-9]/g, '_');
        defs.push(`    subgraph ${cleanG} [${g}]`);
        groupedBlocks[g].forEach(b => {
            let cleanId = b.id.replace(/[^a-zA-Z0-9_]/g, '_');
            let label = b.id.length > 25 ? b.id.substring(0, 25) + '...' : b.id;
            label = label.replace(/"/g, "'");
            defs.push(`        ${cleanId}("${label}")`);
        });
        defs.push(`    end`);
    });

    story.blocks.forEach(b => {
        let cleanId = b.id.replace(/[^a-zA-Z0-9_]/g, '_');
        (b.choices || []).forEach(c => {
            if (c.next) {
                let cleanNext = c.next.replace(/[^a-zA-Z0-9_]/g, '_');
                let edgeLabel = c.txt ? (c.txt.length > 20 ? c.txt.substring(0, 20) + '...' : c.txt) : '';
                edgeLabel = edgeLabel.replace(/"/g, "'").trim();
                if (edgeLabel) {
                    defs.push(`    ${cleanId} -->|"${edgeLabel}"| ${cleanNext}`);
                } else {
                    defs.push(`    ${cleanId} --> ${cleanNext}`);
                }
            }
        });
    });

    defs.push("    classDef default fill:#1e293b,stroke:#64748b,stroke-width:2px,color:#f8fafc,rx:8,ry:8;");
    defs.push("    style Ungrouped fill:none,stroke:none;");

    let mmString = defs.join("\n");

    const loadPanZoom = () => {
        if (window.svgPanZoom) return Promise.resolve();
        return new Promise((res) => {
            const script = document.createElement('script');
            script.src = "https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";
            script.onload = res;
            document.head.appendChild(script);
        });
    };

    const loadMermaid = () => {
        if (window.mermaid) return Promise.resolve();
        return new Promise((res) => {
            const script = document.createElement('script');
            script.src = "https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js";
            script.onload = () => {
                mermaid.initialize({ 
                    startOnLoad: false, 
                    theme: 'dark', 
                    maxTextSize: 90000,
                    flowchart: { useMaxWidth: false, rankSpacing: 80, nodeSpacing: 60 }
                });
                res();
            };
            document.head.appendChild(script);
        });
    };

    Promise.all([loadMermaid(), loadPanZoom()]).then(() => {
        mermaid.render('storyboard-svg-' + Date.now(), mmString).then(({svg}) => {
            content.innerHTML = svg;
            let svgEl = content.querySelector('svg');
            svgEl.style.width = '100%';
            svgEl.style.height = '100%';
            svgEl.style.maxWidth = 'none';

            // Wait for DOM to register the SVG sizes
            setTimeout(() => {
                window.myPanZoom = svgPanZoom(svgEl, {
                    zoomEnabled: true,
                    controlIconsEnabled: true,
                    fit: true,
                    center: true,
                    minZoom: 0.1,
                    maxZoom: 5,
                    zoomScaleSensitivity: 0.2
                });

                // Force a sensible default scale so it's not totally zoomed out for large graphs
                let currentZoom = window.myPanZoom.getZoom();
                if(currentZoom < 0.7) {
                     window.myPanZoom.zoom(0.8);
                     window.myPanZoom.center();
                }
            }, 100);

        }).catch(err => {
            content.innerHTML = `<div style="color:#ef4444; background:#fee2e2; padding:15px; border-radius:6px; font-family:monospace; margin:20px;">Error rendering flowchart. Story might be too complex or contain invalid characters.<br><br>${err.message}</div>`;
        });
    });
};

/* =========================================================
   STORY VALIDATOR (added)
   Flags broken links, unreachable blocks, and soft dead-ends.
========================================================= */
window.validateStory = function() {
    if (!story || !story.blocks) return;

    const ids = new Set(story.blocks.map(b => b.id));
    const errors = [];   // definitely broken
    const warnings = []; // worth a look

    // 1. Dangling references (choices / conditional paths / events pointing nowhere)
    story.blocks.forEach(b => {
        (b.choices || []).forEach(c => {
            if (c.next && !ids.has(c.next)) {
                errors.push(`Block "${b.id}": choice "${c.txt || '(untitled)'}" points to missing block "${c.next}".`);
            }
            (c.conditionalNext || []).forEach(rule => {
                if (rule.next && !ids.has(rule.next)) {
                    errors.push(`Block "${b.id}": a conditional path on "${c.txt || '(untitled)'}" points to missing block "${rule.next}".`);
                }
            });
        });
    });
    (story.dailyEvents || []).forEach((ev, i) => {
        if (ev.type === 'block' && ev.blockName && !ids.has(ev.blockName)) {
            errors.push(`Daily event #${i + 1} jumps to missing block "${ev.blockName}".`);
        }
    });
    (story.statEvents || []).forEach((ev, i) => {
        if (ev.type === 'block' && ev.blockName && !ids.has(ev.blockName)) {
            errors.push(`Stat event #${i + 1} jumps to missing block "${ev.blockName}".`);
        }
    });

    // Determine the start block
    let startId = null;
    if (story.startBlock && ids.has(story.startBlock)) startId = story.startBlock;
    if (!startId) { const g = story.blocks.find(b => b.id.toLowerCase().includes('starting')); if (g) startId = g.id; }
    if (!startId && story.blocks[0]) startId = story.blocks[0].id;
    if (!story.startBlock) warnings.push('No explicit start block set (using a fallback). Use "⭐ Set as Start" to lock it in.');

    // 2. Reachability from the start block
    const reachable = new Set();
    const queue = startId ? [startId] : [];
    // Event-target blocks are also valid entry points; seed them as BFS roots so
    // anything reachable only through an event isn't flagged as unreachable.
    (story.dailyEvents || []).concat(story.statEvents || []).forEach(ev => {
        if (ev.type === 'block' && ev.blockName && ids.has(ev.blockName)) queue.push(ev.blockName);
    });
    while (queue.length) {
        const cur = queue.shift();
        if (reachable.has(cur)) continue;
        reachable.add(cur);
        const blk = story.blocks.find(b => b.id === cur);
        if (!blk) continue;
        (blk.choices || []).forEach(c => {
            if (c.next && !reachable.has(c.next)) queue.push(c.next);
            (c.conditionalNext || []).forEach(rule => { if (rule.next && !reachable.has(rule.next)) queue.push(rule.next); });
        });
    }
    story.blocks.forEach(b => {
        if (!reachable.has(b.id)) warnings.push(`Block "${b.id}" is unreachable (nothing links to it).`);
    });

    // 3. Soft dead-ends: has choices, but none actually navigate anywhere
    story.blocks.forEach(b => {
        const choices = b.choices || [];
        if (choices.length === 0) return; // intentional ending
        const anyNav = choices.some(c => c.next || (c.conditionalNext || []).some(r => r.next));
        if (!anyNav) warnings.push(`Block "${b.id}" has choices but none lead anywhere (soft dead-end).`);
    });

    // Render results in a modal
    let m = document.getElementById('validate-modal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'validate-modal';
        m.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:10001; display:flex; justify-content:center; align-items:center;";
        document.body.appendChild(m);
    }
    const item = (t, color) => `<div style="padding:8px 10px; margin-bottom:6px; background:#f8fafc; border-left:4px solid ${color}; border-radius:4px; font-size:0.85rem; color:#1e293b;">${window.escapeHtml(t)}</div>`;
    let body = '';
    if (errors.length === 0 && warnings.length === 0) {
        body = `<div style="padding:20px; text-align:center; color:#16a34a; font-weight:bold;">✅ No problems found. Your story looks well-connected!</div>`;
    } else {
        if (errors.length) body += `<h4 style="margin:10px 0 6px; color:#b91c1c;">Errors (${errors.length})</h4>` + errors.map(e => item(e, '#ef4444')).join('');
        if (warnings.length) body += `<h4 style="margin:14px 0 6px; color:#b45309;">Warnings (${warnings.length})</h4>` + warnings.map(w => item(w, '#f59e0b')).join('');
    }
    m.innerHTML = `<div style="background:white; padding:20px; border-radius:10px; width:90%; max-width:520px; max-height:80vh; overflow-y:auto; box-shadow:0 10px 30px rgba(0,0,0,0.4);">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding-bottom:10px; margin-bottom:12px;">
            <h3 style="margin:0; color:#1e293b;">✅ Story Validation</h3>
            <button class="btn-s" style="padding:4px 12px;" onclick="document.getElementById('validate-modal').remove()">Close</button>
        </div>
        ${body}
    </div>`;
    m.style.display = 'flex';
};
