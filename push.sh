#!/bin/sh
# 用 $GITHUB_TOKEN 把本仓库推到 GitHub（新建或更新）。
# 用法：GITHUB_TOKEN=xxx ./push.sh [仓库名]
set -e
REPO_NAME="${1:-egern-coupon-sniper}"
HERE=$(cd "$(dirname "$0")" && pwd)

if [ -z "$GITHUB_TOKEN" ]; then
  echo "缺少 GITHUB_TOKEN 环境变量" >&2
  exit 1
fi

# 查当前 token 对应的用户
LOGIN=$(curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/user | python3 -c 'import json,sys; print(json.load(sys.stdin).get("login",""))')
if [ -z "$LOGIN" ]; then
  echo "GITHUB_TOKEN 无效或已过期" >&2
  exit 1
fi
echo "当前账号: $LOGIN"

API="https://api.github.com"
AUTH="Authorization: Bearer $GITHUB_TOKEN"
JSON="Accept: application/vnd.github+json"

# 建仓库（已存在就忽略）
CODE=$(curl -s -o /tmp/_r.json -w '%{http_code}' -X POST -H "$AUTH" -H "$JSON" \
  "$API/user/repos" -d "{\"name\":\"$REPO_NAME\",\"description\":\"京东消费券定时抢券 Egern 模块\",\"private\":false,\"auto_init\":false}")
if [ "$CODE" = "201" ]; then
  echo "已创建仓库 $LOGIN/$REPO_NAME"
else
  echo "仓库已存在或创建失败($CODE)，按已存在处理"
fi

cd "$HERE"
git remote remove origin 2>/dev/null || true
git remote add origin "https://$LOGIN:$GITHUB_TOKEN@github.com/$LOGIN/$REPO_NAME.git"
git branch -M main
git push -u origin main --force
git remote set-url origin "https://github.com/$LOGIN/$REPO_NAME.git"

BASE="https://raw.githubusercontent.com/$LOGIN/$REPO_NAME/main"
echo ""
echo "== 完成 =="
echo "模块地址: $BASE/egern/module-coupon.yaml"
echo "脚本地址: $BASE/egern/coupon-sniper.js"
echo ""
echo "安装链接:"
echo "egern:/modules/new?name=烟台消费券定时抢券&url=$BASE/egern/module-coupon.yaml"
