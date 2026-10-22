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
      get: async (url, o) => {
        const isFire = url === 'https://api.m.jd.com/x';
        calls.push({ m: 'GET', url, o, at: Date.now(), fire: isFire });
        return resp(isFire ? (opts.httpReply || { status: 200, body: '{"code":"0"}' })
                           : { status: 200, body: 'warmup' });
      },
      post: async (url, o) => {
        const isFire = url === 'https://api.m.jd.com/x';
        calls.push({ m: 'POST', url, o, at: Date.now(), fire: isFire });
        return resp(isFire ? (opts.httpReply || { status: 200, body: '{"code":"0"}' })
                           : { status: 200, body: 'warmup' });
      }
    },
    _store: store, _notifications: notifications, _calls: calls
  };
  return ctx;
}
// 只统计真正的领券请求（排除预热）
function fires(ctx) { return ctx._calls.filter((c) => c.fire); }
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
const FIRE_URL = SEED.url;

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
  check('默认不打扰（不通知）', ctx._notifications.length === 0, '实际 ' + ctx._notifications.length);
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
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '5' },
    httpReply: { status: 200, body: '{"code":"0","msg":"领取成功"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('只发一次就停', fires(ctx).length === 1, '实际 ' + fires(ctx).length);
  check('状态标记 success', st && st.success === true, JSON.stringify(st));
  check('通知提示已抢到', ctx._notifications[0] && /抢到/.test(ctx._notifications[0].body));
}

// ============ 5. snipe: code 0001 = 已领取（不是成功）============
console.log('\n[5] snipe.js 识别 0001 已领取');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '5' },
    httpReply: { status: 200, body: '{"code":"0001","echo":"您今日已领取"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('状态标记 already', st && st.already === true, JSON.stringify(st));
  check('没有误判为 success', st && st.success !== true);
  check('只发一次', fires(ctx).length === 1);
}

// ============ 6. snipe: 抢完 -> 终态，立即停（不浪费请求）============
console.log('\n[6] snipe.js 券已抢完立即停止');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '4', RETRY_MS: '10' },
    httpReply: { status: 200, body: '{"code":"0002","echo":"券已抢完"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('终态只打一发就停', fires(ctx).length === 1, '实际 ' + fires(ctx).length);
  check('状态标记 empty', st && st.empty === true, JSON.stringify(st));
  check('没有误判为 success', st && st.success !== true);
  check('标记终态', st && st.terminal === true);
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
  check('已成功则不再发请求', fires(ctx).length === 0, '实际 ' + fires(ctx).length);
}

