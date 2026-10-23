/**
 * v8 极简版测试：伪造 Egern ctx，验证 capture → snipe 全流程。
 * 用法：node test/run-tests.js
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
function scriptPath() {
  const cands = [join(here, '..', 'egern'), join(here, '..')];
  for (const d of cands) if (existsSync(join(d, 'coupon-sniper.js'))) return d;
  return join(here, '..');
}
const load = (f) => readFileSync(join(scriptPath(), f), 'utf-8');

// 角色名映射：名字含「抓包」→ capture；其它 → snipe
const ROLE_NAME = {
  capture: '烟台消费券-抓包',
  snipe: '烟台消费券-抢券'
};
async function runScript(ctx, role) {
  const src = load('coupon-sniper.js')
    .replace(/export default async function \(ctx\)\s*\{/, 'return (async function (ctx) {')
    .trimEnd() + ')';
  const fn = new Function(src)();
  if (role) ctx.script = { name: ROLE_NAME[role] || role };
  return await fn(ctx);
}

function makeCtx(opts = {}) {
  const store = new Map();
  const notifications = [];
  const ctx = {
    env: opts.env || {},
    request: opts.request,
    storage: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => store.set(k, String(v)),
      getJSON: (k) => { const v = store.get(k); if (v === undefined) return null; try { return JSON.parse(v); } catch { return null; } },
      setJSON: (k, v) => store.set(k, JSON.stringify(v)),
      delete: (k) => store.delete(k)
    },
    notify: (o) => notifications.push(o),
    http: {
      get: async (url, o) => fakeResp(opts.getResp || (() => ({ status: 200, text: JSON.stringify({ code: '0', subCode: 'A1' }) })), url, o),
      post: async (url, o) => fakeResp(opts.postResp || (() => ({ status: 200, text: JSON.stringify({ code: '0', subCode: 'A1' }) })), url, o)
    }
  };
  // 暴露 storage 供测试断言
  ctx._store = store; ctx._notes = notifications;
  return ctx;
}
async function fakeResp(make, url, o) {
  const r = make(url, o);
  const text = typeof r.text === 'string' ? r.text : JSON.stringify(r.text || '');
  return { status: r.status ?? 200, text: async () => text };
}

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

function mkReq(url, fid, method = 'POST', text = '') {
  return {
    url, method,
    headers: { get: (n) => ({ cookie: 'ck=1', 'user-agent': 'jdapp', 'content-type': 'application/json' }[n.toLowerCase()]) },
    text: async () => text
  };
}

// ================= 1. 抓包 → 模板 =================
console.log('\n[1] 抓包：京东领券请求 → 存模板');
{
  const ctx = makeCtx();
  await runScript(ctx, 'capture');
  // 无 request → 静默，不崩
  check('无 request 不崩', true);
}
{
  const ctx = makeCtx({ request: mkReq('https://api.m.jd.com/api?functionId=batchReceiveXFCoupon&x=1', 'batchReceiveXFCoupon', 'POST', '{"a":1}') });
  await runScript(ctx, 'capture');
  const tpl = JSON.parse(ctx._store.get('jd_coupon_tpl_v8') || 'null');
  check('存了模板', !!tpl);
  check('模板含 functionId', tpl && /batchReceiveXFCoupon/.test(tpl.functionId));
  check('模板含 body', tpl && tpl.body === '{"a":1}');
}
{
  // 非京东域名 → 不存
  const ctx = makeCtx({ request: mkReq('https://evil.example.com/api?functionId=receiveCoupon', 'receiveCoupon') });
  await runScript(ctx, 'capture');
  check('非京东域名不存', !ctx._store.get('jd_coupon_tpl_v8'));
}
{
  // 无 functionId 但含 coupon 关键词 → 存
  const ctx = makeCtx({ request: mkReq('https://wq.jd.com/coupon/get', '', 'POST', 'x') });
  await runScript(ctx, 'capture');
  check('无 functionId 但 coupon 关键词 → 存', !!ctx._store.get('jd_coupon_tpl_v8'));
}

// ================= 2. classify 语义 =================
console.log('\n[2] 返回码语义');
{
  const cases = [
    [JSON.stringify({ code: '0', subCode: 'A1' }), 'success'],
    [JSON.stringify({ code: '0', subCode: 'B1' }), 'success'],
    [JSON.stringify({ code: '0', msg: '领取成功' }), 'success'],
    ['{"success":true}', 'success'],
    [JSON.stringify({ code: '0', subCode: 'A169' }), 'success'],   // 京东前端也算成功
    [JSON.stringify({ code: '0', msg: '已领取' }), 'already'],
    [JSON.stringify({ code: '0', msg: '已抢完，明天再来' }), 'empty'],
    [JSON.stringify({ code: '601', msg: '排队的人太多' }), 'crowded'],
    [JSON.stringify({ code: '0', msg: '活动未开始' }), 'early'],
    [JSON.stringify({ code: '2', msg: 'does not exist' }), 'badreq'],
    [JSON.stringify({ code: '3', msg: '签名错误' }), 'expired'],
    [JSON.stringify({ code: '9', msg: '啥奇怪文案' }), 'unknown']
  ];
  // 通过 snipe 的 fire→classify 验证太绕，这里直接复制一份判定逻辑做黑盒
  // —— 但为保真实，我们改成实际跑 snipe 手动模式，让脚本自己分类。
  for (const [resp, expect] of cases) {
    const ctx = makeCtx({
      env: { SNIPE_MODE: 'manual', TARGET_HMS: '00:00:00' },
      postResp: () => ({ status: 200, text: resp })
    });
    ctx._store.set('jd_coupon_tpl_v8', JSON.stringify({ method: 'POST', url: 'https://api.m.jd.com/api?functionId=x', headers: {}, body: '{}', functionId: 'x', capturedAt: Date.now() }));
    await runScript(ctx, 'snipe');
    const st = JSON.parse(ctx._store.get('jd_coupon_state_v8'));
    check('[' + expect + ']  → ' + (st.result || '?'), st.result === expect, JSON.stringify(resp).slice(0, 40));
  }
}

// ================= 3. 抢券：无模板 → 通知提示 =================
console.log('\n[3] 无模板');
{
  const ctx = makeCtx({ env: { SNIPE_MODE: 'manual' } });
  await runScript(ctx, 'snipe');
  check('提示"没有模板"', ctx._notes.length === 1 && /没有模板/.test(ctx._notes[0].body));
}

// ================= 4. 抢券：手动模式必发且通知 =================
console.log('\n[4] 手动试跑');
{
  let called = 0;
  const ctx = makeCtx({
    env: { SNIPE_MODE: 'manual' },
    postResp: () => { called++; return { status: 200, text: JSON.stringify({ code: '0', msg: '领取成功' }) }; }
  });
  ctx._store.set('jd_coupon_tpl_v8', JSON.stringify({ method: 'POST', url: 'https://api.m.jd.com/api?functionId=w', headers: {}, body: '{}', functionId: 'w', capturedAt: Date.now() }));
  await runScript(ctx, 'snipe');
  check('手动只发 1 发', called === 1);
  const st = JSON.parse(ctx._store.get('jd_coupon_state_v8'));
  check('分类为 success', st.result === 'success');
  check('通知含"抢到了"', ctx._notes.some((n) => /抢到了/.test(n.body)));
  check('state.terminal = true', st.terminal === true);
}

// ================= 5. 抢券：自动模式，还没到点 → 不动作 =================
console.log('\n[5] 自动模式：距离放券点 >90s → 静默');
{
  let called = 0;
  const ctx = makeCtx({
    env: { TARGET_HMS: '00:00:00' },
    postResp: () => { called++; return { status: 200, text: JSON.stringify({ code: '0', msg: '领取成功' }) }; }
  });
  ctx._store.set('jd_coupon_tpl_v8', JSON.stringify({ method: 'POST', url: 'https://api.m.jd.com/api?functionId=w', headers: {}, body: '{}', functionId: 'w', capturedAt: Date.now() }));
  // 伪造 now：距放券点 5 分钟（脚本里 Date.now() 真实调用，这里没法 mock，但可以验证"今天点已过则等明天"分支）
  await runScript(ctx, 'snipe');
  // 若现在距 00:00:00 已过 2 分钟，则等明天 → 不发请求也不通知
  const now = new Date(); const seg = [0,0,0]; const cand = new Date(); cand.setHours(0,0,0,0);
  const passed = now.getTime() - cand.getTime() > 120000;
  check(passed ? '已过放券点(>2min) → 等明天,静默' : '在放券窗口内 → 正常', passed ? called === 0 : called >= 1, 'called=' + called);
}

// ================= 6. 终态后当天不再重复通知 =================
console.log('\n[6] 终态落盘');
{
  const ctx = makeCtx({
    env: { SNIPE_MODE: 'manual' },
    postResp: () => ({ status: 200, text: JSON.stringify({ code: '0', msg: '券已发完' }) })
  });
  ctx._store.set('jd_coupon_tpl_v8', JSON.stringify({ method: 'POST', url: 'https://api.m.jd.com/api?functionId=w', headers: {}, body: '{}', functionId: 'w', capturedAt: Date.now() }));
  await runScript(ctx, 'snipe');
  const st = JSON.parse(ctx._store.get('jd_coupon_state_v8'));
  check('券发完 → empty', st.result === 'empty');
  check('terminal = true', st.terminal === true);
}

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————');
process.exit(fail ? 1 : 0);