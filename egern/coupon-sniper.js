/**
 * 京东消费券 抢券脚本（单文件多角色版）
 * ============================================================
 * 同一个文件被模块引用三次，靠 ctx.script.name 分派角色：
 *   名字含「抓包」 -> 抓包模式：你在京东App点一次「领取」，把真实请求存下来
 *   名字含「抢券」 -> 抢券模式：到点精确重放该请求
 *   名字含「状态」 -> 状态模式：渲染小组件
 *
 * 存储（ctx.storage）：
 *   jd_coupon_sniper_v1       模板（抓包模式写入）
 *   jd_coupon_sniper_state_v1 状态（抢券模式读写）
 *   jd_coupon_sniper_cands_v1 候选请求列表（抓包模式写入，便于排查）
 *
 * env：
 *   TARGET_HMS  目标时刻 "HH:MM:SS"（默认 00:00:00）
 *   PREFIRE_MS  提前量毫秒（默认 50）
 *   MAX_ROUNDS  重试次数（默认 40）
 *   RETRY_MS    重试间隔毫秒（默认 250）
 *   TIMEOUT_MS  单次请求超时毫秒（默认 6000）
 *   CATCH_UP    'true' = 立刻发一次（调试用）
 *   CAPTURE_MATCH 抓包用的自定义 URL 正则（可选）
 */

const TPL_KEY = 'jd_coupon_sniper_v1';
const STATE_KEY = 'jd_coupon_sniper_state_v1';
const CAND_KEY = 'jd_coupon_sniper_cands_v1';

