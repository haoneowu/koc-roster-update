---
title: KOC 可移植运行包：首次安装与执行
owner: APU Workshop
status: active
updated: 2026-10-08
---

# 首次安装与执行

给商务 Agent 使用；命令在本仓库根目录执行。安装、登录、目标表和浏览器就绪须分别核验，`doctor` 通过不代表业务已成功。

## 1. 安装

安装 Node.js **26.x** 和 Google Chrome，重新打开终端。Windows 可双击仓库根目录 `setup.cmd`；它会安装锁定依赖并询问配置。无需手动修改全局 PowerShell 执行策略。Agent 分阶段执行：

```sh
node scripts/setup.mjs --install
```

有锁文件时运行 `npm ci`，随后显式补齐并验证官方飞书 CLI 原生可执行文件；即使 npm 默认阻止 postinstall，也不会仅凭包目录存在就判为安装成功。运行包已包含固定版本的 Playwright CLI 和飞书 CLI，无需复制作者电脑目录或全局安装 CLI。以下飞书命令直接调用随包版本，适用于 Windows/macOS/Linux：

```sh
node node_modules/@larksuite/cli/scripts/run.js profile list
```

## 2. 飞书身份与自己的目标表

先从目标 Base URL 确认租户 host，再从 profile 列表选择对应应用和用户；不切换全局默认 profile。以下 `PROFILE`、`BASE_TOKEN`、`TABLE_ID` 等是需替换的占位值。

首次完全没有可用 profile 时，Agent 发起并保持初始化进程，向用户展示其实际返回的授权地址：

```sh
node node_modules/@larksuite/cli/scripts/run.js config init --new --name PROFILE
```

已有 profile 直接验证；认证需要时仅申请 Base 业务域，缺少个别 scope 再按实际错误补充：

```sh
node node_modules/@larksuite/cli/scripts/run.js auth status --profile PROFILE --verify --json
node node_modules/@larksuite/cli/scripts/run.js auth login --profile PROFILE --domain base
```

`auth login` 需要用户完成真实授权，启动命令不等于成功。授权后用同一 profile 再验证。此运行包只支持 `user`，不支持 `bot`。密码、应用密钥和登录令牌不写进运行包配置或聊天记录。

没有目标表时，在自己的飞书租户新建一个多维表格及空数据表，或由已获建表授权的 Agent 执行：

```sh
node node_modules/@larksuite/cli/scripts/run.js base +base-create --name "KOC 联系方式库存" --profile PROFILE --as user
node node_modules/@larksuite/cli/scripts/run.js base +table-list --base-token BASE_TOKEN --profile PROFILE --as user
```

使用创建结果里的真实 Base token、链接及数据表 ID，不使用作者的表。直接 Base URL 的 `/base/TOKEN` 对应 Base token，`?table=tbl...` 对应数据表 ID；Wiki 链接须先解析节点的 `obj_type`/`obj_token`，不能把 Wiki token 填成 Base token。

## 3. 配置并初始化字段

```sh
node scripts/setup.mjs --configure --profile PROFILE --identity user --host tenant.feishu.cn --base-token BASE_TOKEN --table-id TABLE_ID --account-marker "达人广场当前账号的唯一可见标识"
npm run doctor
```

账号标识须取自当前达人广场真实页面，用于防止切错账号。省略配置参数并运行 `npm run configure` 可逐项输入。Windows 配置存于 `%APPDATA%\KOC Roster Update\config.json`；macOS 存于 `~/Library/Application Support/KOC Roster Update/config.json`；Linux 存于 `$XDG_CONFIG_HOME/koc-roster-update/config.json`（未设置时为 `~/.config/...`）。环境变量显式设置时优先于文件。

Agent 先读目标表结构；确认是在本次授权范围内补齐库存字段后运行初始化：

```sh
npm run initialize-base
npm run initialize-base -- --apply
```

不带 `--apply` 只报告缺失字段；带 `--apply` 只创建缺失字段并读回验证，不删除已有字段，不修改冲突字段类型。最终以 `passed:true`、`fieldsVerified:23` 为准；类型冲突或同名重复字段必须先解决，不能继续声称表已准备好。默认空表的其他列可以保留。

运行包字段合同如下；以 `runtime/initialize-base.mjs` 的 `PORTABLE_BASE_FIELDS` 为准。字段名必须精确匹配，所有列是可写存储字段，不用公式、自动编号或系统创建时间替代：

