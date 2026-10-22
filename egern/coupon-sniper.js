/**
 * 烟台消费券 抢券脚本（单文件多角色版）
 * ============================================================
 * 同一个文件被模块引用多次，靠 ctx.script.name 分派角色：
 *   名字含「抓包」 -> 抓包模式：持续抓取京东领券请求，刷新模板
 *   名字含「抢券」 -> 抢券模式：到点精确重放 + 全天自动补抢
 *   名字含「状态」 -> 状态模式：渲染小组件
 *   名字含「开关」 -> 开关模式：切换「持续抓取」开关
 *
 * 抢券策略（依据官方规则：每日 00:00-23:59 全天发放、限量先到先得、
 * 且每日按核销情况动态调整发放数量）：
 *   1. 放券时刻精确打一轮（提前量补偿网络延迟）
 *   2. 当天没抢到就按间隔继续补抢，直到成功/已领/当天结束
 *   3. 当天已有定论则不再发（幂等）
 *
 * 存储（ctx.storage）：
 *   jd_coupon_sniper_v1       模板（抓包模式写入）
 *   jd_coupon_sniper_state_v1 状态（抢券模式读写）
 *   jd_coupon_sniper_cands_v1 候选请求列表（抓包模式写入）
 *   jd_coupon_sniper_cfg_v1   配置：{ capture: 'on'|'off' }
 *   jd_coupon_sniper_notice_* 各类提示的节流时间戳
 *
 * env：
 *   TARGET_HMS      目标时刻 "HH:MM:SS"（默认 00:00:00）
 *   PREFIRE_MS      提前量毫秒（默认 50）
 *   MAX_ROUNDS      单轮最多打多少发（默认 40）
 *   RETRY_MS        轮内两发间隔毫秒（默认 250）
 *   TIMEOUT_MS      单次请求超时毫秒（默认 6000）
 *   CATCH_UP        'true' = 忽略目标时刻，立刻发一次
 *   SNIPE_MODE      'manual' = 手动试跑（立刻发，并总是回报结果）
 *   RETRY_ALL_DAY   'true' = 瞬态未果时按间隔补抢（默认 false；终态一律当天不再打）
 *   RETRY_MINUTES   补抢间隔分钟数（默认 60）
 *   EMPTY_KEYWORDS  判定「券已发完」的文案关键词（逗号分隔）
 *   CROWDED_KEYWORDS 判定「排队/繁忙」瞬态的文案关键词（逗号分隔）
 *   RETRY_UNTIL     补抢截止时刻 "HH:MM"（默认 23:00）
 *   CAPTURE_ALWAYS  'true' = 默认持续抓取（开关模式可临时覆盖）
 *   CAPTURE_MATCH   自定义哪个 URL 算领券动作（可选正则）
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
function hhmm(d) {
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
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
// 带节流的提示：同一类消息在窗口期内只发一次，避免定时任务刷屏
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

  // 通知：默认不打扰。模板刷新是后台行为，没必要每次都弹。
  // 需要知道刷新情况时，把模块参数「抓包提醒」改成 true。
  const verbose = String(env.CAPTURE_NOTIFY || '').toLowerCase() === 'true';
  const throttle = num(env.NOTIFY_THROTTLE_MS, 3600000);
  const lastNotify = Number((await ctx.storage.getJSON(CFG_KEY + '_n')) || 0);
  if (verbose && changed && Date.now() - lastNotify > throttle) {
    await ctx.storage.setJSON(CFG_KEY + '_n', Date.now());
    const label = picked.functionId || host;
    ctx.notify({
      title: '领券模板已刷新',
      body: label + ' — ' + new Date(picked.capturedAt).toLocaleTimeString() + ' 抓取。',
      sound: false
    });
  }
}

// ============================ 抢券模式 ============================
// 现实前提：券基本 0 点就抢完，所以胜负只在放券时刻的那一两秒。
// 因此策略是「预热 + 密集突发」，而不是「失败了就慢慢重试」：
//   1. 提前预热：先打一发到同一 host，测出真实 RTT，并让 DNS/TCP/TLS 就绪
//   2. 提前量自适应：按测得的 RTT 提前发送，让请求"到达"服务器时正好是放券瞬间
//   3. 密集突发：开头几发间隔很短（默认 50ms），确认是瞬态后才退避
//   4. 终态即停：成功 / 已领 / 券发完 —— 立刻收手，不浪费请求
//   5. 瞬态才续：排队太挤 / 网络错 —— 才值得再打
async function modeSnipe(ctx) {
  const env = ctx.env || {};
  const timeoutMs = num(env.TIMEOUT_MS, 6000);
  const maxRounds = num(env.MAX_ROUNDS, 30);
  const retryMs = num(env.RETRY_MS, 250);
  const preFireOverride = num(env.PREFIRE_MS, 0);   // 0 = 按实测 RTT 自动
  const burstCount = num(env.BURST_COUNT, 12);
  const burstGapMs = num(env.BURST_GAP_MS, 50);
  const burstLeadMs = num(env.BURST_LEAD_MS, 3000);  // 距放券点多久开始准备
  const parallel = Math.max(1, num(env.PARALLEL, 2)); // 同一瞬间并发几发
  const catchUp = String(env.CATCH_UP || '').toLowerCase() === 'true';
  const manual = String(env.SNIPE_MODE || '').toLowerCase() === 'manual';
  const retryAllDay = String(env.RETRY_ALL_DAY || 'false').toLowerCase() === 'true';
  const retryMinutes = num(env.RETRY_MINUTES, 60);
  const retryUntil = String(env.RETRY_UNTIL || '23:00');
  const targetHms = String(env.TARGET_HMS || '00:00:00');
  const LATE_GRACE = 120000;    // 迟到 2 分钟内仍算"赶上"
  const MAX_LEAD = 90000;       // 距放券点 90 秒内才进入准备阶段
  const HOUR = 3600000;
  const MINUTE = 60000;

  const tpl = await ctx.storage.getJSON(TPL_KEY);
  if (!tpl || !tpl.url) {
    await notifyOnce(ctx, 'notpl', 86400000,
      '京东抢券',
      '还没有领券模板：请在京东 App 里手动点一次「领取」，脚本会自动抓包。',
      manual);
    return;
  }

  // 睡前自检：只检查不抢券，趁用户还醒着提醒刷新模板
  if (String(env.CHECK_ONLY || '').toLowerCase() === 'true') {
    const ageMin = tpl.capturedAt ? Math.round((Date.now() - tpl.capturedAt) / MINUTE) : -1;
    const staleLimit = num(env.STALE_MINUTES, 30);
    // 同时预热一下连接，把 DNS/TCP/TLS 的开销挪到睡前
    const rtt = await warmup(ctx, tpl, timeoutMs);
    const stale = ageMin < 0 || ageMin > staleLimit;
    const lines = [];
    lines.push('放券时刻 ' + targetHms);
    lines.push('模板抓取于 ' + (ageMin < 0 ? '未知' : ageMin + ' 分钟前'));
    if (rtt > 0) lines.push('网络 RTT 约 ' + rtt + 'ms（已预热）');
    if (stale) {
      lines.push('⚠️ 模板可能已失效：');
      lines.push('请现在打开京东 App 搜「烟台消费券」，点一次「领取」');
      lines.push('（成功或失败都算，脚本会自动抓到最新请求刷新模板）。');
      // 只有"有问题"才提醒；一切正常就安静睡觉
      await notifyOnce(ctx, 'stale', 86400000, '抢券模板快过期了', lines.join('\n'), true);
    } else {
      if (String(env.NOTIFY_VERBOSE || '').toLowerCase() === 'true') {
        ctx.notify({ title: '抢券睡前自检', body: lines.join('\n'), sound: false });
      }
    }
    return;
  }

  const state = (await ctx.storage.getJSON(STATE_KEY)) || {};
  const today = todayStr();
  const done = state.date === today && (state.success || state.already);
  if (done && !manual) {
    // 结果已经报过了就别再报第二次（否则每分钟重复提醒）
    if (!state.resultNotified) {
      await notifyOnce(ctx, 'done', 86400000, '京东消费券',
        '今天已经处理过了（' + (state.success ? '已抢到' : '已领取') + '），不会重复发送。', false);
      state.resultNotified = true;
      await ctx.storage.setJSON(STATE_KEY, state);
    }
    return;
  }
  if (state.date === today && state.lockTs && Date.now() - state.lockTs < 55000 && !manual) return;

  const newDay = state.date !== today;
  state.date = today;
  if (newDay) {
    state.success = false;
    state.already = false;
    state.empty = false;
    state.attemptsTotal = 0;
    state.lastAttemptTs = 0;
    state.burstFiredTs = 0;
  }

  // ---------------- 目标时刻 ----------------
  let target;
  if (manual || catchUp) {
    target = Date.now();
  } else {
    const seg = targetHms.split(':');
    const cand = new Date();
    cand.setHours(num(seg[0], 0), num(seg[1], 0), num(seg[2], 0), 0);
    const late = Date.now() - cand.getTime();
    if (late > 0) {
      if (late <= LATE_GRACE) {
        target = cand.getTime();
      } else if (retryAllDay) {
        target = Date.now();
      } else {
        target = cand.getTime() + 86400000;
      }
    } else {
      target = cand.getTime();
    }
    const lead = target - Date.now();
    if (lead > MAX_LEAD) {
      const tplAge = tpl.capturedAt ? Math.round((Date.now() - tpl.capturedAt) / MINUTE) : -1;
      const ageNote = (tplAge >= 0 && tplAge > 30)
        ? ' ⚠️ 模板已 ' + tplAge + ' 分钟没更新，建议现在打开京东App点一次领取刷新模板。'
        : '';
      if (String(env.NOTIFY_VERBOSE || '').toLowerCase() === 'true') {
        await notifyOnce(ctx, 'armed', 86400000, '京东消费券',
          '定时抢券已就位，将在 ' + targetHms + ' 发出（还差 ' +
          Math.round(lead / MINUTE) + ' 分钟）。' + ageNote, false);
      }
      return;
    }
    // 今天已有终态（成功/已领/券发完）—— 当天收工，不再发
    if (state.terminal) {
      // 终态：结果已在上一轮报过，这里保持安静
      return;
    }
    // 刚打完一轮突发，避免同一分钟内重复触发
    if (state.burstFiredTs && Date.now() - state.burstFiredTs < 5000) return;
  }

  state.lockTs = Date.now();
  await ctx.storage.setJSON(STATE_KEY, state);

  // ---------------- 预热 + 测 RTT ----------------
  // 目的：让 DNS/TCP/TLS 在放券前就绪，并拿到真实 RTT 用于算提前量。
  let rttMs = Number(state.rttMs || 0);
  if (!manual) {
    const warm = await warmup(ctx, tpl, timeoutMs);
    if (warm > 0) {
      rttMs = warm;
      state.rttMs = warm;
      state.warmTs = Date.now();
      await ctx.storage.setJSON(STATE_KEY, state);
    }
  }
  // 提前量：按实测 RTT 抵消网络延迟，让请求"到达"服务器时正好是放券瞬间
  const preFireMs = preFireOverride > 0
    ? preFireOverride
    : Math.min(Math.max(rttMs || 50, 20), 300);

  if (manual) {
    ctx.notify({ title: '京东消费券', body: '手动试跑中…', sound: false });
  }

  // ---------------- 发包 ----------------
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

  // 按京东领券接口的真实返回语义分类
  //   success  = 抢到了（code=0 且 subCode 命中 A1|B1）
  //   already  = 今天已领过这一类
  //   empty    = 券确实发完了 —— 终态，继续打没有意义
  //   crowded  = 排队太挤 / 繁忙 —— 瞬态，值得稍后再试
  //   error    = 网络或超时 —— 瞬态
  function classify(text) {
    const raw = text || '';
    let code = null, subCode = null, msg = raw;
    try {
      const j = JSON.parse(raw);
      code = j.code === undefined ? null : String(j.code);
      subCode = j.subCode === undefined ? null : String(j.subCode);
      msg = j.subCodeMsg || j.msg || j.echo || j.tips || raw;
    } catch (_) { /* 非 JSON，按文案判定 */ }
    msg = String(msg);

    if (code === '0' && subCode && /A1|B1/.test(subCode)) return 'success';
    if (/领取成功|领券成功|领取到|抢到券/.test(msg)) return 'success';
    if (/"success"\s*[:=]\s*true/.test(raw)) return 'success';

    if (/已领取|已参与|重复领取|超过限领|不可重复|已抢过|已经领取/.test(msg)) return 'already';

    const emptyKw = (env.EMPTY_KEYWORDS
      ? env.EMPTY_KEYWORDS.split(',')
      : ['已抢完', '抢完', '已领完', '无库存', '库存不足', '已售罄', '售罄',
         '名额已满', '额度已满', '已达上限', '券已发完', '发放完毕', '已被领完']);
    for (const k of emptyKw) { if (k && msg.indexOf(k) >= 0) return 'empty'; }

    // 还没开始 —— 瞬态，不能当终态（否则会误判成"券没了"而提前收手）
    const earlyKw = ['未开始', '未到时间', '活动未开始', '尚未开始', '不在活动时间', '已结束'];
    for (const k of earlyKw) { if (k && msg.indexOf(k) >= 0) return 'early'; }

    if (code === '601') return 'crowded';
    const crowdKw = (env.CROWDED_KEYWORDS
      ? env.CROWDED_KEYWORDS.split(',')
      : ['排队', '人太多', '太挤', '拥挤', '休息一会', '稍后', '繁忙', '请重试']);
    for (const k of crowdKw) { if (k && msg.indexOf(k) >= 0) return 'crowded'; }

    if (code === '0' && !subCode) return 'success';

    // 接口不存在 / 请求非法 —— 说明抓到的不��领券接口
    if (code === '2' || /does not exist|API 不存在|非法请求|参数错误|缺少参数/.test(msg)) return 'badreq';

    // 签名/风控类：说明模板过期
    if (/签名|sign|h5st|非法|验证失败|未授权|token|expire|过期|请重新登录/.test(msg)) return 'expired';

    return 'unknown';
  }

  const TERMINAL = ['success', 'already', 'empty', 'badreq', 'expired'];
  let lastText = '';
  let lastResult = 'unknown';
  let attempts = 0;
  let bestStatus = 0;

  // 并发突发：同一瞬间发 N 发，谁先到服务器算谁的
  async function burst() {
    const n = Math.min(parallel, maxRounds);
    const rs = await Promise.all(Array.from({ length: n }, () => fire()));
    attempts += n;
    for (const r of rs) {
      const res = r.ok ? classify(r.text || '') : 'error';
      if (r.ok && r.status) bestStatus = r.status;
      if (res === 'success') { lastResult = 'success'; lastText = r.text || ''; return 'success'; }
      if (res === 'already') { lastResult = 'already'; lastText = r.text || ''; return 'already'; }
      if (res === 'empty') { lastResult = 'empty'; lastText = r.text || ''; return 'empty'; }
      if (res === 'crowded' || res === 'early') { lastResult = res; lastText = r.text || ''; }
      if (!lastText) lastText = r.text || '';
    }
    return lastResult;
  }

  // ---------------- 主循环 ----------------
  for (let i = 0; i < maxRounds; i++) {
    if (i === 0) {
      const wait = target - Date.now() - preFireMs;
      if (wait > 0) await waitUntil(target - preFireMs);
    } else {
      const gap = (i - 1 < burstCount)
        ? burstGapMs
        : Math.min(retryMs * Math.pow(1.6, i - 1 - burstCount), 4000);
      await sleep(gap + Math.floor(Math.random() * 40));
    }

    let res;
    if (i === 0 && parallel > 1) {
      res = await burst();
    } else {
      const r = await fire();
      attempts++;
      lastText = r.text || '';
      res = r.ok ? classify(lastText) : 'error';
      if (r.ok && r.status) bestStatus = r.status;
      lastResult = res;
    }

    if (TERMINAL.indexOf(res) >= 0) { lastResult = res; break; }
  }

  // ---------------- 落盘 + 通知 ----------------
  state[lastResult] = true;
  state.terminal = TERMINAL.indexOf(lastResult) >= 0;
  state.ts = Date.now();
  state.attempts = attempts;
  state.attemptsTotal = Number(state.attemptsTotal || 0) + attempts;
  state.lastAttemptTs = Date.now();
  state.burstFiredTs = Date.now();
  state.trace = lastText.slice(0, 300);
  await ctx.storage.setJSON(STATE_KEY, state);

  const labels = {
    success: '✅ 抢到了！去京东App「我的-优惠券」确认（券当天有效）',
    already: 'ℹ️ 今日已领取 / 已达上限',
    empty: '😵 券已发完（当天不再重试）',
    crowded: '🔄 排队太挤，未抢到',
    early: '⏰ 还没到放券时刻',
    error: '⚠️ 请求失败（网络问题）',
    badreq: '🚫 接口报错：抓到的可能不是领券接口，请用「候选列表」脚本看看抓到了什么',
    expired: '🔑 签名/登录态已过期：请在京东 App 点一次「领取」重新抓包',
    unknown: '❔ 返回无法判定（原始返回见下），可能是模板过期或接口变了'
  };
  const extra = manual ? '\n（手动试跑，已发 ' + attempts + ' 次）' : '';
  // 判定不了时把原始返回带出来，方便定位（同一��通知，不额外打扰）
  let raw = '';
  if (lastResult === 'unknown' || lastResult === 'error') {
    raw = '\n原始返回: ' + String(lastText).replace(/\s+/g, ' ').slice(0, 160);
  }
  await ctx.storage.setJSON(STATE_KEY, state);

  // 通知节流：
  //   终态（抢到/已领/抢完）-> 必报，这是你要的结果
  //   非终态（判定不了/网络错）-> 每小时最多一次，避免每分钟刷屏
  const isTerminalResult = TERMINAL.indexOf(lastResult) >= 0;
  if (isTerminalResult) {
    state.resultNotified = true;
    await ctx.storage.setJSON(STATE_KEY, state);
    ctx.notify({ title: '京东消费券', body: (labels[lastResult] || lastResult) + extra + raw, sound: true });
  } else {
    await notifyOnce(ctx, 'nonterm', HOUR, '京东消费券',
      (labels[lastResult] || lastResult) + extra + raw +
      '\n（同一问题每小时只提醒一次；修好后可在模块参数里改「详细通知」）', false);
  }
}

