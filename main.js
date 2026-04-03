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