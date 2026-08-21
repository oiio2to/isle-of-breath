"use strict";
/* 配置加载: 代码里只保留默认值, 任何一项都能被 config.json 覆盖.
 * 查找顺序: ISLE_CONFIG 环境变量 → 同目录 isle.config.json → 上一级 config.json.
 * 找不到就用默认值跑, 不报错 —— 参考实现必须开箱即用. */
const fs = require("fs"), path = require("path");

const DEFAULTS = {
  timezoneOffsetHours: 8,
  sleepWindow: { weekdayStartMin: 30, weekendStartMin: 120, wakeMin: 510, weekendNights: [5, 6] },
  quotas: { deepPerNight: 1, floatPerDay: 3, floatMinGapHours: 3, thoughtPerDay: 3, thoughtActiveCap: 20, deepMinChars: 500, floatMinChars: 50 },
  lifespan: { dreamHours: 72, dreamFadeStartHours: 60, struggleFromHours: 48, thoughtHalfLifeHours: 12, boostedHalfLifeHours: 72, thoughtFloor: 0.15, boostedFloor: 0.55, scoreCap: 0.75, thoughtArchiveDays: 30 },
  scoring: { aboutOther: 0.25, novel: 0.2, hook: 0.1, emoDeviationHigh: 15, emoDeviationLow: 10, emoScoreHigh: 0.2, emoScoreLow: 0.15, emoMinSamples: 3, emoWindowDays: 7 },
  pool: { thoughtThreshold: 0.45, dreamThreshold: 0.55, greenhouseThreshold: 0.5 },
  grouping: { unlockEvery: 3, staleDays: 7, minOverlapGrams: 2 },
  fog: { clearAbove: 0.4, mistAbove: 0.2 },
  greenhouse: { minBoneChars: 600 },
  pulse: { url: "http://127.0.0.1:8804/state" },
  stopwords: ["我们","你们","他们","什么","这个","那个","一个","没有","不是","就是","还是","但是","因为","所以","如果","可以","已经","自己","今天","昨天","明天","现在","时候","不会","知道","觉得","有点","一下","她说","他说","你说","我说","她的","他的","我的","你的","想起","忽然","突然","刚才","然后","回来","第一","说的","一直","起来","出来","那种","这种","有没有","是不是","为什么"]
};

function findFile() {
  const cands = [process.env.ISLE_CONFIG, path.join(__dirname, "isle.config.json"), path.join(__dirname, "..", "config.json")].filter(Boolean);
  for (const f of cands) { try { if (fs.statSync(f).isFile()) return f; } catch {} }
  return null;
}
function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over === undefined ? base : over;
  const out = Object.assign({}, base);
  for (const k of Object.keys(over)) { if (k.startsWith("_")) continue; out[k] = (base && typeof base[k] === "object" && !Array.isArray(base[k])) ? merge(base[k], over[k]) : over[k]; }
  return out;
}
let cfg = DEFAULTS, file = findFile();
if (file) { try { cfg = merge(DEFAULTS, JSON.parse(fs.readFileSync(file, "utf8"))); } catch (e) { console.error("[isle] bad config " + file + ": " + e.message + " — using defaults"); } }
if (process.env.PULSE_URL) cfg.pulse = Object.assign({}, cfg.pulse, { url: process.env.PULSE_URL });

module.exports = cfg;
module.exports._file = file;
module.exports._defaults = DEFAULTS;
