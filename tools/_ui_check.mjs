
const $ = (id) => document.getElementById(id);
let state = null, providersData = [], routesData = [];

const CHANNELS = [
  { id:'buddy', name:'WorkBuddy 国内版', org:'腾讯', note:'与 CodeBuddy 共用端点，DeepSeek / Kimi / GLM 免费线', url:'https://copilot.tencent.com' },
  { id:'workbuddy', name:'WorkBuddy 国际版', org:'腾讯', note:'独立账号体系，积分与国内版不互通', url:'https://www.workbuddy.ai' },
  { id:'codearts', name:'CodeArts', org:'华为云', note:'免费体验套餐，DeepSeek / GLM / openPangu 每日额度', url:'https://devcloud.cn-north-4.huaweicloud.com/codeartside/home' },
  { id:'lobsterai', name:'LobsterAI', org:'有道', note:'每日签到领积分，积分换模型额度', url:'https://lobsterai.youdao.com' },
  { id:'qoder', name:'Qoder 国际版', org:'阿里云', note:'每日 100 Credits', url:'https://qoder.com' },
  { id:'qodercn', name:'Qoder 国内版', org:'阿里云', note:'每日 100 Credits，国内端点', url:'https://qoder.com.cn' },
  { id:'trae', name:'TRAE', org:'字节跳动', note:'手机号注册送免费额度，按天重置', url:'https://www.trae.ai' },
  { id:'cline', name:'Cline', org:'Cline Bot', note:'绑定 GitHub 后送美元额度', url:'https://app.cline.bot' },
  { id:'loomy', name:'Loomy', org:'讯飞星火', note:'每日免费额度', url:'https://loomy.xunfei.cn' },
  { id:'raccoon', name:'Raccoon', org:'Raccoon', note:'免费额度按天重置', url:'https://raccoon.ai' },
  { id:'minimax', name:'MiniMax Code', org:'MiniMax', note:'每日免费额度', url:'https://www.minimaxi.com' },
  { id:'zcode', name:'ZCode', org:'智谱', note:'GLM 系列免费线', url:'https://zcode.bigmodel.cn' },
  { id:'gemini', name:'Gemini', org:'Google', note:'免费额度按天重置', url:'https://gemini.google.com' },
];

function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { location.replace('login'); throw new Error('需要登录'); }
  return res;
}

const fmt = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0));
const fmtCredit = (n) => (n >= 100 ? Math.round(n) : (Math.round(n * 100) / 100).toString());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
function timeLeft(ms) { const s = Math.round(ms / 1000); if (s < 60) return s + ' 秒'; if (s < 3600) return Math.round(s / 60) + ' 分'; return (s / 3600).toFixed(1) + ' 小时'; }

$('nav').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-tab]');
  if (!btn) return;
  const tab = btn.dataset.tab;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b === btn));
  ['pool','providers','channels','stats','routes','gateway'].forEach((s) => $('tab-' + s).classList.toggle('hide', s !== tab));
  if (tab === 'providers' && providersData.length === 0) loadProviders();
  if (tab === 'routes' && routesData.length === 0) loadRoutes();
  if (tab === 'gateway') loadGateway();
  if (tab === 'channels') renderChannels();
});

function renderAccounts(accounts) {
  const box = $('accounts');
  if (!accounts.length) { box.innerHTML = '<div class="empty">池里还没有账号。<br>点「＋ 导入账号」粘贴凭据，或在本机双击 WB Pool 同步。</div>'; return; }
  box.innerHTML = accounts.map((a) => {
    const cooling = a.cooldownMs > 0, dead = a.cooldownReason === 'dead';
    const initial = (a.label || '?').replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '').slice(-2) || 'WB';
    return `<div class="acct">
      <div class="avatar ${cooling ? 'cool' : ''}">${esc(initial)}</div>
      <div class="main">
        <div class="name">${esc(a.label)}
          <span class="badge region">${a.region === 'global' ? '国际版' : '国内版'}</span>
          ${cooling ? `<span class="badge ${dead ? 'dead' : 'cool'}">${dead ? '凭据失效' : '冷却 ' + timeLeft(a.cooldownMs)}</span>` : '<span class="badge">可用</span>'}
        </div>
        <div class="meta">
          <span>${a.checkin ? `连续 ${a.checkin.streakDays} 天 · 今日${a.checkin.todayCheckedIn ? '已签' : '未签'}` : '签到未查'}</span>
          <span>·</span><span>令牌 ${a.expiresAt ? new Date(a.expiresAt).toLocaleDateString('zh-CN') : '-'}</span>
          <span>·</span><span>请求 ${a.requestCount}</span>
        </div>
      </div>
      <div class="right">
        <div class="credits">${a.credits ? fmtCredit(a.credits.total) : '—'}<small>分</small></div>
        <button class="sm ghost" onclick="renameAccount('${esc(a.id)}','${esc(a.label)}')">改名</button>
        <button class="sm danger" onclick="removeAccount('${esc(a.id)}','${esc(a.label)}')">删除</button>
      </div>
    </div>`;
  }).join('');
}

