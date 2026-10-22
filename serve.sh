#!/bin/sh
# 本地 HTTP 服务：把 egern 目录暴露给手机（Egern 用 http://<iSH IP>:8799/ 拉取脚本和模块）
cd /var/minis/workspace/jd-coupon-sniper/egern || exit 1
IP=$(ip -4 addr show en0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)
[ -z "$IP" ] && IP=127.0.0.1
echo "服务地址: http://$IP:8799"
echo "模块地址: http://$IP:8799/module-coupon.yaml"
echo "脚本地址: http://$IP:8799/coupon-sniper.js"
exec python3 -m http.server 8799 --bind 0.0.0.0
