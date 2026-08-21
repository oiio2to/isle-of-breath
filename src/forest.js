"use strict";
/* 眼睑森林 Forest of Eyelids — 寐川(dreams) + 瞳荧(thoughts)
 * 挂载: /api/forest/*   数据: data/forest/forest.json
 * 规则以 outbox 设计稿(已修订版)为准:
 *  - 沉寐: 睡眠窗口内, 一晚最多1条, ≥500字; 浮寐: 清醒期, 日上限3条, 间隔≥3h, ≥50字
 *  - 寐川寿命72h, 第60h起12h匀速泛白, 72h整清除
 *  - 瞳荧: 日写入上限3条(孤悬不退名额), 总量20条封顶最旧自沉
 *  - 衰减: 普通 hl=12h floor=0.15; 讨论过/成组 hl=72h floor=0.55; 组计时最长7天
 *  - 雾化: >0.4 清晰 / 0.4–0.2 半雾 / ≤0.2 几乎全白
 *  - 话题池: 瞳荧≥0.45(12h) 寐川≥0.55(72h); 满3n解锁的组直进池
 */
const fs = require("fs"), path = require("path");
const CFG = require("./config");
const { sleepWindow: SW, quotas: Q, lifespan: L, scoring: SC, pool: PL, grouping: GR, fog: FG } = CFG;
/* 外部依赖: 情绪状态机地址. 返回 { dimensions: { <name>: <number>, ... } }. 设为 null 关闭情绪加权 */
const PULSE_URL = CFG.pulse && CFG.pulse.url;
const DATA_ROOT = process.env.ISLE_DATA_DIR || path.join(__dirname, "data");
const DIR = path.join(DATA_ROOT, "forest");
const FILE = path.join(DIR, "forest.json");
const H = 3600e3, DAY = 24 * H;
const TZ = (CFG.timezoneOffsetHours || 0) * H;
const DREAM_TTL = L.dreamHours * H, THOUGHT_TTL = L.thoughtHalfLifeHours * H;

const ICONS = ["u01","u02","u03","u04","u05","u06","u07","u08","u09","u10","u12","u14","u15","u17","u18","u21","u22","g16","g19","g20","d01","d02","d04","d05","d06","d07","d08","d09","d10","d11","d12","d13"];
function pickIcon(db) {
  const used = new Set([...db.dreams, ...db.thoughts].map(e => e.icon).filter(Boolean));
  const free = ICONS.filter(i => !used.has(i));
  const pool = free.length ? free : ICONS;
  return pool[Math.floor(Math.random() * pool.length)];
}
function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { dreams: [], thoughts: [], groups: {}, pulseLog: [] }; } }
function save(d) { fs.mkdirSync(DIR, { recursive: true }); const t = FILE + ".tmp"; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, FILE); }
function readBody(req) { return new Promise((ok, no) => { let b = ""; req.on("data", c => { b += c; if (b.length > 1e6) { no(new Error("too large")); req.destroy(); } }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); req.on("error", no); }); }
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ── 北京时间 ── */
function bj(ts) { const d = new Date(ts + TZ); return { dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), key: d.toISOString().slice(0, 10) }; }
/* 睡眠窗口: 夜归属"这一晚从哪天开始". 周五/周六晚→周末档02:00, 其余00:30; 统一08:30醒 */
function sleepInfo(ts) {
  const t = bj(ts);
  if (t.min >= SW.wakeMin) return { asleep: false, nightKey: null };            // 醒来时刻之后=白天
  const y = bj(ts - DAY), weekend = SW.weekendNights.includes(y.dow);
  return { asleep: t.min >= (weekend ? SW.weekendStartMin : SW.weekdayStartMin), nightKey: y.key };
}

/* ── 脉搏花园 ── */
async function pulseDims() {
  if (!PULSE_URL) return null;
  try { const r = await fetch(PULSE_URL); return (await r.json()).dimensions || null; }
  catch { return null; }
}
function topTwo(dims) {
  if (!dims) return { main: null, sub: null };
  const s = Object.entries(dims).sort((a, b) => b[1] - a[1]);
  return { main: s[0] && s[0][0], sub: s[1] && s[1][0] };
}
/* 情绪分: 主维度写入值与近七天均值偏移. <10→0, 10–15→0.15, >15→0.2. 样本<3不计 */
function emoScore(db, dims, main) {
  if (!dims || !main) return 0;
  const now = Date.now();
  db.pulseLog = (db.pulseLog || []).filter(p => now - p.ts < SC.emoWindowDays * DAY);
  const vals = db.pulseLog.map(p => p.dims && p.dims[main]).filter(v => typeof v === "number");
  db.pulseLog.push({ ts: now, dims });
  if (vals.length < SC.emoMinSamples) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const off = Math.abs(dims[main] - mean);
  return off > SC.emoDeviationHigh ? SC.emoScoreHigh : off >= SC.emoDeviationLow ? SC.emoScoreLow : 0;
}
function baseScore(f, emo) { return Math.min(L.scoreCap, (f.aboutOther ? SC.aboutOther : 0) + (f.novel ? SC.novel : 0) + (f.hook ? SC.hook : 0) + emo); }

