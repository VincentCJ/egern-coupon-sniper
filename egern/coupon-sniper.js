/**
 * 烟台消费券 抢券脚本（单文件多角色版）
 * ============================================================
 * 同一个文件被模块引用多次，靠 ctx.script.name 分派角色：
 *   名字含「抓包」 -> 抓包模式：持续抓取京东领券请求，刷新模板
 *   名字含「抢券」 -> 抢券模式：到点精确重放该请求（也用于手动试跑）
 *   名字含「状态」 -> 状态模式：渲染小组件
 *   名字含「开关」 -> 开关模式：切换「持续抓取」开关
 *
 * 存储（ctx.storage）：
 *   jd_coupon_sniper_v1       模板（抓包模式写入）
 *   jd_coupon_sniper_state_v1 状态（抢券模式读写）
 *   jd_coupon_sniper_cands_v1 候选请求列表（抓包模式写入）
 *   jd_coupon_sniper_cfg_v1   配置：{ capture: 'on'|'off' }
 *   jd_coupon_sniper_notice_* 各类提示的节流时间戳
 *
 * env：
 *   TARGET_HMS     目标时刻 "HH:MM:SS"（默认 00:00:00）
 *   PREFIRE_MS     提前量毫秒（默认 50）
 *   MAX_ROUNDS     重试次数（默认 40）
 *   RETRY_MS       重试间隔毫秒（默认 250）
 *   TIMEOUT_MS     单次请求超时毫秒（默认 6000）
 *   CATCH_UP       'true' = 忽略目标时刻，立刻发一次
 *   SNIPE_MODE     'manual' = 手动试跑（立刻发，并总是回报结果）
 *   CAPTURE_ALWAYS 'true' = 默认持续抓取（开关模式可临时覆盖）
 *   CAPTURE_MATCH  自定义哪个 URL 算领券动作（可选正则）
 *   NOTIFY_THROTTLE_MS 通知节流（默认 60 秒）
 */

const TPL_KEY = 'jd_coupon_sniper_v1';
const STATE_KEY = 'jd_coupon_sniper_state_v1';
const CAND_KEY = 'jd_coupon_sniper_cands_v1';
const CFG_KEY = 'jd_coupon_sniper_cfg_v1';

