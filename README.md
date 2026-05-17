# 阅读人格画像

用 AI 分析你的微信读书笔记与划线，生成你的阅读人格画像。

## 部署到 EdgeOne Pages

### 1. Fork / 上传代码

把本仓库推到 GitHub / GitLab，或直接在 EdgeOne Pages 控制台上传。

### 2. 在 EdgeOne Pages 创建项目

- 构建命令：留空（EdgeOne 自动编译 TypeScript）
- 输出目录：`public`
- Functions 目录：`functions`

### 3. 配置环境变量

在 EdgeOne Pages 控制台 → 项目设置 → 环境变量，添加：

| 变量名 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `DEEPSEEK_FLASH_MODEL` | Stage 1 模型 ID（如 `deepseek-v4-flash`）|
| `DEEPSEEK_PRO_MODEL` | Stage 2 模型 ID（如 `deepseek-v4-pro`）|

### 4. 部署

push 到主分支即自动部署。访问 `*.edgeone.app` 子域即可。

## 本地开发

```bash
npm install
npm run dev   # 启动本地 dev server（需安装 edgeone cli）
```

## 用户流程

1. 打开页面 → 点"打开微信读书授权页" → 在新标签页扫码登录 → 复制 API Key
2. 回到页面 → 点"我已复制 Key，自动粘贴"
3. 系统校验 Key 并显示你有多少本带笔记的书 → 选择分析范围（20/30/40/50 本）
4. 点"开始分析" → 等待 AI 阅读你的笔记（30-60 秒）→ 画像流式呈现

## 技术说明

- 前端：单 HTML + Vanilla JS + Tailwind CDN + marked.js
- 后端：EdgeOne Pages Edge Functions（Node.js / Web API 兼容运行时）
- AI：DeepSeek Flash（逐本摘要）+ DeepSeek Pro（最终画像合成）
- 数据源：微信读书官方 Agent Gateway API
- 隐私：API Key 和笔记内容**不落盘、不存储**，仅在单次请求中使用
