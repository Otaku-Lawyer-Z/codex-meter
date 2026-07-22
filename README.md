# Codex Meter

一个可拖到副屏、常驻显示的 Codex 桌面用量仪表盘。它通过本机 `codex app-server` 只读获取真实账户数据，不抓网页、不估算剩余额度，也不会上传 Codex 凭据。

<img width="2048" height="1476" alt="img_v3_0213p_b1d649bc-fb57-48da-88ab-a6074ee9ec3g" src="https://github.com/user-attachments/assets/3cd84efb-4c36-41b3-a39f-c7bc1ab79d5e" />

## 功能

- 实时显示主要 Codex 额度的剩余百分比，不占用首屏展示不常用模型桶
- 剩余额度圆环在 100% 时完整显示，额度消耗产生的缺口从顶部开始顺时针扩大
- 显示 5 小时、7 天或其他实际返回周期及精确重置倒计时
- 显示可用额度重置次数、逐次到期时间和状态
- 显示累计 token 和最近 28 个活跃日趋势
- 实时显示正在进行的 Codex 项目、任务名称、当前步骤、执行/等待状态与运行时间
- Codex 任务状态每 2 秒更新；账户数据可设为 15 秒到 5 分钟自动刷新，并支持手动刷新
- 睡眠唤醒后保留上一次有效任务数据并自动重试，不显示底层数据库命令错误
- 睡眠唤醒后重建 token 统计连接；读取异常时自动重连并显示最近一次成功数据
- 窗口置顶、登录自动启动、副屏位置与窗口尺寸记忆
- 完全本地、只读；界面不提供“消耗重置次数”操作

## 系统要求

- macOS（当前安装包为 Apple Silicon）
- 已安装并登录 Codex CLI
- Codex CLI 需要提供 `codex app-server` 与 `account/rateLimits/read` 接口

检查本机环境：

```bash
codex --version
codex app-server --help
```

## 开发运行

```bash
npm install
npm start
```

## 验证与打包

```bash
npm test
npm run test:integration
npm run dist:mac
```

产物会生成在 `release/`。未签名的本地构建第一次打开时，macOS 可能要求在“系统设置 → 隐私与安全性”中确认。

如果 Codex 安装在非常规位置，可在启动前设置：

```bash
CODEX_BINARY=/absolute/path/to/codex npm start
```

## 数据与隐私

应用启动一个本机 Codex App Server 子进程，通过 JSONL-over-stdio 调用：

- `account/rateLimits/read`
- `account/usage/read`

它不会读取 `auth.json`，不会把凭据写入日志，也不会向第三方服务发送数据。任务面板只读访问 Codex 本地任务目录与会话状态，界面不读取或展示系统进程、完整命令和启动参数。设置文件只保存窗口位置、置顶状态、启动偏好和刷新频率。

## 当前边界

Codex App Server 目前属于实验性接口，未来 Codex CLI 版本可能调整协议。应用会把连接问题明确显示在界面，不会用本地 token 统计伪装成账户剩余额度。

## License

MIT
