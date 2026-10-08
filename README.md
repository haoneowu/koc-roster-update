---
title: KOC 达人微信收集任务助手
owner: APU Workshop
status: active
updated: 2026-10-08
---

# 达人微信收集任务助手

给 KOC 商务使用的 Skill，包含蝉妈妈名单更新、抖音达人广场微信采集、飞书保存与结果核验。**0.6.0 起随包提供完整运行器和 Windows 安装入口**，不需要作者的电脑、私有仓库或 Freight 单独安装包。

[下载完整 ZIP](https://github.com/haoneowu/koc-roster-update/archive/refs/heads/main.zip) · [安装验证](https://github.com/haoneowu/koc-roster-update/actions/workflows/install.yml)

## Windows 安装

1. 安装 **Google Chrome** 和 **Node.js 26.x（含 npm）**。安装后重新打开终端。
2. 下载上面的 ZIP，**解压整个目录**。不要只复制 `SKILL.md`。
3. 将整个目录交给支持 Skill 的 Agent 安装，或直接告诉它：

   > 请读取这个目录的 SKILL.md，帮我安装并配置达人微信收集任务助手。我使用 Windows，请先检查环境，再引导我登录蝉妈妈、抖音达人广场和授权飞书表。

Agent 使用 `setup.cmd --install` 安装已锁定版本的依赖，包括 Playwright 和飞书 CLI。也可在解压目录运行：

```powershell
node scripts/setup.mjs --install
```

首次使用还需要你自己的飞书达人表、可访问该表的账号，以及两站登录。Agent 按[首次配置指南](references/runtime.md)协助完成配置和建字段；不会要求你寻找原作者的文件。配置只存在本机用户目录，不写进 GitHub。

## 开始任务

配置和授权完成后，告诉 Agent：

> 更新今天的蝉妈妈名单，并收集新增或未完成达人的微信，保存到我的飞书表。

默认最多 10 路后台采集，不限制为 50 条。遇到平台限流，至少等待 5 分钟后先恢复一个原对象；平台要求更长时间时遵从平台。已完成项不会重复采集，保存后核对同一条记录。

状态助手由 `npm run readiness` 启动，地址为 `http://127.0.0.1:18765/`。它显示准备状态和执行进度；开启网页本身不会启动采集。

## 使用范围

- 当前来源筛选沿用宠物/猫类达人榜单；其他行业应先调整业务配置，不能认为是通用行业采集器。
- 网站和飞书登录授权属于使用者自己的账号；下载 Skill 不会携带作者登录态或联系人。
- 本包在本机执行，需要能运行 Node.js 并控制本机 Chrome 的 Agent 环境。仅支持阅读 Skill 的云端会话无法直接操作本机浏览器。
- CI 验证 Windows 安装、启动入口、程序依赖和离线回归。真实网站登录、扩展授权、租户权限和业务采集仍须在使用者电脑验证，不能由 CI 的成功代替。

## 开发验证

```sh
npm ci
npm test
npm run test:runtime
```

运行器版本及完整性校验见 [runtime/README.md](runtime/README.md)。用户引导见 [onboarding](references/onboarding.md)，状态规则见 [readiness](references/readiness.md)。

## Change Log

- 2026-10-08：0.6.1，本次/历史结果分区，飞书表按钮通过系统默认浏览器打开。

- 2026-10-08：0.6.0，补齐运行器源码、锁定依赖、Windows 安装/配置入口；移除作者工作站和飞书账号绑定，增加 Windows/Linux CI。
- 2026-10-08：0.5.58，商务引导及状态页；该历史版本不包含独立运行器。

- 2026-10-08：0.6.2，移除任务页签和打开成功提示；未开始仅显示准备提示，保留Windows系统浏览器打开及安装支持。
