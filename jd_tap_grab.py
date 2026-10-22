#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
京东消费券 · 硬件级点击领取（不用 Egern、不用 MITM、不重放签名）

原理
----
  唤起京东 App 到「烟台消费券」搜索页：apple-open + 京东深链（openapp.jdmobile://）
  到点用 cdtk-ctrl tap 注入【真实硬件触控事件】，点「领取」按钮
  由京东 App 自己去发请求 —— 签名 / 风控 / 定位 / 实名 全部天然正确

按钮坐标自动定位
----------------
  1. 从手机媒体分区拉取最新截图（cdtk-fs media pull）
  2. apple-vision OCR 找出含「领取」的文本块
  3. Vision 的 bbox 语义是 [x/W, y/H(自下而上), w/W, h/H]
     → 像素左上 = (x*W, (1-y-h)*H)，点其中心

前置条件
--------
  1. 手机开启「开发者模式」（设置 › 隐私与安全性 › 开发者模式），重启后生效
     —— 否则 CoreDevice 的 appservice / HID 触控服务不开放
  2. 睡前：手机插上充电 + 设置「自动锁定：永不」（屏幕常亮），京东停在券页
  3. 配对文件路径在 CDTK_PAIRING_FILE

用法
----
  python3 jd_tap_grab.py --check                  # 只检查环境
  python3 jd_tap_grab.py --pull-latest            # 拉一张手机截图下来（标定用）
  python3 jd_tap_grab.py --locate <图片>           # 从截图里找「领取」坐标
  python3 jd_tap_grab.py --probe                  # 立刻点一次（标定/验证）
  python3 jd_tap_grab.py --daily 00:00:00 --days 7
  python3 jd_tap_grab.py --at "2026-10-25 00:00:00"
