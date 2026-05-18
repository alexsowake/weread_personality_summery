# 部署清单 — Node.js 后端 + EdgeOne 前端

> 假设：阿里云 Ubuntu 服务器，Nginx 已在跑，域名 `aicw.me` 已备案、`api.aicw.me` 已解析到本机公网 IP。

## A. 服务器一次性准备（约 5 分钟）

SSH 登录后执行：

```bash
# 1) 装 PM2（进程管理 + 开机自启）
sudo npm install -g pm2

# 2) 准备应用目录
sudo mkdir -p /opt/weread-summery
sudo chown $USER:$USER /opt/weread-summery
cd /opt/weread-summery

# 3) 拉代码 + 装依赖
git clone https://github.com/alexsowake/weread_personality_summery.git .
npm install --omit=dev    # 仅装运行时依赖
npm install tsx           # tsx 用来运行 TS，作为运行依赖

# 4) 写入环境变量（用你本地 .env 里的真实值替换三处占位）
cat > .env <<'EOF'
DEEPSEEK_API_KEY=sk-把本地的真实 key 粘贴这里
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
DEEPSEEK_PRO_MODEL=deepseek-v4-pro
PORT=3001
EOF
chmod 600 .env
```

## B. 用 PM2 启动服务

```bash
cd /opt/weread-summery

# 启动（PM2 会读取 .env，传给 Node 进程）
pm2 start "tsx server/index.ts" --name weread-api --update-env

# 保存进程列表 + 配置开机自启
pm2 save
pm2 startup systemd -u $USER --hp $HOME
# ↑ 这条命令会输出一行 sudo ... 命令，把它粘贴回来再执行一次

# 验证
pm2 status
curl http://127.0.0.1:3001/health   # 应该输出 ok
curl -X POST http://127.0.0.1:3001/api/check \
  -H "Content-Type: application/json" \
  -d '{"wereadKey":"bad"}'           # 应该返回 {"error":"无效的 API Key..."}
```

排错命令：
```bash
pm2 logs weread-api --lines 80    # 看实时日志
pm2 restart weread-api             # 改了 .env 后重启
```

## C. Nginx 反代 + HTTPS（约 10 分钟）

```bash
# 1) 装 certbot（如果还没装）
sudo apt update && sudo apt install -y certbot python3-certbot-nginx

# 2) 把仓库里的模板复制到 sites-available
sudo cp /opt/weread-summery/deploy/nginx-api.conf /etc/nginx/sites-available/api.aicw.me

# 3) 启用站点
sudo ln -sf /etc/nginx/sites-available/api.aicw.me /etc/nginx/sites-enabled/api.aicw.me

# 4) 测试 + 重载
sudo nginx -t && sudo systemctl reload nginx

# 5) 申请证书（自动改写 443 server 块）
sudo certbot --nginx -d api.aicw.me --non-interactive --agree-tos -m 你的邮箱@example.com --redirect

# 6) 最终验证
curl https://api.aicw.me/health                                         # ok
curl -X POST https://api.aicw.me/api/check \
  -H "Content-Type: application/json" \
  -d '{"wereadKey":"wrk-真实key测试一下"}'                              # {"totalBookCount": ...}
```

## D. 前端重新部署

本地（不在服务器上）：

```bash
cd /Users/suxing/Projects/weread_personality_summery
npm run deploy:frontend     # 或者直接 edgeone pages deploy
```

部署后用浏览器打开 EdgeOne 域名，跑完整流程：粘贴 Key → 分析 → 看画像。

## E. 后续更新代码

```bash
# 在服务器上
cd /opt/weread-summery
git pull
npm install --omit=dev      # 如果有新依赖
pm2 restart weread-api
```

## 排错速查

| 症状 | 检查 |
|---|---|
| `curl https://api.aicw.me/health` 502 Bad Gateway | `pm2 status` 看进程是否在；`pm2 logs weread-api` 看错误 |
| 浏览器拿到 CORS 错误 | 看请求 `Origin` 头，对照 `server/index.ts` 的 cors 白名单 |
| SSE 还是被缓冲 | `nginx -T \| grep proxy_buffering` 确认 `off`；检查阿里云盾/WAF 有没有插一层压缩 |
| pm2 重启后 .env 没生效 | 用 `pm2 restart weread-api --update-env` |