async function renameAccount(id, old) {
  const label = prompt('新的备注名', old);
  if (!label || label === old) return;
  await api('api/accounts/rename', { method: 'POST', body: JSON.stringify({ id, label }) });
  toast('已改名'); refresh();
}

async function removeAccount(id, label) {
  if (!confirm(`确定从池里删除「${label}」？`)) return;
  const res = await api('api/accounts/remove', { method: 'POST', body: JSON.stringify({ id }) });
  const d = await res.json();
  toast(d.ok ? '已删除' : '删除失败'); refresh();
}

/**
 * 从本机刷新。
 *
 * 网页读不到本机磁盘，所以这里用自定义协议 wbpool:// 唤起本机的静默同步器
 * （计划的 exe，无窗口），它扫完会把账号推到云端；这边轮询等结果。
 */
let syncBusy = false;
function syncFromLocal(closeId) {
  if (syncBusy) { toast('正在同步中…'); return; }
  syncBusy = true;
  const before = state?.accounts?.length ?? 0;
  const beforeIds = new Set((state?.accounts || []).map((a) => a.id));
  toast('正在扫描本机 WorkBuddy 账号…', 6000);

  // 用隐藏 iframe 触发自定义协议，避免页面被导航走
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    f.src = 'wbpool://sync';
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 4000);
  } catch (e) { /* 协议不可用就走下面的降级提示 */ }

  let n = 0;
  const timer = setInterval(async () => {
    n++;
    await refresh(false);
    const now = state?.accounts || [];
    const added = now.filter((a) => !beforeIds.has(a.id));
    if (added.length > 0) {
      clearInterval(timer);
      syncBusy = false;
      if (closeId) closeModal(closeId);
      toast(`已添加 ${added.length} 个账号：${added.map((a) => a.label).join('、')}`, 6000);
      return;
    }
    if (n >= 10) {
      clearInterval(timer);
      syncBusy = false;
      toast('没等到新账号。请双击桌面「WB Pool」，或在浏览器提示时允许打开外部程序', 8000);
    }
  }, 2000);
}

function openImport() { $('modal-import').classList.add('on'); $('imp-raw').focus(); }
function closeModal(id) { $(id).classList.remove('on'); }

async function doImport() {
  const raw = $('imp-raw').value.trim();
  if (!raw) { toast('请先粘贴内容'); return; }
  toast('正在导入并验证…', 8000);
  try {
    const res = await api('api/accounts/import', { method: 'POST', body: JSON.stringify({ raw, label: $('imp-label').value.trim() }) });
    const d = await res.json();
    if (!res.ok || d.ok === false) { toast('导入失败：' + (d.error || res.status)); return; }
    closeModal('modal-import');
    $('imp-raw').value = ''; $('imp-label').value = '';
    toast(`导入成功（池内 ${d.total} 个）· ${d.probe}`, 4000);
    refresh();
  } catch (e) { toast('导入失败：' + e.message); }
}

function renderAutomation(a) {
  const rows = [], t = a?.today;
  [['checkin','签到'],['rewards','补偿'],['tasks','任务奖励']].forEach(([key, label]) => {
    const v = t?.[key];
    rows.push(v
      ? `<div class="auto-row"><span class="t">${new Date(v.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}</span><span class="r">${label}</span><span class="gain">+${v.credit || 0}</span></div>`
      : `<div class="auto-row"><span class="t">-</span><span class="r" style="color:var(--dimmer)">${label} 今日未跑</span></div>`);
  });
  (a?.recent || []).slice(-5).reverse().forEach((day) => {
    const total = (day.checkin?.credit || 0) + (day.rewards?.credit || 0) + (day.tasks?.credit || 0);
    if (total) rows.push(`<div class="auto-row"><span class="t">${day.date.slice(5)}</span><span class="r">当日收益</span><span class="gain">+${total}</span></div>`);
  });
  $('automation').innerHTML = rows.join('');
  $('auto-tag').textContent = a?.enabled ? `每日 ${a.checkinAt}` : '已关闭';
}

