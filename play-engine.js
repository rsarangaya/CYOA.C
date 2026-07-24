/* =========================================================
   CYOA.C standalone play engine
   Runs a single embedded story (window.CYOA_STORY) with no
   editor, accounts, or database. Progress autosaves to
   localStorage. This file is embedded into published .html
   games (see publish-assets.js / the Publish button).
========================================================= */
(function () {
  if (!window.CYOA_STORY) return;
  var story = window.CYOA_STORY;
  var SAVE_KEY = 'cyoa_pub_' + (story.title || 'story').replace(/[^A-Za-z0-9_]/g, '_');
  var pState = null;
  var _guard = 0;

  function $(id) { return document.getElementById(id); }
  function escapeRegExp(s) { return String(s).replace(/[^A-Za-z0-9_ ]/g, function (c) { return '\\' + c; }); }

  function parseMarkdown(text) {
    var html = String(text == null ? '' : text);
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/\[color:(.*?)\](.*?)\[\/color\]/g, '<span style="color:$1">$2</span>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function checkLogic(val, min, max) { return val >= (min || 0) && val <= (max === undefined ? 999999 : max); }

  function evaluateReqLogic(reqs, reqLogic, vars) {
    if (!reqs || reqs.length === 0) return true;
    var results = [];
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      if (!r.var || !vars[r.var]) { results.push(false); continue; }
      var cur = vars[r.var].val;
      var t = vars[r.var].type;
      var ok = true;
      if (t === 'flag') { if (cur !== r.val) ok = false; }
      else if (t === 'char' || t === 'npc') {
        if (r.op === '==' && cur != r.val) ok = false;
        if (r.op === '!=' && cur == r.val) ok = false;
      } else {
        if (r.op === 'has' && cur < 1) ok = false;
        if (r.op === '>=' && cur < r.val) ok = false;
        if (r.op === '<=' && cur > r.val) ok = false;
        if (r.op === '==' && cur != r.val) ok = false;
        if (r.op === '!=' && cur == r.val) ok = false;
        if (r.op === '>' && cur <= r.val) ok = false;
        if (r.op === '<' && cur >= r.val) ok = false;
      }
      results.push(ok);
    }
    if (reqLogic === 'OR') return results.some(function (x) { return x; });
    return results.every(function (x) { return x; });
  }

  function newState(bId, slot) {
    return {
      bId: bId, vars: JSON.parse(JSON.stringify(story.globalVars || {})),
      config: story.varConfig || {}, usage: {}, slot: slot || 0,
      firedEvents: {}, cooldowns: {}, usesLeft: {}, equipped: { weapon: null, armor: null },
      history: []
    };
  }

  function startBlockId() {
    var e = null;
    if (story.startBlock) e = story.blocks.filter(function (b) { return b.id === story.startBlock; })[0];
    if (!e) e = story.blocks.filter(function (b) { return b.id.toLowerCase().indexOf('starting') !== -1; })[0];
    return e ? e.id : (story.blocks[0] ? story.blocks[0].id : null);
  }

  function autosave() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(pState)); } catch (e) {}
  }
  function hasSave() { try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; } }

  function toast(msg, kind) {
    var el = $('game-msg');
    if (!el) return;
    el.textContent = msg;
    el.style.background = kind === 'bad' ? '#ef4444' : (kind === 'good' ? '#10b981' : '#334155');
    el.style.display = 'block';
    clearTimeout(window._pubToast);
    window._pubToast = setTimeout(function () { el.style.display = 'none'; }, 1800);
  }

  function calcRPGStats() {
    var res = {};
    Object.keys(pState.vars).forEach(function (st) {
      if (pState.vars[st].type !== 'stat') return;
      var base = pState.vars[st].val;
      var eq = pState.equipped || {};
      var w = (eq.weapon && story.rpgItems && story.rpgItems[eq.weapon] && pState.vars[eq.weapon] && pState.vars[eq.weapon].val > 0) ? story.rpgItems[eq.weapon] : null;
      var a = (eq.armor && story.rpgItems && story.rpgItems[eq.armor] && pState.vars[eq.armor] && pState.vars[eq.armor].val > 0) ? story.rpgItems[eq.armor] : null;
      var mod = 0;
      if (w && w.stats && w.stats[st]) mod += w.stats[st];
      if (a && a.stats && a.stats[st]) mod += a.stats[st];
      for (var pk in pState.vars) {
        if (pState.vars[pk].type === 'flag' && pState.vars[pk].val > 0) {
          var pm = story.rpgItems && story.rpgItems[pk];
          if (pm && pm.stats && pm.stats[st]) mod += pm.stats[st];
        }
      }
      res[st] = base + mod;
    });
    return res;
  }

  function tickCooldowns(n) {
    if (!pState.cooldowns) pState.cooldowns = {};
    for (var k in pState.cooldowns) { if (pState.cooldowns[k] > 0) { pState.cooldowns[k] -= n; if (pState.cooldowns[k] < 0) pState.cooldowns[k] = 0; } }
  }

  window.pubUse = function (name) {
    var itemVar = pState.vars[name], def = story.rpgItems && story.rpgItems[name];
    if (!itemVar || !def || itemVar.val <= 0) return;
    if (def.type !== 'consumable' && def.type !== 'useable') return;
    if ((pState.cooldowns[name] || 0) > 0) { toast('On cooldown (' + pState.cooldowns[name] + ')', 'bad'); return; }
    if (def.type === 'useable' && def.maxUses > 0) {
      if (pState.usesLeft[name] === undefined) pState.usesLeft[name] = def.maxUses;
      if (pState.usesLeft[name] <= 0) { toast('No uses left.', 'bad'); return; }
    }
    if (def.stats) {
      for (var st in def.stats) {
        if (!pState.vars[st]) continue;
        pState.vars[st].val += def.stats[st];
        var mx = 'Max' + st;
        if (pState.vars[mx]) pState.vars[st].val = Math.min(pState.vars[st].val, pState.vars[mx].val);
        if (pState.vars[st].val < 0) pState.vars[st].val = 0;
      }
    }
    if (def.type === 'consumable') { itemVar.val -= 1; if (itemVar.val < 0) itemVar.val = 0; }
    if (def.type === 'useable' && def.maxUses > 0) { pState.usesLeft[name] -= 1; if (pState.usesLeft[name] < 0) pState.usesLeft[name] = 0; }
    if ((def.cooldown || 0) > 0) pState.cooldowns[name] = def.cooldown;
    toast('Used ' + name, 'good');
    renderStep();
  };
  window.pubEquip = function (name, type) { pState.equipped[type] = name; renderInventory(); autosave(); };
  window.pubUnequip = function (type) { pState.equipped[type] = null; renderInventory(); autosave(); };
  window.pubTab = function (t) { window._pubTab = t; renderInventory(); };

  function renderInventory() {
    var c = $('p-inventory');
    if (!c) return;
    if (!pState.equipped) pState.equipped = { weapon: null, armor: null };
    var tab = window._pubTab || 'items';
    var timePhases = { 1: 'Early morning', 2: 'Morning', 3: 'Noon', 4: 'Afternoon', 5: 'Evening', 6: 'Night' };
    var html = '<div class="pub-tabs">'
      + '<button class="' + (tab === 'items' ? 'on' : '') + '" onclick="pubTab(\'items\')">Items</button>'
      + '<button class="' + (tab === 'equip' ? 'on' : '') + '" onclick="pubTab(\'equip\')">Equip</button>'
      + '<button class="' + (tab === 'stats' ? 'on' : '') + '" onclick="pubTab(\'stats\')">Stats</button></div>';
    function row(l, r) { return '<div class="pub-row"><span>' + l + '</span><span>' + (r || '') + '</span></div>'; }

    if (tab === 'items') {
      var any = false;
      for (var k in pState.vars) {
        var v = pState.vars[k];
        if (!pState.config[k] || v.type !== 'item' || v.val <= 0) continue;
        var itm = story.rpgItems && story.rpgItems[k];
        if (itm && (itm.type === 'weapon' || itm.type === 'armor')) continue;
        any = true;
        var meta = 'x' + v.val, btn = '';
        if (itm && (itm.type === 'consumable' || itm.type === 'useable')) {
          var cd = pState.cooldowns[k] || 0;
          if (itm.type === 'useable' && itm.maxUses > 0 && pState.usesLeft[k] === undefined) pState.usesLeft[k] = itm.maxUses;
          var out = itm.type === 'useable' && itm.maxUses > 0 && (pState.usesLeft[k] || 0) <= 0;
          var lbl = cd > 0 ? ('CD ' + cd) : (out ? '0 uses' : 'Use');
          btn = '<button class="pub-mini" ' + ((cd > 0 || out) ? 'disabled' : 'onclick="pubUse(\'' + k + '\')"') + '>' + lbl + '</button>';
          if (itm.type === 'useable' && itm.maxUses > 0) meta += ' (' + pState.usesLeft[k] + '/' + itm.maxUses + ')';
        }
        html += row(k, meta + ' ' + btn);
      }
      if (!any) html += '<div class="pub-empty">No items.</div>';
    } else if (tab === 'equip') {
      var wN = (pState.equipped.weapon && pState.vars[pState.equipped.weapon] && pState.vars[pState.equipped.weapon].val > 0) ? pState.equipped.weapon : null;
      var aN = (pState.equipped.armor && pState.vars[pState.equipped.armor] && pState.vars[pState.equipped.armor].val > 0) ? pState.equipped.armor : null;
      html += row('Weapon', (wN || 'None') + (wN ? ' <button class="pub-mini" onclick="pubUnequip(\'weapon\')">Unequip</button>' : ''));
      html += row('Armor', (aN || 'None') + (aN ? ' <button class="pub-mini" onclick="pubUnequip(\'armor\')">Unequip</button>' : ''));
      var gear = false;
      for (var g in pState.vars) {
        var gi = story.rpgItems && story.rpgItems[g];
        if (!gi || pState.vars[g].type !== 'item' || pState.vars[g].val <= 0) continue;
        if (gi.type !== 'weapon' && gi.type !== 'armor') continue;
        gear = true;
        var eqd = pState.equipped.weapon === g || pState.equipped.armor === g;
        html += row(g + ' (' + gi.type + ')', eqd ? 'Equipped' : '<button class="pub-mini" onclick="pubEquip(\'' + g + '\',\'' + gi.type + '\')">Equip</button>');
      }
      if (!gear) html += '<div class="pub-empty">No gear.</div>';
    } else {
      var stats = calcRPGStats();
      if (story.useDayCycle && pState.vars.TimeOfDay) {
        html += row('Time', timePhases[pState.vars.TimeOfDay.val] || 'Night');
        html += row('Day', pState.vars.Day ? pState.vars.Day.val : 1);
      }
      for (var s in pState.vars) {
        if (s === 'TimeOfDay' || s === 'Day' || s.indexOf('Max') === 0) continue;
        if (!pState.config[s]) continue;
        var vv = pState.vars[s];
        if (vv.type === 'stat') {
          var mxk = 'Max' + s;
          var val = stats[s] !== undefined ? stats[s] : vv.val;
          html += row(s, pState.vars[mxk] ? (val + ' / ' + (stats[mxk] !== undefined ? stats[mxk] : pState.vars[mxk].val)) : String(val));
        } else if (vv.type === 'flag') { html += row(s, vv.val > 0 ? 'ON' : 'OFF'); }
        else { html += row(s, vv.val); }
      }
    }
    c.innerHTML = html;
  }

  function checkStatEvents() {
    if (!story.statEvents || !story.statEvents.length) return false;
    if (!pState.firedEvents) pState.firedEvents = {};
    var jumped = false;
    for (var i = 0; i < story.statEvents.length; i++) {
      var ev = story.statEvents[i];
      var key = ev.id || ('statEv_' + i);
      if (ev.fireOnce !== false && pState.firedEvents[key]) continue;
      if (!ev.reqVar || !pState.vars[ev.reqVar]) continue;
      var cur = pState.vars[ev.reqVar].val, req = ev.reqVal, pass = false;
      if (ev.reqOp === '>=') pass = cur >= req;
      if (ev.reqOp === '<=') pass = cur <= req;
      if (ev.reqOp === '==') pass = cur === req;
      if (ev.reqOp === '>') pass = cur > req;
      if (ev.reqOp === '<') pass = cur < req;
      if (pass) {
        if (ev.fireOnce !== false) pState.firedEvents[key] = true;
        if (ev.type === 'var' && ev.varName && pState.vars[ev.varName]) pState.vars[ev.varName].val = ev.val;
        else if (ev.type === 'block' && ev.blockName && pState.bId !== ev.blockName) { pState.bId = ev.blockName; jumped = true; }
      }
    }
    return jumped;
  }

  function pushHistory() {
    if (!pState.history) pState.history = [];
    pState.history.push(JSON.stringify({ bId: pState.bId, vars: pState.vars, usage: pState.usage, equipped: pState.equipped, cooldowns: pState.cooldowns, usesLeft: pState.usesLeft, firedEvents: pState.firedEvents }));
    if (pState.history.length > 100) pState.history.shift();
  }
  window.pubBack = function () {
    if (!pState.history || !pState.history.length) return;
    var s = JSON.parse(pState.history.pop());
    pState.bId = s.bId; pState.vars = s.vars; pState.usage = s.usage; pState.equipped = s.equipped;
    pState.cooldowns = s.cooldowns; pState.usesLeft = s.usesLeft; pState.firedEvents = s.firedEvents;
    renderStep();
  };
  window.pubRestart = function () {
    if (!confirm('Restart from the beginning?')) return;
    pState = newState(startBlockId(), pState.slot);
    renderStep();
  };

  function renderStep() {
    var mm = $('game-msg'); if (mm) mm.style.display = 'none';
    _guard++;
    if (_guard < 100 && checkStatEvents()) { renderStep(); _guard = 0; return; }
    _guard = 0;

    var b = story.blocks.filter(function (bl) { return bl.id === pState.bId; })[0];
    if (!b) return;

    var text = b.text;
    (b.extraTexts || []).forEach(function (ex) {
      if (ex.reqs && ex.reqs.length) { if (evaluateReqLogic(ex.reqs, ex.reqLogic, pState.vars)) text += '\n\n' + ex.text; }
      else if (ex.var) { var cur = (pState.vars[ex.var] || {}).val || 0; if (checkLogic(cur, ex.reqMin, ex.reqMax)) text += '\n\n' + ex.text; }
      else text += '\n\n' + ex.text;
    });
    for (var k in pState.vars) text = text.replace(new RegExp('{' + escapeRegExp(k) + '}', 'g'), pState.vars[k].val);

    $('p-title').textContent = story.title;
    $('p-text').innerHTML = parseMarkdown(text);
    renderInventory();

    var cc = $('p-choices');
    cc.innerHTML = '';
    b.choices.forEach(function (c) {
      var times = pState.usage[c.id] || 0;
      if (c.maxUses > 0 && times >= c.maxUses) return;

      var met = (!c.reqs || c.reqs.length === 0) ? true : evaluateReqLogic(c.reqs, c.reqLogic || 'AND', pState.vars);
      if (c.conditionalNext && c.conditionalNext.length) {
        for (var ri = 0; ri < c.conditionalNext.length; ri++) {
          var rule = c.conditionalNext[ri];
          if (rule.reqs && rule.reqs.length && evaluateReqLogic(rule.reqs, rule.reqLogic || 'AND', pState.vars)) { met = true; break; }
        }
      }
      if (c.persistFlag && pState.vars[c.persistFlag] && pState.vars[c.persistFlag].val === 1) met = true;
      var lockMode = c.lockedMode || (c.hideLocked ? 'hide' : 'show');
      if (!met && lockMode === 'hide') return;

      var label = c.txt;
      for (var kk in pState.vars) label = label.replace(new RegExp('{' + escapeRegExp(kk) + '}', 'g'), pState.vars[kk].val);
      if (c.maxUses > 0 && c.showUsage !== false) label += ' (' + (c.maxUses - times) + ' left)';

      var btn = document.createElement('button');
      btn.className = 'pub-choice' + (!met && lockMode === 'lock' ? ' locked' : '');
      btn.textContent = label;
      btn.onclick = function () {
        if (!met) { toast(c.lockedMsg || 'Locked!', 'bad'); return; }
        pushHistory();

        var nextId = c.next, promptChar = c.promptChar, persistFlag = c.persistFlag;
        var defMet = (!c.reqs || c.reqs.length === 0) ? true : evaluateReqLogic(c.reqs, c.reqLogic || 'AND', pState.vars);
        if (!defMet) {
          for (var ri2 = 0; ri2 < (c.conditionalNext || []).length; ri2++) {
            var rl = c.conditionalNext[ri2];
            var bm = (rl.reqs && rl.reqs.length) ? evaluateReqLogic(rl.reqs, rl.reqLogic || 'AND', pState.vars) : false;
            if (bm && rl.next) { nextId = rl.next; if (rl.persistFlag) persistFlag = rl.persistFlag; if (rl.promptChar) promptChar = rl.promptChar; break; }
          }
        }

        if (promptChar && pState.vars[promptChar]) { var nm = prompt('Name:', pState.vars[promptChar].val); if (nm) pState.vars[promptChar].val = nm.trim(); }
        var wasPersistent = !!(persistFlag && pState.vars[persistFlag] && pState.vars[persistFlag].val === 1);

        (c.effects || []).forEach(function (eff) {
          if (!eff.var || !pState.vars[eff.var]) return;
          var before = pState.vars[eff.var].val || 0;
          if (eff.type === 'take') { pState.vars[eff.var].val = Math.max(0, before - (eff.amt || 0)); if (pState.vars[eff.var].val !== before) toast('- ' + (before - pState.vars[eff.var].val) + ' ' + eff.var, 'bad'); }
          else if (eff.type === 'give') { pState.vars[eff.var].val = before + (eff.amt || 0); toast('+ ' + (eff.amt || 0) + ' ' + eff.var, 'good'); }
        });
        if (!wasPersistent && persistFlag && pState.vars[persistFlag]) pState.vars[persistFlag].val = 1;

        if (story.useDayCycle && pState.vars.TimeOfDay) {
          var add = c.timeAdd !== undefined ? c.timeAdd : (c.passTime === false ? 0 : 1);
          if (add > 0) tickCooldowns(add);
          if (!pState.vars.Day) pState.vars.Day = { type: 'stat', val: 1, stats: null };
          var oldDay = pState.vars.Day.val;
          if (c.forceNextDay) { pState.vars.TimeOfDay.val = 1; pState.vars.Day.val += 1; }
          else if (add > 0) { pState.vars.TimeOfDay.val += add; while (pState.vars.TimeOfDay.val > 6) { pState.vars.TimeOfDay.val -= 6; pState.vars.Day.val += 1; } }
          var forced = null;
          if (pState.vars.Day.val > oldDay) {
            for (var d = oldDay + 1; d <= pState.vars.Day.val; d++) {
              (story.dailyEvents || []).forEach(function (ev) {
                if (ev.day === d) {
                  if (ev.type === 'block' && ev.blockName) forced = ev.blockName;
                  else if ((!ev.type || ev.type === 'var') && ev.varName && pState.vars[ev.varName]) pState.vars[ev.varName].val = ev.val;
                }
              });
            }
          }
          if (forced) nextId = forced;
        }

        pState.usage[c.id] = (pState.usage[c.id] || 0) + 1;
        if (nextId) pState.bId = nextId;
        autosave();
        renderStep();
      };
      cc.appendChild(btn);
    });

    if (!cc.children.length) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:24px; text-align:center;';
      if (!b.choices || !b.choices.length) {
        wrap.innerHTML = '<div class="pub-end">— THE END —</div>';
        var rb = document.createElement('button'); rb.className = 'pub-choice'; rb.textContent = '⟳ Play Again'; rb.onclick = window.pubRestart; wrap.appendChild(rb);
      } else {
        wrap.innerHTML = '<div class="pub-empty">No available options right now.</div>';
        if (pState.history && pState.history.length) { var bb = document.createElement('button'); bb.className = 'pub-choice'; bb.textContent = '↩ Go Back'; bb.onclick = window.pubBack; wrap.appendChild(bb); }
      }
      cc.appendChild(wrap);
    }

    var backBtn = $('btn-back');
    if (backBtn) { var has = pState.history && pState.history.length > 0; backBtn.disabled = !has; backBtn.style.opacity = has ? '1' : '0.45'; }
    autosave();
  }

  window.pubNew = function () { pState = newState(startBlockId(), 1); $('start-overlay').style.display = 'none'; renderStep(); };
  window.pubContinue = function () {
    try { pState = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { pState = null; }
    if (!pState) { window.pubNew(); return; }
    if (!pState.equipped) pState.equipped = { weapon: null, armor: null };
    if (!pState.history) pState.history = [];
    $('start-overlay').style.display = 'none';
    renderStep();
  };

  function boot() {
    $('p-title').textContent = story.title;
    var ov = $('start-overlay');
    var cont = $('btn-continue');
    if (cont) cont.style.display = hasSave() ? 'block' : 'none';
    ov.style.display = 'flex';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