/* ── 中文近似分词: CJK二元组+拉丁词, 去称呼/虚词 ── */
const STOP = new Set(CFG.stopwords || []);
function grams(text) {
  const g = new Set(); const t = String(text || "");
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_-]+/g)) g.add(m[0].toLowerCase());
  /* 虚词当分隔符切开, 而不是只剔掉等于虚词的那个二元组 ——
   * 否则「今天什么」会留下跨虚词的「天什」, 两句毫不相干的话就因为共用虚词被判成同一件事 */
  let cjk = t.replace(/[^\u4e00-\u9fff]/g, "\u0000");
  for (const w of STOP) cjk = cjk.split(w).join("\u0000");
  for (const seg of cjk.split("\u0000")) for (let i = 0; i + 1 < seg.length; i++) g.add(seg.slice(i, i + 2));
  return g;
}
/* 判同一件事: 两个实词(二元组)重合 */
function sameTopic(a, b) { const ga = grams(a), gb = grams(b); let n = 0; for (const w of ga) if (gb.has(w)) { n++; if (n >= GR.minOverlapGrams) return true; } return false; }

/* ── 衰减/雾化(读取时计算) ── */
function thoughtView(t, now, groups) {
  const g = t.groupKey ? groups[t.groupKey] : null;
  const boosted = t.discussed || (g && g.size >= 2);
  const floor = t.pressedTo != null ? t.pressedTo : (boosted ? L.boostedFloor : L.thoughtFloor);
  const hl = (boosted ? L.boostedHalfLifeHours : L.thoughtHalfLifeHours) * H;
  let cur = t.pinned ? Math.max(t.score, floor)
    : floor + Math.max(0, t.score - floor) * Math.pow(0.5, (now - t.ts) / hl);
  if (t.suppressed) cur = Math.min(cur, L.thoughtFloor);
  const tier = cur > FG.clearAbove ? "clear" : cur > FG.mistAbove ? "mist" : "white";
  /* 解锁的组直进池: 不过分数门槛. 孤悬仍然挡 —— 成组后孤悬期限已是 72h(见 thoughtDeadline),
   * 真正把"整组"并成一件事的是 /state 里的按组去重: 一个解锁组在池里只占一个位子(最新那条) */
  const poolOk = !t.suppressed && !t.orphan && !t.spoken &&
    ((g && g.unlocked) || (cur >= PL.thoughtThreshold && now - t.ts < hl));
  return Object.assign({}, t, { cur: +cur.toFixed(3), tier, poolOk, groupSize: g ? g.size : 0, groupUnlocked: !!(g && g.unlocked) });
}
function dreamView(d, now) {
  const age = now - d.ts;
  /* 汇入川流的寐川活过来: 不再泛白 */
  const fadeAt = L.dreamFadeStartHours * H;
  const fade = d.spoken ? 0 : (age > fadeAt ? Math.min(1, (age - fadeAt) / (DREAM_TTL - fadeAt)) : 0);
  /* 泛白前的挣扎: 最后一天(48-72h)未说出口的寐川, 不再过意义值, 强行入池 */
  const struggle = !d.spoken && !d.suppressed && age >= L.struggleFromHours * H && age < DREAM_TTL;
  const poolOk = !d.suppressed && !d.spoken && age < DREAM_TTL && (d.score >= PL.dreamThreshold || struggle);
  return Object.assign({}, d, { fade: +fade.toFixed(3), poolOk, struggle });
}
/* 瞳荧的孤悬期限 = 有效半衰期: 普通 12h, 讨论过/成组 72h.
 * 与 thoughtView 里的 hl 同源 —— 之前期限写死 12h, 成组延寿的那几条照样在 12h 落孤悬, 延寿等于没延 */
