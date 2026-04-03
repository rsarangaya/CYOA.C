window.parseMarkdown = function(text) {
    let html = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/\[color:(.*?)\](.*?)\[\/color\]/g, '<span style="color:$1">$2</span>');
    html = html.replace(/\n/g, '<br>');
    return html;
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


window.getTypeColor = function(t) { return { item: '#f59e0b', stat: '#3b82f6', flag: '#10b981', char: '#a855f7', npc: '#a855f7' }[t] || '#ccc'; };


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