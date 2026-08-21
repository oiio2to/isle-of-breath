# Isle of Breath · 息之洲

**A memory architecture for long-term conversational AI, designed to forget.**

[中文 →](README.md) · [Architecture →](ARCHITECTURE.md) · [Methodology →](docs/methodology.md) · [API →](docs/api.md) · [Roadmap →](ROADMAP.md)

*ARCHITECTURE.md and the docs are written in Chinese, with the formulas, tables and code in common. This README is a full English equivalent of the Chinese one.*

---

## 🌊 What it is

A two-stage **short-term → consolidation** memory pipeline for a single-user, long-running conversational AI, plus a clean boundary to whatever long-term store you use.
It does not do vector retrieval and it does not accumulate. What it does: **give every memory a lifespan, a write quota, a rule that only being spoken aloud extends life, and a final consolidation step that must pass through a human.**

Zero dependencies, Node 18+, two CommonJS modules, JSON-on-filesystem storage. Mount it on any HTTP dispatcher.

## 🌱 What it does (one concrete example)

Monday afternoon, the model has a thought during a conversation and writes it into the forest:

```
POST /api/forest/thought
{ "text": "They mentioned wanting to see that exhibition, but not when", "aboutOther": true, "novel": true, "hook": true }
```

| When | What happens |
|---|---|
| Mon 15:00 | Written. Score = 0.25 + 0.20 + 0.10 = **0.55** (plus 0.2 if the emotional state machine is >15 off its 7-day mean at this moment; capped at 0.75). Enters the topic pool. |
| Mon 23:00 | 8 h in, 12 h half-life, current value has decayed to 0.40 — the UI shows it half-fogged and the conversation layer receives truncated text. |
| Tue 03:00 | 12 h up. Not spoken → **orphaned**. Still visible, but out of the pool. |
| Tue 20:00 | The model writes "they brought up the exhibition twice today". Topic match → **cross-day grouping**. Both entries get a 72 h half-life and a 0.55 floor; Monday's orphan flag is lifted. |
| Wed 21:00 | A third entry on the same topic. Group hits 3 → **unlocked**; the group enters the pool as one item, near the top. |
| Wed 21:30 | It actually gets said in conversation: "That exhibition — did you pick a day?" → marked `spoken`. Dreams stop fading, thoughts get their extension, the group's unlock resets. |
| A week later | Pushed out of the 20-entry active cap → archived. Score ≥ 0.5, so at that moment the whole card **migrates to the greenhouse** as `pending`. |
| Any time | A human opens the greenhouse and clicks "water" → `rooted`. Only after that does it get delivered to long-term storage. Unclicked, it waits. "Drop", and it is gone. |

A thought that was never spoken and never recurred three times is orphaned after 12 h and hard-deleted 30 days after archiving. **There is no "keep everything forever" setting.**

---

## 🧱 The problem

Most long-term memory schemes for AI share one structure: vectorise the conversation, store it, retrieve by similarity. They share one property: **they only grow.**

So they all hit the same wall:

- The more is stored, the worse retrieval gets. After three months the model "remembers" too much to rank; the important and the trivial sit in the same similarity band.
- Letting the model decide "is this worth remembering?" self-reinforces. Models prefer to remember what they themselves said; a few cycles later the store is full of the model's own echo.
- Scheduled memory generation produces fake memories. Something has to be written when the timer fires, so "today was calm" gets written, diluting what actually happened.

Isle of Breath starts from the opposite premise: **the value of memory is not in how much is stored but in what is allowed to remain.**

So the central mechanism is not retrieval. It is **selection, decay, and death.**

---

## 🗺️ Structure

A three-layer pipeline: emergence → consolidation → long-term.

```
   ┌──────────────────────────────────────────────┐
   │  Forest of Eyelids 眼睑森林                   │
   │  short-term · quota'd · mortal · fades        │
   │                                              │
   │  dream-stream 寐川    pupil-glimmer 瞳荧      │
   │  dreams in sleep       waking thought-flashes │
   │  1 / night · 72h       3 / day · 12h          │
   └────────────────┬─────────────────────────────┘
                    │  on exit, score ≥ 0.5
                    │  (migrated before death; the rest vanish)
                    ▼
   ┌──────────────────────────────────────────────┐
   │  Greenhouse 骨骼温室                          │
   │  consolidation · distil automatically,       │
   │                  root by hand                 │
   │  pending ──water──▶ rooted ──▶ cellar         │
   │           (human)                             │
   └────────────────┬─────────────────────────────┘
                    │  after human confirmation
                    ▼
   ┌──────────────────────────────────────────────┐
   │  External long-term store                    │
   │  event buckets · semantic search · own decay │
   │  (not part of this project)                  │
   └──────────────────────────────────────────────┘
```