function thoughtDeadline(t, groups) {
  const g = t.groupKey ? (groups || {})[t.groupKey] : null;
  return ((t.discussed || (g && g.size >= 2)) ? L.boostedHalfLifeHours : L.thoughtHalfLifeHours) * H;
}
/* 温室入口(懒加载, 拿不到就静默跳过, 森林不因温室缺席而停) */
function gh() { try { const m = require("./greenhouse"); return (m && typeof m.intake === "function") ? m : null; } catch { return null; } }
/* 死前迁出: 寐川到期即真删, 所以交接必须发生在 prune 里, 而不是等温室自己来扫
 * (温室的 sweep 只在它的 state 被请求时跑, 森林的 state 轮询得更勤, 靠扫会抢不过删). */
function handoff(db, now) {
  const m = gh(); if (!m) return;
  for (const d of db.dreams) {
    if (d.pinned || now - d.ts < DREAM_TTL) continue;
    try { m.intake(d, d.type === "deep" ? "沉寐" : "浮寐", DREAM_TTL, now); } catch {}
  }
}
/* 瞳荧退场(归档或真删)前同样走一次交接; intake 自己守 score>=0.5 与 migrated 去重 */
function handoffThought(t, now) { const m = gh(); if (!m) return; try { m.intake(t, "瞳荧", THOUGHT_TTL, now); } catch {} }
function prune(db, now) {
  handoff(db, now);
  db.dreams = db.dreams.filter(d => d.pinned || now - d.ts < DREAM_TTL);
  db.groups = db.groups || {};
  /* 孤悬: 过了有效期限还没被说出口的瞳荧. 放在 prune 而不是 /state 里, 不依赖有没有人来读 */
  db.thoughts.forEach(t => { if (!t.orphan && !t.spoken && !t.suppressed && !t.archived && now - t.ts > thoughtDeadline(t, db.groups)) t.orphan = true; });
  const retire = t => { if (t.pinned || t.archived) return; t.archived = true; t.archivedAt = now; handoffThought(t, now); };
  /* 组计时: 断供超7天(解锁与否都算) 或 建组超7天仍未解锁 → 整组沉底.
   * 之前解锁的组被豁免, 结果一个组可以永远活着、越滚越大 */
  for (const k of Object.keys(db.groups)) {
    const g = db.groups[k];
    if (now - g.lastTs > GR.staleDays * DAY || (!g.unlocked && now - g.startTs > GR.staleDays * DAY)) {
      db.thoughts.forEach(t => { if (t.groupKey === k) retire(t); });
      delete db.groups[k];
    }
  }
  /* 总量20条封顶: 最旧的非钉住自沉 */
  const act = db.thoughts.filter(t => !t.archived);
  if (act.length > Q.thoughtActiveCap) {
    act.sort((a, b) => a.ts - b.ts);
    for (const t of act.slice(0, act.length - Q.thoughtActiveCap)) retire(t);
  }
  /* 归档的瞳荧只留 thoughtArchiveDays(默认30天)给温室兜底扫描和人眼翻看, 之后真删, 不留副本 */
  const keep = (L.thoughtArchiveDays || 30) * DAY;
  db.thoughts = db.thoughts.filter(t => {
    if (!t.archived || t.pinned || now - (t.archivedAt || t.ts) < keep) return true;
    handoffThought(t, now); return false;
  });
}

