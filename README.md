---
title: KOC 达人微信收集任务助手
owner: APU Workshop
status: workstation-dependent
updated: 2026-10-08
---

# KOC Roster Update

Skill 0.5.58：商务登录与授权引导、实时准备清单、达人库存采集与结果核验。

这是现有本机 KOC 运行环境的 Skill 包，**不是独立的云端采集服务**。安装本包不会自动安装运行器、复制网站登录或授予飞书权限。另一台电脑使用前需部署兼容的 Freight 0.2.57 运行器，配置授权的飞书表、CLI身份及 Chrome/Playwright；本包目前保留原工作站运行路径。飞书 SkillHub 安装本包也不代表云端能直接访问本机 Chrome。

入口为 [SKILL.md](SKILL.md)，引导话术见 [onboarding](references/onboarding.md)，状态合同见 [readiness](references/readiness.md)。HTML 不含名单、联系人、登录凭据或运行快照。

## Change Log

- 2026-10-08：0.5.58，同步商务引导与准备状态页面。已实测两站登录及同一次官方授权连接复用；未启动新采集。