async function loadProviders() {
  try {
    const res = await api('api/providers');
    const d = await res.json();
    providersData = d.providers || [];
    $('n-pv').textContent = providersData.filter((p) => p.enabled).length + '/' + providersData.length;
    renderProviders();
  } catch (e) { $('providers').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; }
}

function renderProviders() {
  const q = ($('pv-search').value || '').toLowerCase();
  const f = $('pv-filter').value;
  let list = providersData;
  if (q) list = list.filter((p) => (p.name + p.id + (p.notes || '')).toLowerCase().includes(q));
  if (f === 'on') list = list.filter((p) => p.enabled);
  if (f === 'key') list = list.filter((p) => p.hasKey);
  if (!list.length) { $('providers').innerHTML = '<div class="empty">没有匹配的渠道</div>'; return; }
  $('providers').innerHTML = list.slice(0, 120).map((p) => `
    <div class="pv-item ${p.enabled ? 'on' : ''}">
      <div class="pv-top"><span class="pv-name">${esc(p.name)}</span>
        ${p.enabled ? '<span class="badge">已启用</span>' : p.hasKey ? '<span class="badge cool">待启用</span>' : '<span class="badge off">未配置</span>'}
      </div>
      <div class="pv-meta" title="${esc(p.baseUrl)}">${esc(p.baseUrl || '-')}</div>
      <div class="pv-acts">
        <input placeholder="粘贴 API Key" onkeydown="if(event.key==='Enter')saveProvider('${esc(p.id)}',this.value,true)">
        <button class="sm" onclick="saveProvider('${esc(p.id)}',this.previousElementSibling.value,true)">保存</button>
      </div>
      <div class="pv-acts">
        <button class="sm ghost" onclick="saveProvider('${esc(p.id)}','',${p.enabled ? 'false' : 'true'})">${p.enabled ? '停用' : '启用'}</button>
        <button class="sm ghost" onclick="testProvider('${esc(p.id)}')">测试</button>
        <span style="font-size:10.5px;color:var(--dimmer);margin-left:auto">${p.models.length} 模型</span>
      </div>
    </div>`).join('');
}

async function saveProvider(id, apiKey, enabled) {
  const body = { id, enabled };
  if (apiKey) body.apiKey = apiKey;
  const res = await api('api/providers', { method: 'POST', body: JSON.stringify(body) });
  const d = await res.json();
  if (!res.ok) { toast('保存失败：' + (d.error || res.status)); return; }
  toast('已保存'); await loadProviders();
}

async function testProvider(id) {
  toast('测试中…', 15000);
  const res = await api('api/providers/test', { method: 'POST', body: JSON.stringify({ id }) });
  const d = await res.json();
  toast(d.ok ? `通了（${d.ms}ms）` : `失败：${d.error}`, 5000);
}

let channelsState = { capability: {}, codearts: null };

async function renderChannels() {
  try {
    const d = await (await api('api/channels')).json();
    channelsState = d;
  } catch (e) { /* 读不到就只显示静态信息 */ }
  const cap = channelsState.capability || {};
  const ca = channelsState.codearts || {};
  $('channels').innerHTML = CHANNELS.map((c) => {
    const able = cap[c.id]?.cloudLogin === true;
    const reason = cap[c.id]?.reason || '';
    let action;
    if (c.id === 'codearts') {
      if (ca.loggedIn) {
        action = `<span class="badge">已登录 ${esc(ca.user || '')}</span>
           <button class="sm ghost" onclick="pollCodeartsNow()">拉模型</button>
           <button class="sm danger" onclick="logoutCodearts()">退出</button>`;
      } else if (cap[c.id]?.localTool) {
        action = `<button class="sm" onclick="toast('本机运行：node tools/codearts-login.mjs（需本机装 CodeArts IDE）', 7000)">本机登录器</button>`;
      } else {
        action = `<span class="badge off">不可用</span>`;
      }
    } else if (able) {
      action = `<button class="sm" onclick="toast('该渠道云端登录尚未接入')">立即登录</button>`;
    } else {
      action = `<span class="badge off" title="${esc(reason)}">需本机登录</span>`;
    }
    return `<div class="pv-item ${c.id === 'codearts' && ca.loggedIn ? 'on' : ''}">
      <div class="pv-top">
        <span class="pv-name">${esc(c.name)}</span>
        <span class="badge region">${esc(c.org)}</span>
      </div>
      <div style="font-size:11.5px;color:var(--dim);line-height:1.6">${esc(c.note)}</div>
      <div style="font-size:11px;color:var(--dimmer);line-height:1.5">${able ? '✓ 可在云端登录' : '· ' + esc(reason)}</div>
      <div class="pv-acts">
        ${action}
        <a href="${esc(c.url)}" target="_blank" rel="noopener" style="text-decoration:none;margin-left:auto"><button class="sm ghost">官网</button></a>
      </div>
    </div>`;
  }).join('');
  $('channels').dataset.done = '1';
}

