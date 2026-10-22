/**
 * 测试：在 Node 里伪造 Egern ctx，验证 capture -> snipe 全流程。
 * 用法：node test/run-tests.js
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// 脚本文件位置：优先 ../egern/，其次同级
function scriptPath() {
  const cands = [join(here, '..', 'egern'), join(here, '..')];
  for (const d of cands) {
    if (existsSync(join(d, 'coupon-sniper.js'))) return d;
  }
  return join(here, '..');
}
const load = (f) => readFileSync(join(scriptPath(), f), 'utf-8');

// 单文件多角色：靠 ctx.script.name 分派
const ROLE_NAME = {
  capture: '烟台消费券-自动抓包',
  snipe: '烟台消费券-定时抢券',
  status: '烟台消费券-状态',
  toggle: '烟台消费券-开关'
};
async function runScript(file, ctx, role) {
  const src = load(file)
    .replace(/export default async function \(ctx\)\s*\{/, 'return (async function (ctx) {')
    .trimEnd() + ')';
  const fn = new Function(src)();
  if (role) ctx.script = { name: ROLE_NAME[role] || role };
  return await fn(ctx);
}

function makeCtx(opts = {}) {
  const store = new Map();
  const notifications = [];
  const calls = [];
  const ctx = {
    env: opts.env || {},
    request: opts.request,
    response: opts.response,
    storage: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => store.set(k, String(v)),
      getJSON: (k) => {
        const v = store.get(k);
        if (v === undefined) return null;
        try { return JSON.parse(v); } catch { return null; }
      },
      setJSON: (k, v) => store.set(k, JSON.stringify(v)),
      delete: (k) => store.delete(k)
    },
    notify: (o) => notifications.push(o),
    http: {
      get: async (url, o) => { calls.push({ m: 'GET', url, o }); return resp(opts.httpReply || { status: 200, body: '{"code":"0"}' }); },
      post: async (url, o) => { calls.push({ m: 'POST', url, o }); return resp(opts.httpReply || { status: 200, body: '{"code":"0"}' }); }
    },
    _store: store, _notifications: notifications, _calls: calls
  };
  return ctx;
}
function resp(r) {
  return { status: r.status, headers: new Map(), text: async () => r.body, json: async () => JSON.parse(r.body) };
}
function makeReq(url, body = null, extraHeaders = {}) {
  const h = new Map(Object.entries({
    'Cookie': 'pt_key=AAA; pt_pin=jd_test',
    'User-Agent': 'jdapp;iPhone;13.0.0',
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Irrelevant': 'drop-me',
    ...extraHeaders
  }));
  return {
    method: 'POST',
    url,
    headers: { get: (n) => h.get(n) },
    body: { text: async () => body }
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
const SEED = { method: 'POST', url: 'https://api.m.jd.com/x', headers: { Cookie: 'a=b' }, body: 'body=1' };

// ============ 1. capture ============
console.log('\n[1] capture.js 抓取真实请求');
{
  const req = makeReq('https://api.m.jd.com/client.action?functionId=govCouponReceive&actId=123',
                      'body=%7B%22actId%22%3A%22123%22%7D');
  const ctx = makeCtx({ request: req });
  await runScript('coupon-sniper.js', ctx, 'capture');
  const tpl = ctx.storage.getJSON('jd_coupon_sniper_v1');
  check('模板已写入 storage', !!tpl);
  check('method 正确', tpl && tpl.method === 'POST', tpl && tpl.method);
  check('url 正确', tpl && tpl.url.includes('govCouponReceive'));
  check('body 已抓到', tpl && /actId/.test(tpl.body || ''), String(tpl && tpl.body));
  check('Cookie 已保存', tpl && tpl.headers.Cookie.includes('pt_key'));
  check('无关请求头已过滤', tpl && !tpl.headers['X-Irrelevant']);
  check('发了通知', ctx._notifications.length === 1);
}

// ============ 2. capture 忽略非京东域名 ============
console.log('\n[2] capture.js 忽略非京东请求');
{
  const ctx = makeCtx({ request: makeReq('https://api.example.com/x', 'a=1') });
  await runScript('coupon-sniper.js', ctx, 'capture');
  check('非京东请求未写模板', !ctx.storage.getJSON('jd_coupon_sniper_v1'));
  check('非京东请求不打扰用户', ctx._notifications.length === 0);
}

// ============ 3. capture 忽略纯 GET 页面浏览 ============
console.log('\n[3] capture.js 忽略无特征 GET');
{
  const ctx = makeCtx({ request: makeReq('https://item.jd.com/100.html', null) });
  await runScript('coupon-sniper.js', ctx, 'capture');
  const tpl = ctx.storage.getJSON('jd_coupon_sniper_v1');
  check('GET 页面不作为模板（或仅存为弱候选）', !tpl || !tpl.body);
}

// ============ 4. snipe: 成功 ============
console.log('\n[4] snipe.js 领取成功');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', MAX_ROUNDS: '5' },
    httpReply: { status: 200, body: '{"code":"0","msg":"领取成功"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('只发一次就停', ctx._calls.length === 1, '实际 ' + ctx._calls.length);
  check('状态标记 success', st && st.success === true, JSON.stringify(st));
  check('通知提示已抢到', ctx._notifications[0] && /抢到/.test(ctx._notifications[0].body));
}

// ============ 5. snipe: code 0001 = 已领取（不是成功）============
console.log('\n[5] snipe.js 识别 0001 已领取');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', MAX_ROUNDS: '5' },
    httpReply: { status: 200, body: '{"code":"0001","echo":"您今日已领取"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('状态标记 already', st && st.already === true, JSON.stringify(st));
  check('没有误判为 success', st && st.success !== true);
  check('只发一次', ctx._calls.length === 1);
}

// ============ 6. snipe: 抢完 -> 重试到上限 ============
console.log('\n[6] snipe.js 券已抢完时重试');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', MAX_ROUNDS: '4', RETRY_MS: '10' },
    httpReply: { status: 200, body: '{"code":"0002","echo":"券已抢完"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('打满了重试次数', ctx._calls.length === 4, '实际 ' + ctx._calls.length);
  check('状态标记 empty', st && st.empty === true, JSON.stringify(st));
  check('没有误判为 success', st && st.success !== true);
}

// ============ 7. snipe: 幂等 ============
console.log('\n[7] snipe.js 当天幂等');
{
  const ctx = makeCtx({ env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true' }, httpReply: { status: 200, body: '{"code":"0"}' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  ctx.storage.setJSON('jd_coupon_sniper_state_v1', {
    date: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()), success: true
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('已成功则不再发请求', ctx._calls.length === 0, '实际 ' + ctx._calls.length);
}

// ============ 8. snipe: 无模板 ============
console.log('\n[8] snipe.js 缺模板提示');
{
  const ctx = makeCtx({ env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true' } });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('提示去手动抓包', ctx._notifications.length === 1 && /手动点一次/.test(ctx._notifications[0].body));
  check('没有发请求', ctx._calls.length === 0);
}

// ============ 9. snipe: 时刻已过且未开补发 ============
console.log('\n[9] snipe.js 时刻已过且未开补发');
{
  const ctx = makeCtx({ env: { TARGET_HMS: '00:00:00', RETRY_ALL_DAY: 'false' }, httpReply: { status: 200, body: '{"code":"0"}' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('未发请求', ctx._calls.length === 0);
}

// ============ 10. 定时精度（跨秒等待）============
console.log('\n[10] snipe.js 触发精度');
{
  // 目标设为 3 秒后的那一整秒
  const d = new Date(Date.now() + 3000);
  const p = (n) => String(n).padStart(2, '0');
  const hms = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  const ctx = makeCtx({
    env: { TARGET_HMS: hms, MAX_ROUNDS: '1', PREFIRE_MS: '0' },
    httpReply: { status: 200, body: '{"code":"0"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const target = new Date(); target.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const drift = Math.abs(Date.now() - target.getTime());
  check('发出时刻误差 < 150ms', drift < 150, '误差 ' + drift + 'ms');
  console.log('     实测误差 ' + drift + 'ms');
}

// ============ 11. 提前量 PREFIRE_MS 生效 ============
console.log('\n[11] snipe.js 提前量生效');
{
  const d = new Date(Date.now() + 2000);
  const p = (n) => String(n).padStart(2, '0');
  const hms = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  const ctx = makeCtx({
    env: { TARGET_HMS: hms, MAX_ROUNDS: '1', PREFIRE_MS: '200' },
    httpReply: { status: 200, body: '{"code":"0"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const target = new Date(); target.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const lead = target.getTime() - Date.now();
  check('提前了 150~250ms 发出', lead >= 150 && lead <= 250, '实际提前 ' + lead + 'ms');
}

// ============ 12. 迟到补发（cron 晚触发）============
console.log('\n[12] snipe.js 迟到补发');
{
  // 目标时刻设为 30 秒前（模拟 cron 晚触发但在宽限期内）
  const d = new Date(Date.now() - 30000);
  const p = (n) => String(n).padStart(2, '0');
  const hms = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  const ctx = makeCtx({
    env: { TARGET_HMS: hms, MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"code":"0"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const t0 = Date.now();
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('迟到时仍然补发了一次', ctx._calls.length === 1, '实际 ' + ctx._calls.length);
  check('补发没有干等', Date.now() - t0 < 1500, (Date.now() - t0) + 'ms');
}

// ============ 13. 并发锁：上一轮未结束时不重复打 ============
console.log('\n[13] snipe.js 并发锁');
{
  const ctx = makeCtx({ env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true' }, httpReply: { status: 200, body: '{"code":"0"}' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  ctx.storage.setJSON('jd_coupon_sniper_state_v1', {
    date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
    lockTs: Date.now()
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('上一轮在跑时不重复发', ctx._calls.length === 0, '实际 ' + ctx._calls.length);
}

// ============ 14. 非目标分钟直接返回（不空等）============
console.log('\n[14] snipe.js 非目标分钟快速返回');
{
  // 用明确还没到的时刻，确保走"未到点立即返回"分支
  const tmr = new Date(Date.now() + 25 * 3600 * 1000);
  const p4 = (n) => String(n).padStart(2, '0');
  const hms = p4(tmr.getHours()) + ':' + p4(tmr.getMinutes()) + ':' + p4(tmr.getSeconds());
  const ctx = makeCtx({ env: { TARGET_HMS: hms, RETRY_ALL_DAY: 'true' }, httpReply: { status: 200, body: '{"code":"0"}' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const t0 = Date.now();
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('立即返回', Date.now() - t0 < 500, (Date.now() - t0) + 'ms');
  check('没有发请求', ctx._calls.length === 0);
}

// ============ 15. 目标在 60 秒后 -> 等到点再发 ============
console.log('\n[15] snipe.js 跨分钟等待');
{
  const d = new Date(Date.now() + 60000);
  const p2 = (n) => String(n).padStart(2, '0');
  const hms = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  const ctx = makeCtx({
    env: { TARGET_HMS: hms, MAX_ROUNDS: '1', PREFIRE_MS: '0' },
    httpReply: { status: 200, body: '{"code":"0"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const target = new Date(); target.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0);
  const t0 = Date.now();
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const drift = Math.abs(Date.now() - target.getTime());
  check('等待了约 60s 后准时发', drift < 150, '误差 ' + drift + 'ms');
  check('确实发了一次', ctx._calls.length === 1);
  console.log('     实测误差 ' + drift + 'ms，总耗时 ' + (Date.now() - t0) + 'ms');
}

// ============ 16. 状态小组件 ============
console.log('\n[16] 状态模式 渲染小组件');
{
  const ctx = makeCtx({});
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  ctx.storage.setJSON('jd_coupon_sniper_state_v1', {
    date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
    success: true
  });
  const out = await runScript('coupon-sniper.js', ctx, 'status');
  check('返回 widget DSL', out && out.type === 'widget', JSON.stringify(out).slice(0, 80));
  check('有子节点', !!(out && out.children && out.children.length));
  check('显示已抢到', out && JSON.stringify(out.children).includes('已抢到'));
}

// ============ 17. 未抓包时状态提示 ============
console.log('\n[17] 状态模式 未抓包提示');
{
  const ctx = makeCtx({});
  const out = await runScript('coupon-sniper.js', ctx, 'status');
  check('提示手动点一次', out && JSON.stringify(out.children).includes('手动点一次'));
}

// ============ 18. 开关：默认开 -> 关 ============
console.log('\n[18] 开关模式 切换持续抓取');
{
  const ctx = makeCtx({ env: { CAPTURE_ALWAYS: 'true' } });
  await runScript('coupon-sniper.js', ctx, 'toggle');
  const cfg = ctx.storage.getJSON('jd_coupon_sniper_cfg_v1');
  check('首次切换为 off', cfg && cfg.capture === 'off', JSON.stringify(cfg));
  check('通知告知已关闭', ctx._notifications[0] && /已关闭/.test(ctx._notifications[0].body));
}

// ============ 19. 开关：再切回开 ============
console.log('\n[19] 开关模式 再次切换');
{
  const ctx = makeCtx({ env: { CAPTURE_ALWAYS: 'true' } });
  ctx.storage.setJSON('jd_coupon_sniper_cfg_v1', { capture: 'off' });
  await runScript('coupon-sniper.js', ctx, 'toggle');
  const cfg = ctx.storage.getJSON('jd_coupon_sniper_cfg_v1');
  check('切回 on', cfg && cfg.capture === 'on', JSON.stringify(cfg));
}

// ============ 20. 开关关闭时不再抓包 ============
console.log('\n[20] 持续抓取 关闭后不抓包');
{
  const ctx = makeCtx({ request: makeReq('https://api.m.jd.com/client.action?functionId=govCouponReceive', 'body=1') });
  ctx.storage.setJSON('jd_coupon_sniper_cfg_v1', { capture: 'off' });
  await runScript('coupon-sniper.js', ctx, 'capture');
  check('关闭时不写模板', !ctx.storage.getJSON('jd_coupon_sniper_v1'));
  check('关闭时不通知', ctx._notifications.length === 0);
}

// ============ 21. 持续抓取会刷新模板（签名保鲜）============
console.log('\n[21] 持续抓取 刷新模板');
{
  const ctx = makeCtx({ request: makeReq('https://api.m.jd.com/client.action?functionId=govCouponReceive&t=1', 'body=OLD') });
  await runScript('coupon-sniper.js', ctx, 'capture');
  const t1 = ctx.storage.getJSON('jd_coupon_sniper_v1');
  check('首次抓到模板', !!t1 && /OLD/.test(t1.body || ''));

  // 同一 functionId 再来一发更新的
  const ctx2 = makeCtx({ request: makeReq('https://api.m.jd.com/client.action?functionId=govCouponReceive&t=2', 'body=NEW') });
  ctx2.storage.setJSON('jd_coupon_sniper_v1', t1);
  await runScript('coupon-sniper.js', ctx2, 'capture');
  const t2 = ctx2.storage.getJSON('jd_coupon_sniper_v1');
  check('模板被刷新为最新', !!t2 && /NEW/.test(t2.body || ''), t2 && t2.body);
  check('functionId 被记录', !!t2 && t2.functionId === 'govCouponReceive');
}

// ============ 22. 通知节流 ============
console.log('\n[22] 持续抓取 通知节流');
{
  const ctx = makeCtx({
    env: { NOTIFY_THROTTLE_MS: '60000' },
    request: makeReq('https://api.m.jd.com/client.action?functionId=govCouponReceive', 'body=1')
  });
  for (let i = 0; i < 5; i++) {
    await runScript('coupon-sniper.js', ctx, 'capture');
  }
  check('多次抓取只通知一次', ctx._notifications.length === 1, '实际 ' + ctx._notifications.length);
}

// ============ 23. 状态显示开关状态 ============
console.log('\n[23] 状态模式 显示抓取开关');
{
  const ctx = makeCtx({ env: { CAPTURE_ALWAYS: 'true' } });
  ctx.storage.setJSON('jd_coupon_sniper_cfg_v1', { capture: 'off' });
  const out = await runScript('coupon-sniper.js', ctx, 'status');
  check('显示为关', JSON.stringify(out.children).includes('持续抓取：关'));
}

// ============ 24. 抢券：还没到点时要有提示 ============
console.log('\n[24] 抢券模式 未到点会提示已就位');
{
  // 用一个明确还没到的时刻（明天），确保走"未到点"分支
  const tmr = new Date(Date.now() + 25 * 3600 * 1000);
  const p3 = (n) => String(n).padStart(2, '0');
  const hms = p3(tmr.getHours()) + ':' + p3(tmr.getMinutes()) + ':' + p3(tmr.getSeconds());
  const ctx = makeCtx({ env: { TARGET_HMS: hms, RETRY_ALL_DAY: 'true' }, httpReply: { status: 200, body: '{"code":"0"}' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('有提示', ctx._notifications.length === 1, '实际 ' + ctx._notifications.length);
  check('提示包含放券时刻', ctx._notifications[0] && ctx._notifications[0].body.includes(hms),
    ctx._notifications[0] && ctx._notifications[0].body);
  check('没有发请求', ctx._calls.length === 0);
}

// ============ 25. 抢券：当天已完成会告知 ============
console.log('\n[25] 抢券模式 当天已完成会告知');
{
  const ctx = makeCtx({ env: { TARGET_HMS: '00:00:00' }, httpReply: { status: 200, body: '{"code":"0"}' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  ctx.storage.setJSON('jd_coupon_sniper_state_v1', {
    date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()), success: true
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('有提示', ctx._notifications.length === 1, '实际 ' + ctx._notifications.length);
  check('说明不会重复发送', ctx._notifications[0] && /不会重复/.test(ctx._notifications[0].body),
    ctx._notifications[0] && ctx._notifications[0].body);
  check('没有发请求', ctx._calls.length === 0);
}

// ============ 26. 手动试跑：无视当天已完成，照发并回报 ============
console.log('\n[26] 手动试跑 强制发出');
{
  const ctx = makeCtx({
    env: { SNIPE_MODE: 'manual', MAX_ROUNDS: '2', RETRY_MS: '10' },
    httpReply: { status: 200, body: '{"code":"0","msg":"领取成功"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  ctx.storage.setJSON('jd_coupon_sniper_state_v1', {
    date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()), success: true
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('照样发了请求', ctx._calls.length >= 1, '实际 ' + ctx._calls.length);
  check('回报了结果', ctx._notifications.length >= 1);
  check('结果提示含抢到', ctx._notifications.some((n) => /抢到/.test(n.body)),
    JSON.stringify(ctx._notifications.map((n) => n.body)));
}

// ============ 27. 手动试跑：没有模板也要提示 ============
console.log('\n[27] 手动试跑 缺模板时提示');
{
  const ctx = makeCtx({ env: { SNIPE_MODE: 'manual' } });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('提示去手动抓包', ctx._notifications.length === 1 && /手动点一次/.test(ctx._notifications[0].body));
}

// ============ 28. 已就位提示按小时节流，不刷屏 ============
console.log('\n[28] 未到点提示节流');
{
  const tmr = new Date(Date.now() + 25 * 3600 * 1000);
  const p3 = (n) => String(n).padStart(2, '0');
  const hms = p3(tmr.getHours()) + ':' + p3(tmr.getMinutes()) + ':' + p3(tmr.getSeconds());
  const ctx = makeCtx({ env: { TARGET_HMS: hms, RETRY_ALL_DAY: 'true' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  for (let i = 0; i < 5; i++) {
    await runScript('coupon-sniper.js', ctx, 'snipe');
  }
  check('5 次只提示 1 次', ctx._notifications.length === 1, '实际 ' + ctx._notifications.length);
}

// ============ 29. 全天补抢：间隔内不发 ============
console.log('\n[29] 全天补抢 间隔内不重复打');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', RETRY_ALL_DAY: 'true', RETRY_MINUTES: '15', MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"code":"0002","echo":"券已抢完"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  // 第一次：已过放券时刻很久 -> 视为补抢轮，立刻打
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('第一轮发出', ctx._calls.length === 1, '实际 ' + ctx._calls.length);
  // 第二轮：间隔未到 -> 不发
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('间隔内不再发', ctx._calls.length === 1, '实际 ' + ctx._calls.length);
}

// ============ 30. 全天补抢：间隔到了再发 ============
console.log('\n[30] 全天补抢 间隔到点后再发');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', RETRY_ALL_DAY: 'true', RETRY_MINUTES: '15', MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"code":"0002","echo":"券已抢完"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  ctx.storage.setJSON('jd_coupon_sniper_state_v1', {
    date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
    lastAttemptTs: Date.now() - 16 * 60 * 1000     // 16 分钟前
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('间隔已过 -> 补发一次', ctx._calls.length === 1, '实际 ' + ctx._calls.length);
}

// ============ 31. 补抢到点截止后停止 ============
console.log('\n[31] 全天补抢 过了截止时间不再发');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', RETRY_ALL_DAY: 'true', RETRY_MINUTES: '15', RETRY_UNTIL: '00:01', MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"code":"0002"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  ctx.storage.setJSON('jd_coupon_sniper_state_v1', {
    date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
    lastAttemptTs: Date.now() - 60 * 60 * 1000
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('截止后不发', ctx._calls.length === 0, '实际 ' + ctx._calls.length);
}

// ============ 32. 抢到后当天不再补抢 ============
console.log('\n[32] 抢到后不再补抢');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', RETRY_ALL_DAY: 'true', RETRY_MINUTES: '1', MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"code":"0","msg":"领取成功"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const n1 = ctx._calls.length;
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('成功后不再发', ctx._calls.length === n1, '实际 ' + ctx._calls.length);
  check('状态为 success', ctx.storage.getJSON('jd_coupon_sniper_state_v1').success === true);
}

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————');
process.exit(fail ? 1 : 0);