// ============ 8. snipe: 无模板 ============
console.log('\n[8] snipe.js 缺模板提示');
{
  const ctx = makeCtx({ env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true' } });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('提示去手动抓包', ctx._notifications.length === 1 && /手动点一次/.test(ctx._notifications[0].body));
  check('没有发请求', fires(ctx).length === 0);
}

// ============ 9. snipe: 时刻已过且未开补发 ============
console.log('\n[9] snipe.js 时刻已过且未开补发');
{
  const ctx = makeCtx({ env: { TARGET_HMS: '00:00:00', RETRY_ALL_DAY: 'false' }, httpReply: { status: 200, body: '{"code":"0"}' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('未发请求', fires(ctx).length === 0);
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
  check('迟到时仍然补发了一次', fires(ctx).length === 1, '实际 ' + fires(ctx).length);
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
  check('上一轮在跑时不重复发', fires(ctx).length === 0, '实际 ' + fires(ctx).length);
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
  check('没有发请求', fires(ctx).length === 0);
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
  check('确实发了一次', fires(ctx).length === 1);
  console.log('     实测误差 ' + drift + 'ms，总耗时 ' + (Date.now() - t0) + 'ms');
}

// ============ 16. 状态小组件 ============
console.log('\n[16] 状态模式 渲染小组件');
{
  const ctx = makeCtx({ });
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
  const ctx = makeCtx({ });
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
    env: { NOTIFY_THROTTLE_MS: '60000', CAPTURE_NOTIFY: 'true' },
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
  const ctx = makeCtx({ env: { TARGET_HMS: hms, RETRY_ALL_DAY: 'true', NOTIFY_VERBOSE: 'true' }, httpReply: { status: 200, body: '{"code":"0"}' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('有提示', ctx._notifications.length === 1, '实际 ' + ctx._notifications.length);
  check('提示包含放券时刻', ctx._notifications[0] && ctx._notifications[0].body.includes(hms),
    ctx._notifications[0] && ctx._notifications[0].body);
  check('没有发请求', fires(ctx).length === 0);
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
  check('没有发请求', fires(ctx).length === 0);
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
  check('照样发了请求', fires(ctx).length >= 1, '实际 ' + fires(ctx).length);
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
  const ctx = makeCtx({ env: { TARGET_HMS: hms, RETRY_ALL_DAY: 'true', NOTIFY_VERBOSE: 'true' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  for (let i = 0; i < 5; i++) {
    await runScript('coupon-sniper.js', ctx, 'snipe');
  }
  check('5 次只提示 1 次', ctx._notifications.length === 1, '实际 ' + ctx._notifications.length);
}

// ============ 29. 突发：并发发数生效 ============
console.log('\n[29] 突发模式 并发发数');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '3', MAX_ROUNDS: '3' },
    httpReply: { status: 200, body: '{"code":"601"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const fc = fires(ctx);
  check('至少发了 3 发', fc.length >= 3, '实际 ' + fc.length);
  const spread = fc[2].at - fc[0].at;
  check('前 3 发是并发（时间戳几乎相同）', spread < 30, '相差 ' + spread + 'ms');
}

// ============ 30. 突发：并发里有一发成功即算成功 ============
console.log('\n[30] 突发模式 并发中任一成功即成功');
{
  let n = 0;
  const ctx = makeCtx({ env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '3', MAX_ROUNDS: '3' } });
  ctx.http.post = async (url, o) => {
    n++;
    ctx._calls.push({ m: 'POST', url, o, at: Date.now(), fire: true });
    const body = n === 2 ? '{"code":"0","subCode":"A1"}' : '{"code":"601"}';
    return { status: 200, headers: new Map(), text: async () => body, json: async () => JSON.parse(body) };
  };
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('判为成功', st && st.success === true, JSON.stringify(st));
  check('成功后立即停', fires(ctx).length === 3, '实际 ' + fires(ctx).length);
}

// ============ 31. 终态立即停（券发完不浪费）============
console.log('\n[31] 突发模式 终态立即停');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '20', BURST_GAP_MS: '10' },
    httpReply: { status: 200, body: '{"code":"0002","subCodeMsg":"券已抢完"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('只打一发就停', fires(ctx).length === 1, '实际 ' + fires(ctx).length);
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('标记终态', st && st.terminal === true);
}

// ============ 32. 「未开始」判为瞬态而非终态 ============
console.log('\n[32] 未开始算瞬态不误判为已发完');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '3', BURST_GAP_MS: '10' },
    httpReply: { status: 200, body: '{"code":"0000","msg":"活动未开始"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('未判为 empty', st && st.empty !== true, JSON.stringify(st));
  check('未判为终态', st && st.terminal !== true);
  check('继续重试', fires(ctx).length === 3, '实际 ' + fires(ctx).length);
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
  const n1 = fires(ctx).length;
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('成功后不再发', fires(ctx).length === n1, '实际 ' + fires(ctx).length);
  check('状态为 success', ctx.storage.getJSON('jd_coupon_sniper_state_v1').success === true);
}

// ============ 33. 返回码语义：code=0 + subCode A1 = 成功 ============
console.log('\n[33] 京东返回码语义 判定');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"code":"0","subCode":"A1"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('code=0 + subCode A1 判为成功', st && st.success === true, JSON.stringify(st));
}

// ============ 34. code=601 = 排队（瞬态，可重试）============
console.log('\n[34] code=601 排队判为瞬态');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '3', RETRY_MS: '10' },
    httpReply: { status: 200, body: '{"code":"601","msg":"此时排队领券的人太多，休息一会儿再试试吧！"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('判为 crowded 而非 empty', st && st.crowded === true, JSON.stringify(st));
  check('判为 crowded 后未标记终态', st && st.terminal !== true);
  check('瞬态会继续重试', fires(ctx).length === 3, '实际 ' + fires(ctx).length);
}

// ============ 35. 「已抢完」= 终态，立即停 ============
console.log('\n[35] 已抢完为终态立即停止');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '20', RETRY_MS: '10' },
    httpReply: { status: 200, body: '{"code":"0002","subCodeMsg":"券已抢完"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const st = ctx.storage.getJSON('jd_coupon_sniper_state_v1');
  check('判为 empty', st && st.empty === true, JSON.stringify(st));
  check('标记为终态', st && st.terminal === true);
  check('立刻停止只打一发', fires(ctx).length === 1, '实际 ' + fires(ctx).length);
}

// ============ 36. 终态后全天补抢不再发 ============
console.log('\n[36] 终态后不再补抢');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', RETRY_ALL_DAY: 'true', RETRY_MINUTES: '1', PARALLEL: '1', MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"code":"0002","subCodeMsg":"券已抢完"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  ctx.storage.setJSON('jd_coupon_sniper_state_v1', {
    date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
    lastAttemptTs: Date.now() - 120 * 60 * 1000,
    empty: true, terminal: true
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('终态当天不再发', fires(ctx).length === 0, '实际 ' + fires(ctx).length);
}

// ============ 37. 瞬态未果仍可补抢 ============
console.log('\n[37] 瞬态未果仍可补抢');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', RETRY_ALL_DAY: 'true', RETRY_MINUTES: '1', PARALLEL: '1', MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"code":"601"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  ctx.storage.setJSON('jd_coupon_sniper_state_v1', {
    date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
    lastAttemptTs: Date.now() - 120 * 60 * 1000,
    crowded: true
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('瞬态允许再打一轮', fires(ctx).length === 1, '实际 ' + fires(ctx).length);
}

// ============ 38. 突发阶段快、突发结束后退避 ============
console.log('\n[38] 突发快 过后退避');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1',
           BURST_COUNT: '2', BURST_GAP_MS: '40', MAX_ROUNDS: '7', RETRY_MS: '100' },
    httpReply: { status: 200, body: '{"code":"601"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const fc = fires(ctx);
  const gaps = [];
  for (let i = 1; i < fc.length; i++) gaps.push(fc[i].at - fc[i - 1].at);
  console.log('     间隔序列(ms): ' + gaps.join(', '));
  check('突发阶段间隔很小', gaps[0] < 120, gaps[0] + 'ms');
  check('突发阶段间隔稳定（不递增）', Math.abs(gaps[0] - gaps[1]) < 60, JSON.stringify(gaps.slice(0, 2)));
  check('突发结束后开始退避', gaps[3] > gaps[0], JSON.stringify(gaps));
}

// ============ 39. 睡前自检：模板过期会提醒刷新 ============
console.log('\n[39] 睡前自检 过期提醒');
{
  const ctx = makeCtx({
    env: { CHECK_ONLY: 'true', TARGET_HMS: '00:00:00', STALE_MINUTES: '30' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', {
    method: 'POST', url: 'https://api.m.jd.com/x', headers: {}, body: 'b',
    capturedAt: Date.now() - 60 * 60 * 1000      // 1 小时前
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('有自检通知', ctx._notifications.length === 1, '实际 ' + ctx._notifications.length);
  check('提示去点一次领取', ctx._notifications[0] && /点一次/.test(ctx._notifications[0].body),
    ctx._notifications[0] && ctx._notifications[0].body);
  check('自检不发领券请求', fires(ctx).length === 0, '实际 ' + fires(ctx).length);
}

// ============ 40. 睡前自检：模板新鲜则安心睡觉 ============
console.log('\n[40] 睡前自检 新鲜模板');
{
  const ctx = makeCtx({
    env: { CHECK_ONLY: 'true', TARGET_HMS: '00:00:00', STALE_MINUTES: '30' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', {
    method: 'POST', url: 'https://api.m.jd.com/x', headers: {}, body: 'b',
    capturedAt: Date.now() - 5 * 60 * 1000       // 5 分钟前
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('模板正常时保持安静', ctx._notifications.length === 0, '实际 ' + ctx._notifications.length);
  check('自检不发领券请求', fires(ctx).length === 0);
}

// ============ 41. 通知收敛：抓包默认不打扰 ============
console.log('\n[41] 抓包默认静默');
{
  const ctx = makeCtx({
    request: makeReq('https://api.m.jd.com/client.action?functionId=govCouponReceive', 'body=1')
  });
  await runScript('coupon-sniper.js', ctx, 'capture');
  check('抓包不发通知', ctx._notifications.length === 0, '实际 ' + ctx._notifications.length);
  check('但模板已抓到', !!ctx.storage.getJSON('jd_coupon_sniper_v1'));
}

// ============ 42. 通知收敛：开了抓包提醒才通知 ============
console.log('\n[42] 抓包提醒开关');
{
  const ctx = makeCtx({
    env: { CAPTURE_NOTIFY: 'true' },
    request: makeReq('https://api.m.jd.com/client.action?functionId=govCouponReceive', 'body=1')
  });
  await runScript('coupon-sniper.js', ctx, 'capture');
  check('开启后有通知', ctx._notifications.length === 1, '实际 ' + ctx._notifications.length);
}

// ============ 43. 通知收敛：抢到后不再每分钟重复提醒 ============
console.log('\n[43] 结果只报一次');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"code":"0","msg":"领取成功"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const n1 = ctx._notifications.length;
  check('第一轮报结果', n1 === 1, '实际 ' + n1);
  // 之后每分钟再跑，不该再报
  await runScript('coupon-sniper.js', ctx, 'snipe');
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('后续不再重复提醒', ctx._notifications.length === n1, '实际 ' + ctx._notifications.length);
}

// ============ 44. 通知收敛：默认不报「已就位」============
console.log('\n[44] 默认不报已就位');
{
  const tmr = new Date(Date.now() + 25 * 3600 * 1000);
  const p5 = (n) => String(n).padStart(2, '0');
  const hms = p5(tmr.getHours()) + ':' + p5(tmr.getMinutes()) + ':' + p5(tmr.getSeconds());
  const ctx = makeCtx({ env: { TARGET_HMS: hms, RETRY_ALL_DAY: 'true' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('默认无通知', ctx._notifications.length === 0, '实际 ' + ctx._notifications.length);
}

// ============ 45. 睡前自检：正常时保持安静 ============
console.log('\n[45] 睡前自检 正常时安静');
{
  const ctx = makeCtx({ env: { CHECK_ONLY: 'true', TARGET_HMS: '00:00:00', STALE_MINUTES: '30' } });
  ctx.storage.setJSON('jd_coupon_sniper_v1', {
    method: 'POST', url: 'https://api.m.jd.com/x', headers: {}, body: 'b',
    capturedAt: Date.now() - 5 * 60 * 1000
  });
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('模板正常时无通知', ctx._notifications.length === 0, '实际 ' + ctx._notifications.length);
}

// ============ 46. 未知结果通知按小时节流（防刷屏）============
console.log('\n[46] 未知结果不刷屏');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '1' },
    httpReply: { status: 200, body: '{"weird":"payload"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  const n1 = ctx._notifications.length;
  check('第一次会通知', n1 === 1, '实际 ' + n1);
  check('通知里带原始返回', ctx._notifications[0] && /原始返回/.test(ctx._notifications[0].body),
    ctx._notifications[0] && ctx._notifications[0].body);
  // 连续多轮不应重复通知
  await runScript('coupon-sniper.js', ctx, 'snipe');
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('不再重复通知', ctx._notifications.length === n1, '实际 ' + ctx._notifications.length);
}

// ============ 47. 接口不存在 = 抓错接口（明确提示）============
console.log('\n[47] 接口不存在有专门提示');
{
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00', CATCH_UP: 'true', PARALLEL: '1', MAX_ROUNDS: '5' },
    httpReply: { status: 200, body: '{"code":"2","echo":"the current API does not exist"}' }
  });
  ctx.storage.setJSON('jd_coupon_sniper_v1', SEED);
  await runScript('coupon-sniper.js', ctx, 'snipe');
  check('判为 badreq', ctx._notifications[0] && /抓到的可能不是领券接口/.test(ctx._notifications[0].body),
    ctx._notifications[0] && ctx._notifications[0].body);
}

// ============ 48. 候选列表角色 ============
console.log('\n[48] 候选列表脚本');
{
  const ctx = makeCtx({});
  ctx.storage.setJSON('jd_coupon_sniper_cands_v1', [
    { method: 'POST', url: 'https://api.m.jd.com/client.action?functionId=govCouponReceive',
      headers: {}, body: 'b', functionId: 'govCouponReceive', capturedAt: Date.now() },
    { method: 'GET', url: 'https://api.m.jd.com/x?functionId=other', headers: {}, body: null,
      functionId: 'other', capturedAt: Date.now() - 1000 }
  ]);
  await runScript('coupon-sniper.js', ctx, '候选列表');
  check('列出候选', ctx._notifications.length === 1, '实际 ' + ctx._notifications.length);
  check('含 functionId', ctx._notifications[0] && /govCouponReceive/.test(ctx._notifications[0].body),
    ctx._notifications[0] && ctx._notifications[0].body);
}

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————');
process.exit(fail ? 1 : 0);