let codeartsTimer = null;

async function loginCodearts() {
  toast('正在生成登录链接…');
  try {
    const res = await api('api/channels/codearts/start', { method: 'POST', body: '{}' });
    const d = await res.json();
    if (!res.ok || !d.ok) { toast('生成失败：' + (d.error || res.status), 5000); return; }
    window.open(d.loginUrl, '_blank', 'noopener');
    toast('已打开登录页，请在那边完成华为云登录…', 6000);
    pollCodearts(d.id, 0);
  } catch (e) { toast('失败：' + e.message); }
}

async function pollCodearts(id, n) {
  if (n > 150) { toast('等待超时，可稍后刷新查看', 5000); return; }
  try {
    const d = await (await api('api/channels/codearts/status?id=' + encodeURIComponent(id))).json();
    if (d.status === 'ok') {
      toast(`登录成功${d.user ? '：' + d.user : ''}${d.models ? ' · ' + d.models + ' 个模型' : ''}`, 6000);
      renderChannels();
      return;
    }
    if (d.status === 'error') { toast('登录失败：' + (d.error || ''), 6000); renderChannels(); return; }
  } catch (e) { /* 继续轮询 */ }
  codeartsTimer = setTimeout(() => pollCodearts(id, n + 1), 2000);
}

async function pollCodeartsNow() {
  const res = await api('api/channels/codearts/models', { method: 'POST', body: '{}' });
  const d = await res.json();
  toast(d.ok ? `凭据有效，${d.models.length} 个模型` : '失败：' + (d.error || ''), 5000);
}

async function logoutCodearts() {
  if (!confirm('退出 CodeArts？')) return;
  await api('api/channels/codearts/logout', { method: 'POST', body: '{}' });
  toast('已退出'); renderChannels();
}

function renderChart(recent) {
  const max = Math.max(1, ...recent.map((d) => d.calls));
  $('chart').innerHTML = recent.map((d) => {
    const h = Math.max(2, Math.round((d.calls / max) * 84));
    return `<div class="bar ${d.calls === 0 ? 'zero' : ''}" title="${d.date}：${d.calls} 次 / ${fmtCredit(d.credit)} 积分"><i style="height:${h}px"></i><span>${d.date.slice(5)}</span></div>`;
  }).join('') || '<div class="empty">暂无数据</div>';
}

function renderBreakdown(today) {
  const ba = Object.entries(today.byAccount || {});
  const bm = Object.entries(today.byModel || {});
  if (!ba.length && !bm.length) { $('breakdown').innerHTML = '<div class="empty">今天还没有调用</div>'; return; }
  const nameOf = (id) => state?.accounts?.find((a) => a.id === id)?.label || id.slice(0, 10);
  const row = (label, v) => `<div class="auto-row"><span class="r">${esc(label)}</span><span class="t" style="width:70px;text-align:right">${v.calls} 次</span><span class="gain" style="width:60px;text-align:right">${fmtCredit(v.credit)}</span></div>`;
  $('breakdown').innerHTML =
    (ba.length ? '<div style="font-size:11px;color:var(--dimmer);margin-bottom:4px">按账号</div>' + ba.map(([k, v]) => row(nameOf(k), v)).join('') : '') +
    (bm.length ? '<div style="font-size:11px;color:var(--dimmer);margin:12px 0 4px">按模型</div>' + bm.map(([k, v]) => row(k, v)).join('') : '');
}

