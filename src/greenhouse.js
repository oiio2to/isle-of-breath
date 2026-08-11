// 骨骼温室 · 文件存储后端 —— 蒸馏自动, 生根过手
// GET  /api/greenhouse/state          全部骨签/标本(待浇水优先)
// POST /api/greenhouse/add            {title,text,src}  蒸馏管道投递(daily/forest/manual)
// POST /api/greenhouse/act            {id, act:root|cellar|edit, text?}
const fs = require("fs"), path = require("path");
const DIR = path.join(__dirname, "data", "greenhouse");
const FILE = path.join(DIR, "greenhouse.json");
const H = 3600e3;
function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { items: [], migrated: [] }; } }
function save(d) { fs.mkdirSync(DIR, { recursive: true }); const t = FILE + ".tmp"; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, FILE); }
function rid() { return "gh" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function readBody(req) { return new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); }); }
/* 标本迁入: 森林里到期(寐川>72h/瞳荧>12h)且意义值>=0.5 的条目, 死前整卡迁来待浇水 */
function sweepForest(db, now) {
  let dirty = false;
  try {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "forest", "forest.json"), "utf8"));
    const mig = new Set(db.migrated || []);
    const take = (e, kind, ttl) => {
      if (mig.has(e.id) || (e.score || 0) < 0.5 || now - e.ts < ttl) return;
      db.items.push({ id: rid(), srcId: e.id, kind: "specimen", title: (e.text || "").slice(0, 18),
        text: e.text || "", src: kind, paper: e.paper || null, spoken: !!e.spoken, ts: e.ts,
        migratedAt: now, status: "pending", rings: e.spoken ? 1 : 0 });
      mig.add(e.id); dirty = true;
    };
    (f.dreams || []).forEach(d => take(d, d.type === "deep" ? "沉寐" : "浮寐", 72 * H));
    (f.thoughts || []).forEach(t => take(t, "瞳荧", 12 * H));
    db.migrated = [...mig];
  } catch {}
  return dirty;
}
module.exports = async function (req, res, u, json) {
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
    if (text.length < 10) return json(res, 422, { error: "太短了" });
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
    else if (b.act === "edit") { if (String(b.text || "").trim().length >= 10) { it.text = String(b.text).trim(); it.edited = true; } it.status = "rooted"; it.rootedAt = now; }
    else return json(res, 400, { error: "bad act" });
    save(db);
    return json(res, 200, { ok: true, item: it });
  }
  return json(res, 404, { error: "not found" });
};
