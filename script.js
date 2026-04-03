let currentUser = null, currentDashboardId = null;
let storiesList = [], story = null, bIdx = 0;
let pState = { bId: null, vars: {}, config: {}, usage: {}, slot: 1 };
let authMode = 'signin';
let recoveryUserRecord = null;

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
        const db = await openDB();
        const tx = db.transaction('Users', 'readwrite');
        const store = tx.objectStore('Users');
        let existing = await idbReq(store.index('UserName').get(user));
        if (authMode === 'signin') {
            if (!existing) return showAuthError('User not found. Switch to Sign Up!');
            if (existing.Password !== pass) return showAuthError('Incorrect password!');
        } else {
            if (existing) return showAuthError('Username taken. Switch to Sign In!');
            if (!sq || !sa) return showAuthError('Security Question and Answer are required for signup!');
            const uid = await idbReq(store.add({ UserName: user, Password: pass, SecurityQuestion: sq, SecurityAnswer: sa.toLowerCase() }));
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
        const db = await openDB();
        const tx = db.transaction('Users', 'readwrite');
        const store = tx.objectStore('Users');
        recoveryUserRecord.Password = newPass;
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
            <div><strong>${s.Story_Title}</strong></div>
            <div style="display:flex; gap:8px;">
                <button class="btn-p" onclick="startPlay(${i})">▶ Play</button>
                <button class="btn-s" onclick="loadEditor(${i})">✏ Edit</button>
                <button class="btn-s" style="background:#dcfce7; color:#166534;" onclick="duplicateStory(${i})">📋 Duplicate</button>
                <button class="btn-d" style="width:auto; margin:0;" onclick="deleteStory(${i})">🗑 Delete</button>
            </div>
        </div>
    `).join('') || "<p>No stories yet.</p>";
}

async function loadStoryFromDB(storyId) {
    const db = await openDB();
    const tx = db.transaction(['Stories', 'StoryBlocks', 'ExtraTexts', 'Choices', 'Variables', 'ChoiceEffects'], 'readonly');
    const dbStory = await idbReq(tx.objectStore('Stories').get(storyId));
    const blocks = await idbReq(tx.objectStore('StoryBlocks').index('Story_ID').getAll(storyId));
    const vars = await idbReq(tx.objectStore('Variables').index('Story_ID').getAll(storyId));
    let memStory = { id: dbStory.Story_ID, title: dbStory.Story_Title, useDayCycle: !!dbStory.UseDayCycle, isRPG: !!dbStory.Is_RPG, rpgStats: JSON.parse(dbStory.RPG_Stats_JSON || '["HP","MaxHP","Atk","Def","Dex","Agi"]'), rpgItems: JSON.parse(dbStory.RPG_Items_JSON || '{}'), blockGroups: JSON.parse(dbStory.Block_Groups_JSON || '["Ungrouped"]'), dailyEvents: JSON.parse(dbStory.Daily_Events_JSON || '[]'), globalVars: {}, varConfig: {}, blocks: [] };
    for (let v of vars) {
        memStory.globalVars[v.Var_Name] = { type: v.Var_Type, val: v.Default_Value, stats: JSON.parse(v.Char_Stats_JSON || '{}') };
        if (v.Is_HUD) memStory.varConfig[v.Var_Name] = true;
    }
    for (let b of blocks) {
        let memBlock = { id: b.Block_Name, text: b.Block_Text, group: b.Block_Group || 'Ungrouped', choices: [], extraTexts: [] };
        let extras = await idbReq(tx.objectStore('ExtraTexts').index('StoryBlock_ID').getAll(b.StoryBlock_ID));
        for (let e of extras) {
            let parsedReqs = [];
            if (e.Reqs_JSON) {
                parsedReqs = JSON.parse(e.Reqs_JSON);
            } else if (e.Req_Var) {
                parsedReqs.push({ var: e.Req_Var, op: '>=', val: e.Req_Min });
                if (e.Req_Max !== undefined && e.Req_Max < 999999) {
                    parsedReqs.push({ var: e.Req_Var, op: '<=', val: e.Req_Max });
                }
            }
            memBlock.extraTexts.push({
                var: e.Req_Var, reqMin: e.Req_Min, reqMax: e.Req_Max, // keeping legacy fields for safety
                reqs: parsedReqs,
                reqLogic: e.Req_Logic || 'AND',
                text: e.Text_Content
            });
        }
        let choices = await idbReq(tx.objectStore('Choices').index('StoryBlock_ID').getAll(b.StoryBlock_ID));
        for (let c of choices) {
            let memChoice = { id: c.Choice_ID.toString(), txt: c.Choice_Text, next: c.Next_Block_Name, hideLocked: c.Hide_Locked, maxUses: c.Max_Uses, showUsage: c.Show_Usage, persistFlag: c.Persist_Flag, promptChar: c.Prompt_Char, lockedMsg: c.Locked_Msg, timeAdd: c.Time_Add !== undefined ? c.Time_Add : (c.Passes_Time === false ? 0 : 1), forceNextDay: !!c.Force_Next_Day, passTime: c.Passes_Time !== false, giveVar: '', giveAmt: 0, takeVar: '', takeAmt: 0, reqs: [], reqLogic: c.Req_Logic || 'AND' };
            if (c.Reqs_JSON) {
                memChoice.reqs = JSON.parse(c.Reqs_JSON);
            } else if (c.Req_Var) {
                memChoice.reqs.push({var: c.Req_Var, op: '>=', val: c.Req_Min});
                if (c.Req_Max !== undefined && c.Req_Max < 999999) {
                    memChoice.reqs.push({var: c.Req_Var, op: '<=', val: c.Req_Max});
                }
            }
            let effects = await idbReq(tx.objectStore('ChoiceEffects').index('Choice_ID').getAll(c.Choice_ID));
            for (let eff of effects) {
                if (eff.Effect_Type === 'give') { memChoice.giveVar = eff.Variable_Name; memChoice.giveAmt = eff.Amount; }
                if (eff.Effect_Type === 'take') { memChoice.takeVar = eff.Variable_Name; memChoice.takeAmt = eff.Amount; }
            }
            memBlock.choices.push(memChoice);
        }
        memStory.blocks.push(memBlock);
    }
    memStory.blocks.forEach(bk => { if (!memStory.blockGroups) memStory.blockGroups = ['Ungrouped']; if (!memStory.blockGroups.includes(bk.group)) memStory.blockGroups.push(bk.group); });
    return memStory;
}

async function saveStoryToDB(storyObj) {
    const db = await openDB();
    const tx = db.transaction(['Stories', 'StoryBlocks', 'ExtraTexts', 'Choices', 'Variables', 'ChoiceEffects'], 'readwrite');
    let sObj = { Story_Title: storyObj.title, Dashboard_ID: currentDashboardId, UseDayCycle: !!storyObj.useDayCycle, Is_RPG: !!storyObj.isRPG, RPG_Stats_JSON: JSON.stringify(storyObj.rpgStats || []), RPG_Items_JSON: JSON.stringify(storyObj.rpgItems || {}), Block_Groups_JSON: JSON.stringify(storyObj.blockGroups || ['Ungrouped']), Daily_Events_JSON: JSON.stringify(storyObj.dailyEvents || []) };
    if (storyObj.id) sObj.Story_ID = storyObj.id;
    const sid = await idbReq(tx.objectStore('Stories').put(sObj));
    storyObj.id = sid;
    const oldVars = await idbReq(tx.objectStore('Variables').index('Story_ID').getAll(sid));
    for (let v of oldVars) tx.objectStore('Variables').delete(v.Variable_ID);
    const oldBlocks = await idbReq(tx.objectStore('StoryBlocks').index('Story_ID').getAll(sid));
    for (let b of oldBlocks) {
        const oldE = await idbReq(tx.objectStore('ExtraTexts').index('StoryBlock_ID').getAll(b.StoryBlock_ID));
        for (let e of oldE) tx.objectStore('ExtraTexts').delete(e.ExtraText_ID);
        const oldC = await idbReq(tx.objectStore('Choices').index('StoryBlock_ID').getAll(b.StoryBlock_ID));
        for (let c of oldC) {
            const oldEff = await idbReq(tx.objectStore('ChoiceEffects').index('Choice_ID').getAll(c.Choice_ID));
            for (let e of oldEff) tx.objectStore('ChoiceEffects').delete(e.Effect_ID);
            tx.objectStore('Choices').delete(c.Choice_ID);
        }
        tx.objectStore('StoryBlocks').delete(b.StoryBlock_ID);
    }
    for (let vName in storyObj.globalVars) {
        let v = storyObj.globalVars[vName];
        tx.objectStore('Variables').add({ Story_ID: sid, Var_Name: vName, Var_Type: v.type, Default_Value: v.val, Is_HUD: !!storyObj.varConfig[vName], Char_Stats_JSON: JSON.stringify(v.stats || {}) });
    }
    for (let b of storyObj.blocks) {
        let bid = await idbReq(tx.objectStore('StoryBlocks').add({ Story_ID: sid, Block_Name: b.id, Block_Text: b.text, Block_Group: b.group || 'Ungrouped' }));
        if (b.extraTexts) {
            for (let ext of b.extraTexts) {
                tx.objectStore('ExtraTexts').add({ StoryBlock_ID: bid, Req_Var: ext.var||'', Req_Min: ext.reqMin||0, Req_Max: ext.reqMax||0, Text_Content: ext.text, Reqs_JSON: JSON.stringify(ext.reqs || []), Req_Logic: ext.reqLogic || 'AND' });
            }
        }
        for (let c of b.choices) {
            let cid = await idbReq(tx.objectStore('Choices').add({ StoryBlock_ID: bid, Choice_Text: c.txt, Next_Block_Name: c.next||'', Reqs_JSON: JSON.stringify(c.reqs || []), Req_Logic: c.reqLogic || 'AND', Hide_Locked: !!c.hideLocked, Max_Uses: c.maxUses||0, Show_Usage: c.showUsage !== false, Persist_Flag: c.persistFlag||'', Prompt_Char: c.promptChar||'', Locked_Msg: c.lockedMsg||'', Passes_Time: c.passTime !== false, Time_Add: c.timeAdd !== undefined ? c.timeAdd : 1, Force_Next_Day: !!c.forceNextDay }));
            if (c.giveVar) tx.objectStore('ChoiceEffects').add({ Choice_ID: cid, Variable_Name: c.giveVar, Effect_Type: 'give', Amount: c.giveAmt||0 });
            if (c.takeVar) tx.objectStore('ChoiceEffects').add({ Choice_ID: cid, Variable_Name: c.takeVar, Effect_Type: 'take', Amount: c.takeAmt||0 });
        }
    }
    return new Promise((res) => { tx.oncomplete = () => res(sid); });
}

window.deleteStory = async function(index) {
    if(!confirm("Delete this story and all relationships?")) return;
    const sid = storiesList[index].Story_ID;
    const db = await openDB();
    const tx = db.transaction(['Stories', 'StoryBlocks', 'ExtraTexts', 'Choices', 'Variables', 'ChoiceEffects', 'GameSaves'], 'readwrite');
    tx.objectStore('Stories').delete(sid);
    const oldBlocks = await idbReq(tx.objectStore('StoryBlocks').index('Story_ID').getAll(sid));
    for (let b of oldBlocks) {
        const oldExt = await idbReq(tx.objectStore('ExtraTexts').index('StoryBlock_ID').getAll(b.StoryBlock_ID));
        for (let e of oldExt) tx.objectStore('ExtraTexts').delete(e.ExtraText_ID);
        const oldC = await idbReq(tx.objectStore('Choices').index('StoryBlock_ID').getAll(b.StoryBlock_ID));
        for (let c of oldC) {
            const oldE = await idbReq(tx.objectStore('ChoiceEffects').index('Choice_ID').getAll(c.Choice_ID));
            for (let e of oldE) tx.objectStore('ChoiceEffects').delete(e.Effect_ID);
            tx.objectStore('Choices').delete(c.Choice_ID);
        }
        tx.objectStore('StoryBlocks').delete(b.StoryBlock_ID);
    }
    tx.oncomplete = async () => await refreshLibrary();
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

    let varHTML = `<div style="display:flex; align-items:center; margin-bottom:15px; padding:10px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;"><label style="font-size:0.8rem; font-weight:bold; cursor:pointer; display:flex; align-items:center; gap:6px; color:black;"><input type="checkbox" ${story.useDayCycle ? 'checked' : ''} onchange="toggleDayCycle(this.checked)"> 🌙 Enable Day/Night Cycle</label></div>`;

    varHTML += `<div style="display:flex; flex-direction:column; gap:10px; margin-bottom:15px; background:#f1f5f9; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
        <div style="display:flex; gap:10px; align-items:center;">
            <label style="font-size:0.8rem; font-weight:bold; color:#334155;">View:</label>
            <select style="flex:1; padding:6px; font-size:0.8rem; border-radius:4px; border:1px solid #94a3b8;" onchange="window.activeVarFilter=this.value; window.renderVarTable();">
                <option value="stat" ${window.activeVarFilter==='stat'?'selected':''}>Stats</option>
                <option value="item" ${window.activeVarFilter==='item'?'selected':''}>Items</option>
                <option value="flag" ${window.activeVarFilter==='flag'?'selected':''}>Flags</option>
                <option value="npc" ${window.activeVarFilter==='npc'?'selected':''}>NPCs</option>
            </select>
        </div>
        <input type="text" id="main-var-search" placeholder="Search ${window.activeVarFilter}s..." value="${window.activeVarSearchTerm}" oninput="window.activeVarSearchTerm=this.value; window.filterMainVarTable()" style="padding:6px; font-size:0.8rem; border-radius:4px; border:1px solid #94a3b8; width:100%; box-sizing:border-box;">
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

        varHTML += `<div class="main-var-card" data-var-name="${key.toLowerCase()}" style="background:white; border-radius:8px; padding:12px; margin-bottom:12px; border-left: 5px solid ${color}; box-shadow: 0 2px 4px rgba(0,0,0,0.1); color: #333;"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;"><span style="font-size:0.6rem; font-weight:bold; color:${color}; text-transform:uppercase;">${effType}</span><label style="font-size:0.65rem; display:flex; align-items:center; gap:4px; cursor:pointer; color:#666;"><input type="checkbox" ${story.varConfig[key] ? 'checked' : ''} onchange="toggleVarVis('${key}', this.checked)"> HUD</label></div><div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;"><input style="flex:1.5; padding:6px; font-size:0.8rem; border:1px solid #ddd; border-radius:4px;" value="${key}" onchange="renameVar('${key}', this.value)"><div style="flex:1;">${window.renderVarInput(key, v)}</div><button onclick="deleteVar('${key}')" style="background:#fee2e2; color:#ef4444; border:none; border-radius:4px; padding:6px 10px;">✕</button></div>${effType === 'npc' ? window.renderNPCSubVars(key, v) : ''}${rpgModHTML}</div>`;
    }

    varHTML += `<button class="btn-p"  style="width:100%; margin-bottom:15px; font-size:0.8rem; padding:10px;" onclick="addTypedVar(window.activeVarFilter)">+ Add Custom ${window.activeVarFilter.toUpperCase()}</button>`;

    let eventHTML = '';
    if (story.useDayCycle) {
        eventHTML = `<div style="margin-top:15px; background:#fffbeb; padding:10px; border-radius:6px; border:1px solid #fde68a;"><h4 style="margin:0 0 10px 0; font-size:0.8rem; color:#b45309;">📅 Daily Events</h4>`;
        (story.dailyEvents || []).forEach((ev, i) => {
            ev.type = ev.type || 'var';
            let actionHTML = '';
            if (ev.type === 'var') {
                actionHTML = `
                    <select style="flex:1; padding:2px; font-size:0.7rem;" onchange="updateDailyEvent(${i}, 'varName', this.value)">
                        <option value="">- Var -</option>
                        ${Object.keys(story.globalVars).map(v => `<option value="${v}" ${ev.varName===v?'selected':''}>${v}</option>`).join('')}
                    </select>
                    <span style="font-size:0.7rem;">To</span>
                    <input type="number" style="width:40px; padding:2px; font-size:0.7rem;" value="${ev.val !== undefined ? ev.val : 1}" onchange="updateDailyEvent(${i}, 'val', parseInt(this.value))">
                `;
            } else {
                actionHTML = `
                    <select style="flex:1; padding:2px; font-size:0.7rem;" onchange="updateDailyEvent(${i}, 'blockName', this.value)">
                        <option value="">- Block -</option>
                        ${story.blocks.map(b => `<option value="${b.id}" ${ev.blockName===b.id?'selected':''}>${b.id}</option>`).join('')}
                    </select>
                `;
            }
            eventHTML += `<div style="display:flex; gap:4px; margin-bottom:5px; align-items:center;">
                <span style="font-size:0.7rem;">Day</span>
                <input type="number" style="width:40px; padding:2px; font-size:0.7rem;" value="${ev.day}" onchange="updateDailyEvent(${i}, 'day', parseInt(this.value))">
                <select style="padding:2px; font-size:0.7rem;" onchange="updateDailyEvent(${i}, 'type', this.value)">
                    <option value="var" ${ev.type==='var'?'selected':''}>Set</option>
                    <option value="block" ${ev.type==='block'?'selected':''}>Jump</option>
                </select>
                ${actionHTML}
                <button class="btn-d" style="width:auto; margin:0; padding:2px 6px;" onclick="removeDailyEvent(${i})">✕</button>
            </div>`;
        });
        eventHTML += `<button class="btn-s" style="font-size:0.65rem; padding:4px; width:100%;" onclick="addDailyEvent()">+ Add Event</button></div>`;
    }

    document.getElementById('ed-var-table').innerHTML = varHTML + eventHTML;

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
        html += `<div style="background:white; padding:6px 10px; border-radius:6px; font-size:0.75rem; font-weight:600; color:#831843; border:1px solid #f9a8d4; display:flex; justify-content:space-between; align-items:center; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
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
    html += `<label style="font-size:0.75rem; font-weight:bold; color:#4f46e5; display:flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" ${isRPGItem ? 'checked' : ''} onchange="toggleRPGItem('${key}', this.checked, '${effType}')"> ${labelTxt}</label>`;

    if (isRPGItem) {
        let item = story.rpgItems[key];
        if (!item.stats) item.stats = {};

        html += `<div style="margin-top:8px; padding:10px; background:#e0e7ff; border-radius:6px; border:1px solid #c7d2fe;">`;

        if (effType === 'item') {
            html += `<div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                <span style="font-size:0.7rem; font-weight:bold; color:#3730a3;">Item Type:</span>
                <select style="padding:4px; font-size:0.7rem; border-radius:4px; border:1px solid #a5b4fc; flex:1;" onchange="updateRPGItem('${key}', 'type', this.value)">
                    <option value="weapon" ${item.type==='weapon'?'selected':''}>Weapon</option>
                    <option value="armor" ${item.type==='armor'?'selected':''}>Armor</option>
                    <option value="consumable" ${item.type==='consumable'?'selected':''}>Consumable (Destroyed on use)</option>
                    <option value="useable" ${item.type==='useable'?'selected':''}>Useable (Limited Uses / Cooldown)</option>
                </select>
            </div>`;
            if (item.type === 'consumable' || item.type === 'useable') {
                html += `<div style="display:flex; gap:10px; margin-bottom:10px;">
                    <label style="flex:1; font-size:0.7rem; color:#3730a3; font-weight:bold;">Max Uses (0=Stack/Inf)
                        <input type="number" min="0" value="${item.maxUses || 0}" style="width:100%; padding:4px; margin-top:4px; border:1px solid #a5b4fc; border-radius:4px;" onchange="updateRPGItem('${key}', 'maxUses', parseInt(this.value)||0)">
                    </label>
                    <label style="flex:1; font-size:0.7rem; color:#3730a3; font-weight:bold;">Cooldown (Phases)
                        <input type="number" min="0" value="${item.cooldown || 0}" style="width:100%; padding:4px; margin-top:4px; border:1px solid #a5b4fc; border-radius:4px;" onchange="updateRPGItem('${key}', 'cooldown', parseInt(this.value)||0)">
                    </label>
                </div>`;
            }
        } else {
            html += `<div style="font-size:0.7rem; color:#3730a3; margin-bottom:10px; font-style:italic;">This modifier will apply to the player's stats permanently as long as this Flag is turned ON (Value > 0).</div>`;
        }

        html += `<div style="display:flex; flex-direction:column; gap:4px; margin-bottom:10px;">`;
        let hasStats = false;
        for (let st in item.stats) {
            if (item.stats[st] !== 0) {
                hasStats = true;
                let valStr = item.stats[st] > 0 ? `+${item.stats[st]}` : item.stats[st];
                let col = item.stats[st] > 0 ? '#10b981' : '#ef4444';
                html += `<div style="display:flex; justify-content:space-between; align-items:center; background:white; padding:4px 8px; border-radius:4px; border:1px solid #cbd5e1; font-size:0.7rem; font-weight:bold;">
                    <span>${st} <span style="color:${col}; margin-left:6px;">${valStr}</span></span>
                    <button style="background:none; border:none; color:#ef4444; cursor:pointer; font-weight:bold; padding:0;" onclick="removeRPGItemStat('${key}', '${st}')">✕</button>
                </div>`;
            }
        }
        if (!hasStats) {
            html += `<div style="font-size:0.65rem; color:#64748b; font-style:italic; padding-bottom:6px;">No stat modifiers yet.</div>`;
        }
        html += `</div>`;

        let statOptions = Object.keys(story.globalVars)
            .filter(k => story.globalVars[k].type === 'stat')
            .map(s => `<option value="${s}">${s}</option>`)
            .join('');

        html += `<div style="display:flex; gap:5px; align-items:center;">
            <select id="rpg_mod_stat_${key}" style="flex:1; padding:4px; font-size:0.7rem; border-radius:4px; border:1px solid #a5b4fc;">
                <option value="">- Stat -</option>
                ${statOptions}
            </select>
            <input type="number" id="rpg_mod_val_${key}" value="1" style="width:50px; padding:4px; font-size:0.7rem; border-radius:4px; border:1px solid #a5b4fc; text-align:center;">
            <button style="background:#4f46e5; color:white; border:none; border-radius:4px; padding:4px 8px; font-size:0.7rem; cursor:pointer; font-weight:bold;" onclick="addRPGItemStatUI('${key}')">Add</button>
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

    const style = `width:100%; padding:6px; font-size:0.8rem; border:1px solid #ddd; border-radius:4px;`;
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
            ctr.style.display = 'inline-flex';
            ctr.style.alignItems = 'center';
            ctr.style.marginLeft = '15px';
            ctr.innerHTML = `<span style="font-size:0.75rem; font-weight:bold; margin-right:5px; color:#475569;">Folder:</span>
                             <select id="ed-blk-group" style="padding:4px; font-size:0.75rem; border-radius:4px; border:1px solid #cbd5e1;" onchange="changeBlockGroup(this.value)"></select>
                             <button class="btn-s" style="padding:4px 8px; margin:0 0 0 5px; font-size:0.7rem;" onclick="createBlockGroup()">+ Add Folder</button>
                             <button class="btn-s" style="background:#10b981; color:white; border:none; padding:4px 12px; border-radius:4px; margin-left:15px; cursor:pointer;" onclick="playtestCurrentBlock()">▶️ Test Block</button>`;
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
    }
    document.getElementById('ed-blk-text').value = b.text;
    document.getElementById('ed-blk-text').oninput = (e) => b.text = e.target.value;
    window.renderVariableHelper();
    window.renderVarTable();
    window.renderChoices();
    window.renderExtraTextEditor();
    
    if (!document.getElementById('block-search-input')) {
        document.getElementById('ed-blocks-menu').innerHTML = `
            <div style="margin-bottom: 10px;">
                <input type="text" id="block-search-input" placeholder="Search blocks..." oninput="updateBlockSearch()" style="width:100%; padding:6px; box-sizing:border-box; border-radius:4px; border:1px solid #ccc;">
            </div>
            <div id="block-list-container"></div>
        `;
    }
    window.updateBlockSearch();

    // Hijack the hardcoded HTML + Add Block button to become a Folder button
    document.querySelectorAll('button').forEach(btn => {
        if (btn.getAttribute('onclick') === 'addBlock()') {
            btn.innerHTML = '📁 + Add Block Group';
            btn.setAttribute('onclick', 'createBlockGroup()');
        }
    });

};

