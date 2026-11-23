# Multi-view synthesis · Mac 成片服务

供双机相机 Demo 的另一台 Mac 部署使用。手机从两路原片提取首尾图，Mac 调用 MiniMax / Vidu 生成转场，完整成片由控制端手机拼合并保存。

部署 Agent 请先读 [AGENTS.md](AGENTS.md)，再按 [完整部署指南](docs/mac-deployment.md) 执行。

## 新 Mac 快速开始

准备 Node.js 24 和 Xcode Command Line Tools。本项目启动命令要求至少 Node 22.9；Node 24.18.0 已在原开发 Mac 验证。

```sh
git clone https://github.com/Jasperrax1/Multi-viewi-synthesis.git
cd Multi-viewi-synthesis
npm ci --omit=dev
npm run setup:mac
```

首次配置工具会生成 `.env.vidu` 的随机本机连接令牌和 `.env.minimax` 的空白 Key 配置，保留已经存在的文件。请在新 Mac 上填写 `MINIMAX_API_KEY`；需要 Vidu 时填写 `VIDU_API_KEY`。配置文件只留本机。

```sh
npm run check:mac
networksetup -listallhardwareports
npm start -- --interface en0
```

`en0` 要替换为这台 Mac 的实际 Wi-Fi 网卡。两台手机和 Mac 加入允许设备互访的同一热点或 Wi-Fi，Mac 同时保持互联网连接。启动后会打开当前配对二维码和提示词控制器；保持这个终端运行。

控制端手机进入「更多 → 设置 → 成片模型与服务 → 扫码连接 Mac」，核对指纹后检查连接。在另一个终端可做免费检查：

```sh
npm run health:mac
```

本机接口检查通过之后，仍需确认手机扫码后的连接结果。上述部署流程不生成付费视频。

## 提示词控制器

在这台 Mac 打开 <http://127.0.0.1:8790/>：

- MiniMax 默认「旋转运镜」，另有已验证的「电影运镜」分支。
- 两版可独立编辑；选择版本后点「使用此版本」才切换后续新任务。
- Vidu 保留已有旋转版本。每笔已提交任务保留自己的提示词快照。

控制器修改会保存到 `config/montage-presets.json`。更新代码前请保留本机的提示词修改。

## 数据与任务

这个公开仓库只发布 Mac 服务、控制器和部署工具。API Key、客户端令牌、Mac 私钥、配对二维码、已录视频和原生成任务不随 Git 分发。首次部署时由用户在新 Mac 填写 Key；其他准备工作可由 Agent 按指南完成。

新 Mac 首次启动会创建自己的身份，需要手机重新扫码。若要继续查询旧 Mac 的任务，须由用户通过安全渠道转移原 `.env.vidu`、`.env.minimax`、`.runtime/montage-tls` 和完整 `.runtime/montage`，并先停止旧 Mac 的服务。不要通过再次提交来猜测旧任务结果。

## 开发验证

```sh
npm test
```

默认测试仅使用本地临时目录、合成图及模拟模型接口，不调用真实云生成。可选的浏览器测试需要开发依赖和 Google Chrome：

```sh
npm ci
npm run test:ui
```