An emotional state machine (Pulse Garden) plugs in sideways: it stores no memories, but stamps each entry with the emotional tone at write time and contributes to the significance score.

One sentence for the division of labour: **the forest decides what is worth recalling, the greenhouse decides what is worth remembering, the long-term layer makes sure what is remembered can still be found.**

---

## 📜 Seven design principles

These are the real content. The implementation is one concrete answer to them.

### 1. 🍂 Memories must die

Every entry has an explicit lifespan. Dreams: 72 h, then deleted — no archive, no copy. Thoughts: orphaned at 12 h, hard-deleted 30 days after archiving.

Death is not a resource limit. It is the selection mechanism. **A system that can keep everything has no judgement.**

### 2. 🎚️ Writes are quota'd

Thoughts: 3 per day. Deep dreams: 1 per night. Floating dreams: 3 per day, ≥3 h apart.

Quotas force choice. Without them memory degrades into a log — recording everything means nothing matters. The quota makes the system answer, every day: what are the three things most worth keeping?

### 3. 💬 Only what is spoken survives

Entries carry a `spoken` flag, set when the memory is actually used in conversation. It is the only life-extension path:

- A spoken dream stops fading and stays past its clearing window
- A spoken thought's half-life goes 12 h → 72 h, its floor 0.15 → 0.55
- Anything unspoken at its deadline becomes **orphaned** — an explicit state meaning "thought about, never said"

Orphaned is not failure. It is one of the most informative states in the system.

### 4. 🫴 Consolidation passes through a human

**Distil automatically, root by hand.**

Entries leaving the forest migrate to the greenhouse on their own, but moving from greenhouse to long-term memory takes a human action (water / root). The human can rewrite the text at that moment.

This is the core anti-hallucination measure. Let the model decide what deserves long-term memory and the store fills with its own echo. The human step costs one click; the return is that every long-term entry was confirmed by a real person.

### 5. 🌙 PASS is allowed

A scheduled nudge fires during the sleep window and after long idle periods, asking whether a memory should be written. **It accepts PASS as an answer.**

This looks trivial and is the single most important defence in the architecture. A scheduled task that must produce output will produce filler. Allowing a quiet exit means every forest entry exists because there was something to remember, not because a timer fired.

### 6. 📡 Significance comes from external signals, not self-assessment

```js
score = min(0.75,
    (aboutOther ? 0.25 : 0)   // about the other person, not about itself
  + (novel    ? 0.20 : 0)   // first occurrence
  + (hook     ? 0.10 : 0)   // an unresolved thread
  + emoScore                // emotional deviation, below
)
```

`emoScore` is the deviation of the dominant emotional dimension from its 7-day mean at write time: >15 → 0.2, 10–15 → 0.15, <10 → 0. Fewer than three samples → 0.

The three flags are still filled by the writer (the model), but they are **factual questions** (is this about the other person? is it the first time?), not value judgements (is it important?). `emoScore` is the one input the model cannot touch: **what is written in an emotionally unusual moment matters more**, and that call is made by an external state machine.

### 7. 🕯️ The struggle before fading

Dreams start fading at hour 60 and clear at 72. Between hours 48 and 72, an unspoken dream enters **struggle**: it bypasses the score threshold, forces its way into the pool, and sorts to the top.

It models "almost forgotten, but still want to say it". Without it, low-score memories die quietly — and people often only remember to mention something at the edge of forgetting it.

---

## ⚙️ Key mechanisms

### Cross-day grouping

A new thought is topic-matched against active history (CJK bigrams + Latin words, stopwords removed; two content grams in common = same topic).

