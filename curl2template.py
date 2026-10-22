#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把抓包得到的 cURL 命令转成 grab.py 用的模板 JSON。

用法：
  python3 curl2template.py -f req.txt -o template.json      # req.txt 里粘 cURL
  python3 curl2template.py -c "curl 'https://...' -H '...'" -o template.json
  pbpaste | python3 curl2template.py -o template.json

支持：Chrome/Safari 的 Copy as cURL、Charles / Egern / Surge / Stream 导出的 cURL。
"""
import argparse
import json
import re
import shlex
import sys

DROP_FLAGS = {"--compressed", "--insecure", "-k", "-s", "--silent", "-v", "--verbose",
              "-L", "--location", "--tlsv1.2", "--http2", "-i", "--include", "-g"}
HAS_VALUE = {"-H", "--header", "-b", "--cookie", "-d", "--data", "--data-raw",
             "--data-binary", "--data-ascii", "-A", "--user-agent", "-X", "--request",
             "--url", "-u", "--user", "--referer", "-e", "--form", "-F", "--connect-timeout"}


def parse(cmd):
    cmd = cmd.replace("\\\n", " ").replace("^\n", " ").replace("\n", " ")
    cmd = re.sub(r"curl(\.exe)?", "curl", cmd, count=1)
    try:
        toks = shlex.split(cmd)
    except ValueError:
        toks = [t.strip("'\"") for t in cmd.split()]
    if toks and toks[0].endswith("curl"):
        toks = toks[1:]

    url, method, headers, body = None, None, {}, None
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in ("-H", "--header") and i + 1 < len(toks):
            k, _, v = toks[i + 1].partition(":")
            if k:
                headers[k.strip()] = v.strip()
            i += 2
        elif t in ("-b", "--cookie") and i + 1 < len(toks):
            headers["Cookie"] = toks[i + 1]
            i += 2
        elif t in ("-A", "--user-agent") and i + 1 < len(toks):
            headers["User-Agent"] = toks[i + 1]
            i += 2
        elif t in ("-d", "--data", "--data-raw", "--data-binary", "--data-ascii") and i + 1 < len(toks):
            body = toks[i + 1] if body is None else body + "&" + toks[i + 1]
            i += 2
        elif t in ("-F", "--form") and i + 1 < len(toks):
            sys.stderr.write("⚠️ 表单上传 -F 不支持，请改用 -d\n")
            i += 2
        elif t in ("-X", "--request") and i + 1 < len(toks):
            method = toks[i + 1].upper()
            i += 2
        elif t == "--url" and i + 1 < len(toks):
            url = toks[i + 1]
            i += 2
        elif t in DROP_FLAGS:
            i += 1
        elif t.startswith("-"):
            i += 2 if t in HAS_VALUE else 1
        else:
            if url is None:
                url = t
            i += 1
    return url, method, headers, body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-f", "--file", help="包含 cURL 的文件")
    ap.add_argument("-c", "--cmd", help="直接给 cURL 字符串")
    ap.add_argument("-o", "--out", default="template.json")
    ap.add_argument("--referer", default=None, help="补一个 Referer")
    ap.add_argument("--ua", default=None, help="覆盖 User-Agent")
    a = ap.parse_args()

    if a.cmd:
        raw = a.cmd
    elif a.file:
        raw = open(a.file, encoding="utf-8", errors="replace").read()
    else:
        raw = sys.stdin.read()
    if "curl" not in raw:
        sys.exit("没找到 curl 命令")

    url, method, headers, body = parse(raw)
    if not url:
        sys.exit("解析失败：没取到 URL")
    if a.referer:
        headers.setdefault("Referer", a.referer)
    if a.ua:
        headers["User-Agent"] = a.ua
    headers.pop("Content-Length", None)
    headers.pop("Host", None)
    headers.setdefault("Accept", "*/*")

    tpl = {
        "method": method or ("POST" if body else "GET"),
        "url": url,
        "headers": headers,
        "body": body,
        "success_keywords": ["领取成功", "\"success\":true", "\"code\":\"0\"", "\"code\":0"],
        "already_keywords": ["已领取", "已参与", "重复领取", "超过限领", "已抢过"],
        "empty_keywords": ["抢完", "已领完", "无库存", "库存不足", "已达上限"],
    }
    if body and body.lstrip().startswith("{"):
        try:
            tpl["body_json"] = json.loads(body)
            tpl["body"] = None
        except ValueError:
            pass

    json.dump(tpl, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("已写入 %s" % a.out)
    print("方法 %s  主机 %s" % (tpl["method"], url.split("/")[2]))
    if body:
        print("body 前 200 字: %s" % body[:200])
    for k in ("h5st", "sign", "pt_key", "x-api-eid-token"):
        if k in url or (body and k in body):
            print("⚠️ 请求里含 %s —— 这是签名/时效参数，重放可能失效" % k)


if __name__ == "__main__":
    main()
