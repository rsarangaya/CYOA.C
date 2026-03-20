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
            
            const uid = await idbReq(store.add({ 
                UserName: user, 
                Password: pass, 
                SecurityQuestion: sq, 
                SecurityAnswer: sa.toLowerCase() 
            }));
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
    } catch (e) { console.error(e); }
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
                <button class="btn-p" onclick="startPlay(${i})">Play</button> 
                <button class="btn-s" onclick="loadEditor(${i})">Edit</button>
                <button class="btn-s" style="background:#dcfce7; color:#166534;" onclick="duplicateStory(${i})">Duplicate</button>
                <button class="btn-d" style="width:auto; margin:0;" onclick="deleteStory(${i})">Delete</button>
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
    
    let memStory = { id: dbStory.Story_ID, title: dbStory.Story_Title, globalVars: {}, varConfig: {}, blocks: [] };

    for (let v of vars) {
        memStory.globalVars[v.Var_Name] = { type: v.Var_Type, val: v.Default_Value, stats: JSON.parse(v.Char_Stats_JSON || '{}') };
        if (v.Is_HUD) memStory.varConfig[v.Var_Name] = true;
    }

    for (let b of blocks) {
        let memBlock = { id: b.Block_Name, text: b.Block_Text, choices: [], extraTexts: [] };
        
        let extras = await idbReq(tx.objectStore('ExtraTexts').index('StoryBlock_ID').getAll(b.StoryBlock_ID));
        for (let e of extras) memBlock.extraTexts.push({ var: e.Req_Var, reqMin: e.Req_Min, reqMax: e.Req_Max, text: e.Text_Content });

        let choices = await idbReq(tx.objectStore('Choices').index('StoryBlock_ID').getAll(b.StoryBlock_ID));
        for (let c of choices) {
            let memChoice = { 
                id: c.Choice_ID.toString(), txt: c.Choice_Text, next: c.Next_Block_Name, 
                reqVar: c.Req_Var, reqMin: c.Req_Min, reqMax: c.Req_Max, 
                hideLocked: c.Hide_Locked, maxUses: c.Max_Uses, showUsage: c.Show_Usage,
                persistFlag: c.Persist_Flag, promptChar: c.Prompt_Char, lockedMsg: c.Locked_Msg,
                giveVar: '', giveAmt: 0, takeVar: '', takeAmt: 0 
            };
            
            let effects = await idbReq(tx.objectStore('ChoiceEffects').index('Choice_ID').getAll(c.Choice_ID));
            for (let eff of effects) {
                if (eff.Effect_Type === 'give') { memChoice.giveVar = eff.Variable_Name; memChoice.giveAmt = eff.Amount; }
                if (eff.Effect_Type === 'take') { memChoice.takeVar = eff.Variable_Name; memChoice.takeAmt = eff.Amount; }
            }
            memBlock.choices.push(memChoice);
        }
        memStory.blocks.push(memBlock);
    }
    return memStory;
}