- Same day → merged, count incremented, **no quota consumed**
- Different day → grouped; the group gets the 72 h half-life and 0.55 floor, and orphan flags on members still within 72 h are lifted
- Every multiple of 3 → **unlocked**: members skip the score gate; **one seat per group** in the pool (newest entry, with `groupSize`)
- Starved for 7 days (unlocked or not), or 7 days old without ever unlocking → the whole group sinks

The point: **recurrence is itself a signal.** Thinking about something three times in three days says more than thinking about it once, deeply.

The cost is just as clear: bigram overlap is a crude similarity. High-frequency collocations the stopword list misses ("she said", "suddenly remembered") chain unrelated entries into one big group. That is not hypothetical — it happened in production; see [Methodology · §7](docs/methodology.md#七审计记录).

### Decay and fog

Decay is computed at read time and never persisted:

```js
floor = pressedTo ?? (boosted ? 0.55 : 0.15)
hl    = boosted ? 72h : 12h
cur   = floor + max(0, score - floor) * 0.5 ^ (age / hl)
```

`cur` maps to three tiers: `> 0.4` clear / `0.4–0.2` mist / `≤ 0.2` white. Memories fade rather than vanish — and in the mist tier the model also receives truncated text.

### Topic pool

The forest's only exposure to the conversation layer.

| Kind | Admission |
|---|---|
| Thought | `cur ≥ 0.45`, within its effective half-life, not orphaned |
| Thought (unlocked group) | score gate waived; still not orphaned; one seat per group |
| Dream | `score ≥ 0.55` |
| Dream (struggle) | admitted, sorted first |

`spoken`, `suppressed` and `orphan` entries never enter.

### Sleep window

Dream writes are bound to a sleep window, and "a night" belongs to the day it began:

```
weekdays  00:30 – 08:30
weekends  02:00 – 08:30   (Friday and Saturday nights)
```

Deep dreams only inside the window, one per night, ≥500 characters. Floating dreams only while awake, 3 per day, ≥3 h apart, ≥50 characters. The minimums are deliberate: **no length, no consolidation.** A one-line "dream" is a label.

### Two exits, two endings

| | dream | thought |
|---|---|---|
| Lifespan | 72 h, then **deleted** | **orphaned** after 12 h (72 h if grouped / spoken), still visible |
| Last leg | struggle at 48–72 h | pushed out of the 20-entry cap, or its group dies → archived |
| Greenhouse hand-off | the moment before deletion | the moment of archiving |
| Condition | `score ≥ 0.5`, not migrated before | same |
| Gone for good | 72 h | 30 days after archiving |

Both happen inside `prune()`, which runs before every request; the greenhouse's own `sweep` is only a safety net.

---

## 🔭 What actually happens once it is installed

1. **Switching windows does not break continuity.** A new session opens with the present already in place: what is floating in the pool, the shape of the emotional state, which hooks are open. Recent messages belong to a window; everything else is server-side state that belongs to the person.
2. **It brings things up on its own.** The pool is active, not passive. It pushes "the three to five things most worth saying now" into the conversation layer — including the dream from three days ago that is about to fade. "You mentioned that exhibition the other day — what happened?" was never asked for; it was a 48-hour-old, 0.62-score entry in struggle, sorted first.
3. **Forgetting is visible.** A thought goes clear → mist → white over three days, and the model receives the same truncation. It forgets in sync with you. Side effect: seeing something about to fade makes you want to say it now.
4. **"Thought about but never said" becomes a thing you can look at.** The orphan list says more about a stretch of time than the chat log does.
5. **There is no junk in long-term memory.** Filler does not survive 72 hours, let alone reach the watering queue. Most days the queue is empty or has one or two items. That is not laziness — nothing happened that deserved permanence.
6. **Recurring thoughts get treated as signal.** How deeply something was thought about, a model cannot judge; how many times, it can count.

---

## ⚖️ What it costs, honestly

- **It takes time to show a difference.** Everything operates on 12-hour-to-7-day scales. For a week it is indistinguishable from a plain memory store.
- **You have to water.** Ignore the queue and long-term memory stays empty. Low participation cost, but not zero.
- **It really forgets.** Things that felt unimportant and went unsaid are not there three days later. That is the design goal, not a defect — but it gives you pause the first time.
- **Topic matching is crude.** Bigram overlap over-groups on a corpus where every entry is about the same person. The stopword list has to be maintained for your own corpus.
- **Single-writer assumption.** File storage with whole-file read/write; concurrent writes overwrite. Fine for one user, breaks immediately for many.

---

## 🚀 Quick start

```bash
git clone https://github.com/oiio2to/isle-of-breath
cd isle-of-breath
cp config.example.json config.json   # stopwords, sleep window, thresholds — optional, built-in defaults work
npm test                             # 12 pure-function and hand-off tests, zero deps
node example/server.js               # reference server on :8080
curl localhost:8080/api/forest/state
```

Both modules mount on any Node HTTP dispatcher:

```js
const forest     = require("./src/forest");
const greenhouse = require("./src/greenhouse");

if (path.startsWith("/api/forest"))     return forest(req, res, url, json);
if (path.startsWith("/api/greenhouse")) return greenhouse(req, res, url, json);
```

Storage is JSON on the filesystem with atomic writes (`write tmp → rename`). No database. Data lives in `src/data/` by default; override with `ISLE_DATA_DIR`.

Full endpoint reference: [docs/api.md](docs/api.md)

---

## 📁 Repository layout

```
README.md / README.en.md   why it is designed this way (zh / en)
ARCHITECTURE.md            how the three layers connect; the full lifecycle of one entry
ROADMAP.md                 what is next and why it is not done yet
CLAUDE.md                  constraints for AI coding assistants: vocabulary, invariants, scrub checklist
docs/methodology.md        what failed behind each rule; how parameters were tuned; audit log
docs/api.md                endpoint reference
config.example.json        every tunable, commented
src/config.js              defaults ← config.json ← env
src/forest.js              forest: writes, quotas, grouping, decay, pool, exit hand-off (~290 lines)
src/greenhouse.js          greenhouse: intake, root, cellar, stars, drop (~100 lines)
example/server.js          minimal reference server
test/forest.test.js        node:test — sleep window, scoring, decay, grouping, orphan, hand-off, human gate
```

---

## 🔌 External dependencies · not included

| Component | Role | Notes |
|---|---|---|
| **Pulse Garden** | 8-dimension emotional state machine | The forest reads `dimensions` over HTTP. Replace with anything returning `{dimensions: {name: number}}`, or set `pulse.url` to `null` to disable emotional weighting |
| **Long-term store** | event-bucket storage and semantic retrieval | My deployment uses [Ombre Brain](https://github.com/P0luz/Ombre-Brain) (MIT, by P0lar1zzZ). Isle of Breath does not depend on it; deliver `rooted` entries anywhere |
| **Model layer** | writes dream and thought text | Decoupled. The nudge only asks "should something be written?"; what gets written is the model's call |

---

## 🧭 Where it fits

**Good for:** single-user or small-scale long-running conversational AI; settings that value memory quality over quantity; systems that accept a human in the loop.

**Not for:** multi-tenant products (manual watering does not scale); anything needing full audit trails (memories really are deleted); RAG systems that treat memory as a retrieval index.

The trade is explicit: **scalability for trustworthiness.**

---

## 📄 License

- **Code** (`src/`, `example/`): [GNU AGPL-3.0](LICENSE). Use, modify, distribute, commercially included. If you modify it and serve it over a network, publish your changes under AGPL too.
- **Documentation** (`docs/`, READMEs): [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).

The ideas here are not protected and are not meant to be. Reimplementing them your own way is exactly what this document is for. The license covers copying this text and this code.

---

## 🏡 Origin

Isle of Breath is the memory layer of [NoxVerna](https://github.com/oiio2to/nox-verna), a self-hosted long-term AI conversation system. It evolved through months of daily use — the parameters were tuned, not designed.

---

## 🤝 Related work

[kimi-core](https://github.com/marikagura/kimi-core) (marikagura, AGPL-3.0) is another memory engine for one-to-one long-term relationships. Its route is different — hybrid retrieval, pgvector, event sourcing, reproducible retrieval evals — but it converged independently on the same key judgement:

> No LLM auto-consolidation (its failure mode is silent corruption). Every fact about you passes through your own hands and gets your confirmation.

That is "distil automatically, root by hand" in other words. I read it after this architecture was written; both sides walked out of the same failure — letting the model rate importance leads to self-reinforcement.

Worth reading side by side: kimi-core goes much deeper on **retrieval**; Isle of Breath's weight is on **selection and forgetting**.