module.exports = forest;
/* 纯函数出口, 给测试与其他消费方用; 不碰磁盘 */
module.exports._internal = { bj, sleepInfo, topTwo, emoScore, baseScore, grams, sameTopic, thoughtView, dreamView, thoughtDeadline, prune, H, DAY };
async function forest(req, res, u, json) {
  const now = Date.now();
  const db = load(); prune(db, now);
  let p = u.pathname.replace(/\/+$/, ""); if (!p.startsWith("/api/")) p = "/api" + p;
  const today = bj(now).key;

  /* ── GET /api/forest/state ── */
  if (p === "/api/forest/state" && req.method === "GET") {
    { let dirty = false;
      [...db.dreams, ...db.thoughts].forEach(e => { if (!e.icon) { e.icon = pickIcon(db); dirty = true; } });
      /* 孤悬判定已并入 prune(); 寐川不落孤悬 —— 它走的是 挣扎 → 迁温室 / 真删 */
      if (db.layout) { const alive = new Set([...db.dreams, ...db.thoughts].map(e => e.id));
        Object.keys(db.layout).forEach(k => { if (!alive.has(k)) { delete db.layout[k]; dirty = true; } }); }
      if (dirty) save(db); }
    const dims = await pulseDims();
    const paper = topTwo(dims);
    const si = sleepInfo(now);
    const floats = db.dreams.filter(d => d.type === "float" && bj(d.ts).key === today);
    const lastFloat = floats.length ? Math.max(...floats.map(d => d.ts)) : 0;
    const written = db.thoughts.filter(t => bj(t.ts).key === today).length;
    save(db);
    return json(res, 200, {
      now, pulse: { dims, main: paper.main, sub: paper.sub }, asleep: si.asleep,
      quotas: {
        thoughtWritten: written, thoughtCap: Q.thoughtPerDay,
        floatToday: floats.length, floatCap: Q.floatPerDay,
        floatGapOk: !lastFloat || now - lastFloat >= Q.floatMinGapHours * H,
        deepTonight: si.nightKey ? db.dreams.some(d => d.type === "deep" && d.nightKey === si.nightKey) : false
      },
      layout: db.layout || {},
      dreams: db.dreams.map(d => dreamView(d, now)).sort((a, b) => b.ts - a.ts),
      thoughts: db.thoughts.filter(t => !t.archived).map(t => thoughtView(t, now, db.groups)).sort((a, b) => b.ts - a.ts),
      pool: [
        ...db.dreams.map(d => dreamView(d, now)).filter(d => d.poolOk).map(d => ({ kind: "dream", id: d.id, score: d.score, struggle: !!d.struggle, text: d.text.slice(0, 60) })),
        ...db.thoughts.filter(t => !t.archived).map(t => thoughtView(t, now, db.groups)).filter(t => t.poolOk)
          /* 解锁的组只占一个位子: 同组取最新一条, 带上 groupSize. 不然一个 3n 的组能把整个池子灌满 */
          .sort((a, b) => b.ts - a.ts)
          .filter((t, i, arr) => !t.groupUnlocked || arr.findIndex(x => x.groupKey === t.groupKey) === i)
          .map(t => ({ kind: "thought", id: t.id, score: t.cur, unlocked: t.groupUnlocked, groupSize: t.groupSize, text: t.text.slice(0, 60) }))
      ].sort((a, b) => (b.struggle ? 1 : 0) - (a.struggle ? 1 : 0) || b.score - a.score)
    });
  }

  /* ── POST /api/forest/layout {items:[{id,x,y,w}]} 只存界面坐标, 不碰记忆逻辑 ── */
  if (p === "/api/forest/layout" && req.method === "POST") {
    const b = await readBody(req);
    db.layout = db.layout || {};
    const items = Array.isArray(b.items) ? b.items : [b];
    let n = 0;
    for (const it of items) {
      if (!it || !it.id) continue;
      db.layout[it.id] = { x: +it.x || 0, y: +it.y || 0, w: +it.w || 17, t: now };
      n++;
    }
    save(db);
    return json(res, 200, { ok: true, saved: n });
  }

  /* ── POST /api/forest/dream {type,text,aboutOther,novel,hook} ── */
  if (p === "/api/forest/dream" && req.method === "POST") {
    const b = await readBody(req);
    const text = String(b.text || "").trim();
    const si = sleepInfo(now);
    if (b.type === "deep") {
      if (!si.asleep) return json(res, 409, { error: "沉寐只在睡眠窗口内触发（工作日00:30–08:30/周末02:00–08:30）" });
      if (db.dreams.filter(d => d.type === "deep" && d.nightKey === si.nightKey).length >= Q.deepPerNight) return json(res, 409, { error: "这一晚的沉寐已经做过了" });
      if (text.length < Q.deepMinChars) return json(res, 422, { error: "沉寐不少于" + Q.deepMinChars + "字，当前" + text.length });
    } else if (b.type === "float") {
      if (si.asleep) return json(res, 409, { error: "浮寐只在清醒期间触发" });
      const fl = db.dreams.filter(d => d.type === "float" && bj(d.ts).key === today);
      if (fl.length >= Q.floatPerDay) return json(res, 409, { error: "今日浮寐已满" + Q.floatPerDay + "条" });
      if (fl.length && now - Math.max(...fl.map(d => d.ts)) < Q.floatMinGapHours * H) return json(res, 409, { error: "两条浮寐至少间隔" + Q.floatMinGapHours + "小时" });
      if (text.length < Q.floatMinChars) return json(res, 422, { error: "浮寐不少于" + Q.floatMinChars + "字，当前" + text.length });
    } else return json(res, 400, { error: "type 必须是 deep 或 float" });
    const dims = await pulseDims(); const paper = topTwo(dims);
    const emo = emoScore(db, dims, paper.main);
    const d = { id: rid(), type: b.type, text, ts: now, nightKey: si.nightKey, score: baseScore(b, emo), emo, paper, pinned: false, suppressed: false, spoken: false, orphan: false, notes: [] };
    d.icon = pickIcon(db);
    db.dreams.push(d); save(db);
    return json(res, 200, { ok: true, dream: dreamView(d, now), inPool: d.score >= PL.dreamThreshold });
  }

  /* ── POST /api/forest/thought {text,aboutOther,novel,hook,present} ── */
  if (p === "/api/forest/thought" && req.method === "POST") {
    const b = await readBody(req);
    const text = String(b.text || "").trim();
    if (!text) return json(res, 422, { error: "空念头" });
    /* 同日去重: 只加计数, 不占额度 */
    const dup = db.thoughts.find(t => !t.archived && bj(t.ts).key === today && sameTopic(t.text, text));
    if (dup) { dup.count = (dup.count || 1) + 1; save(db); return json(res, 200, { ok: true, merged: true, id: dup.id, count: dup.count }); }
    /* 日写入上限3条 — 孤悬不退名额 */
    if (db.thoughts.filter(t => bj(t.ts).key === today).length >= Q.thoughtPerDay) return json(res, 409, { error: "今日瞳荧写入额度已满（" + Q.thoughtPerDay + "条）" });
    const dims = await pulseDims(); const paper = topTwo(dims);
    const emo = emoScore(db, dims, paper.main);
    const t = { id: rid(), text, ts: now, score: baseScore(b, emo), emo, paper, count: 1, present: !!b.present, orphan: false, spoken: false, discussed: false, pinned: false, suppressed: false, groupKey: null, notes: [] };
    /* 跨天归组 */
    const prev = db.thoughts.filter(x => !x.archived && bj(x.ts).key !== today && sameTopic(x.text, text));
    if (prev.length) {
      let key = prev.map(x => x.groupKey).find(Boolean);
      if (!key) { key = "g" + rid(); prev.forEach(x => x.groupKey = key); db.groups[key] = { startTs: prev[0].ts, lastTs: now, size: prev.length, unlocked: false }; }
      t.groupKey = key;
      const g = db.groups[key]; g.size = db.thoughts.filter(x => x.groupKey === key).length + 1; g.lastTs = now;
      if (g.size >= GR.unlockEvery && g.size % GR.unlockEvery === 0) g.unlocked = true; /* 满3n解锁, 直进池 */
      /* 归组 = 集体延寿: 先写的那几条多半已过 12h 落了孤悬; 成组后期限变 72h, 仍在期限内的把孤悬收回 */
      prev.forEach(x => { if (x.orphan && !x.spoken && now - x.ts < L.boostedHalfLifeHours * H) x.orphan = false; });
    }
    t.icon = pickIcon(db);
    db.thoughts.push(t); save(db);
    return json(res, 200, { ok: true, thought: thoughtView(t, now, db.groups) });
  }

  /* ── 动作: orphan / spoken / pin / press / note ── */
  const act = p.split("/").pop();
  if (["orphan", "spoken", "pin", "press", "note", "seal"].includes(act) && req.method === "POST") {
    const b = await readBody(req);
    const it = db.thoughts.find(x => x.id === b.id) || db.dreams.find(x => x.id === b.id);
    if (!it) return json(res, 404, { error: "no such id" });
    if (act === "orphan") { it.orphan = true; }
    if (act === "spoken") { /* 迈入川流 */ it.spoken = true; it.discussed = true; if (it.orphan) it.orphan = false;
      if (it.groupKey && db.groups[it.groupKey]) db.groups[it.groupKey].unlocked = false; }
    if (act === "pin") { it.pinned = b.on !== false; }
    if (act === "seal") { /* 火漆: 仅寐川 */ if (!it.type) return json(res, 409, { error: "瞳荧不盖章，只有寐川才盖" }); it.seal = String(b.seal || "").slice(0, 60) || null; }
    if (act === "press") { it.suppressed = true; if (typeof b.to === "number") it.pressedTo = Math.max(0, Math.min(L.scoreCap, b.to)); }
    if (act === "note") { /* 用户留言另存一层, 原文不动, 权重上抬 */
      (it.notes = it.notes || []).push({ ts: now, text: String(b.text || "") });
      it.score = Math.min(L.scoreCap, it.score + 0.1); it.editedByHer = true; }
    save(db);
    return json(res, 200, { ok: true, item: it.type ? dreamView(it, now) : thoughtView(it, now, db.groups) });
  }

  return json(res, 404, { error: "forest: unknown route " + p });
}