function num(v, dflt) {
  const n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function hhmmss(d) {
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
function functionIdOf(url) {
  const m = String(url || '').match(/functionId=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
async function waitUntil(ts) {
  for (;;) {
    const rem = ts - Date.now();
    if (rem <= 0) return;
    if (rem > 25) { await sleep(rem - 20); continue; }
    const t0 = Date.now();
    while (Date.now() - t0 < rem) { /* spin */ }
  }
}
// 带节流的提示：同一类消息在窗口期内只发一次，避免定时任务每分钟刷屏
async function notifyOnce(ctx, tag, windowMs, title, body, force) {
  const key = CFG_KEY + '_n_' + tag;
  const last = Number((await ctx.storage.getJSON(key)) || 0);
  if (!force && Date.now() - last < windowMs) return false;
  await ctx.storage.setJSON(key, Date.now());
  ctx.notify({ title, body, sound: true });
  return true;
}

// ============================ 抓包模式 ============================
// 持续抓取：只要京东 App 在产生流量，就不断用最新的领券请求刷新模板，
// 这样模板里的签名参数始终是"新鲜"的，隔天重放的成功率更高。
async function modeCapture(ctx) {
  const env = ctx.env || {};
  const req = ctx.request;
  if (!req) return;

  // --- 开关：关闭时立刻返回，不做任何解析 ---
  const cfg = (await ctx.storage.getJSON(CFG_KEY)) || {};
  const captureOn = cfg.capture
    ? cfg.capture === 'on'
    : String(env.CAPTURE_ALWAYS || 'true').toLowerCase() === 'true';
  if (!captureOn) return;

  const url = req.url || '';
  const host = (url.match(/^https?:\/\/([^/]+)/) || [])[1] || '';
  if (!/(^|\.)jd\.com$/i.test(host)) return;    // 只管京东系域名

  const method = String(req.method || 'GET').toUpperCase();
  const fid = functionIdOf(url);

  // --- 判断这条请求像不像"领券动作" ---
  let custom = null;
  if (env.CAPTURE_MATCH) {
    try { custom = new RegExp(env.CAPTURE_MATCH, 'i'); } catch (_) { custom = null; }
  }
  const builtin = /coupon|consume|subsidy|gift|lottery|draw|receive|benefit|quan|券/i;
  const cur = await ctx.storage.getJSON(TPL_KEY);
  const curFid = cur && cur.functionId ? cur.functionId : '';

  const sameAsCurrent = !!(fid && curFid && fid === curFid);
  const looksCoupon = (custom ? custom.test(url) : builtin.test(url)) || sameAsCurrent;
  if (!looksCoupon) return;

  // 只有可能成为新模板的才读 body（省开销）
  let body = null;
  try {
    if (typeof req.text === 'function') body = await req.text();
    else if (req.body && typeof req.body.text === 'function') body = await req.body.text();
  } catch (_) { body = null; }

  const headers = {};
  if (req.headers && req.headers.get) {
    for (const name of ['Cookie', 'User-Agent', 'Content-Type', 'Referer',
                        'Accept', 'Origin', 'Accept-Language', 'x-referer-page']) {
      const v = req.headers.get(name);
      if (v) headers[name] = v;
    }
  }

  const snap = {
    method,
    url,
    headers,
    body,
    functionId: fid,
    capturedAt: Date.now()
  };

  const cands = (await ctx.storage.getJSON(CAND_KEY)) || [];
  cands.unshift(snap);
  while (cands.length > 30) cands.pop();
  await ctx.storage.setJSON(CAND_KEY, cands);

  // 选模板：优先同接口刷新 > 内置领券特征 > 最近 POST
  const picked =
    cands.find((c) => curFid && c.functionId === curFid) ||
    cands.find((c) => (custom ? custom.test(c.url) : builtin.test(c.url))) ||
    cands.find((c) => c.method === 'POST') ||
    cands[0];

  const changed = !cur || cur.url !== picked.url || cur.body !== picked.body;
  await ctx.storage.setJSON(TPL_KEY, picked);

  // 通知节流：只在"模板真正变了"且超过节流窗口时才提醒，避免刷屏
  const throttle = num(env.NOTIFY_THROTTLE_MS, 60000);
  const lastNotify = Number((await ctx.storage.getJSON(CFG_KEY + '_n')) || 0);
  if (changed && Date.now() - lastNotify > throttle) {
    await ctx.storage.setJSON(CFG_KEY + '_n', Date.now());
    const label = picked.functionId || host;
    ctx.notify({
      title: '领券模板已刷新',
      body: label + ' — ' + new Date(picked.capturedAt).toLocaleTimeString() + ' 抓取，持续抓取已开启。',
      sound: false
    });
  }
}

// ============================ 抢券模式 ============================
async function modeSnipe(ctx) {
  const env = ctx.env || {};
  const timeoutMs = num(env.TIMEOUT_MS, 6000);
  const maxRounds = num(env.MAX_ROUNDS, 40);
  const retryMs = num(env.RETRY_MS, 250);
  const preFireMs = num(env.PREFIRE_MS, 50);
  const catchUp = String(env.CATCH_UP || '').toLowerCase() === 'true';
  const manual = String(env.SNIPE_MODE || '').toLowerCase() === 'manual';
  const targetHms = String(env.TARGET_HMS || '00:00:00');
  const LATE_GRACE = 120000;    // 迟到 2 分钟内仍算"赶上"，立刻补发
  const MAX_LEAD = 90000;       // 目标在 90 秒内才值得等
  const HOUR = 3600000;

  const tpl = await ctx.storage.getJSON(TPL_KEY);
  if (!tpl || !tpl.url) {
    await notifyOnce(ctx, 'notpl', HOUR,
      '京东抢券',
      '还没有领券模板：请在京东 App 里手动点一次「领取」，脚本会自动抓包。',
      manual);
    return;
  }

  // 幂等 + 并发锁
  const state = (await ctx.storage.getJSON(STATE_KEY)) || {};
  const today = todayStr();
  const done = state.date === today && (state.success || state.already || state.empty);
  if (done && !manual) {
    await notifyOnce(ctx, 'done', HOUR, '京东消费券',
      '今天已经处理过了（' + (state.success ? '已抢到' : state.already ? '已领取' : '已抢完') +
      '），不会重复发送。', false);
    return;
  }
  if (state.date === today && state.lockTs && Date.now() - state.lockTs < 55000 && !manual) return;

  state.date = today;
  state.success = false;
  state.already = false;
  state.empty = false;

  // 目标时刻
  let target;
  if (manual || catchUp) {
    target = Date.now();
  } else {
    const seg = targetHms.split(':');
    const cand = new Date();
    cand.setHours(num(seg[0], 0), num(seg[1], 0), num(seg[2], 0), 0);
    target = (Date.now() - cand.getTime() <= LATE_GRACE)
      ? cand.getTime()
      : cand.getTime() + 86400000;
    if (target - Date.now() > MAX_LEAD) {
      // 还没到点：明确回报一次（每天一次），之后安静等待
      await notifyOnce(ctx, 'armed', HOUR, '京东消费券',
        '定时抢券已就位，将在 ' + targetHms + ' 发出（还差 ' +
        Math.round((target - Date.now()) / 60000) + ' 分钟）。模板已就绪。', false);
      return;
    }
  }
  state.lockTs = Date.now();
  await ctx.storage.setJSON(STATE_KEY, state);

  if (manual) {
    ctx.notify({ title: '京东消费券', body: '手动试跑中…', sound: false });
  }

  async function fire() {
    const headers = {};
    for (const k in (tpl.headers || {})) headers[k] = tpl.headers[k];
    const method = String(tpl.method || 'POST').toUpperCase();
    const body = tpl.body;
    try {
      let resp;
      if (method === 'GET' || method === 'HEAD') {
        resp = await ctx.http.get(tpl.url, { headers, timeout: timeoutMs, redirect: 'manual' });
      } else {
        resp = await ctx.http.post(tpl.url, {
          headers,
          body: body === undefined || body === null ? undefined : body,
          timeout: timeoutMs,
          redirect: 'manual'
        });
      }
      return { ok: true, status: resp.status, text: await resp.text() };
    } catch (e) {
      return { ok: false, status: 0, text: String(e) };
    }
  }

  function classify(text) {
    const s = text || '';
    if (/领取成功|领券成功|领取到|抢到券/.test(s)) return 'success';
    if (/"success"\s*[:=]\s*true/.test(s)) return 'success';
    if (/"code"\s*[:=]\s*"?0"?\s*[,}]/.test(s)) return 'success';
    if (/已领取|已参与|重复领取|超过限领|已抢过|不可重复/.test(s)) return 'already';
    if (/抢完|已领完|无库存|库存不足|已达上限|已售罄/.test(s)) return 'empty';
    return 'unknown';
  }

  let lastText = '';
  let lastResult = 'unknown';
  let attempts = 0;
  for (let i = 0; i < maxRounds; i++) {
    const wait = target - Date.now() - preFireMs;
    if (wait > 0) await waitUntil(target - preFireMs);

    const r = await fire();
    attempts++;
    lastText = r.text || '';
    lastResult = r.ok ? classify(lastText) : 'error';

    if (lastResult === 'success' || lastResult === 'already') break;
    if (i < maxRounds - 1) await sleep(retryMs + Math.floor(Math.random() * 60));
  }

  state[lastResult] = true;
  state.ts = Date.now();
  state.attempts = attempts;
  state.trace = lastText.slice(0, 300);
  await ctx.storage.setJSON(STATE_KEY, state);

  const labels = {
    success: '✅ 抢到了！去京东App「我的-优惠券」确认（券当天有效）',
    already: 'ℹ️ 今日已领取 / 已达上限',
    empty: '😵 券已抢完',
    error: '⚠️ 请求失败（网络 / 签名 / 风控），详见状态里的 trace',
    unknown: '❔ 返回无法判定，模板可能已失效，建议重新抓包'
  };
  const extra = manual ? '\n（手动试跑，已发 ' + attempts + ' 次）' : '';
  ctx.notify({
    title: '京东消费券',
    body: (labels[lastResult] || lastResult) + extra,
    sound: true
  });
}

// ============================ 开关模式 ============================
// 切换「持续抓取」开关。也可用模块参数 CAPTURE_ALWAYS 设默认值。
async function modeToggle(ctx) {
  const env = ctx.env || {};
  const cfg = (await ctx.storage.getJSON(CFG_KEY)) || {};
  const defOn = String(env.CAPTURE_ALWAYS || 'true').toLowerCase() === 'true';
  const curOn = cfg.capture ? cfg.capture === 'on' : defOn;
  const next = curOn ? 'off' : 'on';

  cfg.capture = next;
  cfg.toggledAt = Date.now();
  await ctx.storage.setJSON(CFG_KEY, cfg);

  const tpl = await ctx.storage.getJSON(TPL_KEY);
  const msg = next === 'on'
    ? '持续抓取已开启：打开京东 App 即自动刷新领券模板。' +
      (tpl && tpl.capturedAt ? '（当前模板 ' + new Date(tpl.capturedAt).toLocaleTimeString() + ' 抓取）' : '（暂无模板，去点一次「领取」）')
    : '持续抓取已关闭：不再抓取新请求，模板保持当前版本。';
  ctx.notify({ title: '持续抓包 ' + (next === 'on' ? '已开启' : '已关闭'), body: msg, sound: true });
}

// ============================ 状态模式 ============================
async function modeStatus(ctx) {
  const env = ctx.env || {};
  const tpl = await ctx.storage.getJSON(TPL_KEY);
  const state = (await ctx.storage.getJSON(STATE_KEY)) || {};
  const cfg = (await ctx.storage.getJSON(CFG_KEY)) || {};
  const defOn = String(env.CAPTURE_ALWAYS || 'true').toLowerCase() === 'true';
  const captureOn = cfg.capture ? cfg.capture === 'on' : defOn;
  const hasTpl = !!(tpl && tpl.url);
  const today = todayStr();

  let statusText = '未开始';
  let statusColor = '#8E8E93';
  if (state.date === today) {
    if (state.success) { statusText = '✅ 已抢到'; statusColor = '#34C759'; }
    else if (state.already) { statusText = 'ℹ️ 今日已领'; statusColor = '#5856D6'; }
    else if (state.empty) { statusText = '😵 已抢完'; statusColor = '#FF9F0A'; }
    else if (state.error) { statusText = '⚠️ 请求失败'; statusColor = '#FF453A'; }
    else { statusText = '⏳ 待放券'; statusColor = '#007AFF'; }
  }

  const capText = captureOn ? '持续抓取：开' : '持续抓取：关';
  const capColor = captureOn ? '#34C759' : '#8E8E93';
  const tplAge = tpl && tpl.capturedAt ? new Date(tpl.capturedAt).toLocaleTimeString() : '无';

  const children = [
    { type: 'text', text: '烟台消费券', font: { size: 'caption2' }, textColor: '#C7C7CC' },
    { type: 'text', text: statusText, font: { size: 'title3', weight: 'bold' }, textColor: statusColor },
    { type: 'text', text: capText, font: { size: 'caption2' }, textColor: capColor },
    { type: 'text', text: hasTpl ? '模板 ' + tplAge : '请手动点一次「领取」', font: { size: 'caption2' }, textColor: '#8E8E93' }
  ];

  return {
    type: 'widget',
    children,
    backgroundColor: '#1C1C1E',
    padding: 16
  };
}

// ============================ 入口 ============================
export default async function (ctx) {
  const name = (ctx.script && ctx.script.name) || '';
  try {
    if (name.indexOf('开关') >= 0) return await modeToggle(ctx);
    if (name.indexOf('状态') >= 0) return await modeStatus(ctx);
    if (name.indexOf('抓包') >= 0) return await modeCapture(ctx);
    if (name.indexOf('抢券') >= 0) return await modeSnipe(ctx);
    if (ctx.request) return await modeCapture(ctx);
    return await modeStatus(ctx);
  } catch (e) {
    try {
      ctx.notify({ title: '京东抢券脚本异常', body: String(e), sound: true });
    } catch (_) { /* ignore */ }
  }
}
