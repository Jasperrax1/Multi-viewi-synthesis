# 在另一台 Mac 部署成片服务

本指南供用户或部署 Agent 从空目录完成安装。手机继续使用已有 APK；不需要 Android SDK、重新安装手机应用、FFmpeg 或本地 AI 显卡。Mac 接收手机提取的两张 JPEG，向 MiniMax / Vidu 提交转场任务；手机负责下载转场并拼接完整成片。

## 1. 确认前提

- 一台可正常运行 Node.js 和 Xcode Command Line Tools 的 Mac。建议 Node.js 24，原开发机验证版本为 24.18.0；最低支持 22.9。启动命令使用的 [`--env-file-if-exists`](https://nodejs.org/api/cli.html#--env-file-if-existsfile) 从 Node 22.9 起提供。
- Mac、控制端和拍摄端加入允许设备互访的同一个热点或 Wi-Fi。仅同网不保证互通：访客网络、客户端隔离、防火墙和 VPN 路由均可能阻断连接。
- Mac 还需要互联网访问对应模型平台。只有局域网、没有互联网时，可以检查手机连接，但不能生成新转场。
- 用户提供 MiniMax API Key；需要切换 Vidu 时另配 Vidu Key。平台账户需要足够余额，仓库不会附带 Key 或免费生成额度。

先检查已有工具，缺失时再安装，避免覆盖用户已有的 Node 环境：

```sh
node --version
npm --version
xcode-select -p
/usr/bin/swift --version
```

如果缺少 Command Line Tools，运行 `xcode-select --install`，由用户完成系统安装窗口。Node 可使用现有版本管理器安装 24，或从 [Node.js 官方网站](https://nodejs.org/) 安装。不要因为部署而自动修改全局网络或系统防护设置。

## 2. 获取代码与创建配置

```sh
git clone https://github.com/Jasperrax1/Multi-viewi-synthesis.git
cd Multi-viewi-synthesis
npm ci --omit=dev
npm run setup:mac
```

所有后续命令都在仓库根目录执行。首次配置会以 `600` 权限创建 `.env.vidu` 和 `.env.minimax`，为手机连接生成随机令牌；重复执行保留已有文件，不重置身份或任务。

请用户在新 Mac 的本地编辑器里填写 `.env.minimax`：

```dotenv
MINIMAX_API_KEY=
MINIMAX_API_REGION=cn
```

`cn` 表示中国区 API；海外账户使用 `global`。Key 必须属于选择的区域。要用 Vidu，再在 `.env.vidu` 的 `VIDU_API_KEY=` 后填写对应 Key。保留 setup 已生成的 `VIDU_CLIENT_TOKEN`，不要把它替换成模型 Key。

不要让用户把真实 Key 发到聊天、GitHub 或日志中；也不要执行会打印整个环境配置的命令。上述配置被 Git 忽略。仓库中的 `server/*.env.example` 仅作变量参考。

运行只读检查：

```sh
npm run check:mac
```

退出码含义：`0` 为本机环境和基本配置检查通过，`1` 为缺少依赖或配置错误，`2` 为其他检查通过但还没有可用的私有局域网地址。检查只判断 Key 是否填写，不验证模型账户、余额或互联网可达性，不调用生成 API。

默认 `.env.vidu` 中 `VIDU_MAX_PAID_JOBS=0` 表示本地不限制生成任务数，真实费用仍由模型平台收取。部署验收不要自动创建付费任务。

## 3. 选网卡并启动

将三台设备连接到同一热点或 Wi-Fi，然后查看本机网卡：

```sh
networksetup -listallhardwareports
```

根据实际 Wi-Fi 对应的 Device 启动，下面的 `en0` 仅为示例：

```sh
npm start -- --interface en0
```

也可以直接执行 `npm run montage:lan -- --interface en0`。不要使用 VPN 的 `utun` 地址或复制旧 Mac 的 IP。启动器会建立本机 TLS 身份，打开提示词控制器和当前配对二维码。终端需要持续运行；`Ctrl+C` 正常停止。

- 手机访问的 HTTPS 成片接口默认端口为 `8788`。
- 本机提示词控制器默认在 <http://127.0.0.1:8790/>，仅限这台 Mac 访问。
- 当前二维码位于启动日志打印的 `.runtime/montage-tls/pairing-<进程号>-<序号>.png`。地址变化后文件会更新，旧文件会删除；二维码含连接凭证，只供本人手机扫描，不要提交或公开截图。
- Bonjour 服务为 `_puramontage._tcp`，用于已信任手机发现地址变化。启动器监测选定网卡，地址改变时重新绑定；界面有等待提示时不要展示旧二维码。

如果同一网卡有多个可用地址，可使用 `--address 当前局域网IPv4` 明确选择；固定了地址后，热点重新分配地址时需要更新该参数。`--no-open` 可禁止自动打开窗口，之后手动打开控制器和当前二维码。

首次运行如系统询问 Node 的本地网络或入站连接权限，允许本项目所需权限；不要整体关闭防火墙。演示时保持 Mac 唤醒，可在另一终端使用 `caffeinate -i`，演示结束按 `Ctrl+C` 退出。

## 4. 免费验证并让手机配对

在仓库根目录的另一个终端运行：

```sh
npm run health:mac
```

它读取本机启动器返回的当前地址，使用本地证书和公钥指纹验证 HTTPS，再带本机令牌请求 `GET /v1/health`。成功输出 `ok: true` 和 `cloudTasksCreated: 0`。不会提交生成任务。

这个结果仅证明 Mac 本机接口正常。控制端手机还需进入「更多 → 设置 → 成片模型与服务 → 扫码连接 Mac」，扫描当前二维码，核对指纹后点「确认并检查连接」。换新 Mac 默认会生成新身份，因此首次需要重新扫码；保留同一 Mac 的身份和令牌后，后续可依赖已信任设备发现和重连。

验收完成后报告：Node 版本、实际网卡和服务地址、本机健康检查结果、手机是否确认连接、当前提示词分支，以及未满足的条件。没有手机参与时，明确写“手机连接待验证”，不能用本机检查代替双机验证。

## 5. 两版提示词

在 <http://127.0.0.1:8790/> 选择模型和提示词版本。MiniMax 默认使用「旋转运镜」，另保留「电影运镜」分支；两版可分别编辑和保存。选中编辑不等于切换生效，需要点「使用此版本」。切换只影响之后提交的新任务，已提交任务保留原提示词快照。

MiniMax 配方为 `MiniMax-H3-Highspeed`、`768P`、生成 4 秒；当前手机 APK 将转场按 2 倍速用于 2 秒合成。Vidu 配方为 Q2 Pro Fast、`720p`、2 秒。最终的倍速和原片拼接由手机执行，Mac 不单独拼接完整成片。

修改会保存到 `config/montage-presets.json`。更新仓库前先保留本机改动；不要使用 `git reset --hard` 覆盖调好的提示词。

## 6. 迁移与更新的边界

普通 clone 只得到代码和公开提示词，不含原 Mac 的 Key、令牌、TLS 身份、二维码、历史任务或用户视频。新电脑的安全默认做法是生成新身份、用户本机填 Key、手机重新扫码。

若要在新 Mac 继续查询旧任务，需先停止旧 Mac 的服务，并由用户通过安全渠道完整迁移：

- `.env.vidu`、`.env.minimax`：原模型配置及手机连接令牌。
- `.runtime/montage-tls/`：原 `key.pem` 和 `cert.pem`，目录权限 `700`，文件 `600`。
- `.runtime/montage/`：完整原任务记录及相关文件，保持内容和权限。
- `config/montage-presets.json`：需要保留的提示词版本。

这些内容不通过 GitHub 传递。不要让两台 Mac 使用同一身份和同一套任务目录同时运行。`.lock` 只在确认对应进程已经结束后处理；不得删除原任务 JSON 来“修复连接”。遇到 `SUBMISSION_UNKNOWN`，先查原任务和日志，不能自动重新提交付费请求。

## 7. 常见故障

| 现象 | 检查方式 |
|---|---|
| 本机控制器打不开 | 确认启动进程仍运行；检查终端报错与 `8790` 端口占用。控制器地址只能在运行服务的 Mac 本机打开。 |
| 等待局域网地址 | 核对 Wi-Fi 对应网卡和私有 IPv4，重新运行 `check:mac`。热点切换后保留进程，让启动器重新绑定。 |
| 本机健康检查通过，手机失败 | 确认同网、允许客户端互访、扫描新 Mac 当前二维码；检查本地网络权限、防火墙和 VPN 局域网路由。不要直接关闭所有系统防护。 |
| 配对能连，生成失败 | 区分局域网与互联网；检查所选模型 Key、区域、余额和服务日志。日志可能包含任务信息，不公开整份原始日志。 |
| 旧任务找不到 | 新 clone 不包含原任务；从原 Mac 安全迁移完整任务目录，保留原任务 ID。不要猜测提交是否成功后直接重发。 |

可用 `lsof -nP -iTCP:8788 -sTCP:LISTEN` 和 `lsof -nP -iTCP:8790 -sTCP:LISTEN` 查看占用；只停止已确认属于本项目的旧进程。

## 8. 代码自测

```sh
npm test
```

默认测试只使用本地数据和模拟模型接口，不消耗平台生成额度。可选浏览器测试需要开发依赖及 Google Chrome：

```sh
npm ci
npm run test:ui
```

测试通过不代表模型账户余额或真实云端生成已验证；付费样片由用户另行明确触发。