window.getLogicUI = function(prefix, i, obj, type, updateFunc) {
    if (type === 'flag') return `<div class="range-container" style="flex:1;"><span style="font-size:0.7rem; color:#64748b; margin-right:4px;">Is:</span><select style="border:none; flex:1; font-weight:bold; background:transparent;" onchange="${updateFunc}('${i}', 'reqMin', parseInt(this.value)); ${updateFunc}('${i}', 'reqMax', parseInt(this.value));"><option value="1" ${obj.reqMin === 1 ? 'selected' : ''}> On</option><option value="0" ${obj.reqMin === 0 ? 'selected' : ''}> Off</option></select></div>`;
    return `<div class="range-container"><input type="number" class="range-input" value="${obj.reqMin || 0}" onchange="${updateFunc}('${i}', 'reqMin', parseInt(this.value))"><span style="color:#94a3b8; font-weight:bold; font-size:0.8rem;">to</span><input type="number" class="range-input" value="${obj.reqMax || 0}" onchange="${updateFunc}('${i}', 'reqMax', parseInt(this.value))"></div>`;
};


window.evaluateReqLogic = function(reqs, reqLogic, vars) {
    if (!reqs || reqs.length === 0) return true;
    let results = [];

    for (let r of reqs) {
        if (!r.var || !vars[r.var]) { 
            results.push(false); 
            continue; 
        }

        let cur = vars[r.var].val;
        let t = vars[r.var].type;
        let rMet = true;

        if (t === 'flag') {
            if (cur !== r.val) rMet = false;
        } else if (t === 'char' || t === 'npc') {
            if (r.op === '==' && cur != r.val) rMet = false;
            if (r.op === '!=' && cur == r.val) rMet = false;
        } else {
            if (r.op === 'has' && cur < 1) rMet = false;
            if (r.op === '>=' && cur < r.val) rMet = false;
            if (r.op === '<=' && cur > r.val) rMet = false;
            if (r.op === '==' && cur != r.val) rMet = false;
            if (r.op === '!=' && cur == r.val) rMet = false;
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
            <span>📁 ${grp} <span style="font-size:0.65rem; color:#94a3b8; margin-left:4px;">(${grpBlocks.length})</span></span>
            <div style="display:flex; gap:8px; align-items:center;">
                <button onclick="event.stopPropagation(); addBlock('${grp}')" style="background:#475569; color:white; border:1px solid #64748b; border-radius:4px; font-size:0.65rem; padding:2px 6px; cursor:pointer; transition: 0.2s;" onmouseover="this.style.background='#64748b'" onmouseout="this.style.background='#475569'">+ Block</button>
                <span style="width:12px; text-align:center;">${isExpanded ? '▼' : '▶'}</span>
            </div>
        </div>`;

        if (isExpanded) {
            listHtml += `<div style="padding-left:10px; border-left:2px solid #cbd5e1; margin-left:5px;">`;
            listHtml += grpBlocks.map(m => `
                <div class="block-menu-item" style="display:flex; justify-content:space-between; align-items:center; background:${m.originalIndex === bIdx ? 'var(--p)' : '#f1f5f9'}; color:${m.originalIndex === bIdx ? 'white' : 'black'}; margin-top:4px; padding:6px; border-radius:4px; border:1px solid #e2e8f0;">
                    <span onclick="setActiveBlock(${m.originalIndex})" style="flex-grow:1; cursor:pointer; font-size:0.85rem;">${m.blk.id}</span>
                    ${story.blocks.length > 1 ? `<span class="remove-blk-btn" onclick="removeBlock(${m.originalIndex})" style="cursor:pointer; font-weight:bold; padding:0 5px; color:${m.originalIndex === bIdx ? '#fca5a5' : '#ef4444'};">×</span>` : ''}
                </div>
            `).join('');
            if (grpBlocks.length === 0) listHtml += `<div style="font-size:0.7rem; color:#94a3b8; padding:5px;">No blocks.</div>`;
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

    let html = `<h4>Conditional Text</h4>`;
    if (b.extraTexts) {
        b.extraTexts.forEach((extra, i) => {

            // Auto-migrate old single vars to reqs array format on the fly if needed
            if (!extra.reqs) {
                extra.reqs = [];
                if (extra.var) {
                    extra.reqs.push({ var: extra.var, op: '>=', val: extra.reqMin });
                    if (extra.reqMax !== undefined && extra.reqMax < 999999) {
                        extra.reqs.push({ var: extra.var, op: '<=', val: extra.reqMax });
                    }
                }
            }

            let logicSelect = '';
            if (extra.reqs && extra.reqs.length > 1) {
                logicSelect = `<select style="margin-left: 10px; padding: 2px; font-size: 0.65rem; border:1px solid #cbd5e1; border-radius:4px;" onchange="updateExtraText(${i}, 'reqLogic', this.value)">
                    <option value="AND" ${extra.reqLogic !== 'OR' ? 'selected' : ''}>ALL (AND)</option>
                    <option value="OR" ${extra.reqLogic === 'OR' ? 'selected' : ''}>ANY (OR)</option>
                </select>`;
            }

            let reqsHTML = `<div style="padding:10px; margin-bottom:10px;">
                <label style="font-size:0.65rem; font-weight:bold; color:#475569; display:flex; align-items:center;">Conditions ${logicSelect}</label>`;

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
                        vals = `<input type="text" style="flex:1; width:50px; border: 1px solid #ddd; border-radius: 4px; padding: 4px;" value="${r.val}" onchange="updateExtraReq(${i}, ${rIdx}, 'val', this.value)">`;
                    } else {
                        ops = `<select style="flex:1; border: 1px solid #ddd; border-radius: 4px;" onchange="updateExtraReq(${i}, ${rIdx}, 'op', this.value)">
                            <option value="has" ${r.op==='has'?'selected':''}>Has</option>
                            <option value=">=" ${r.op==='>='?'selected':''}>&ge;</option>
                            <option value="<=" ${r.op==='<='?'selected':''}>&le;</option>
                            <option value="==" ${r.op==='=='?'selected':''}>==</option>
                            <option value="!=" ${r.op==='!='?'selected':''}>!=</option>
                        </select>`;
                        if (r.op !== 'has') vals = `<input type="number" style="flex:1; width:50px; border: 1px solid #ddd; border-radius: 4px; padding: 4px;" value="${r.val}" onchange="updateExtraReq(${i}, ${rIdx}, 'val', parseInt(this.value))">`;
                    }

                    reqsHTML += `<div style="display:flex; gap:5px; margin-top:5px; align-items:center;">
                        <select style="flex:1; border: 1px solid #ddd; border-radius: 4px; padding: 4px;" onchange="updateExtraReq(${i}, ${rIdx}, 'var', this.value)">
                            <option value="">- Var -</option>
                            ${vOpt.replace(`value="${r.var}"`, `value="${r.var}" selected`)}
                        </select>
                        ${r.var ? ops : ''} ${r.var && vals ? vals : ''}
                        <button class="btn-d" style="width:auto; margin:0; padding:4px 8px;" onclick="removeExtraReq(${i}, ${rIdx})">🗑</button>
                    </div>`;
                });
            }

            reqsHTML += `<button class="btn-s" style="margin-top:8px; font-size:0.6rem; padding:4px; width:100%;" onclick="addExtraReq(${i})">+ Add Condition</button></div>`;

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
        if(t === 'flag') { r.op = '='; r.val = 1; }
        else if(t === 'char' || t === 'npc') { r.op = '='; r.val = ''; }
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
        
        
        let logicSelect = '';
        if (c.reqs && c.reqs.length > 1) {
            logicSelect = `
                <select style="margin-left: 10px; padding: 2px; font-size: 0.65rem; border:1px solid #cbd5e1; border-radius:4px;" onchange="updateChoice(${i}, 'reqLogic', this.value)">
                    <option value="AND" ${c.reqLogic !== 'OR' ? 'selected' : ''}>ALL (AND)</option>
                    <option value="OR" ${c.reqLogic === 'OR' ? 'selected' : ''}>ANY (OR)</option>
                </select>
            `;
        }
        let reqsHTML = `<div style="grid-column: span 2; background:#f8fafc; padding:10px; border-radius:6px; border:1px dashed #cbd5e1;"><label style="font-size:0.65rem; font-weight:bold; color:#475569; display:flex; align-items:center;">Requirements ${logicSelect}</label>`;
        (c.reqs || []).forEach((r, rIdx) => {
            let t = story.globalVars[r.var]?.type;
            let ops = '', vals = '';
            if(t === 'flag') {
                ops = `<select style="flex:1;" onchange="updateReq(${i}, ${rIdx}, 'val', parseInt(this.value))"><option value="1" ${r.val===1?'selected':''}>Is On</option><option value="0" ${r.val===0?'selected':''}>Is Off</option></select>`;
            } else if(t === 'char' || t === 'npc') {
                ops = `<select style="flex:1;" onchange="updateReq(${i}, ${rIdx}, 'op', this.value)"><option value="=" ${r.op==='='?'selected':''}>Is</option><option value="!=" ${r.op==='!='?'selected':''}>Is Not</option></select>`;
                vals = `<input type="text" style="flex:1; width:50px;" value="${r.val}" onchange="updateReq(${i}, ${rIdx}, 'val', this.value)">`;
            } else {
                ops = `<select style="flex:1;" onchange="updateReq(${i}, ${rIdx}, 'op', this.value)"><option value="has" ${r.op==='has'?'selected':''}>Has</option><option value=">=" ${r.op==='>='?'selected':''}>&ge;</option><option value="<=" ${r.op==='<='?'selected':''}>&le;</option><option value="=" ${r.op==='='?'selected':''}>=</option><option value="!=" ${r.op==='!='?'selected':''}>&ne;</option></select>`;
                if(r.op !== 'has') vals = `<input type="number" style="flex:1; width:50px;" value="${r.val}" onchange="updateReq(${i}, ${rIdx}, 'val', parseInt(this.value))">`;
            }
            reqsHTML += `<div style="display:flex; gap:5px; margin-top:5px; align-items:center;">
                <select style="flex:1;" onchange="updateReq(${i}, ${rIdx}, 'var', this.value)"><option value="">- Var -</option>${vOpt.replace(`value="${r.var}"`, `value="${r.var}" selected`)}</select>
                ${r.var ? ops : ''}
                ${r.var && vals ? vals : ''}
                <button class="btn-d" style="width:auto; margin:0; padding:4px 8px;" onclick="removeReq(${i}, ${rIdx})">✕</button>
            </div>`;
        });
        reqsHTML += `<button class="btn-s" style="margin-top:8px; font-size:0.6rem; padding:4px; width:100%;" onclick="addReq(${i})">+ Add Requirement</button></div>`;

        return `<div class="card" style="border: 1px solid #ddd; background:#fafafa; margin-top:10px;"><input value="${c.txt}" oninput="updateChoice(${i}, 'txt', this.value)" placeholder="Choice Text" style="width:100%; margin-bottom:10px; font-weight:bold;"><div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; background:#e2e8f0; padding:15px; border-radius:8px;"><div><label style="font-size:0.6rem; font-weight:bold;">Give</label><select onchange="updateChoice(${i}, 'giveVar', this.value)"><option value="">None</option>${vOpt.replace(`value="${c.giveVar}"`, `value="${c.giveVar}" selected`)}</select><input type="number" value="${c.giveAmt || 0}" onchange="updateChoice(${i}, 'giveAmt', parseInt(this.value))"></div><div><label style="font-size:0.6rem; font-weight:bold;">Take</label><select onchange="updateChoice(${i}, 'takeVar', this.value)"><option value="">None</option>${vOpt.replace(`value="${c.takeVar}"`, `value="${c.takeVar}" selected`)}</select><input type="number" value="${c.takeAmt || 0}" onchange="updateChoice(${i}, 'takeAmt', parseInt(this.value))"></div>${reqsHTML}<div><label style="font-size:0.6rem; font-weight:bold;">Persistence</label><select onchange="updateChoice(${i}, 'persistFlag', this.value)"><option value="">Set Flag On...</option>${vOpt.replace(`value="${c.persistFlag}"`, `value="${c.persistFlag}" selected`)}</select><label class="checkbox-line">Hide if Locked <input type="checkbox" ${c.hideLocked ? 'checked' : ''} onchange="updateChoice(${i}, 'hideLocked', this.checked)"></label></div><div><label style="font-size:0.6rem; font-weight:bold;">Max Uses</label><input type="number" value="${c.maxUses || 0}" onchange="updateChoice(${i}, 'maxUses', parseInt(this.value))"><label class="checkbox-line">Show Count <input type="checkbox" ${c.showUsage !== false ? 'checked' : ''} onchange="updateChoice(${i}, 'showUsage', this.checked)"></label><div style="display:flex; flex-direction:column; gap:4px; margin-top:5px; padding:5px; background:#f1f5f9; border-radius:4px; grid-column: span 2;"><label style="font-size:0.6rem; font-weight:bold; color:#334155;">Time Progression</label><div style="display:flex; gap:10px; align-items:center;"><label style="font-size:0.6rem;">Add Time Phases: <input type="number" style="width:40px; padding:2px;" value="${c.timeAdd !== undefined ? c.timeAdd : (c.passTime===false?0:1)}" onchange="updateChoice(${i}, 'timeAdd', parseInt(this.value))"></label><label style="font-size:0.6rem;">Force Next Day <input type="checkbox" ${c.forceNextDay ? 'checked' : ''} onchange="updateChoice(${i}, 'forceNextDay', this.checked)"></label></div></div></div><div><label style="font-size:0.6rem; font-weight:bold;">Prompt Name Change</label><select onchange="updateChoice(${i}, 'promptChar', this.value)"><option value="">None</option>${cOpt.replace(`value="${c.promptChar}"`, `value="${c.promptChar}" selected`)}</select></div><div style="grid-column: span 2;"><label style="font-size:0.6rem; color:#64748b; font-weight:bold;">Custom Locked Message</label><input style="width:100%; font-size:0.75rem;" placeholder="Default: Locked!" value="${c.lockedMsg || ''}" oninput="updateChoice(${i}, 'lockedMsg', this.value)"></div></div><select style="margin-top:10px; width:100%;" onchange="updateChoice(${i}, 'next', this.value)"><option value="">Stay here...</option>${story.blocks.map(bl => `<option value="${bl.id}" ${bl.id === c.next ? 'selected' : ''}>→ ${bl.id}</option>`).join('')}</select><button class="btn-d" onclick="removeChoice(${i})" style="margin-top:10px; width:100%;">Remove Choice</button></div>`;
    }).join('');
};