async function saveStoryToDB(storyObj) {
    const db = await openDB();
    const tx = db.transaction(['Stories', 'StoryBlocks', 'ExtraTexts', 'Choices', 'Variables', 'ChoiceEffects'], 'readwrite');
    
    let sObj = { Story_Title: storyObj.title, Dashboard_ID: currentDashboardId };
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
        tx.objectStore('Variables').add({
            Story_ID: sid, Var_Name: vName, Var_Type: v.type, Default_Value: v.val, Is_HUD: !!storyObj.varConfig[vName], Char_Stats_JSON: JSON.stringify(v.stats || {})
        });
    }

    for (let b of storyObj.blocks) {
        let bid = await idbReq(tx.objectStore('StoryBlocks').add({ Story_ID: sid, Block_Name: b.id, Block_Text: b.text }));
        
        if (b.extraTexts) {
            for (let ext of b.extraTexts) {
                tx.objectStore('ExtraTexts').add({ StoryBlock_ID: bid, Req_Var: ext.var||'', Req_Min: ext.reqMin||0, Req_Max: ext.reqMax||0, Text_Content: ext.text });
            }
        }

        for (let c of b.choices) {
            let cid = await idbReq(tx.objectStore('Choices').add({
                StoryBlock_ID: bid, Choice_Text: c.txt, Next_Block_Name: c.next||'', 
                Req_Var: c.reqVar||'', Req_Min: c.reqMin||0, Req_Max: c.reqMax||100,
                Hide_Locked: !!c.hideLocked, Max_Uses: c.maxUses||0, Show_Usage: c.showUsage !== false,
                Persist_Flag: c.persistFlag||'', Prompt_Char: c.promptChar||'', Locked_Msg: c.lockedMsg||''
            }));
            
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
    let varHTML = `<div style="display:flex; gap:5px; margin-bottom:15px; padding:0 5px;">
        <button class="btn-p" style="flex:1; font-size:0.65rem; padding:8px 2px;" onclick="addTypedVar('item')">+ Item</button>
        <button class="btn-p" style="flex:1; font-size:0.65rem; padding:8px 2px;" onclick="addTypedVar('stat')">+ Stat</button>
        <button class="btn-p" style="flex:1; font-size:0.65rem; padding:8px 2px;" onclick="addTypedVar('flag')">+ Flag</button>
        <button class="btn-p" style="flex:1; font-size:0.65rem; padding:8px 2px;" onclick="addTypedVar('char')">+ Char</button>
    </div>`;

    for (let key in story.globalVars) {
        const v = story.globalVars[key];
        const color = window.getTypeColor(v.type);
        varHTML += `
            <div style="background:white; border-radius:8px; padding:12px; margin-bottom:12px; border-left: 5px solid ${color}; box-shadow: 0 2px 4px rgba(0,0,0,0.1); color: #333;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-size:0.6rem; font-weight:bold; color:${color}; text-transform:uppercase;">${v.type}</span>
                    <label style="font-size:0.65rem; display:flex; align-items:center; gap:4px; cursor:pointer; color:#666;">
                        <input type="checkbox" ${story.varConfig[key] ? 'checked' : ''} onchange="toggleVarVis('${key}', this.checked)"> HUD
                    </label>
                </div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                    <input style="flex:1.5; padding:6px; font-size:0.8rem; border:1px solid #ddd; border-radius:4px;" value="${key}" onchange="renameVar('${key}', this.value)">
                    <div style="flex:1;">${window.renderVarInput(key, v)}</div>
                    <button onclick="deleteVar('${key}')" style="background:#fee2e2; color:#ef4444; border:none; border-radius:4px; padding:6px 10px;">✕</button>
                </div>
                ${v.type === 'char' ? window.renderCharSubVars(key, v) : ''}
            </div>`;
    }
    document.getElementById('ed-var-table').innerHTML = varHTML;
};

window.renderVarInput = function(key, v) {
    const style = `width:100%; padding:6px; font-size:0.8rem; border:1px solid #ddd; border-radius:4px;`;
    if (v.type === 'char') return `<input style="${style}" type="text" value="${v.val}" onchange="story.globalVars['${key}'].val=this.value">`;
    if (v.type === 'flag') return `<select style="${style}" onchange="story.globalVars['${key}'].val=parseInt(this.value)"><option value="0" ${v.val==0?'selected':''}>Off</option><option value="1" ${v.val==1?'selected':''}>On</option></select>`;
    return `<input style="${style}" type="number" value="${v.val}" onchange="story.globalVars['${key}'].val=parseInt(this.value)">`;
};

window.renderEditor = function() {
    const titleInput = document.getElementById('ed-title');
    if (titleInput) {
        titleInput.value = story.title;
        titleInput.oninput = (e) => { story.title = e.target.value; };
    }
    
    const b = story.blocks[bIdx];
    const blockIdInput = document.getElementById('ed-blk-id');
    if (blockIdInput) {
        blockIdInput.value = b.id;
        blockIdInput.onchange = (e) => window.syncBlockId(e.target.value);
    }
    
    document.getElementById('ed-blk-text').value = b.text;
    document.getElementById('ed-blk-text').oninput = (e) => { b.text = e.target.value; };
    
    window.renderVariableHelper(); 
    window.renderVarTable(); 
    window.renderChoices();
    window.renderExtraTextEditor();
    
    document.getElementById('ed-blocks-menu').innerHTML = story.blocks.map((blk, i) => `
        <div class="block-menu-item" style="display:flex; justify-content:space-between; align-items:center; background:${i === bIdx ? 'var(--p)' : '#e5e7eb'}; color:${i === bIdx ? 'white' : 'black'}">
             <span onclick="setActiveBlock(${i})" style="flex-grow:1; cursor:pointer;">${blk.id}</span>
             ${story.blocks.length > 1 ? `<span class="remove-blk-btn" onclick="removeBlock(${i})">✕</span>` : ''}
        </div>
    `).join('');
};

window.getLogicUI = function(prefix, i, obj, type, updateFunc) {
    if (type === 'flag') {
        return `<div class="range-container" style="flex:1;"><span style="font-size:0.7rem; color:#64748b; margin-right:4px;">Is:</span><select style="border:none; flex:1; font-weight:bold; background:transparent;" onchange="${updateFunc}(${i}, 'reqMin', parseInt(this.value)); ${updateFunc}(${i}, 'reqMax', parseInt(this.value));"><option value="1" ${obj.reqMin == 1 ? 'selected' : ''}>On</option><option value="0" ${obj.reqMin == 0 ? 'selected' : ''}>Off</option></select></div>`;
    }
    return `<div class="range-container"><input type="number" class="range-input" value="${obj.reqMin || 0}" onchange="${updateFunc}(${i}, 'reqMin', parseInt(this.value))"><span style="color:#94a3b8; font-weight:bold; font-size:0.8rem;">to</span><input type="number" class="range-input" value="${obj.reqMax || 0}" onchange="${updateFunc}(${i}, 'reqMax', parseInt(this.value))"></div>`;
};

window.checkLogic = function(val, min, max) {
    return val >= (min || 0) && val <= (max === undefined ? 999999 : max);
};

window.renderExtraTextEditor = function() {
    const b = story.blocks[bIdx];
    const vKeys = Object.keys(story.globalVars || {});
    
    let html = `<h4>Conditional Text</h4>`;
    if (b.extraTexts) {
        b.extraTexts.forEach((extra, i) => {
            const vType = story.globalVars[extra.var]?.type;
            html += `
            <div class="card" style="border-left: 4px solid var(--p); background: #fcfcfc;">
                <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items:center;">
                    <select style="flex: 2;" onchange="updateExtraText(${i}, 'var', this.value); renderEditor();">
                        <option value="">-- Variable --</option>
                        ${vKeys.map(v => `<option value="${v}" ${extra.var === v ? 'selected' : ''}>${v}</option>`).join('')}
                    </select>
                    ${window.getLogicUI('extra', i, extra, vType, 'updateExtraText')}
                    <button class="btn-d" style="width: auto; margin:0; padding:5px 10px;" onclick="removeExtraText(${i})">✕</button>
                </div>
                <textarea rows="2" style="width:100%;" placeholder="Text to show..." oninput="updateExtraText(${i}, 'text', this.value)">${extra.text}</textarea>
            </div>`;
        });
    }
    html += `<button class="btn-s" style="width: 100%;" onclick="addExtraTextField()">+ Add Conditional Text</button>`;
    document.getElementById('extra-text-container').innerHTML = html;
};

window.renderChoices = function() {
    const b = story.blocks[bIdx];
    const vOpt = Object.keys(story.globalVars || {}).map(v => `<option value="${v}">${v}</option>`).join('');
    const cOpt = Object.keys(story.globalVars || {}).filter(k => story.globalVars[k].type === 'char').map(v => `<option value="${v}">${v}</option>`).join('');

    document.getElementById('ed-choices').innerHTML = b.choices.map((c, i) => {
        const vType = story.globalVars[c.reqVar]?.type;
        return `
        <div class="card" style="border: 1px solid #ddd; background:#fafafa; margin-top:10px;">
            <input value="${c.txt}" oninput="updateChoice(${i}, 'txt', this.value)" placeholder="Choice Text" style="width:100%; margin-bottom:10px; font-weight:bold;">
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; background:#e2e8f0; padding:15px; border-radius:8px;">
                <div><label style="font-size:0.6rem; font-weight:bold;">Give</label><select onchange="updateChoice(${i}, 'giveVar', this.value)"><option value="">(None)</option>${vOpt.replace(`value="${c.giveVar}"`, `value="${c.giveVar}" selected`)}</select><input type="number" value="${c.giveAmt || 0}" onchange="updateChoice(${i}, 'giveAmt', parseInt(this.value))"></div>
                <div><label style="font-size:0.6rem; font-weight:bold;">Take</label><select onchange="updateChoice(${i}, 'takeVar', this.value)"><option value="">(None)</option>${vOpt.replace(`value="${c.takeVar}"`, `value="${c.takeVar}" selected`)}</select><input type="number" value="${c.takeAmt || 0}" onchange="updateChoice(${i}, 'takeAmt', parseInt(this.value))"></div>
                
                <div>
                    <label style="font-size:0.6rem; font-weight:bold;">Requirement (Range)</label>
                    <select onchange="updateChoice(${i}, 'reqVar', this.value); renderEditor();" style="margin-bottom:5px;">
                        <option value="">(None)</option>
                        ${vOpt.replace(`value="${c.reqVar}"`, `value="${c.reqVar}" selected`)}
                    </select>
                    ${window.getLogicUI('choice', i, c, vType, 'updateChoice')}
                </div>

                <div>
                    <label style="font-size:0.6rem; font-weight:bold;">Persistence</label>
                    <select onchange="updateChoice(${i}, 'persistFlag', this.value)">
                        <option value="">(Set Flag On...)</option>
                        ${vOpt.replace(`value="${c.persistFlag}"`, `value="${c.persistFlag}" selected`)}
                    </select>
                    <label class="checkbox-line">Hide if Locked <input type="checkbox" ${c.hideLocked ? 'checked' : ''} onchange="updateChoice(${i}, 'hideLocked', this.checked)"></label>
                </div>

                <div>
                    <label style="font-size:0.6rem; font-weight:bold;">Max Uses</label>
                    <input type="number" value="${c.maxUses || 0}" onchange="updateChoice(${i}, 'maxUses', parseInt(this.value))">
                    <label class="checkbox-line">Show Count <input type="checkbox" ${c.showUsage !== false ? 'checked' : ''} onchange="updateChoice(${i}, 'showUsage', this.checked)"></label>
                </div>
                
                <div><label style="font-size:0.6rem; font-weight:bold;">Prompt Name Change</label><select onchange="updateChoice(${i}, 'promptChar', this.value)"><option value="">(None)</option>${cOpt.replace(`value="${c.promptChar}"`, `value="${c.promptChar}" selected`)}</select></div>
                
                <div style="grid-column: span 2;">
                    <label style="font-size:0.6rem; color:#64748b; font-weight:bold;">Custom Locked Message</label>
                    <input style="width:100%; font-size:0.75rem;" placeholder="Default: Locked!" value="${c.lockedMsg || ''}" oninput="updateChoice(${i}, 'lockedMsg', this.value)">
                </div>
            </div>
            <select style="margin-top:10px; width:100%;" onchange="updateChoice(${i}, 'next', this.value)"><option value="">Stay here...</option>${story.blocks.map(bl => `<option value="${bl.id}" ${bl.id === c.next ? 'selected' : ''}>${bl.id}</option>`).join('')}</select>
            <button class="btn-d" onclick="removeChoice(${i})" style="margin-top:10px; width:100%;">Remove Choice</button>
        </div>`}).join('');
};

window.renderStep = function() {
    const b = story.blocks.find(bl => bl.id === pState.bId);
    if (!b) return;

    let combinedText = b.text;
    if (b.extraTexts) {
        b.extraTexts.forEach(extra => {
            const cur = pState.vars[extra.var]?.val || 0;
            if (window.checkLogic(cur, extra.reqMin, extra.reqMax)) combinedText += "\n\n" + extra.text;
        });
    }

    for (let k in pState.vars) {
        const v = pState.vars[k];
        combinedText = combinedText.replace(new RegExp(`{${k}}`, 'g'), v.val);
    }

    document.getElementById('p-title').innerText = story.title;
    document.getElementById('p-text').innerText = combinedText;
    
    let sHTML = "";
    for(let k in pState.vars) if(pState.config[k]) { 
        const v = pState.vars[k]; 
        sHTML += `<div class="var-tag" style="background:${window.getTypeColor(v.type)};">${v.type === 'char' ? v.val : k + ': ' + v.val}</div>`; 
    }
    document.getElementById('p-inventory').innerHTML = sHTML;

    const choiceContainer = document.getElementById('p-choices');
    choiceContainer.innerHTML = '';
    
    b.choices.forEach(c => {
        const times = pState.usage[c.id] || 0;
        if (c.maxUses > 0 && times >= c.maxUses) return;

        let met = true;
        if (c.reqVar) {
            const cur = pState.vars[c.reqVar]?.val || 0;
            met = window.checkLogic(cur, c.reqMin, c.reqMax);
        }

        const isAlreadyPersistent = c.persistFlag && pState.vars[c.persistFlag]?.val === 1;
        if (isAlreadyPersistent) met = true;

        if (!met && c.hideLocked) return;

        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        if (!met) btn.classList.add('locked');
        
        let label = c.txt;
        if (c.maxUses > 0 && c.showUsage !== false) label += ` (${c.maxUses - times} left)`;
        btn.innerText = label;

        btn.onclick = () => {
            if (!met) return window.msg(c.lockedMsg || "Locked!");

            if (c.promptChar && pState.vars[c.promptChar]) { 
                const n = prompt(`Name:`, pState.vars[c.promptChar].val); 
                if (n) pState.vars[c.promptChar].val = n.trim(); 
            }

            if (!isAlreadyPersistent) {
                if (c.persistFlag && pState.vars[c.persistFlag]) pState.vars[c.persistFlag].val = 1;
                if (c.takeVar && pState.vars[c.takeVar]) pState.vars[c.takeVar].val -= (c.takeAmt || 0);
                if (c.giveVar && pState.vars[c.giveVar]) pState.vars[c.giveVar].val += (c.giveAmt || 0);
            }
            
            pState.usage[c.id] = (pState.usage[c.id] || 0) + 1;
            if (c.next) pState.bId = c.next;
            window.renderStep();
        };
        choiceContainer.appendChild(btn);
    });
};

/* --- EDITOR & MISC EVENT HANDLERS --- */
window.addExtraTextField = function() { if (!story.blocks[bIdx].extraTexts) story.blocks[bIdx].extraTexts = []; story.blocks[bIdx].extraTexts.push({ var: '', reqMin: 1, reqMax: 1, text: '' }); window.renderEditor(); };
window.updateExtraText = function(i, field, val) { story.blocks[bIdx].extraTexts[i][field] = val; };
window.removeExtraText = function(i) { story.blocks[bIdx].extraTexts.splice(i, 1); window.renderEditor(); };
window.addChoice = function() { story.blocks[bIdx].choices.push({ id: Date.now().toString(), txt: 'New Choice', next: '', giveVar: '', giveAmt: 0, takeVar: '', takeAmt: 0, reqVar: '', reqMin: 0, reqMax: 100, hideLocked: false, maxUses: 0, showUsage: true, persistFlag: '', promptChar: '', lockedMsg: '' }); window.renderChoices(); };
window.updateChoice = function(idx, f, v) { story.blocks[bIdx].choices[idx][f] = v; };
window.removeChoice = function(i) { story.blocks[bIdx].choices.splice(i, 1); window.renderChoices(); };
window.renderCharSubVars = function(charKey, v) { let subHTML = `<div style="background:#f8fafc; border:1px dashed #cbd5e1; margin-top:10px; padding:10px; border-radius:6px;">`; for (let sKey in v.stats) { subHTML += `<div style="display:flex; gap:5px; margin-bottom:6px; align-items:center;"><input style="flex:1; font-size:0.75rem; padding:4px;" value="${sKey}" onchange="renameCharStat('${charKey}', '${sKey}', this.value)"><input style="width:50px; font-size:0.75rem; padding:4px;" type="number" value="${v.stats[sKey]}" onchange="story.globalVars['${charKey}'].stats['${sKey}']=parseInt(this.value)"><button onclick="deleteCharStat('${charKey}', '${sKey}')" style="background:none; border:none; color:#94a3b8;">✕</button></div>`; } subHTML += `<button class="btn-s" style="width:100%; font-size:0.65rem;" onclick="addCharStat('${charKey}')">+ Add Stat</button></div>`; return subHTML; };
window.renderVariableHelper = function() { const varKeys = Object.keys(story.globalVars); let html = `<div style="margin-top:8px; display:flex; align-items:center; gap:10px; background:#f0f9ff; padding:8px; border-radius:6px; border:1px solid #bae6fd;"><label style="font-size:0.7rem; font-weight:bold; color:#0369a1;">Insert:</label><select style="font-size:0.7rem; padding:4px;" onchange="insertVarAtCursor(this.value); this.value='';"><option value="">-- Var --</option>${varKeys.map(k => `<option value="{${k}}">${k}</option>`).join('')}</select></div>`; document.getElementById('var-helper-container').innerHTML = html; };
window.insertVarAtCursor = function(val) { const txt = document.getElementById('ed-blk-text'); const start = txt.selectionStart; txt.value = txt.value.substring(0, start) + val + txt.value.substring(txt.selectionEnd); story.blocks[bIdx].text = txt.value; txt.focus(); };
window.getTypeColor = function(t) { return { item: '#f59e0b', stat: '#3b82f6', flag: '#10b981', char: '#a855f7' }[t] || '#ccc'; };
window.addTypedVar = function(type) { const n = prompt("Name:"); if(n) { story.globalVars[n.trim()] = { type, val: type==='char'?'Stranger':0, stats: type==='char'?{}:null }; window.renderEditor(); } };
window.addCharStat = function(charKey) { const s = prompt("Stat Name:"); if(s) { story.globalVars[charKey].stats[s.trim()] = 0; window.renderVarTable(); } };
window.renameVar = function(oldK, newK) { if (newK && oldK !== newK) { story.globalVars[newK] = story.globalVars[oldK]; story.varConfig[newK] = story.varConfig[oldK]; delete story.globalVars[oldK]; delete story.varConfig[oldK]; window.renderEditor(); } };
window.deleteVar = function(k) { if(confirm(`Delete ${k}?`)) { delete story.globalVars[k]; delete story.varConfig[k]; window.renderEditor(); } };
window.renameCharStat = function(cK, oldS, newS) { story.globalVars[cK].stats[newS] = story.globalVars[cK].stats[oldS]; delete story.globalVars[cK].stats[oldS]; };
window.deleteCharStat = function(cK, sK) { delete story.globalVars[cK].stats[sK]; window.renderVarTable(); };
window.toggleVarVis = function(k, v) { story.varConfig[k] = v; };

window.openEditor = function() { story = { id: null, title: "New Game", blocks: [{ id: 'starting room', text: "Start here...", choices: [], extraTexts: [] }], globalVars: {}, varConfig: {} }; bIdx = 0; window.renderEditor(); window.showScreen('edit-screen'); };
window.loadEditor = async function(i) { story = await loadStoryFromDB(storiesList[i].Story_ID); bIdx = 0; window.renderEditor(); window.showScreen('edit-screen'); };
window.setActiveBlock = function(i) { bIdx = i; window.renderEditor(); };
window.syncBlockId = function(newName) { const old = story.blocks[bIdx].id; story.blocks[bIdx].id = newName; story.blocks.forEach(blk => blk.choices.forEach(ch => { if (ch.next === old) ch.next = newName; })); window.renderEditor(); };
window.addBlock = function() { story.blocks.push({ id: 'block_' + Date.now(), text: '', choices: [], extraTexts: [] }); bIdx = story.blocks.length - 1; window.renderEditor(); };
window.removeBlock = function(i) { if(confirm(`Delete block?`)) { story.blocks.splice(i, 1); if (bIdx >= story.blocks.length) bIdx = story.blocks.length - 1; window.renderEditor(); } };
window.saveStory = async function() { await saveStoryToDB(story); await refreshLibrary(); window.showScreen('dash-screen'); };
window.showScreen = function(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); document.getElementById(id).classList.add('active'); };
window.msg = function(m) { const el = document.getElementById('game-msg'); el.innerText = m; el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 2000); };

