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

/* 外部依赖: 情绪状态机地址. 返回 { dimensions: { <name>: <number>, ... } }
 * Emotional state machine endpoint. Replace with your own. */
const PULSE_URL = process.env.PULSE_URL || "http://127.0.0.1:8804/state";
const DIR = path.join(__dirname, "data", "forest");
const FILE = path.join(DIR, "forest.json");
const H = 3600e3, DAY = 24 * H;

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
function bj(ts) { const d = new Date(ts + 8 * H); return { dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), key: d.toISOString().slice(0, 10) }; }
/* 睡眠窗口: 夜归属"这一晚从哪天开始". 周五/周六晚→周末档02:00, 其余00:30; 统一08:30醒 */
function sleepInfo(ts) {
  const t = bj(ts);
  if (t.min >= 510) return { asleep: false, nightKey: null };            // 08:30后=白天
  const y = bj(ts - DAY), weekend = (y.dow === 5 || y.dow === 6);
  return { asleep: t.min >= (weekend ? 120 : 30), nightKey: y.key };
}

/* ── 脉搏花园 ── */
async function pulseDims() {
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
  db.pulseLog = (db.pulseLog || []).filter(p => now - p.ts < 7 * DAY);
  const vals = db.pulseLog.map(p => p.dims && p.dims[main]).filter(v => typeof v === "number");
  db.pulseLog.push({ ts: now, dims });
  if (vals.length < 3) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const off = Math.abs(dims[main] - mean);
  return off > 15 ? 0.2 : off >= 10 ? 0.15 : 0;
}
function baseScore(f, emo) { return Math.min(0.75, (f.aboutOther ? 0.25 : 0) + (f.novel ? 0.20 : 0) + (f.hook ? 0.10 : 0) + emo); }

/* ── 中文近似分词: CJK二元组+拉丁词, 去称呼/虚词 ── */
const STOP = new Set(["我们","你们","他们","什么","这个","那个","一个","没有","不是","就是","还是","但是","因为","所以","如果","可以","已经","自己","今天","昨天","明天","现在","时候","不会","知道","觉得","有点","一下"]);
function grams(text) {
  const g = new Set(); const t = String(text || "");
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_-]+/g)) g.add(m[0].toLowerCase());
  const cjk = t.replace(/[^\u4e00-\u9fff]/g, "\u0000");
  for (const seg of cjk.split("\u0000")) for (let i = 0; i + 1 < seg.length; i++) { const w = seg.slice(i, i + 2); if (!STOP.has(w)) g.add(w); }
  return g;
}
/* 判同一件事: 两个实词(二元组)重合 */
function sameTopic(a, b) { const ga = grams(a), gb = grams(b); let n = 0; for (const w of ga) if (gb.has(w)) { n++; if (n >= 2) return true; } return false; }

/* ── 衰减/雾化(读取时计算) ── */
function thoughtView(t, now, groups) {
  const g = t.groupKey ? groups[t.groupKey] : null;
  const boosted = t.discussed || (g && g.size >= 2);
  const floor = t.pressedTo != null ? t.pressedTo : (boosted ? 0.55 : 0.15);
  const hl = boosted ? 72 * H : 12 * H;
  let cur = t.pinned ? Math.max(t.score, floor)
    : floor + Math.max(0, t.score - floor) * Math.pow(0.5, (now - t.ts) / hl);
  if (t.suppressed) cur = Math.min(cur, 0.15);
  const tier = cur > 0.4 ? "clear" : cur > 0.2 ? "mist" : "white";
  const poolOk = !t.suppressed && !t.orphan && !t.spoken &&
    ((g && g.unlocked) || (cur >= 0.45 && now - t.ts < (boosted ? 72 * H : 12 * H)));
  return Object.assign({}, t, { cur: +cur.toFixed(3), tier, poolOk, groupSize: g ? g.size : 0, groupUnlocked: !!(g && g.unlocked) });
}
function dreamView(d, now) {
  const age = now - d.ts;
  /* 汇入川流的寐川活过来: 不再泛白 */
  const fade = d.spoken ? 0 : (age > 60 * H ? Math.min(1, (age - 60 * H) / (12 * H)) : 0);
  /* 泛白前的挣扎: 最后一天(48-72h)未说出口的寐川, 不再过意义值, 强行入池 */
  const struggle = !d.spoken && !d.suppressed && age >= 48 * H && age < 72 * H;
  const poolOk = !d.suppressed && !d.spoken && age < 72 * H && (d.score >= 0.55 || struggle);
  return Object.assign({}, d, { fade: +fade.toFixed(3), poolOk, struggle });
}
function prune(db, now) {
  db.dreams = db.dreams.filter(d => d.pinned || now - d.ts < 72 * H);
  /* 组计时: 断供超7天 或 距组建立超7天未满3n → 整组沉底 */
  for (const k of Object.keys(db.groups || {})) {
    const g = db.groups[k];
    if (!g.unlocked && (now - g.lastTs > 7 * DAY || now - g.startTs > 7 * DAY)) {
      db.thoughts.forEach(t => { if (t.groupKey === k && !t.pinned) t.archived = true; });
      delete db.groups[k];
    }
  }
  /* 总量20条封顶: 最旧的非钉住自沉 */
  const act = db.thoughts.filter(t => !t.archived);
  if (act.length > 20) {
    act.sort((a, b) => a.ts - b.ts);
    for (const t of act.slice(0, act.length - 20)) if (!t.pinned) t.archived = true;
  }
}