window.calcRPGStats = function() {
    let res = {};
    Object.keys(pState.vars).forEach(st => {
        if (pState.vars[st].type === 'stat') {
            let base = pState.vars[st].val;
            let wName = pState.equipped ? pState.equipped.weapon : null;
            let aName = pState.equipped ? pState.equipped.armor : null;
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
        <div style="font-size:0.85rem; margin-bottom:6px; display:flex; justify-content:space-between;"><strong>Weapon:</strong> <span>${w} ${w!=='None'?`<button style="font-size:0.6rem; padding:2px 4px; cursor:pointer; background:#ef4444; color:white; border:none; border-radius:3px;" onclick="unequipItem('weapon')">Unequip</button>`:''}</span></div>
        <div style="font-size:0.85rem; display:flex; justify-content:space-between;"><strong>Armor:</strong> <span>${a} ${a!=='None'?`<button style="font-size:0.6rem; padding:2px 4px; cursor:pointer; background:#ef4444; color:white; border:none; border-radius:3px;" onclick="unequipItem('armor')">Unequip</button>`:''}</span></div>
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
                passivesHtml += `<span style="background:#fef3c7; color:#b45309; padding:4px 8px; border-radius:4px; font-size:0.7rem; border:1px solid #fde68a; font-weight:bold; box-shadow:0 1px 2px rgba(0,0,0,0.05);">⚡ ${k} (${statsText.join(', ')})</span>`;
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
                    actionBtn = `<button style="padding:4px 10px; font-size:0.7rem; background:#3b82f6; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="equipItem('${k}', '${itm.type}')">Equip</button>`;
                } else {
                    actionBtn = `<span style="font-size:0.7rem; color:#10b981; font-weight:bold;">Equipped</span>`;
                }
            } else if (itm.type === 'consumable') {
                actionBtn = `<button style="padding:4px 10px; font-size:0.7rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="consumeItem('${k}')">Use</button>`;
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
                    <div style="font-weight:bold; font-size:0.8rem;">${k} <span style="font-size:0.7rem; color:#64748b; font-weight:normal;">x${count}</span></div>
                    <div style="font-size:0.65rem; color:#475569;">${statsText.join(' | ')}</div>
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

    const b = story.blocks.find(bl => bl.id === pState.bId);
    if (!b) return;

    let combinedText = b.text;
    if (b.extraTexts) {
        b.extraTexts.forEach(extra => {
            // Support legacy format or new multiple-reqs format
            if (extra.reqs && extra.reqs.length > 0) {
                if (window.evaluateReqLogic(extra.reqs, extra.reqLogic, pState.vars)) {
                    combinedText += "\n\n" + extra.text;
                }
            } else if (extra.var) {
                // Fallback for legacy single-condition
                const cur = pState.vars[extra.var]?.val || 0;
                if (window.checkLogic(cur, extra.reqMin, extra.reqMax)) combinedText += "\n\n" + extra.text;
            } else {
                // No conditions
                combinedText += "\n\n" + extra.text;
            }
        });
    }

    for (let k in pState.vars) {
        const v = pState.vars[k];
        combinedText = combinedText.replace(new RegExp(`{${k}}`, 'g'), v.val);
    }

    document.getElementById('p-title').innerText = story.title;
    document.getElementById('p-text').innerHTML = window.parseMarkdown(combinedText);
    
    window.renderInventory();

    const choiceContainer = document.getElementById('p-choices');
    choiceContainer.innerHTML = '';
    
    b.choices.forEach(c => {
        const times = pState.usage[c.id] || 0;
        if (c.maxUses > 0 && times >= c.maxUses) return;

        let met = window.evaluateReqLogic(c.reqs, c.reqLogic, pState.vars);
        if (!c.reqs || c.reqs.length === 0) {
            if (c.reqVar) {
                const cur = pState.vars[c.reqVar]?.val || 0;
                met = window.checkLogic(cur, c.reqMin, c.reqMax);
            }
        }

        const isAlreadyPersistent = c.persistFlag && pState.vars[c.persistFlag]?.val === 1;
        if (isAlreadyPersistent) met = true;

        if (!met && c.hideLocked) return;

        const btn = document.createElement('button');
        btn.className = 'choice-btn';

        let label = c.txt; for(let k in pState.vars) { label = label.replace(new RegExp(`{${k}}`, 'g'), pState.vars[k].val); }
        if (c.maxUses > 0 && c.showUsage !== false) label += ` (${c.maxUses - times} left)`;
        btn.innerText = label;

        btn.onclick = () => {
            if (!met) return window.msg(c.lockedMsg || "Locked!");

            if (c.promptChar && pState.vars[c.promptChar]) { 
                const n = prompt(`Name:`, pState.vars[c.promptChar].val); 
                if (n) pState.vars[c.promptChar].val = n.trim(); 
            }

            if (!isAlreadyPersistent) {
                if (c.persistFlag && pState.vars[c.persistFlag]) {
                    pState.vars[c.persistFlag].val = 1;
                }
                if (c.takeVar && pState.vars[c.takeVar]) {
                    pState.vars[c.takeVar].val -= (c.takeAmt || 0);
                    window.showToast(`- ${c.takeAmt || 0} ${c.takeVar}`, 'bad');
                }
                if (c.giveVar && pState.vars[c.giveVar]) {
                    pState.vars[c.giveVar].val += (c.giveAmt || 0);
                    window.showToast(`+ ${c.giveAmt || 0} ${c.giveVar}`, 'good');
                }
            }

            if (story.useDayCycle && pState.vars['TimeOfDay']) {
                let timeAdd = c.timeAdd !== undefined ? c.timeAdd : (c.passTime === false ? 0 : 1);
    if (timeAdd > 0) window.tickCooldowns(timeAdd);
                let forceNextDay = !!c.forceNextDay;

                // Safe check if Day exists
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
            if (c.next) pState.bId = c.next;
            if (window._forcedBlock) {
                pState.bId = window._forcedBlock;
                window._forcedBlock = null;
            }
            window.renderStep();
        };
        choiceContainer.appendChild(btn);
    });
};

window.addExtraTextField = function() {
    if (!story.blocks[bIdx].extraTexts) story.blocks[bIdx].extraTexts = [];
    story.blocks[bIdx].extraTexts.push({ reqs: [], reqLogic: 'AND', text: '' });
    window.renderEditor();
};
window.updateExtraText = function(i, field, val) { story.blocks[bIdx].extraTexts[i][field] = val; };
window.removeExtraText = function(i) { story.blocks[bIdx].extraTexts.splice(i, 1); window.renderEditor(); };

window.addChoice = function() {
    story.blocks[bIdx].choices.push({ id: Date.now().toString(), txt: 'New Choice', next: '', giveVar: '', giveAmt: 0, takeVar: '', takeAmt: 0, reqs: [], hideLocked: false, maxUses: 0, showUsage: true, persistFlag: '', promptChar: '', lockedMsg: '', timeAdd: 1, forceNextDay: false });
    window.renderChoices();
};
window.updateChoice = function(idx, f, v) { story.blocks[bIdx].choices[idx][f] = v; };
window.removeChoice = function(i) { story.blocks[bIdx].choices.splice(i, 1); window.renderChoices(); };

window.renderNPCSubVars = function(charKey, v) {
    let subHTML = `<div style="background:#f8fafc; border:1px dashed #cbd5e1; margin-top:10px; padding:10px; border-radius:6px;">`;
    for (let sKey in v.stats) {
        subHTML += `<div style="display:flex; gap:5px; margin-bottom:6px; align-items:center;"><input style="flex:1; font-size:0.75rem; padding:4px;" value="${sKey}" onchange="renameNPCStat('${charKey}', '${sKey}', this.value)"><input style="width:50px; font-size:0.75rem; padding:4px;" type="number" value="${v.stats[sKey]}" onchange="story.globalVars['${charKey}'].stats['${sKey}']=parseInt(this.value)"><button onclick="deleteNPCStat('${charKey}', '${sKey}')" style="background:none; border:none; color:#94a3b8;">✕</button></div>`;
    }
    subHTML += `<button class="btn-s" style="width:100%; font-size:0.65rem;" onclick="addNPCStat('${charKey}')">+ Add Stat</button></div>`;
    return subHTML;
};

window.renderVariableHelper = function() { 
    let html = `<div style="margin-top:8px; display:flex; align-items:center; gap:10px; background:#f0f9ff; padding:8px; border-radius:6px; border:1px solid #bae6fd;">
        <label style="font-size:0.7rem; font-weight:bold; color:#0369a1;">Story Text Tools:</label>
        <button class="btn-s" style="font-size:0.7rem; padding:4px 10px; margin:0;" onclick="openVariableInsertModal()">➕ Insert Variable</button>
        <span style="font-size:0.65rem; color:#64748b; margin-left:10px;">Format: **bold**, *italic*, [color:red]text[/color]</span>
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
        <p style="font-size:0.75rem; color:#475569; margin-top:0; margin-bottom:10px;">Select a variable to inject it dynamically into your story text.</p>

        <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:10px; background:#f1f5f9; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
            <div style="display:flex; gap:10px; align-items:center;">
                <label style="font-size:0.8rem; font-weight:bold; color:#334155;">View:</label>
                <select style="flex:1; padding:6px; font-size:0.8rem; border-radius:4px; border:1px solid #94a3b8;" onchange="window.insertVarFilter=this.value; window.renderInsertVarList();">
                    <option value="stat">Stats</option>
                    <option value="item">Items</option>
                    <option value="flag">Flags</option>
                    <option value="npc">NPCs</option>
                </select>
            </div>
            <input type="text" id="insert-var-search" placeholder="Search variables..." oninput="window.filterInsertVarList()" style="padding:6px; font-size:0.8rem; border-radius:4px; border:1px solid #94a3b8; width:100%; box-sizing:border-box;">
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
            <span style="font-size:0.6rem; color:#64748b; text-transform:uppercase;">${effType}</span>
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
    const n = prompt("Name");
    if(n) { story.globalVars[n.trim()] = { type, val: (type==='char'||type==='npc')?'Stranger':0, stats: (type==='char'||type==='npc')?{}:null }; window.renderEditor(); }
};

window.addNPCStat = function(charKey) {
    const s = prompt("Stat Name");
    if(s) { story.globalVars[charKey].stats[s.trim()] = 0; window.renderVarTable(); }
};

window.renameVar = function(oldK, newK) {
    if (newK && oldK !== newK) {
        story.globalVars[newK] = story.globalVars[oldK];
        story.varConfig[newK] = story.varConfig[oldK];
        delete story.globalVars[oldK];
        delete story.varConfig[oldK];
        if (story.rpgItems && story.rpgItems[oldK]) {
            story.rpgItems[newK] = story.rpgItems[oldK];
            delete story.rpgItems[oldK];
        }
        window.renderEditor();
    }
};

window.deleteVar = function(k) {
    if(confirm(`Delete ${k}?`)) { 
        delete story.globalVars[k]; 
        delete story.varConfig[k]; 
        if(story.rpgItems) delete story.rpgItems[k];
        window.renderEditor(); 
    }
};

window.renameNPCStat = function(cK, oldS, newS) { story.globalVars[cK].stats[newS] = story.globalVars[cK].stats[oldS]; delete story.globalVars[cK].stats[oldS]; };
window.deleteNPCStat = function(cK, sK) { delete story.globalVars[cK].stats[sK]; window.renderVarTable(); };
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
            <button class="btn-d" style="flex:1; margin:0; padding:12px; background:#64748b;" onclick="initNewStory(false)">No<br><small style="font-size:0.6rem;">(Visual Novel)</small></button>
            <button class="btn-p" style="flex:1; margin:0; padding:12px; background:#b91c1c;" onclick="initNewStory(true)">Yes<br><small style="font-size:0.6rem;">(Full RPG)</small></button>
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
    window.showScreen('edit-screen');
};

window.loadEditor = async function(i) {
    story = await loadStoryFromDB(storiesList[i].Story_ID);
    bIdx = 0;
    window.renderEditor();
    window.showScreen('edit-screen');
};

window.setActiveBlock = function(i) { bIdx = i; window.renderEditor(); };
window.syncBlockId = function(newName) {
    const old = story.blocks[bIdx].id;
    story.blocks[bIdx].id = newName;
    story.blocks.forEach(blk => blk.choices.forEach(ch => { if (ch.next === old) ch.next = newName; }));
    window.renderEditor();
};

window.addBlock = function() {
    story.blocks.push({ id: 'block_' + Date.now(), text: '', group: story.blocks[bIdx] ? story.blocks[bIdx].group : 'Main', choices: [], extraTexts: [] });
    bIdx = story.blocks.length - 1;
    window.renderEditor();
};

window.removeBlock = function(i) {
    if(confirm("Delete block?")) {
        story.blocks.splice(i, 1);
        if (bIdx >= story.blocks.length) bIdx = story.blocks.length - 1;
        window.renderEditor();
    }
};

window.saveStory = async function() {
    await saveStoryToDB(story);
    await refreshLibrary();
    window.showScreen('dash-screen');
};


window.parseMarkdown = function(text) {
    let html = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
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
        tc.style.cssText = "position:fixed; bottom:20px; right:20px; z-index:10000; display:flex; flex-direction:column; gap:10px; pointer-events:none;";
        document.body.appendChild(tc);
    }
    let toast = document.createElement('div');
    let bg = type === 'good' ? 'rgba(16, 185, 129, 0.9)' : type === 'bad' ? 'rgba(239, 68, 68, 0.9)' : 'rgba(51, 65, 85, 0.9)';
    toast.style.cssText = `background:${bg}; color:white; padding:10px 20px; border-radius:4px; font-size:0.85rem; font-weight:bold; box-shadow:0 4px 6px rgba(0,0,0,0.3); opacity:0; transform:translateY(20px); transition:all 0.3s ease;`;
    toast.innerText = msg;
    tc.appendChild(toast);

    setTimeout(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; }, 10);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 2500);
};

window.playtestCurrentBlock = function() {
    pState = { 
        bId: story.blocks[bIdx].id, 
        vars: JSON.parse(JSON.stringify(story.globalVars)), 
        config: story.varConfig, 
        usage: {}, 
        slot: 0, 
        equipped: {weapon: null, armor: null} 
    };
    window.isPlaytesting = true;

    let pb = document.getElementById('playtest-back-btn');
    if (!pb) {
        pb = document.createElement('button');
        pb.id = 'playtest-back-btn';
        pb.className = 'btn-d';
        pb.style.cssText = "position:absolute; top:10px; right:10px; background:#ef4444; width:auto; z-index:1000; box-shadow:0 4px 10px rgba(0,0,0,0.3); font-weight:bold;";
        pb.innerText = "✖ Exit Test";
        pb.onclick = () => {
            window.isPlaytesting = false;
            window.showScreen('edit-screen');
            pb.style.display = 'none';
        };
        document.getElementById('play-screen').appendChild(pb);
    }
    pb.style.display = 'block';

    window.showScreen('play-screen');
    window.renderStep();
};

window.showScreen = function(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
};

window.msg = function(m) {
    const el = document.getElementById('game-msg');
    el.innerText = m;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 2000);
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

window.importStory = async function(event) {
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
    if (saves.length >= 3) {
        alert("Maximum save slots (3) reached. Please delete an old save to start a new game.");
        window.pmShowContinue();
        return;
    }
    const usedSlots = saves.map(s => s.SlotNumber || 1);
    let slotNum = 1;
    while(usedSlots.includes(slotNum)) slotNum++;
    const entry = story.blocks.find(b => b.id.toLowerCase().includes('starting'));
    pState = { bId: entry ? entry.id : story.blocks[0].id, vars: JSON.parse(JSON.stringify(story.globalVars)), config: story.varConfig, usage: {}, slot: slotNum, equipped: {weapon: null, armor: null} };
    window.pmClose();
    window.showScreen('play-screen');
    window.renderStep();
};

window.pmShowContinue = async function() {
    const saves = await getStoryUserSaves();
    let html = '';
    for (let i = 1; i <= 3; i++) {
        const save = saves.find(s => (s.SlotNumber || 1) === i);
        if (save) {
            html += `<div class="slot-row"><div style="flex:1;"><div style="font-weight:bold; font-size:0.9rem; color:var(--p);">Slot ${i}</div><div style="font-size:0.75rem; color:#475569; font-weight:600;">Block: ${save.CurrentBlock}</div><div style="font-size:0.7rem; color:#94a3b8;">${save.Timestamp || 'Legacy Save'}</div></div><div style="display:flex; gap:8px;"><button class="btn-p" style="padding:6px 12px; font-size:0.8rem; border-radius:4px;" onclick="pmLoadGame(${save.Save_ID}, ${i})">Load</button><button class="btn-d" style="padding:6px 10px; margin:0; font-size:0.8rem; border-radius:4px; width:auto;" onclick="pmDeleteSave(${save.Save_ID})">🗑</button></div></div>`;
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
    pState = { bId: save.CurrentBlock, vars: JSON.parse(save.VariablesJSON), usage: JSON.parse(save.UsageJSON || '{}'), config: story.varConfig, slot: slotNum, equipped: JSON.parse(save.EquippedJSON || '{"weapon":null,"armor":null}') };
    window.pmClose();
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
        const tx = db.transaction('GameSaves', 'readwrite');
        const store = tx.objectStore('GameSaves');
        const saves = await idbReq(store.index('Story_ID').getAll(story.id));
        const userSaves = saves.filter(s => s.User_ID === currentUser.User_ID);

        let slotInfo = [1, 2, 3].map(i => {
            let s = userSaves.find(x => (x.SlotNumber || 1) === i);
            return `Slot ${i}: ${s ? s.CurrentBlock + ' (' + (s.Timestamp || 'Legacy') + ')' : 'Empty'}`;
        }).join('\n');

        let slotInput = prompt("Enter slot to save to (1, 2, or 3):\n\n" + slotInfo, pState.slot || 1);
        if (slotInput === null) return;

        let slotNum = parseInt(slotInput);
        if (isNaN(slotNum) || slotNum < 1 || slotNum > 3) {
            alert("Invalid slot number. Must be 1, 2, or 3.");
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
            EquippedJSON: JSON.stringify(pState.equipped || {}) 
        };

        if (existing) saveObj.Save_ID = existing.Save_ID;
        await idbReq(store.put(saveObj));

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
            <button class="btn-s" style="flex:1; padding:6px; ${window.activeBackpackTab==='items'?'background:#4f46e5;color:white;border-color:#4f46e5;':'color:#cbd5e1;'}" onclick="window.activeBackpackTab='items'; window.renderInventory();">Items</button>
            <button class="btn-s" style="flex:1; padding:6px; ${window.activeBackpackTab==='equip'?'background:#4f46e5;color:white;border-color:#4f46e5;':'color:#cbd5e1;'}" onclick="window.activeBackpackTab='equip'; window.renderInventory();">Equip</button>
            <button class="btn-s" style="flex:1; padding:6px; ${window.activeBackpackTab==='stats'?'background:#4f46e5;color:white;border-color:#4f46e5;':'color:#cbd5e1;'}" onclick="window.activeBackpackTab='stats'; window.renderInventory();">Stats</button>
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
            if (v.type !== 'item' || v.val <= 0) continue;

            const itm = story.rpgItems && story.rpgItems[k] ? story.rpgItems[k] : null;
            // Only show consumables, useables, or general items that aren't gear in the item tab (or show gear too but no equip button)
            if (itm && (itm.type === 'weapon' || itm.type === 'armor')) continue; 

            hasItems = true;
            let meta = `<span style="font-size:0.75rem; color:#fbbf24; font-weight:bold;">x${v.val}</span>`;
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
                        style="padding:4px 10px; margin:0; font-size:0.7rem; border:none; border-radius:4px; ${cd>0 || outOfUses ? 'background:#475569; color:#94a3b8; cursor:not-allowed;' : 'background:#10b981; color:white; cursor:pointer;'}"
                        onclick="${cd>0 || outOfUses ? '' : `window.useRPGItem('${k}')`}"
                    >${label}</button>
                `;

                if (itm.type === 'useable' && itm.maxUses > 0) {
                    meta += ` <span style="font-size:0.7rem; color:#94a3b8;">(${pState.usesLeft[k]}/${itm.maxUses})</span>`;
                }
            }

            html += row(k, `${meta}${button}`);
        }
        if (!hasItems) html += `<div style="font-size:0.8rem; color:#94a3b8; font-style:italic; text-align:center; padding:10px;">No items.</div>`;
    }

    if (window.activeBackpackTab === 'equip') {
        html += row('Weapon', `<span style="color:#fbbf24; font-weight:bold; font-size:0.85rem;">${pState.equipped.weapon || 'None'}</span> ${pState.equipped.weapon ? `<button style="padding:4px 8px; font-size:0.7rem; background:#ef4444; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="window.unequipItem('weapon')">Unequip</button>` : ''}`);
        html += row('Armor', `<span style="color:#fbbf24; font-weight:bold; font-size:0.85rem;">${pState.equipped.armor || 'None'}</span> ${pState.equipped.armor ? `<button style="padding:4px 8px; font-size:0.7rem; background:#ef4444; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="window.unequipItem('armor')">Unequip</button>` : ''}`);

        html += `<div style="margin-top:15px; font-size:0.7rem; color:#94a3b8; font-weight:bold; text-transform:uppercase; border-bottom:1px solid #475569; padding-bottom:4px; margin-bottom:8px;">Available Gear</div>`;
        let hasGear = false;
        for (let k in pState.vars) {
            const v = pState.vars[k];
            const itm = story.rpgItems && story.rpgItems[k] ? story.rpgItems[k] : null;
            if (!itm || v.type !== 'item' || v.val <= 0) continue;
            if (itm.type !== 'weapon' && itm.type !== 'armor') continue;

            const isEquipped = pState.equipped.weapon === k || pState.equipped.armor === k;
            hasGear = true;
            html += row(
                `${k} <span style="font-size:0.65rem; color:#94a3b8;">(${itm.type})</span>`,
                isEquipped
                    ? `<span style="font-size:0.7rem; color:#10b981; font-weight:bold;">Equipped</span>`
                    : `<button style="padding:4px 10px; font-size:0.7rem; font-weight:bold; background:#3b82f6; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="window.equipItem('${k}', '${itm.type}')">Equip</button>`
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

            if (v.type === 'stat') {
                const maxKey = 'Max' + k;
                const val = stats[k] !== undefined ? stats[k] : v.val;
                const txt = pState.vars[maxKey]
                    ? `${val} / ${stats[maxKey] !== undefined ? stats[maxKey] : pState.vars[maxKey].val}`
                    : `${val}`;

                html += row(k, `<span style="color:#10b981; font-weight:bold;">${txt}</span>`);
            } else if (pState.config[k] && v.type === 'flag') {
                // Show HUD flags
                html += row(k, `<span style="color:${v.val > 0 ? '#10b981' : '#94a3b8'}; font-weight:bold;">${v.val > 0 ? 'ON' : 'OFF'}</span>`);
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
