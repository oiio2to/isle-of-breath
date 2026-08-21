"use strict";
/* 纯函数与交接测试. 运行: npm test (node >= 18, 零依赖) */
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os"), fs = require("fs"), path = require("path");

process.env.ISLE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "isle-"));
const forest = require("../src/forest");
const greenhouse = require("../src/greenhouse");
const { bj, sleepInfo, baseScore, emoScore, sameTopic, thoughtView, dreamView, thoughtDeadline, prune, H, DAY } = forest._internal;

/* 北京时间某天某分钟 → epoch ms */
const at = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);

test("sleep window: a night belongs to the day it began", () => {
  const mon0300 = at(2026, 8, 24, 3, 0);          // 周一凌晨三点 → 属于周日晚
  const si = sleepInfo(mon0300);
  assert.equal(si.asleep, true);
  assert.equal(si.nightKey, "2026-08-23");
  const sat0100 = at(2026, 8, 22, 1, 0);          // 周六 01:00 → 周五晚, 周末档 02:00 才入睡
  assert.equal(sleepInfo(sat0100).asleep, false);
  assert.equal(sleepInfo(at(2026, 8, 22, 2, 30)).asleep, true);
  assert.equal(sleepInfo(at(2026, 8, 24, 9, 0)).asleep, false);  // 08:30 后白天
  assert.equal(bj(mon0300).key, "2026-08-24");
});

test("score: flags add up, capped at 0.75, model cannot self-rate", () => {
  assert.equal(baseScore({}, 0), 0);
  assert.equal(baseScore({ aboutOther: 1, novel: 1, hook: 1 }, 0.2), 0.75);
  assert.equal(baseScore({ aboutOther: 1, novel: 1, hook: 1 }, 0.2), baseScore({ aboutOther: 1, novel: 1, hook: 1 }, 0.9));
  assert.equal(baseScore({ aboutOther: 1 }, 0.15), 0.4);
});

test("emoScore: needs 3 samples, then thresholds at 10 / 15", () => {
  const db = { pulseLog: [] };
  assert.equal(emoScore(db, { joy: 50 }, "joy"), 0);   // 1 样本
  assert.equal(emoScore(db, { joy: 50 }, "joy"), 0);   // 2
  assert.equal(emoScore(db, { joy: 50 }, "joy"), 0);   // 3 → 够了, 但偏移 0
  assert.equal(emoScore(db, { joy: 62 }, "joy"), 0.15); // off 12
  assert.equal(emoScore(db, { joy: 80 }, "joy"), 0.2);  // off > 15
  assert.equal(emoScore(db, null, "joy"), 0);
});

test("sameTopic: two overlapping content bigrams, stopwords ignored", () => {
  assert.equal(sameTopic("想去看那个展览，周末去", "那个展览周末人多吗"), true);   // 展览 + 周末
  assert.equal(sameTopic("今天想去看那个展览", "展览的票已经买了"), false);        // 只有 展览 一个实词重合
  assert.equal(sameTopic("我们今天什么都没做", "我们明天什么都不做"), false);
  assert.equal(sameTopic("Helios demo blocked", "the helios demo again"), true);
});

test("decay is computed at read time and never mutates", () => {
  const t0 = Date.now();
  const t = { id: "a", text: "x", ts: t0, score: 0.75 };
  const v0 = thoughtView(t, t0, {});
  assert.equal(v0.cur, 0.75); assert.equal(v0.tier, "clear"); assert.equal(v0.poolOk, true);
  const v12 = thoughtView(t, t0 + 12 * H, {});           // 一个半衰期: 0.15 + 0.6*0.5
  assert.equal(v12.cur, 0.45);
  assert.equal(v12.poolOk, false);                        // 12h 窗口已关
  const v36 = thoughtView(t, t0 + 36 * H, {});
  assert.equal(v36.tier, "mist");                          // 0.15 + 0.6/8 = 0.225
  assert.equal(t.cur, undefined);                          // 原对象没被改
});

test("spoken / grouped thoughts get 72h half-life and 0.55 floor", () => {
  const t0 = Date.now();
  const t = { id: "b", text: "x", ts: t0, score: 0.75, discussed: true };
  const v = thoughtView(t, t0 + 72 * H, {});
  assert.equal(v.cur, 0.65);                               // 0.55 + 0.2*0.5
  const g = { k: { size: 3, unlocked: true } };
  const u = thoughtView({ id: "c", text: "x", ts: t0, score: 0.1, groupKey: "k" }, t0 + 200 * H, g);
  assert.equal(u.poolOk, true);                            // 解锁的组直进池, 不过门槛
});

test("dreams: pool at 0.55, struggle at 48-72h bypasses the threshold, fade from 60h", () => {
  const t0 = Date.now();
  const d = { id: "d", text: "x", ts: t0, score: 0.3 };
  assert.equal(dreamView(d, t0 + 1 * H).poolOk, false);
  const s = dreamView(d, t0 + 50 * H);
  assert.equal(s.struggle, true); assert.equal(s.poolOk, true);
  assert.equal(dreamView(d, t0 + 66 * H).fade, 0.5);
  assert.equal(dreamView({ ...d, spoken: true }, t0 + 66 * H).fade, 0);
  assert.equal(dreamView(d, t0 + 73 * H).poolOk, false);
});

