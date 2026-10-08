---
title: KOC 商务实时准备状态机
owner: APU Workshop
status: candidate
updated: 2026-10-08
---

# 入口

默认打开 `http://127.0.0.1:18765`，不是静态快照文件。页面每 5 秒读取最新状态；每次 GET 直接读取受限 active/ledger 和有效生产锁，更新完成/在途/冷却信息，不等准备探测；服务启动即运行固定只读探测器，此后每 30 秒核验一次。页面自动核验，不显示手动刷新按钮或刷新频率提示。普通用户只看到状态清单和运行进度；不显示当前待办、状态变化条件或关于本页。采集标题右侧提供飞书表链接。

从项目根目录启动：

```sh
npm run readiness
```

默认私有状态文件：Windows `%APPDATA%/KOC Roster Update/readiness-live.json`（实际目录由 runtime 的 `KOC_DATA_DIR` 决定）。可用 `KOC_READINESS_STATUS_PATH` 固定配置另一私有路径，`KOC_READINESS_HTML_PATH` 指定此 Skill 的 HTML。监听仅 `127.0.0.1:18765`；拒绝其他 Host/Origin，不暴露目录、任意文件或任意命令。

`readiness-live-probe.mjs` 是项目固定探测器；无命令行参数，接收环境变量 `KOC_READINESS_STATUS_PATH`，原子写入 JSON，成功退出 0。最长 60 秒，一次仅一个探测。不得因探测而采集、写 Base、创建新授权或重复弹窗。

# 状态合同

```json
{
  "schemaVersion": 1,
  "checkedAt": "2026-10-08T03:00:00Z",
  "validForSeconds": 300,
  "sites": {"chann":{"state":"unknown"},"buyin":{"state":"unknown"}},
  "component": "unknown",
  "base": {"read":"unknown","write":"unknown"},
  "run": {"state":"paused","actualLanes":0,"targetLanes":10,"completed":10,"total":45,"observedAt":"2026-10-08T03:00:00Z","reasonCode":"BASE_READ_UNAVAILABLE"}
}
```

- `checkedAt` 是真实探测时间，读取 HTTP 或刷新页面不得改写。`run.observedAt` 是当前 ledger 文件更新时间，两者独立；`inFlight` 是 ledger 在途条数。有效 daily-inventory 锁且正 PID 存活才标运行，读取异常保留原探测快照，不伪造新进度。
- 网站：`unknown | logged_out | logged_in | authorized`。未知先核验；已登录不等于 Playwright 已授权。authorized 必须正确账号且当前页面实测可操作。
- 组件：`unknown | missing | ready`；Base 读、写各自 `unknown | missing | granted`。不以 scope 代替资源权限，不为检查写权限试写业务记录。
- 两站登录、组件就绪后按蝉妈妈 → 抖音达人广场补缺失授权；已有有效授权复用。失效只退回受影响项。
- `run` 可省略；状态 `running | cooldown | paused | completed`，路数 0–10、目标 10，数量为核验完成量。默认 10 路，不静默降路；显式诊断 2 路、尾批及冷却单探测除外。
- `nextProbeAt` 为 ISO 时间或 Unix 毫秒，至少最后失败后 5 分钟，平台要求更久时优先。只显示允许探测时间，不据此伪造任务正在运行。
- `completed` 还需 completed=total、`readbackVerified:true`。准备核验通过不代表运行完成。
- server 仅允许 `reasonCode` 映射的商务原因：`BASE_READ_UNAVAILABLE`、`AUTH_REQUIRED`、`RATE_LIMITED`、`BROWSER_CAPACITY_UNAVAILABLE`；其他原因显示待核查。任意内部错误文本、凭证、联系人、目标 ID 不对外返回。
- `validForSeconds` 为 1–3600，建议 300。过期不显示当前成功绿勾，不自动重复登录或授权；读取失败保留带真实时间的上次结果。

HTML 仍支持内嵌 `readiness-snapshot` 作为离线参考：用 `JSON.stringify(snapshot).replace(/</g, "\\u003c")` 转义后替换模板 `null`。离线页不作为默认交付。

## Change Log

| 日期 | 变更 |
|---|---|
| 2026-10-08 | 增加本机只读状态服务、5 秒页面刷新、30 秒真实探测及立即重新检查；区分探测与运行观察时间，保留渐进披露。 |

## 任务助手布局

页面名称为“达人微信收集任务助手”。布局依次为“任务开始前准备”（两站、浏览器组件、飞书读取与保存五项；未满足项有区别图标和具体指引）及“任务执行状态”。执行区分“基于蝉妈妈做条目更新”和“微信采集更新”：前者显示入库进度、本次入库条数及筛选名单条数，后者显示采集进度、微信/未展示/无匹配/平台限制/技术失败/未知写入/未处理分类。数量由对应来源回执与库存核验派生，不混淆筛选名单、本次新增及Base总量；缺少分母时不虚构百分比。

服务增加sourceUpdate（绑定最新来源批次的入库回执）及run.results（仅核验完成项计业务结果，其余分技术失败、未知写入、未处理）。不输出身份、联系人或原始回执。

- 2026-10-08：移除冗余说明及刷新控件。未登录、Playwright未授权、未安装以明确红色状态展示；实际连接丢失显示Playwright未连接，不冒称网站退出或授权失效。未满足项提示“请按 Agent 引导操作”。

## 本次与历史（0.6.1）
页面用 sessionStorage 保存本页首次打开时间，刷新不重置。/status?since=ISO 分区当前任务及 history；历史完成结果不混入当前。保留原始ledger和checkpoint。打开飞书表使用同源POST /open-base及X-KOC-Open-Base:1；服务仅打开配置表URL，客户端不提交URL。

- 2026-10-08：本次与历史分区、默认系统浏览器跳转。