| 类型 | 字段 |
|---|---|
| 文本 text | Text、抖音号、蝉妈妈来源、采集批次、榜单验证状态、首次收录榜期、最近观测榜期、榜单筛选口径、视频销售额、蝉妈妈榜单指标原文、当期在榜状态、联系方式最近错误、微信号、本次联系方式状态、商务跟进状态、商务备注 |
| 文本 text，URL 样式 | 联系方式来源 |
| 整数 number | 首次收录排名、最近观测排名 |
| 日期 datetime | 首次收录时间、最近观测时间、联系方式最近尝试、联系方式最近成功 |

状态列使用文本，无需手工预建单选选项。`Text` 存昵称，`抖音号` 存账号字符串，不能建成数字列。

## 4. 登录、浏览器授权与准备页

在同一个 Chrome 用户环境登录[蝉妈妈榜单](https://www.chanmama.com/bloggerRank/)及[达人广场](https://buyin.jinritemai.com/dashboard/servicehall/daren-square)。按官方入口安装 Playwright Chrome 扩展；已有安装和有效连接直接复用。

```sh
npm run connect
```

保持此连接请求有效，在实际出现的扩展授权页选蝉妈妈标签，点击 **Allow and select**。Agent 验证连接后复用同一会话核验达人广场，不因同一任务再次索权。默认固定会话为 `koc-roster`；只有显式设置 `KOC_PLAYWRIGHT_SESSION` 才改变。交互细节见 [onboarding.md](onboarding.md)。

```sh
npm run readiness
```

打开终端报告的 [本机准备页](http://127.0.0.1:18765)，保持服务运行；它每 30 秒刷新观察。页面组件、两站登录、账号和表访问都要通过实际检查，不能把 `doctor` 的“文件存在”当成授权成功。

## 5. 更新来源并采集本次库存

连接中只保留一个需使用的蝉妈妈标签；完成来源账号登录后保存本机来源会话，再更新榜单并新增入库：

```sh
npm run capture-session
npm run koc:one-shot -- --mode list-integrated --target 500
```

`target` 支持 1–500；500 是请求上限，不是保证新增 500 人。此命令采集一批来源并执行 add-only 入库，不直接开始联系方式采集。检查实际返回与批次证据，来源失败时先恢复该批次，不能当成成功创建新批次。

准备最多 10 个真正后台的达人广场执行目标，然后生成库存、开始本次采集：

```sh
npm run bootstrap-background
npm run koc:daily -- --prepare
npm run koc:daily -- --run
```

运行器最多 10 路并发，实际路数受待处理对象和可验证后台目标限制，不需要额外并发参数。自动后台初始化要求浏览器支持 CDP，成功须返回 `passed:true` 且 `ready>=10`。若 CDP 不可用，按错误提示手动打开 10 个已登录的达人广场业务标签并保持在后台，再运行初始化验证；仍以真实后台及账号检查为准，不能把前台标签伪装成后台。

`--run` 遇限流会保存状态、等待 5 分钟并做单对象探测；中断后继续相同命令恢复未完成库存。只有上一库存已完成、且本次确有新批次需要处理时才使用 `--new`；不要为重跑成功对象随意新建库存。任务结束核验实际完成数、剩余数、未知写入以及 Base/checkpoint 读回；未完成或 `sourceIssues` 非空不得宣布全量完成。

## 本机数据与故障边界

来源会话、checkpoint、执行账本保留在每用户数据目录；Windows 为 `%APPDATA%\KOC Roster Update`，macOS 为 `~/Library/Application Support/KOC Roster Update`，Linux 为 `$XDG_DATA_HOME/KOC Roster Update`（默认 `~/.local/share/...`）。`KOC_DATA_DIR` 可覆盖目录，须使用当前用户私有目录，不能放入仓库或共享文件夹。

认证失效先恢复原 profile；scope 不足按实际缺项补齐；资源错误先核对 host/profile/user 路由并做只读验证。记录验证时间、目标范围与结果，不记录凭证。安装及离线测试通过不替代新机器上的网站授权、后台能力和真实业务回归。

## Change Log

- 2026-10-08：新增可移植包首次安装、租户身份路由、自有 Base 字段初始化、来源会话及最多 10 路库存采集指南。
