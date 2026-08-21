// 骨骼温室 · 文件存储后端 —— 蒸馏自动, 生根过手
// GET  /api/greenhouse/state          全部骨签/标本(待浇水优先)
// POST /api/greenhouse/add            {title,text,src}  蒸馏管道投递(daily/forest/manual)
// POST /api/greenhouse/act            {id, act:root|cellar|edit, text?}
const fs = require("fs"), path = require("path");
const CFG = require("./config");
const DATA_ROOT = process.env.ISLE_DATA_DIR || path.join(__dirname, "data");
const DIR = path.join(DATA_ROOT, "greenhouse");
const FILE = path.join(DIR, "greenhouse.json");
const H = 3600e3;
const MIN_LEN = CFG.greenhouse.minBoneChars;   // 骨骼温室正文字数下限: 骨头要够长才立得住
function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { items: [], migrated: [] }; } }
function save(d) { fs.mkdirSync(DIR, { recursive: true }); const t = FILE + ".tmp"; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, FILE); }
function rid() { return "gh" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function readBody(req) { return new Promise(r => { let b = ""; req.on("data", c => { b += c; if (b.length > 1e6) { req.destroy(); r({}); } }); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); }); }
/* 标本迁入: 森林里到期(寐川>72h/瞳荧>12h)且意义值>=0.5 的条目, 死前整卡迁来待浇水.
 * takeInto 是唯一的写入点: 森林 prune 在删除寐川前直接调 intake(), 温室自己的 sweep 只兜底瞳荧
 * (瞳荧到期只 archived 不删, 所以扫得到; 寐川到期会被真删, 只靠 sweep 会抢不过 prune). */
const GH_THRESHOLD = CFG.pool.greenhouseThreshold;
const DREAM_TTL = CFG.lifespan.dreamHours * H, THOUGHT_TTL = CFG.lifespan.thoughtHalfLifeHours * H;
function takeInto(db, e, kind, ttl, now) {
  const mig = new Set(db.migrated || []);
  if (!e || !e.id || mig.has(e.id) || (e.score || 0) < GH_THRESHOLD || now - e.ts < ttl) return false;
  db.items.push({ id: rid(), srcId: e.id, kind: "specimen", title: (e.text || "").slice(0, 18),
    text: e.text || "", src: kind, paper: e.paper || null, spoken: !!e.spoken, ts: e.ts,
    migratedAt: now, status: "pending", rings: e.spoken ? 1 : 0 });
  mig.add(e.id); db.migrated = [...mig];
  return true;
}
/* 给森林调的入口: 一条到期条目, 死前迁入. 返回是否真的迁了 */
function intake(e, kind, ttl, now) {
  const db = load();
  if (!takeInto(db, e, kind, ttl, now || Date.now())) return false;
  save(db); return true;
}
function sweepForest(db, now) {
  let dirty = false;
  try {
    const f = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "forest", "forest.json"), "utf8"));
    (f.dreams || []).forEach(d => { if (takeInto(db, d, d.type === "deep" ? "沉寐" : "浮寐", DREAM_TTL, now)) dirty = true; });
    /* 瞳荧只在真的"到期"后兜底(孤悬或已归档); 还活着的成组瞳荧不抢先迁 */
    (f.thoughts || []).forEach(t => { if ((t.orphan || t.archived) && takeInto(db, t, "瞳荧", THOUGHT_TTL, now)) dirty = true; });
  } catch {}
  return dirty;
}
module.exports = greenhouse;
module.exports.intake = intake;
module.exports._internal = { takeInto, GH_THRESHOLD };
async function greenhouse(req, res, u, json) {
  let p = u.pathname.replace(/\/+$/, ""); if (!p.startsWith("/api/")) p = "/api" + p;
  const now = Date.now(); const db = load();
  if (p === "/api/greenhouse/state" && req.method === "GET") {
    if (sweepForest(db, now)) save(db);
    const items = db.items.slice().sort((a, b) =>
      ((b.status === "pending" ? 1 : 0) - (a.status === "pending" ? 1 : 0)) || (b.ts - a.ts));
    return json(res, 200, { now, counts: {
      pending: db.items.filter(i => i.status === "pending").length,
      rooted: db.items.filter(i => i.status === "rooted").length,
      cellar: db.items.filter(i => i.status === "cellar").length }, items });
  }
  if (p === "/api/greenhouse/add" && req.method === "POST") {
    const b = await readBody(req);
    const text = String(b.text || "").trim();
    if (text.length < MIN_LEN) return json(res, 422, { error: "太短了,骨骼温室要求至少 " + MIN_LEN + " 字,现在只有 " + text.length + " 字" });
    const it = { id: rid(), kind: "bone", title: String(b.title || text.slice(0, 18)).slice(0, 40),
      text, src: String(b.src || "manual"), ts: now, status: "pending", rings: 0 };
    db.items.push(it); save(db);
    return json(res, 200, { ok: true, item: it });
  }
  if (p === "/api/greenhouse/act" && req.method === "POST") {
    const b = await readBody(req);
    const it = db.items.find(x => x.id === b.id);
    if (!it) return json(res, 404, { error: "没有这块骨头" });
    if (b.act === "root") { it.status = "rooted"; it.rootedAt = now; }
    else if (b.act === "cellar") { it.status = "cellar"; it.cellarAt = now; }
    else if (b.act === "stars") {
      const v = parseInt(b.stars, 10);
      if (v >= 1 && v <= 5) { it.stars = v; it.starsAt = now; }
    }
    else if (b.act === "drop") {
      db.items = db.items.filter(x => x.id !== it.id);
      save(db);
      return json(res, 200, { ok: 1, dropped: it.id });
    }
    else if (b.act === "edit") {
      const _t = String(b.text || "").trim();
      /* 编辑同样守字数下限, 否则改一刀就能把已入库的骨头削成碎渣 */
      if (_t && _t.length < MIN_LEN) return json(res, 422, { error: "改完只有 " + _t.length + " 字,不能少于 " + MIN_LEN + " 字" });
      if (_t.length >= MIN_LEN) { it.text = _t; it.edited = true; }
      it.status = "rooted"; it.rootedAt = now; }
    else return json(res, 400, { error: "bad act" });
    save(db);
    return json(res, 200, { ok: true, item: it });
  }
  return json(res, 404, { error: "not found" });
}