async function loadRoutes() {
  try {
    const res = await api('api/routes');
    const d = await res.json();
    routesData = d.routes || [];
    renderRoutes();
  } catch (e) { $('routes').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; }
}

function renderRoutes() {
  $('n-rt').textContent = routesData.length || '';
  if (!routesData.length) { $('routes').innerHTML = '<div class="empty">还没有模型链，点右上角新建</div>'; return; }
  $('routes').innerHTML = routesData.map((r, i) => `
    <div class="pv-item" style="margin-bottom:9px">
      <div class="pv-top">
        <span class="pv-name">${esc(r.name)}</span>
        <span class="badge region mono">${esc(r.id)}</span>
        <span class="badge off">${r.strategy === 'round-robin' ? '轮换' : '顺序'}</span>
        <button class="sm danger" style="margin-left:auto" onclick="removeRoute(${i})">删除</button>
      </div>
      <div class="mono" style="font-size:11.5px;color:var(--dim);word-break:break-all">${r.models.map((m, j) => (j ? ' → ' : '') + esc(m)).join('')}</div>
    </div>`).join('');
}

async function addRoute() {
  const id = prompt('链 ID（调用时用作 model，例：fast）');
  if (!id) return;
  const modelsRaw = prompt('模型列表，用逗号分隔（例：wbpool/hy3,groq/llama-3.3-70b）');
  if (!modelsRaw) return;
  routesData.push({ id, name: id, strategy: 'sequential', models: modelsRaw.split(',').map((s) => s.trim()).filter(Boolean) });
  await saveRoutes();
}

async function removeRoute(i) { routesData.splice(i, 1); await saveRoutes(); }

async function saveRoutes() {
  const res = await api('api/routes', { method: 'POST', body: JSON.stringify({ routes: routesData }) });
  const d = await res.json();
  if (!res.ok) { toast('保存失败'); return; }
  routesData = d.routes; renderRoutes(); toast('已保存');
}

let modelCatalog = { workbuddy: [], thirdParty: [] };
let modelSelection = new Set();

async function loadModels() {
  try {
    const d = await (await api('api/models')).json();
    modelCatalog = { workbuddy: d.workbuddy || [], thirdParty: d.thirdParty || [] };
    modelSelection = new Set(d.selection || []);
    renderModelPicker();
  } catch (e) {
    $('model-picker').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
  }
}

function renderModelPicker() {
  const q = ($('m-search').value || '').toLowerCase();
  const match = (m) => !q || (m.name + ' ' + m.vendor + ' ' + m.id).toLowerCase().includes(q);
  const wb = modelCatalog.workbuddy.filter(match);
  const tp = modelCatalog.thirdParty.filter(match);

  const item = (m) => {
    const on = modelSelection.has(m.id);
    return `<label class="pv-item" style="flex-direction:row;align-items:center;gap:9px;cursor:pointer;${on ? 'border-color:rgba(61,220,151,.45)' : ''}">
      <input type="checkbox" style="width:15px;height:15px;flex:none;accent-color:#3ddc97" ${on ? 'checked' : ''}
        onchange="toggleModel('${esc(m.id)}', this.checked)">
      <span style="flex:1;min-width:0">
        <span class="pv-name" style="display:block">${esc(m.name)}</span>
        <span class="pv-meta">${esc(m.vendor)}${m.free ? ' · <span class="free">免费</span>' : (m.credits ? ' · x' + m.credits : '')}</span>
      </span>
    </label>`;
  };

  const section = (title, list, empty) => list.length
    ? `<div style="font-size:11.5px;color:var(--dimmer);margin:4px 0 8px">${title}（${list.length}）</div><div class="pv">${list.map(item).join('')}</div>`
    : (empty ? `<div class="empty" style="padding:12px">${empty}</div>` : '');

  $('model-picker').innerHTML =
    section('WorkBuddy 账号池', wb) +
    (tp.length ? '<div style="height:14px"></div>' + section('第三方渠道', tp) : '') +
    (!wb.length && !tp.length ? '<div class="empty">没有匹配的模型</div>' : '');

  $('m-count').textContent = `已选 ${modelSelection.size} 个`;
}

function toggleModel(id, on) {
  if (on) modelSelection.add(id); else modelSelection.delete(id);
  renderModelPicker();
}

function selectNone() {
  modelSelection.clear();
  renderModelPicker();
}

