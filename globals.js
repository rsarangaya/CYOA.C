var currentUser = null, currentDashboardId = null;
var storiesList = [], story = null, bIdx = 0;
var pState = { bId: null, vars: {}, config: {}, usage: {}, slot: 1 };
var authMode = "signin";
var recoveryUserRecord = null;