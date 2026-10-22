#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
京东消费券 / 优惠券 定时领取器（请求重放模式，仅限本人账号自用）

流程：抓一次真实领券请求 -> curl2template.py 转成模板 -> 本脚本对时后在整点精确重发。

用法示例：
  python3 grab.py -t template.json --probe          # 立刻试打一发，验证模板
  python3 grab.py -t template.json --in 20          # 20 秒后开抢
  python3 grab.py -t template.json --daily 00:00    # 每天 00:00:00 开抢（今天已过则明天）
  python3 grab.py -t template.json --at "2026-10-23 00:00:00"
"""
import argparse
import json
import os
import random
import ssl
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148")

def _make_ctx():
    for p in (os.environ.get("SSL_CERT_FILE"), "/etc/ssl/certs/ca-certificates.crt",
              "/etc/ssl/cert.pem"):
        if p and os.path.exists(p):
            try:
                return ssl.create_default_context(cafile=p)
            except Exception:
                pass
    return ssl.create_default_context()


CTX = _make_ctx()


def _insecure_ctx():
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c

PH = {
    "{{ts_s}}": lambda: str(int(time.time())),
    "{{ts_ms}}": lambda: str(int(time.time() * 1000)),
    "{{ts_us}}": lambda: str(int(time.time() * 1000000)),
    "{{date}}": lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "{{uuid}}": lambda: uuid.uuid4().hex,
    "{{rand}}": lambda: str(random.randint(100000, 999999)),
}


def log(msg):
    print("[%s] %s" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], msg), flush=True)


def fill(s):
    if not isinstance(s, str):
        return s
    for k, fn in PH.items():
        if k in s:
            s = s.replace(k, fn())
    return s


class Clock(object):
    """用 JD 服务器 Date 头的『秒跳变』估算本机时钟偏差，精度约 RTT/2。"""

    def __init__(self, host="www.jd.com", timeout=4.0):
        self.host = host
        self.timeout = timeout
        self.offset = 0.0

    def _probe(self):
        req = urllib.request.Request("https://%s/" % self.host,
                                     headers={"User-Agent": UA, "Accept": "*/*"})
        t0 = time.time()
        try:
            r = urllib.request.urlopen(req, timeout=self.timeout, context=CTX)
            hdr = r.headers.get("Date")
            r.read(64)
            r.close()
        except Exception:
            return None, t0, time.time()
        t1 = time.time()
        if not hdr:
            return None, t0, t1
        try:
            srv = parsedate_to_datetime(hdr).timestamp()
        except Exception:
            return None, t0, t1
        return srv, t0, t1

    def sync(self, rounds=4):
        prev, offs, deadline = None, [], time.time() + 25
        while len(offs) < rounds and time.time() < deadline:
            srv, t0, t1 = self._probe()
            if srv is None:
                time.sleep(0.25)
                continue
            if prev is not None and srv > prev:      # Date 跳了一秒 -> 边界
                off = srv - (t0 + t1) / 2.0
                if abs(off) < 10:
                    offs.append(off)
            prev = srv
        if offs:
            offs.sort()
            self.offset = offs[len(offs) // 2]
            log("对时完成 offset %+.3fs（%d 样本，抖动 %.0fms）"
                % (self.offset, len(offs), (max(offs) - min(offs)) * 1000))
        else:
            log("对时失败，改用本机时间")
        return self.offset

    def now(self):
        return time.time() + self.offset


def build(tpl):
    """把模板变成 urllib Request（每次调用重新填占位符）"""
    url = fill(tpl["url"])
    headers = {k: fill(v) for k, v in (tpl.get("headers") or {}).items()}
    body = tpl.get("body")
    if tpl.get("body_json") is not None:
        body = json.dumps(tpl["body_json"], separators=(",", ":"), ensure_ascii=False)
    method = (tpl.get("method") or ("POST" if body else "GET")).upper()
    data = fill(body).encode("utf-8") if body else None
    return urllib.request.Request(url, data=data, headers=headers, method=method)


def fire(tpl, timeout):
    t0 = time.time()
    try:
        r = urllib.request.urlopen(build(tpl), timeout=timeout, context=CTX)
        txt = r.read().decode("utf-8", "replace")
        r.close()
        return getattr(r, "status", 200), txt, time.time() - t0, None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0, None
    except Exception as e:
        return None, "", time.time() - t0, repr(e)


def is_proxy_ca_err(err):
    return err and "CERTIFICATE_VERIFY" in str(err)


def classify(text, tpl):
    for kw in tpl.get("success_keywords") or ["领取成功", "\"success\":true", "success\": true"]:
        if kw in text:
            return "success"
    for kw in tpl.get("already_keywords") or ["已领取", "已参与", "重复领取", "超过限领"]:
        if kw in text:
            return "already"
    for kw in tpl.get("empty_keywords") or ["抢完", "已领完", "无库存", "库存不足"]:
        if kw in text:
            return "empty"
    return "unknown"


def wait_until(target, clock):
    while True:
        rem = target - clock.now()
        if rem <= 0:
            return
        if rem > 0.06:
            time.sleep(min(rem - 0.05, 0.4))
        # 最后 60ms 忙等，避免 sleep 精度抖动


def notify(title, body):
    if shutil.which("apple-notification"):
        try:
            subprocess.run(["apple-notification", "--title", title, "--body", body],
                           timeout=10, capture_output=True)
        except Exception:
            pass


def resolve_target(a, clock):
    if a.in_s is not None:
        return clock.now() + a.in_s
    if a.at:
        dt = datetime.strptime(a.at, "%Y-%m-%d %H:%M:%S")
        return time.mktime(dt.timetuple()) + clock.offset
    if a.daily:
        h, m = (int(x) for x in a.daily.split(":"))
        now_srv = datetime.now() + timedelta(seconds=clock.offset)
        cand = now_srv.replace(hour=h, minute=m, second=0, microsecond=0)
        if cand <= now_srv - timedelta(seconds=1):
            cand += timedelta(days=1)
        return time.mktime(cand.timetuple()) + clock.offset
    return None


def run_round(tpl, target, a, clock, logf):
    t_next = target - a.advance
    result = "unknown"
    for i in range(a.rounds):
        wait_until(t_next, clock)
        st, txt, el, err = fire(tpl, a.timeout)
        result = "error" if err else classify(txt, tpl)
        line = ("#%02d %s http=%s %.0fms %s"
                % (i + 1, datetime.now().strftime("%H:%M:%S.%f")[:-3], st, el * 1000,
                   (err or txt)[:400].replace("\n", " ")))
        log(line)
        if logf:
            logf.write(line + "\n")
            logf.flush()
        if result in ("success", "already"):
            break
        t_next = max(clock.now(), target + (i + 1) * a.interval)
    return result


def main():
    ap = argparse.ArgumentParser(description="京东消费券定时领取器")
    ap.add_argument("-t", "--template", required=True)
    ap.add_argument("--at", help="目标时间 'YYYY-MM-DD HH:MM:SS'（本机时区）")
    ap.add_argument("--daily", help="每天该时刻开抢，如 00:00")
    ap.add_argument("--in", dest="in_s", type=float, help="N 秒后开抢")
    ap.add_argument("--days", type=int, default=1, help="配合 --daily：连续跑几天")
    ap.add_argument("--advance", type=float, default=0.05, help="提前多少秒打第一发（默认0.05）")
    ap.add_argument("--rounds", type=int, default=40, help="最多重试次数")
    ap.add_argument("--interval", type=float, default=0.25, help="重试间隔秒")
    ap.add_argument("--timeout", type=float, default=6.0)
    ap.add_argument("--probe", action="store_true", help="立即打一发看返回，用来验证模板")
    ap.add_argument("--no-sync", action="store_true", help="跳过对时")
    ap.add_argument("--clock-offset", type=float, default=0.0, help="手工时钟偏差（秒）")
    ap.add_argument("--logfile", default="grab.log")
    ap.add_argument("--insecure", action="store_true",
                    help="跳过 TLS 校验（本机走 Egern/Charles 中间人代理时需要）")
    a = ap.parse_args()

    global CTX
    if a.insecure:
        CTX = _insecure_ctx()
        log("⚠️ 已关闭 TLS 证书校验（走本地中间人代理）")
    tpl = json.load(open(a.template, encoding="utf-8"))
    log("模板：%s %s" % (tpl.get("method", "GET"), tpl["url"][:110]))
    if any(k in json.dumps(tpl) for k in ("h5st", "sign=")):
        log("⚠️ 模板里含 h5st/sign 签名参数：这类参数会过期，重放多半失败。建议见 README『半自动模式』")

    clock = Clock()
    if a.probe:
        st, txt, el, err = fire(tpl, a.timeout)
        print("--- probe ---\nHTTP %s  %.0fms\n%s" % (st, el * 1000, err or txt[:2000]))
        return 0

    if not a.no_sync:
        clock.sync()
    else:
        clock.offset = a.clock_offset

    logf = open(a.logfile, "a", encoding="utf-8") if a.logfile else None
    day = 0
    while True:
        target = resolve_target(a, clock)
        if target is None:
            log("需要 --at / --daily / --in 之一")
            return 2
        wait_s = target - clock.now()
        if wait_s > 0:
            log("开抢时间 %s（还有 %.1fs）"
                % (datetime.fromtimestamp(target - clock.offset).strftime("%Y-%m-%d %H:%M:%S"),
                   wait_s))
        result = run_round(tpl, target, a, clock, logf)
        msg = {"success": "✅ 领到了，去京东 App『我的-优惠券』确认（券当天有效）",
               "already": "ℹ️ 接口提示今日已领 / 已达上限",
               "empty": "😵 券已抢完",
               "error": "⚠️ 网络/请求错误",
               "unknown": "❔ 返回无法判定，看 grab.log 原文"}.get(result, result)
        log(msg)
        notify("京东消费券", msg)
        day += 1
        if not a.daily or day >= a.days:
            break
        log("明天 %s 继续…" % a.daily)
    if logf:
        logf.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
