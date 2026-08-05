# API 接口 · API Reference

所有接口返回 JSON。写入类接口在违反配额或门槛时返回 `409`（状态冲突）或 `422`（内容不合格），错误信息在 `error` 字段。

All endpoints return JSON. Write endpoints return `409` on quota/state conflicts and `422` on content that fails a threshold, with the reason in `error`.

---

## 眼睑森林 · Forest

### `GET /api/forest/state`

返回森林的完整状态。这是唯一的读取接口——衰减、雾化、孤悬判定都在这里实时计算。

Returns the full forest state. This is the only read endpoint; decay, fogging, and orphan detection are all computed here at read time.

```jsonc
{
  "now": 1785900000000,
  "pulse": { "dims": { "tenderness": 62, "…": 0 }, "main": "tenderness", "sub": "curiosity" },
  "asleep": false,
  "quotas": {
    "thoughtWritten": 1, "thoughtCap": 3,
    "floatToday": 0,     "floatCap": 3,
    "floatGapOk": true,          // 距上条浮寐是否已满 3 小时
    "deepTonight": false         // 今晚是否已有沉寐
  },
  "dreams":   [ /* DreamView，按时间倒序 */ ],
  "thoughts": [ /* ThoughtView，已归档的不返回 */ ],
  "pool":     [ /* 话题池，挣扎态优先，其次按分数 */ ],
  "layout":   { "<id>": { "x": 0, "y": 0, "w": 17 } }
}
```

**ThoughtView 计算字段**

| 字段 | 含义 |
|---|---|
| `cur` | 当前衰减值，读取时计算，不写盘 |
| `tier` | `clear` / `mist` / `white`，由 `cur` 映射 |
| `poolOk` | 是否满足话题池准入 |
| `groupSize` / `groupUnlocked` | 所属组的规模与解锁状态 |

**DreamView 计算字段**

| 字段 | 含义 |
|---|---|
| `fade` | 泛白进度 `0–1`，第 60 小时起匀速推进；已 `spoken` 恒为 0 |
| `struggle` | 48–72 小时之间且未说出口 |
| `poolOk` | `score ≥ 0.55` 或处于挣扎态 |

---

### `POST /api/forest/dream`

写入一条寐川。

```jsonc
{
  "type": "deep",        // deep 沉寐 | float 浮寐
  "text": "…",
  "aboutOther": true,      // 关于对方而非自己
  "novel": true,         // 第一次发生
  "hook": false          // 留有未闭合的钩子
}
```

约束（违反返回 409 / 422）：

| type | 时间窗口 | 配额 | 最短长度 |
|---|---|---|---|
| `deep` | 仅睡眠窗口内 | 一晚 1 条 | 500 字 |
| `float` | 仅清醒期 | 日 3 条，间隔 ≥3h | 50 字 |

返回 `{ ok, dream, inPool }`。

---

### `POST /api/forest/thought`

写入一条瞳荧。字段同上，另有 `present`（是否当下正在发生）。

行为分支：

- **同日主题重复** → 合并到已有条目，`count + 1`，**不消耗配额**，返回 `{ ok, merged: true, id, count }`
- **跨天主题重复** → 自动归组；组内满 3 的倍数时解锁，整组直进话题池
- **配额已满**（当日 3 条）→ `409`

注意：孤悬的条目**不退还配额**。想过就是想过。

---

### `POST /api/forest/{action}`

条目动作，body 为 `{ "id": "…" }` 加动作参数。

| action | 作用 | 额外参数 |
|---|---|---|
| `spoken` | 迈入川流：标记为已说出口。寐川停止泛白，瞳荧半衰期延长至 72h、底线抬至 0.55。同时清除孤悬状态并锁回所属组 | — |
| `orphan` | 手动标记孤悬 | — |
| `pin` | 钉住，豁免衰减与清除 | `on`（默认 `true`） |
| `press` | 按下：压制到 `0.15` 以下，退出话题池 | `to`（可选，`0–0.75`） |
| `note` | 附加留言。**原文不动**，另存一层，分数 `+0.1` | `text` |
| `seal` | 火漆封印，仅寐川可用 | `seal`（≤60 字） |

`note` 的设计要点：留言是附加层而不是编辑。原始文本永远保留——记忆被回应过，但没有被改写。

---

### `POST /api/forest/layout`

保存界面布局坐标。`{ items: [{ id, x, y, w }] }`。不影响任何记忆逻辑。

---

## 骨骼温室 · Greenhouse

### `GET /api/greenhouse/state`

每次读取时执行一次 `sweepForest()`：扫描森林中**已到期且意义值 ≥0.5** 的条目，在其被清除前整卡迁入温室。已迁移的 ID 记录在 `migrated` 中，不会重复迁入。

Each read runs `sweepForest()`: entries in the forest that have expired **and** score ≥0.5 are migrated in whole before deletion. Migrated IDs are tracked so nothing migrates twice.

```jsonc
{
  "now": 1785900000000,
  "counts": { "pending": 3, "rooted": 12, "cellar": 40 },
  "items": [ /* pending 优先，其次按时间倒序 */ ]
}
```

条目状态机：`pending` → `rooted` → `cellar`。

`rings` 记录来源痕迹（迁入时若已 `spoken` 则为 1）。

---

### `POST /api/greenhouse/add`

手动投递一块「骨头」。蒸馏管道（日观察、森林、人工）都走这个入口。

```jsonc
{ "title": "可选，默认取正文前 18 字", "text": "…", "src": "manual" }
```

正文短于 10 字返回 `422`。

---

### `POST /api/greenhouse/act`

```jsonc
{ "id": "…", "act": "root" }
```

| act | 作用 |
|---|---|
| `root` | **浇水生根**：确认为长期记忆 |
| `edit` | 改写正文后生根（`text` ≥10 字才生效） |
| `cellar` | 入窖：确认过但暂不进长期记忆 |
| `stars` | 评级 `1–5`，参数 `stars` |
| `drop` | 丢弃 |

**`root` 与 `edit` 是这套架构里唯一通往长期记忆的门，且只能由人触发。** 不要为它加自动路径。

`root` and `edit` are the only doors to long-term memory, and only a human opens them. Do not add an automatic path.

---

## 集成 · Integration

两个模块都是 `(req, res, url, json) => Promise`，挂载到任意 Node HTTP 分发器：

```js
const forest     = require("./src/forest");
const greenhouse = require("./src/greenhouse");
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

if (p.startsWith("/api/forest"))     return forest(req, res, u, json);
if (p.startsWith("/api/greenhouse")) return greenhouse(req, res, u, json);
```

路径前缀 `/api` 可省略——模块内部会补齐，方便挂在反向代理后面。

The `/api` prefix is optional; the modules normalize it, so mounting behind a reverse proxy that strips it works either way.