"""
import argparse
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import time
from datetime import datetime, timedelta

APP_BUNDLE = "com.360buy.jdmobile"
DEEP_LINK = ("openapp.jdmobile://virtual?params="
             "%7B%22url%22%3A%22https%3A%2F%2Fso.m.jd.com%2Fware%2Fsearch.action"
             "%3Fkeyword%3D%E7%83%9F%E5%8F%B0%E6%B6%88%E8%B4%B9%E5%88%B8%22%7D")
SHOT_DIR = "/DCIM/100APPLE"


def log(msg):
    print("[%s] %s" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], msg), flush=True)


# ---------------- 对时 ----------------
def ntp_offset(host="time.apple.com", samples=5):
    def one():
        q = struct.pack("!12B", 0x1b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        q += struct.pack("!Q", int((time.time() + 2208988800) * 2 ** 32) & 0xFFFFFFFFFFFFFFFF)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(3.0)
        try:
            ip = socket.gethostbyname(host)
            t0 = time.time()
            s.sendto(q, (ip, 123))
            d, _ = s.recvfrom(64)
            t1 = time.time()
        except Exception:
            return None
        finally:
            s.close()
        if len(d) < 48:
            return None
        srv = (struct.unpack("!I", d[40:44])[0]
               + struct.unpack("!I", d[44:48])[0] / 2 ** 32 - 2208988800)
        return srv - (t0 + t1) / 2.0

    offs = []
    for _ in range(samples):
        o = one()
        if o is None:
            break
        offs.append(o)
        time.sleep(0.2)
    if not offs:
        return 0.0
    offs.sort()
    return offs[len(offs) // 2]


def wait_until(target_ts, offset):
    while True:
        rem = target_ts - (time.time() + offset)
        if rem <= 0:
            return
        if rem > 0.03:
            time.sleep(min(rem - 0.025, 0.4))
        else:
            t0 = time.time()
            while time.time() - t0 < rem:
                pass


# ---------------- 环境 ----------------
def check_env():
    ok = True
    print("== 环境检查 ==")
    for name, path in (("cdtk-ctrl", "cdtk-ctrl"), ("apple-open", "apple-open"),
                       ("apple-vision", "apple-vision")):
        p = shutil.which(path)
        print("  %-14s %s" % (name, p or "❌ 未找到"))
        if not p:
            ok = False
    pf = os.environ.get("CDTK_PAIRING_FILE")
    print("  %-14s %s" % ("配对文件", pf or "❌ 未设置 CDTK_PAIRING_FILE"))
    if not pf or not os.path.exists(pf):
        ok = False
    try:
        out = subprocess.run(["cdtk-ctrl", "hid-list"], capture_output=True,
                             text=True, timeout=90)
        txt = ((out.stdout or "") + (out.stderr or "")).strip()
        bad = ("No such service" in txt or "InvalidServiceError" in txt)
        if out.returncode == 0 and not bad:
            print("  %-14s ✅ 可用" % "触控注入")
        else:
            hint = " → 需开启「开发者模式」(设置›隐私与安全性›开发者模式) 并重启" \
                if ("universalhidservice" in txt or "appservice" in txt) else ""
            print("  %-14s ❌ 不可用%s" % ("触控注入", hint))
            ok = False
    except Exception as e:
        print("  %-14s ❌ %s" % ("触控注入", e))
        ok = False
    try:
        out = subprocess.run(["cdtk-install", "list"], capture_output=True, text=True, timeout=120)
        print("  %-14s %s" % ("京东App", "✅ 已安装" if APP_BUNDLE in (out.stdout or "") else "❌ 未检测到"))
    except Exception as e:
        print("  %-14s ⚠️  %s" % ("京东App", e))
    return ok


# ---------------- 截图 / 定位 ----------------
def pull_latest_shot(dest="/tmp/jd_shot.png"):
    """从手机媒体分区拉取最新一张截图"""
    out = subprocess.run(["cdtk-fs", "media", "ls", SHOT_DIR],
                         capture_output=True, text=True, timeout=180)
    files = re.findall(r"(IMG_\d+\.PNG)", out.stdout or "", re.I)
    if not files:
        return None
    latest = sorted(files)[-1]
    r = subprocess.run(["cdtk-fs", "media", "pull", "%s/%s" % (SHOT_DIR, latest), dest],
                       capture_output=True, text=True, timeout=180)
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return dest
    return None


def ocr_blocks(image):
    out = subprocess.run(["apple-vision", "ocr", image, "--lang", "zh-Hans,en", "-q"],
                         capture_output=True, text=True, timeout=120)
    try:
        return json.loads(out.stdout).get("blocks", [])
    except Exception:
        return []


def locate(image, keywords=("领取", "立即领取", "领券")):
    """在截图里找出关键词按钮的像素坐标（Vision bbox: [x/W, y/H(自下), w/W, h/H]）"""
    from PIL import Image
    W, H = Image.open(image).size
    hits = []
    for b in ocr_blocks(image):
        text = b.get("text", "")
        if not any(k in text for k in keywords):
            continue
        x, y, w, h = b["bbox"]
        left = x * W
        top = (1 - y - h) * H
        cx = left + w * W / 2.0
        cy = top + h * H / 2.0
        hits.append({"text": text, "x": int(cx), "y": int(cy),
                     "box": [int(left), int(top), int(w * W), int(h * H)]})
    # 从上到下排序（y 小的在上）
    hits.sort(key=lambda d: d["y"])
    return hits, (W, H)


# ---------------- 动作 ----------------
def open_jd():
    try:
        out = subprocess.run(["apple-open", DEEP_LINK], capture_output=True, text=True, timeout=20)
        return '"opened": true' in (out.stdout or "")
    except Exception:
        return False


def tap(x, y, timeout=60):
    try:
        out = subprocess.run(["cdtk-ctrl", "tap", str(int(x)), str(int(y))],
                             capture_output=True, text=True, timeout=timeout)
        if out.returncode != 0:
            log("tap(%s,%s) 失败: %s" % (x, y, (out.stderr or out.stdout).strip()[:120]))
            return False
        return True
    except subprocess.TimeoutExpired:
        log("tap(%s,%s) 超时" % (x, y))
        return False
    except Exception as e:
        log("tap(%s,%s) 异常: %s" % (x, y, e))
        return False


def notify(title, body):
    if shutil.which("apple-notification"):
        try:
            subprocess.run(["apple-notification", "schedule", "--title", title, "--body", body,
                            "--after", "1", "--id", "jdgr%d" % int(time.time())],
                           capture_output=True, timeout=15)
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--buttons", default=os.environ.get("BUTTONS", ""),
                    help="手动指定坐标 'x,y;x,y'，留空则自动从截图定位")
    ap.add_argument("--at", help="目标时刻 'YYYY-MM-DD HH:MM:SS'")
    ap.add_argument("--daily", help="每天该时刻，如 00:00:00")
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--wake-lead", type=float, default=25.0, help="提前多少秒唤起京东")
    ap.add_argument("--tap-gap", type=float, default=0.18, help="多个按钮点击间隔")
    ap.add_argument("--auto-locate", action="store_true", help="从手机截图自动找「领取」按钮")
    ap.add_argument("--probe", action="store_true", help="立刻点一次，用于标定/验证")
    ap.add_argument("--check", action="store_true", help="只检查环境")
    ap.add_argument("--pull-latest", action="store_true", help="拉一张手机截图到 /tmp/jd_shot.png")
    ap.add_argument("--locate", metavar="IMG", help="从指定图片里找「领取」坐标")
    args = ap.parse_args()

    if args.check:
        return 0 if check_env() else 1

    if args.pull_latest:
        p = pull_latest_shot()
        print(p or "没拉到截图")
        return 0 if p else 1

    if args.locate:
        hits, size = locate(args.locate)
        print("图片尺寸 %dx%d" % size)
        if not hits:
            print("没找到「领取」字样")
            return 1
        for h in hits:
            print("  「%s」 -> 点击坐标 (%d, %d)  框=%s" % (h["text"], h["x"], h["y"], h["box"]))
        return 0

    # ---- 按钮坐标 ----
    buttons = []
    for part in args.buttons.split(";"):
        if "," in part:
            x, y = part.split(",", 1)
            try:
                buttons.append((int(x), int(y)))
            except ValueError:
                pass

    if not buttons and args.auto_locate:
        log("拉取手机截图并定位「领取」按钮 …")
        shot = pull_latest_shot()
        if shot:
            hits, size = locate(shot)
            log("截图 %dx%d，找到 %d 个候选" % (size[0], size[1], len(hits)))
            for h in hits:
                log("  「%s」 -> (%d,%d)" % (h["text"], h["x"], h["y"]))
            buttons = [(h["x"], h["y"]) for h in hits]
        else:
            log("拉不到截图，改用手工坐标")

    if not buttons and not args.probe:
        log("没有按钮坐标。用 --auto-locate 自动找，或 --buttons 'x,y' 指定。")
        return 2

    if args.probe:
        log("探测：唤起京东 App …")
        open_jd()
        time.sleep(3)
        for (x, y) in buttons:
            log("tap(%d,%d)" % (x, y))
            tap(x, y)
            time.sleep(1.0)
        log("探测完成，请看手机：点到「领取」了吗？")
        return 0

    # ---- 定时 ----
    off = ntp_offset()
    log("对时偏差 %+.3fs" % off)

    day = 0
    while True:
        now = datetime.now()
        if args.daily:
            h, m, s = (int(x) for x in args.daily.split(":"))
            target = now.replace(hour=h, minute=m, second=s, microsecond=0)
            if target <= now:
                target += timedelta(days=1)
        elif args.at:
            target = datetime.strptime(args.at, "%Y-%m-%d %H:%M:%S")
        else:
            log("需要 --at 或 --daily")
            return 2

        ts = time.mktime(target.timetuple())
        log("目标 %s（还有 %.1f 秒）" % (target.strftime("%Y-%m-%d %H:%M:%S"), ts - (time.time() + off)))

        # 提前定位按钮（截图 + OCR），到点直接点，避免临场开销
        if args.auto_locate and not buttons:
            shot = pull_latest_shot()
            if shot:
                hits, _ = locate(shot)
                buttons = [(h["x"], h["y"]) for h in hits]
                log("已定位 %d 个按钮" % len(buttons))

        # 提前唤醒京东
        wait_until(ts - off - args.wake_lead, 0)
        log("唤起京东 App …")
        open_jd()
        time.sleep(max(0.0, (ts - off) - time.time() - 1.2))

        wait_until(ts, off)
        log("到点！开始点击")
        for i, (x, y) in enumerate(buttons):
            if i:
                time.sleep(args.tap_gap)
            log("tap(%d,%d)" % (x, y))
            tap(x, y)

        log("点击完成，共 %d 次" % len(buttons))
        notify("京东消费券", "已在 %s 点击 %d 次领取按钮。早上请到京东App「我的-优惠券」确认。"
               % (target.strftime("%H:%M:%S"), len(buttons)))

        day += 1
        if not args.daily or day >= args.days:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