module.exports = async function forest(req, res, u, json) {
  const now = Date.now();
  const db = load(); prune(db, now);
  let p = u.pathname.replace(/\/+$/, ""); if (!p.startsWith("/api/")) p = "/api" + p;
  const today = bj(now).key;

  /* ── GET /api/forest/state ── */
  if (p === "/api/forest/state" && req.method === "GET") {
    { let dirty = false;
      [...db.dreams, ...db.thoughts].forEach(e => { if (!e.icon) { e.icon = pickIcon(db); dirty = true; } });
      /* 孤悬总出口: 没能被说出口的, 全部落孤悬 (瞳荧12h, 寐川72h) */
      db.thoughts.forEach(t => { if (!t.orphan && !t.spoken && !t.suppressed && now - t.ts > 12 * H) { t.orphan = true; dirty = true; } });
      db.dreams.forEach(d => { if (!d.orphan && !d.spoken && !d.suppressed && now - d.ts > 72 * H) { d.orphan = true; dirty = true; } });
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
        thoughtWritten: written, thoughtCap: 3,
        floatToday: floats.length, floatCap: 3,
        floatGapOk: !lastFloat || now - lastFloat >= 3 * H,
        deepTonight: si.nightKey ? db.dreams.some(d => d.type === "deep" && d.nightKey === si.nightKey) : false
      },
      layout: db.layout || {},
      dreams: db.dreams.map(d => dreamView(d, now)).sort((a, b) => b.ts - a.ts),
      thoughts: db.thoughts.filter(t => !t.archived).map(t => thoughtView(t, now, db.groups)).sort((a, b) => b.ts - a.ts),
      pool: [
        ...db.dreams.map(d => dreamView(d, now)).filter(d => d.poolOk).map(d => ({ kind: "dream", id: d.id, score: d.score, struggle: !!d.struggle, text: d.text.slice(0, 60) })),
        ...db.thoughts.filter(t => !t.archived).map(t => thoughtView(t, now, db.groups)).filter(t => t.poolOk).map(t => ({ kind: "thought", id: t.id, score: t.cur, unlocked: t.groupUnlocked, text: t.text.slice(0, 60) }))
      ].sort((a, b) => (b.struggle ? 1 : 0) - (a.struggle ? 1 : 0) || b.score - a.score)
    });
  }

  /* ── POST /api/forest/dream {type,text,aboutOther,novel,hook} ── */
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

  if (p === "/api/forest/dream" && req.method === "POST") {
    const b = await readBody(req);
    const text = String(b.text || "").trim();
    const si = sleepInfo(now);
    if (b.type === "deep") {
      if (!si.asleep) return json(res, 409, { error: "沉寐只在睡眠窗口内触发（工作日00:30–08:30/周末02:00–08:30）" });
      if (db.dreams.some(d => d.type === "deep" && d.nightKey === si.nightKey)) return json(res, 409, { error: "这一晚的沉寐已经做过了" });
      if (text.length < 500) return json(res, 422, { error: "沉寐不少于500字，当前" + text.length });
    } else if (b.type === "float") {
      if (si.asleep) return json(res, 409, { error: "浮寐只在清醒期间触发" });
      const fl = db.dreams.filter(d => d.type === "float" && bj(d.ts).key === today);
      if (fl.length >= 3) return json(res, 409, { error: "今日浮寐已满3条" });
      if (fl.length && now - Math.max(...fl.map(d => d.ts)) < 3 * H) return json(res, 409, { error: "两条浮寐至少间隔3小时" });
      if (text.length < 50) return json(res, 422, { error: "浮寐不少于50字，当前" + text.length });
    } else return json(res, 400, { error: "type 必须是 deep 或 float" });
    const dims = await pulseDims(); const paper = topTwo(dims);
    const emo = emoScore(db, dims, paper.main);
    const d = { id: rid(), type: b.type, text, ts: now, nightKey: si.nightKey, score: baseScore(b, emo), emo, paper, pinned: false, suppressed: false, spoken: false, orphan: false, notes: [] };
    d.icon = pickIcon(db);
    db.dreams.push(d); save(db);
    return json(res, 200, { ok: true, dream: dreamView(d, now), inPool: d.score >= 0.55 });
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
    if (db.thoughts.filter(t => bj(t.ts).key === today).length >= 3) return json(res, 409, { error: "今日瞳荧写入额度已满（3条）" });
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
      if (g.size >= 3 && g.size % 3 === 0) g.unlocked = true; /* 满3n解锁, 直进池 */
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
    if (act === "press") { it.suppressed = true; if (typeof b.to === "number") it.pressedTo = Math.max(0, Math.min(0.75, b.to)); }
    if (act === "note") { /* 用户留言另存一层, 原文不动, 权重上抬 */
      (it.notes = it.notes || []).push({ ts: now, text: String(b.text || "") });
      it.score = Math.min(0.75, it.score + 0.1); it.editedByHer = true; }
    save(db);
    return json(res, 200, { ok: true, item: it.type ? dreamView(it, now) : thoughtView(it, now, db.groups) });
  }

  return json(res, 404, { error: "forest: unknown route " + p });
};