function num(v, dflt) {
  const n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
// 精确等待：>25ms 用定时器，最后 25ms 自旋
async function waitUntil(ts) {
  for (;;) {
    const rem = ts - Date.now();
    if (rem <= 0) return;
    if (rem > 25) { await sleep(rem - 20); continue; }
    const t0 = Date.now();
    while (Date.now() - t0 < rem) { /* spin */ }
  }
}

// ============================ 抓包模式 ============================
async function modeCapture(ctx) {
  const env = ctx.env || {};
  const req = ctx.request;
  if (!req) return;

  const url = req.url || '';
  const host = (url.match(/^https?:\/\/([^/]+)/) || [])[1] || '';
  if (!/(^|\.)jd\.com$/i.test(host)) return;    // 只管京东系域名

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
    method: String(req.method || 'GET').toUpperCase(),
    url,
    headers,
    body,
    capturedAt: Date.now()
  };

  const cands = (await ctx.storage.getJSON(CAND_KEY)) || [];
  cands.unshift(snap);
  while (cands.length > 20) cands.pop();
  await ctx.storage.setJSON(CAND_KEY, cands);

  let custom = null;
  if (env.CAPTURE_MATCH) {
    try { custom = new RegExp(env.CAPTURE_MATCH, 'i'); } catch (_) { custom = null; }
  }
  const builtin = /coupon|consume|subsidy|gift|lottery|draw|receive|benefit|quan|券/i;

  const picked =
    (custom ? cands.find((c) => custom.test(c.url)) : null) ||
    cands.find((c) => builtin.test(c.url)) ||
    cands.find((c) => c.method === 'POST') ||
    cands[0];

  await ctx.storage.setJSON(TPL_KEY, picked);

  const isCouponish = (custom ? custom.test(picked.url) : builtin.test(picked.url)) || picked.method === 'POST';
  if (isCouponish) {
    const fn = (picked.url.match(/functionId=([^&]+)/) || [])[1] || host;
    ctx.notify({
      title: '已抓取领券请求',
      body: fn + ' — 模板已保存，' + (env.TARGET_HMS || '00:00:00') + ' 自动重放。',
      sound: true
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
  const targetHms = String(env.TARGET_HMS || '00:00:00');
  const LATE_GRACE = 120000;    // 迟到 2 分钟内仍算"赶上"，立刻补发
  const MAX_LEAD = 90000;       // 目标在 90 秒内才值得等

  const tpl = await ctx.storage.getJSON(TPL_KEY);
  if (!tpl || !tpl.url) {
    ctx.notify({
      title: '京东抢券',
      body: '还没有领券模板：请先在京东 App 里手动点一次「领取」，脚本会自动抓包。',
      sound: true
    });
    return;
  }

  // 幂等 + 并发锁
  const state = (await ctx.storage.getJSON(STATE_KEY)) || {};
  const today = todayStr();
  if (state.date === today && (state.success || state.already || state.empty)) return;
  if (state.date === today && state.lockTs && Date.now() - state.lockTs < 55000) return;
  state.date = today;
  state.success = false;
  state.already = false;
  state.empty = false;

  // 目标时刻
  let target;
  if (catchUp) {
    target = Date.now();
  } else {
    const seg = targetHms.split(':');
    const cand = new Date();
    cand.setHours(num(seg[0], 0), num(seg[1], 0), num(seg[2], 0), 0);
    target = (Date.now() - cand.getTime() <= LATE_GRACE)
      ? cand.getTime()
      : cand.getTime() + 86400000;
    if (target - Date.now() > MAX_LEAD) return;   // 还早，下一分钟再来
  }
  state.lockTs = Date.now();
  await ctx.storage.setJSON(STATE_KEY, state);

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
  for (let i = 0; i < maxRounds; i++) {
    const wait = target - Date.now() - preFireMs;
    if (wait > 0) await waitUntil(target - preFireMs);

    const r = await fire();
    lastText = r.text || '';
    lastResult = r.ok ? classify(lastText) : 'error';

    if (lastResult === 'success' || lastResult === 'already') break;
    if (i < maxRounds - 1) await sleep(retryMs + Math.floor(Math.random() * 60));
  }

  state[lastResult] = true;
  state.ts = Date.now();
  state.trace = lastText.slice(0, 300);
  await ctx.storage.setJSON(STATE_KEY, state);

  const labels = {
    success: '✅ 抢到了！去京东App「我的-优惠券」确认（券当天有效）',
    already: 'ℹ️ 今日已领取 / 已达上限',
    empty: '😵 券已抢完',
    error: '⚠️ 请求失败（网络 / 签名 / 风控），详见状态里的 trace',
    unknown: '❔ 返回无法判定，模板可能已失效，建议重新抓包'
  };
  ctx.notify({ title: '京东消费券', body: labels[lastResult] || lastResult, sound: true });
}

// ============================ 状态模式 ============================
async function modeStatus(ctx) {
  const tpl = await ctx.storage.getJSON(TPL_KEY);
  const state = (await ctx.storage.getJSON(STATE_KEY)) || {};
  const hasTpl = !!(tpl && tpl.url);
  const today = todayStr();

  let statusText = '未开始';
  let statusColor = '#8E8E93';
  if (state.date === today) {
    if (state.success) { statusText = '✅ 已抢到'; statusColor = '#34C759'; }
    else if (state.already) { statusText = 'ℹ️ 今日已领'; statusColor = '#5856D6'; }
    else if (state.empty) { statusText = '😵 已抢完'; statusColor = '#FF9F0A'; }
    else if (state.error) { statusText = '⚠️ 请求失败'; statusColor = '#FF453A'; }
    else { statusText = '❔ 未判定'; statusColor = '#8E8E93'; }
  }

  const children = [
    { type: 'text', text: '烟台消费券', font: { size: 'caption2' }, textColor: '#C7C7CC' },
    { type: 'text', text: statusText, font: { size: 'title3', weight: 'bold' }, textColor: statusColor },
    { type: 'text', text: hasTpl ? '模板已就绪' : '请手动点一次「领取」', font: { size: 'caption2' }, textColor: '#8E8E93' }
  ];
  if (state.trace) {
    children.push({
      type: 'text', text: String(state.trace).slice(0, 40),
      font: { size: 'caption2' }, textColor: '#636366', lineLimit: 1
    });
  }
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
    if (name.indexOf('状态') >= 0) return await modeStatus(ctx);
    if (name.indexOf('抓包') >= 0) return await modeCapture(ctx);
    if (name.indexOf('抢券') >= 0) return await modeSnipe(ctx);
    // 没匹配到角色时，按有没有 request 判断
    if (ctx.request) return await modeCapture(ctx);
    return await modeStatus(ctx);
  } catch (e) {
    try {
      ctx.notify({ title: '京东抢券脚本异常', body: String(e), sound: true });
    } catch (_) { /* ignore */ }
  }
}