// 预热：打一发到同一 host（不涉及领券），顺便测 RTT
async function warmup(ctx, tpl, timeoutMs) {
  try {
    let origin = '';
    try { origin = new URL(tpl.url).origin; } catch (_) { return 0; }
    if (!origin) return 0;
    const t0 = Date.now();
    await ctx.http.get(origin + '/', { timeout: Math.min(timeoutMs, 3000), redirect: 'manual' });
    return Date.now() - t0;
  } catch (_) {
    return 0;
  }
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

// ============================ 候选列表模式 ============================
// 诊断用：把最近抓到的请求列出来，方便确认哪个才是真正的领券接口
async function modeList(ctx) {
  const cands = (await ctx.storage.getJSON(CAND_KEY)) || [];
  if (!cands.length) {
    ctx.notify({ title: '领券候选列表', body: '还没有抓到任何请求。\n请在京东 App 搜「烟台消费券」点一次「领取」。', sound: true });
    return;
  }
  const lines = cands.slice(0, 8).map((c, i) => {
    const t = c.capturedAt ? new Date(c.capturedAt).toLocaleTimeString() : '?';
    const fid = c.functionId || '(无functionId)';
    const u = String(c.url || '').slice(0, 70);
    return (i + 1) + '. ' + t + ' ' + c.method + ' ' + fid + '\n   ' + u;
  });
  ctx.notify({ title: '领券候选列表(' + cands.length + ')', body: lines.join('\n'), sound: false });
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
    else if (state.lastAttemptTs) { statusText = '🔄 补抢中'; statusColor = '#FF9F0A'; }
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
    if (name.indexOf('候选') >= 0) return await modeList(ctx);
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