window.triggerImport = function() { document.getElementById('file-in').click(); };
window.exportStory = function() { if (!story) return; const b = new Blob([JSON.stringify(story, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${story.title.replace(/\s+/g, '_')}.json`; a.click(); };
window.importStory = async function(event) { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = async (e) => { try { const imp = JSON.parse(e.target.result); const nS = Array.isArray(imp) ? imp : [imp]; for (let s of nS) { s.id = null; await saveStoryToDB(s); } await refreshLibrary(); window.msg("Imported!"); event.target.value = ""; } catch (err) { alert("Failed import."); } }; reader.readAsText(file); };

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
window.pmBackToMain = function() {
    document.getElementById('pm-main-view').style.display = 'block';
    document.getElementById('pm-slots-view').style.display = 'none';
};

window.pmNewGame = async function() {
    const saves = await getStoryUserSaves();
    if (saves.length >= 3) {
        alert("Maximum save slots (3) reached. Please delete an old save to start a new game.");
        window.pmShowContinue(); 
        return;
    }
    
    // Find the lowest available slot number (1, 2, or 3)
    const usedSlots = saves.map(s => s.Slot_Number || 1);
    let slotNum = 1;
    while(usedSlots.includes(slotNum)) slotNum++;

    const entry = story.blocks.find(b => b.id.toLowerCase().includes("starting")); 
    pState = { 
        bId: entry ? entry.id : story.blocks[0].id, 
        vars: JSON.parse(JSON.stringify(story.globalVars || {})), 
        config: story.varConfig || {}, 
        usage: {},
        slot: slotNum
    };
    
    window.pmClose();
    window.showScreen('play-screen'); 
    window.renderStep(); 
};

window.pmShowContinue = async function() {
    const saves = await getStoryUserSaves();
    let html = '';
    
    for (let i = 1; i <= 3; i++) {
        const save = saves.find(s => (s.Slot_Number || 1) === i);
        if (save) {
            html += `
            <div class="slot-row">
                <div style="flex:1;">
                    <div style="font-weight:bold; font-size:0.9rem; color:var(--p);">Slot ${i}</div>
                    <div style="font-size:0.75rem; color:#475569; font-weight:600;">Block: ${save.Current_Block}</div>
                    <div style="font-size:0.7rem; color:#94a3b8;">${save.Timestamp || 'Legacy Save'}</div>
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="btn-p" style="padding:6px 12px; font-size:0.8rem; border-radius:4px;" onclick="pmLoadGame(${save.Save_ID}, ${i})">Load</button>
                    <button class="btn-d" style="padding:6px 10px; margin:0; font-size:0.8rem; border-radius:4px; width:auto;" onclick="pmDeleteSave(${save.Save_ID})">✕</button>
                </div>
            </div>`;
        } else {
            html += `
            <div class="slot-row" style="background:#f1f5f9; justify-content:center; color:#94a3b8; font-size:0.85rem;">
                - Empty Slot ${i} -
            </div>`;
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

    pState = { 
        bId: save.Current_Block, 
        vars: JSON.parse(save.Variables_JSON), 
        usage: JSON.parse(save.Usage_JSON || '{}'), 
        config: story.varConfig || {},
        slot: slotNum
    };
    
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
        const existing = userSaves.find(s => (s.Slot_Number || 1) === pState.slot);
        
        let saveObj = { 
            User_ID: currentUser.User_ID, 
            Story_ID: story.id, 
            Slot_Number: pState.slot || 1,
            Timestamp: new Date().toLocaleString(),
            Current_Block: pState.bId, 
            Variables_JSON: JSON.stringify(pState.vars), 
            Usage_JSON: JSON.stringify(pState.usage) 
        };
        
        if (existing) saveObj.Save_ID = existing.Save_ID;
        
        await idbReq(store.put(saveObj));
        
        const msg = document.getElementById('save-msg');
        msg.style.display = 'block'; 
        setTimeout(()=> msg.style.display = 'none', 2000);
        
    } catch (err) {
        console.error("Error saving game:", err);
        alert("Failed to save progress to database.");
    }
};
