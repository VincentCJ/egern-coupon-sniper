// 京东「烟台消费券」极简抢券 v8
// ============================================================
// 设计原则：一个文件、三个角色，逻辑一眼看完。
//   - 名字含「抓包」 → http_request：京东 App 里点「领取」时抓最新请求存为模板
//   - 名字含「抢券」 → schedule：cron 每分钟，到点用模板重放，结果必通知
//   - 名字含「试跑」 → generic：手动点一下，立刻用当前模板发一次，验证能不能用
//
// 模板来源：你睡前打开京东 App，进烟台消费券专区点一次「领取」，
//           抓包脚本抓到这次请求 → 明天 0 点自动重放同一个请求。
//
// 结果通知（必发，不节流不吞）：
//   ✅ 抢到了 / ℹ️ 已领过 / 😵 券发完 / ⚠️ 网络失败 / ❓ 无法判定(带原始返回)
// ============================================================

const VERSION = 'v8';
const TPL_KEY = 'jd_coupon_tpl_v8';       // 领券请求模板（url/method/headers/body）
const STATE_KEY = 'jd_coupon_state_v8';   // 今日结果（跨天自动重置）

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function hhmmss(d) {
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function functionIdOf(url) {
  const m = String(url || '').match(/functionId=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// ---------------- 抓包：存模板 ----------------
// 京东域名 + 疑似领券请求 → 存下来当模板。白名单优先，正则可覆盖。
async function capture(ctx) {
  const env = ctx.env || {};
  const req = ctx.request;
  if (!req) return;

  const url = req.url || '';
  const host = (url.match(/^https?:\/\/([^/]+)/) || [])[1] || '';
  if (!/(^|\.)jd\.com$/i.test(host)) return;

  const fid = functionIdOf(url);
  const isWhite = !!(fid &&
    /batchReceiveXFCoupon|receiveXFCoupon|receiveCoupon|govCouponReceive/i.test(fid));

  let custom = null;
  if (env.CAPTURE_MATCH) {
    try { custom = new RegExp(env.CAPTURE_MATCH, 'i'); } catch (_) { custom = null; }
  }
  const builtin = /coupon|consume|subsidy|gift|lottery|draw|receive|benefit|quan|券|gov/i;

  const cur = await ctx.storage.getJSON(TPL_KEY);
  const curFid = cur && cur.functionId ? cur.functionId : '';
  const looksCoupon = isWhite
    || (custom ? custom.test(url) : builtin.test(url))
    || (fid && curFid && fid === curFid);
  if (!looksCoupon) return;

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

  await ctx.storage.setJSON(TPL_KEY, {
    method: String(req.method || 'POST').toUpperCase(),
    url,
    headers,
    body,
    functionId: fid,
    capturedAt: Date.now()
  });

  // 刷新了模板就说一声（低频，一天最多提 5 次免刷屏）
  const lastN = Number((await ctx.storage.getJSON(TPL_KEY + '_n')) || 0);
  if (Date.now() - lastN > 3 * 3600000 || lastN === 0) {
    await ctx.storage.setJSON(TPL_KEY + '_n', Date.now());
    const age = '已抓到领券模板 [' + (fid || host) + '] ' + hhmmss(new Date());
    ctx.notify({ title: '抢券模板已更新', body: age + '，0 点会自动重放。', sound: false });
  }
}

// ---------------- 重放一发 ----------------
async function fire(ctx, tpl, timeoutMs) {
  const headers = Object.assign({}, tpl.headers || {});
  const method = String(tpl.method || 'POST').toUpperCase();
  try {
    let resp;
    if (method === 'GET' || method === 'HEAD') {
      resp = await ctx.http.get(tpl.url, { headers, timeout: timeoutMs, redirect: 'manual' });
    } else {
      resp = await ctx.http.post(tpl.url, {
        headers, body: tpl.body == null ? undefined : tpl.body,
        timeout: timeoutMs, redirect: 'manual'
      });
    }
    return { ok: true, status: resp.status, text: await resp.text() };
  } catch (e) {
    return { ok: false, status: 0, text: String(e) };
  }
}

// 京东返回语义（前端 JS 逆出）：code=0 + subCode~A1|B1 = 成功
function classify(text) {
  const raw = text || '';
  let code = null, subCode = null, msg = raw;
  try {
    const j = JSON.parse(raw);
    code = j.code === undefined ? null : String(j.code);
    subCode = j.subCode === undefined ? null : String(j.subCode);
    msg = j.subCodeMsg || j.msg || j.echo || j.tips || raw;
  } catch (_) { /* 非 JSON 按文案判 */ }
  msg = String(msg);

  if (code === '0' && subCode && /A1|B1/.test(subCode)) return 'success';
  if (/领取成功|领券成功|领取到|抢到券/.test(msg)) return 'success';
  if (/"success"\s*[:=]\s*true/.test(raw)) return 'success';
  if (/已领取|已参与|重复领取|超过限领|不可重复|已抢过|已经领取/.test(msg)) return 'already';
  if (/已抢完|抢完|已领完|无库存|库存不足|已售罄|售罄|名额已满|额度已满|已达上限|券已发完|发放完毕|已被领完/.test(msg)) return 'empty';
  if (/未开始|未到时间|活动未开始|尚未开始|不在活动时间|已结束/.test(msg)) return 'early';
  if (code === '601') return 'crowded';
  if (/排队|人太多|太挤|拥挤|休息一会|稍后|繁忙|请重试/.test(msg)) return 'crowded';
  if (code === '2' || /does not exist|API 不存在|非法请求|参数错误|缺少参数/.test(msg)) return 'badreq';
  if (/签名|sign|h5st|非法|验证失败|未授权|token|expire|过期|请重新登录/.test(msg)) return 'expired';
  // 兜底：code=0 且无 subCode，且上面没匹配到任何具体文案 → 才算成功
  if (code === '0' && !subCode) return 'success';
  return 'unknown';
}

// ---------------- 抢券主流程 ----------------
// manual=true 时立即发（试跑）；否则等今天的放券点，只在 [−2s, +90s] 窗口内动。
async function snipe(ctx) {
  const env = ctx.env || {};
  const manual = String(env.SNIPE_MODE || '').toLowerCase() === 'manual';
  const targetHms = String(env.TARGET_HMS || '00:00:00');
  const timeoutMs = num(env.TIMEOUT_MS, 6000);
  const maxRounds = num(env.MAX_ROUNDS, 30);
  const retryMs = num(env.RETRY_MS, 400);

  const tpl = await ctx.storage.getJSON(TPL_KEY);
  if (!tpl || !tpl.url) {
    ctx.notify({ title: '抢券还没准备好',
      body: '没有模板。打开京东 App 搜「烟台消费券」，点一次「领取」，抓到模板后 0 点才会自动抢。', sound: true });
    return;
  }

  const state = (await ctx.storage.getJSON(STATE_KEY)) || {};
  const today = todayStr();
  if (state.date === today && state.terminal && !manual) return;  // 今天已有结果
  state.date = today;

  // 距放券点
  const seg = targetHms.split(':');
  const cand = new Date();
  cand.setHours(num(seg[0], 0), num(seg[1], 0), num(seg[2], 0), 0);
  if (!manual) {
    let target = cand.getTime();
    if (Date.now() > target + 120000) target += 86400000;  // 今天点已过 → 明天
    const lead = target - Date.now();
    if (lead > 90000) return;                              // 还早，下一轮 cron 再说
  }

  // 发弹：第 1 发立即，后面指数退避
  let lastResult = 'unknown', lastText = '', attempts = 0;
  const TERMINAL = ['success', 'already', 'empty', 'badreq', 'expired'];
  for (let i = 0; i < maxRounds; i++) {
    if (i > 0) {
      const gap = Math.min(retryMs * Math.pow(1.5, i), 4000);
      await new Promise((r) => setTimeout(r, gap));
    }
    const r = await fire(ctx, tpl, timeoutMs);
    attempts++;
    lastText = r.text || '';
    lastResult = r.ok ? classify(lastText) : 'error';
    if (TERMINAL.indexOf(lastResult) >= 0) break;
    if (manual) break;   // 试跑只发 1 发，省着用
  }

  // 落盘 + 通知（必发）
  state.terminal = TERMINAL.indexOf(lastResult) >= 0;
  state.result = lastResult;
  state.attempts = attempts;
  state.ts = Date.now();
  state.trace = String(lastText).slice(0, 300);
  await ctx.storage.setJSON(STATE_KEY, state);

  const labels = {
    success: '✅ 抢到了！去京东App「我的-优惠券」确认（券当天有效）',
    already: 'ℹ️ 今日已领取 / 已达上限',
    empty: '😵 券已发完',
    crowded: '🔄 排队太挤，没抢到',
    early: '⏰ 还没到放券时刻',
    error: '⚠️ 网络请求失败',
    badreq: '🚫 接口报错（抓到的可能不是领券接口）',
    expired: '🔑 模板已过期，请打开京东App点一次「领取」重新抓',
    unknown: '❓ 返回无法判定'
  };
  const raw = (lastResult === 'unknown' || lastResult === 'error')
    ? '\n原始返回: ' + String(lastText).replace(/\s+/g, ' ').slice(0, 160)
    : '';
  ctx.notify({
    title: (manual ? '试跑：' : '京东消费券 ') + (labels[lastResult] || lastResult).slice(0, 20),
    body: (labels[lastResult] || lastResult) + raw + (manual ? '' : '\n共发 ' + attempts + ' 发'),
    sound: true
  });
}

// ---------------- 入口 ----------------
export default async function (ctx) {
  const name = (ctx.script && ctx.script.name) || '';
  try {
    if (name.indexOf('抓包') >= 0 || ctx.request) return await capture(ctx);
    return await snipe(ctx);       // 抢券 / 试跑 都走这（试跑靠 SNIPE_MODE=manual）
  } catch (e) {
    try { ctx.notify({ title: '抢券脚本异常', body: String(e), sound: true }); } catch (_) {}
  }
}