test("handoff: an expiring dream with score >= 0.5 lands in the greenhouse before deletion", () => {
  const t0 = Date.now();
  const db = { dreams: [
      { id: "keep", type: "deep", text: "worth keeping", ts: t0 - 73 * H, score: 0.55 },
      { id: "drop", type: "float", text: "not worth it", ts: t0 - 73 * H, score: 0.3 },
      { id: "young", type: "float", text: "still alive", ts: t0 - 1 * H, score: 0.75 },
    ], thoughts: [], groups: {}, pulseLog: [] };
  prune(db, t0);
  assert.deepEqual(db.dreams.map(d => d.id), ["young"]);   // 两条到期的都被真删
  const gh = JSON.parse(fs.readFileSync(path.join(process.env.ISLE_DATA_DIR, "greenhouse", "greenhouse.json"), "utf8"));
  assert.deepEqual(gh.items.map(i => i.srcId), ["keep"]);  // 只有够格的那条迁过去
  assert.equal(gh.items[0].status, "pending");             // 而且是待浇水, 不是自动生根
  assert.equal(gh.items[0].src, "沉寐");
  prune({ dreams: [{ id: "keep", type: "deep", text: "worth keeping", ts: t0 - 73 * H, score: 0.55 }], thoughts: [], groups: {} }, t0);
  const gh2 = JSON.parse(fs.readFileSync(path.join(process.env.ISLE_DATA_DIR, "greenhouse", "greenhouse.json"), "utf8"));
  assert.equal(gh2.items.length, 1);                        // migrated 集合挡住重复迁入
});

test("orphan deadline follows the effective half-life; unlocked bypasses the score gate but not orphan", () => {
  const t0 = Date.now();
  const groups = { k: { size: 3, unlocked: false, startTs: t0 - 50 * H, lastTs: t0 } };
  const lone = { id: "l", text: "x", ts: t0 - 13 * H, score: 0.7 };
  const member = { id: "m", text: "x", ts: t0 - 13 * H, score: 0.7, groupKey: "k" };
  assert.equal(thoughtDeadline(lone, groups), 12 * H);
  assert.equal(thoughtDeadline(member, groups), 72 * H);
  const db = { dreams: [], thoughts: [lone, member], groups, pulseLog: [] };
  prune(db, t0);
  assert.equal(lone.orphan, true);            // 普通瞳荧 12h 落孤悬
  assert.equal(member.orphan, undefined);     // 成组的 72h 才落, 延寿是真的延
  /* 解锁只免分数门槛, 不免孤悬: 60h 的成员(未孤悬, 期限 72h)分数 0.2 也进池; 已孤悬的不进 */
  groups.k.unlocked = true;
  const low = { id: "o", text: "x", ts: t0 - 60 * H, score: 0.2, groupKey: "k" };
  assert.equal(thoughtView(low, t0, groups).poolOk, true);
  assert.equal(thoughtView({ ...low, orphan: true }, t0, groups).poolOk, false);
  /* 成组本身就是 boosted(底线 0.55), 所以没解锁也在池里; 拆掉组, 它就是一条 60h 的普通瞳荧, 早出窗口了 */
  assert.equal(thoughtView({ ...low, groupKey: null }, t0, groups).poolOk, false);
});

test("a starved group dies after staleDays even if it was unlocked", () => {
  const t0 = Date.now();
  const groups = { k: { size: 6, unlocked: true, startTs: t0 - 30 * DAY, lastTs: t0 - 8 * DAY } };
  const m = { id: "m", text: "x", ts: t0 - 8 * DAY, score: 0.3, groupKey: "k" };
  const db = { dreams: [], thoughts: [m], groups, pulseLog: [] };
  prune(db, t0);
  assert.equal(db.groups.k, undefined);
  assert.equal(m.archived, true);
});

test("archived thoughts are handed to the greenhouse on retirement, then purged after thoughtArchiveDays", () => {
  const t0 = Date.now();
  const ghFile = path.join(process.env.ISLE_DATA_DIR, "greenhouse", "greenhouse.json");
  const before = JSON.parse(fs.readFileSync(ghFile, "utf8")).items.length;
  const thoughts = [];
  for (let i = 0; i < 21; i++) thoughts.push({ id: "t" + i, text: "x" + i, ts: t0 - (30 - i) * H, score: i === 0 ? 0.6 : 0.3 });
  const db = { dreams: [], thoughts, groups: {}, pulseLog: [] };
  prune(db, t0);                                                   // 21 > cap 20 → 最旧的 t0 归档
  assert.equal(db.thoughts.filter(t => t.archived).map(t => t.id).join(), "t0");
  assert.equal(db.thoughts.find(t => t.id === "t0").archivedAt, t0);
  const after = JSON.parse(fs.readFileSync(ghFile, "utf8"));
  assert.equal(after.items.length, before + 1);                    // 够格(0.6)的那条进了温室
  assert.equal(after.items.at(-1).srcId, "t0");
  assert.equal(after.items.at(-1).status, "pending");
  prune(db, t0 + 31 * DAY);                                         // 30 天后真删
  assert.equal(db.thoughts.some(t => t.id === "t0"), false);
  assert.equal(JSON.parse(fs.readFileSync(ghFile, "utf8")).items.length, before + 1);  // 不会二次迁入
});

test("greenhouse: nothing moves from pending to rooted without an explicit act", () => {
  assert.equal(typeof greenhouse.intake, "function");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "greenhouse.js"), "utf8");
  const auto = /status\s*=\s*"rooted"/g;
  const hits = (src.match(auto) || []).length;
  assert.ok(hits >= 1);
  /* 每一处 rooted 赋值都必须在 /act 处理器里 (人工动作), 不在 intake/sweep 里 */
  const intakeBody = src.slice(src.indexOf("function takeInto"), src.indexOf("function sweepForest"));
  assert.equal(/rooted/.test(intakeBody), false);
});