async function saveSelection() {
  const res = await api('api/models/selection', {
    method: 'POST',
    body: JSON.stringify({ ids: [...modelSelection] }),
  });
  const d = await res.json();
  if (!res.ok) { toast('保存失败'); return; }
  toast(`已保存 ${d.selection.length} 个模型，点「写入 WorkBuddy」生效`, 5000);
  loadGateway();
}

/** 让本机 exe 把勾选的模型写进 WorkBuddy 的 models.json。 */
function applyToWorkbuddy() {
  toast('正在写入 WorkBuddy 模型列表…', 6000);
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    f.src = 'wbpool://sync';
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 4000);
  } catch (e) { /* 走下面的提示 */ }
  setTimeout(() => {
    toast('已触发。若 WorkBuddy 里没出现，请双击桌面「WB Pool」再试', 7000);
    loadGateway();
  }, 6000);
}

async function loadGateway() {
  try {
    const res = await api('api/gateway');
    const d = await res.json();
    const base = location.href.replace(/\/[^/]*$/, '/');
    $('gw-url').textContent = base + 'v1/chat/completions';
    $('gw-key').textContent = d.gatewayKey;
    $('gw-models').innerHTML = d.selected > 0
      ? `<span class="mono">${d.selected} 个已勾选</span> · 网关共 ${d.modelCount} 个可选`
      : '<span style="color:var(--amber)">还没勾选，去下面选</span>';
    if (!modelCatalog.workbuddy.length) loadModels();
    $('gw-info').innerHTML = `
      <div class="k">接口</div><div class="copy">${esc(base)}v1/chat/completions</div>
      <div class="k">模型列表</div><div class="copy">${esc(base)}v1/models</div>
      <div class="k">默认模型</div><div class="mono">${esc(d.defaultModel)}</div>
      <div class="k">鉴权</div><div class="mono">Authorization: Bearer &lt;API Key&gt;</div>`;
  } catch (e) { $('gw-info').innerHTML = `<div class="k">读取失败</div><div>${esc(e.message)}</div>`; }
}

async function act(path, label) {
  toast(label + '…', 8000);
  try {
    const res = await api('api/' + path, { method: 'POST', body: '{}' });
    const d = await res.json();
    if (path === 'checkin' && d.results) {
      toast(`签到完成，共 +${d.results.reduce((s, r) => s + (r.credit || 0), 0)} 分`);
    } else toast(label + '完成');
    refresh();
  } catch (e) { toast(label + '失败：' + e.message); }
}

async function logout() { await api('api/logout', { method: 'POST', body: '{}' }); location.replace('login'); }

async function refresh(showToast) {
  try {
    const res = await api('api/status');
    const d = await res.json();
    state = d;
    const { pool, accounts, stats } = d;
    $('m-total').textContent = pool.total;
    $('m-health').textContent = `${pool.usable} 可用 · ${pool.cooling} 冷却`;
    $('m-calls').textContent = fmt(stats.today.calls);
    $('m-failover').textContent = `${stats.today.failures} 失败 · ${stats.today.failovers} 换号`;
    $('m-credit').textContent = fmtCredit(stats.today.credit);
    $('m-tokens').textContent = `${fmt(stats.today.inputTokens)} 入 / ${fmt(stats.today.outputTokens)} 出`;
    $('m-left').textContent = accounts.some((a) => a.credits)
      ? fmtCredit(accounts.reduce((s, a) => s + (a.credits?.total || 0), 0)) : '—';
    $('m-third').textContent = d.providers.length ? `${d.providers.length} 个第三方渠道` : '第三方未启用';
    $('health').innerHTML = `<span class="dot ${pool.usable > 0 ? '' : 'bad'}"></span><span>${pool.usable}/${pool.total} 账号可用</span>`;
    $('dist-tag').textContent = pool.distribution + ' · 下一个 ' + (pool.preferred || '无');
    $('n-pool').textContent = pool.total;
    renderAccounts(accounts);
    renderAutomation(d.automation);
    renderChart(stats.recent || []);
    renderBreakdown(stats.today);
    $('s-fail').textContent = stats.today.failures;
    $('s-failover').textContent = stats.today.failovers;
    $('s-third').textContent = stats.today.thirdPartyCalls;
    if (showToast) toast('已刷新');
  } catch (e) {
    $('health').innerHTML = `<span class="dot bad"></span><span>连不上</span>`;
  }
}

refresh();
setInterval(() => refresh(), 8000);
