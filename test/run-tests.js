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
  status: '烟台消费券-状态'
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
  const ctx = makeCtx({ env: { TARGET_HMS: '00:00:00' }, httpReply: { status: 200, body: '{"code":"0"}' } });
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
  const ctx = makeCtx({ env: { TARGET_HMS: '03:17:00' }, httpReply: { status: 200, body: '{"code":"0"}' } });
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

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————');
process.exit(fail ? 1 : 0);
