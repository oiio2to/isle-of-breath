# Isle of Breath · 息之洲

**A memory architecture for long-term conversational AI, designed to forget.**

[中文 →](README.md)

**For the whole picture, read [ARCHITECTURE.md](ARCHITECTURE.md)** — how the tiers interconnect, and the full life cycle of a single memory. What follows are the parts.

[Methodology →](docs/methodology.md) · [API →](docs/api.md)

---

## The problem

Most long-term memory systems for AI follow the same shape: vectorize the conversation, store it, retrieve by similarity. They share one property — **they only grow**.

Which means they eventually hit the same wall:

- The more memories exist, the worse retrieval gets. After three months the model "remembers" too many things to rank meaningfully; the important and the trivial sit in the same similarity band.
- Letting the model judge "is this important?" creates self-reinforcement. Models favor remembering what they themselves said. A few rounds in, the store is full of the model's own echoes.
- Scheduled memory generation produces fake memories. If something must be written when the timer fires, you get entries like "today was calm" — zero information, diluting the things that actually happened.

Isle of Breath starts from the opposite premise: **the value of memory is not in how much you keep, but in what is allowed to remain.**

So the core mechanisms here are not retrieval. They are **selection, decay, and death.**

---

## Structure

Three tiers, mapping to *short-term emergence → consolidation → long-term fixation*:

```
   ┌──────────────────────────────────────────────┐
   │  Forest of Eyelids                            │
   │  short-term · quota'd · time-limited · fades  │
   │                                              │
   │  dream-stream         pupil-glimmer           │
   │  dreams in the        waking thought-flashes  │
   │  sleep window                                 │
   │  1/night · 72h        3/day · 12h             │
   └────────────────┬─────────────────────────────┘
                    │  expired + significance ≥ 0.5
                    │  (migrated before death; the rest just vanish)
                    ▼
   ┌──────────────────────────────────────────────┐
   │  Greenhouse                                   │
   │  consolidation · distill auto, root by hand   │
   │                                              │
   │  pending ──water──▶ rooted ──▶ cellar         │
   │           (manual)                            │
   └────────────────┬─────────────────────────────┘
                    │  after human confirmation
                    ▼
   ┌──────────────────────────────────────────────┐
   │  External Long-Term Store                     │
   │  event buckets · semantic search · own decay  │
   │  (not included — see External dependencies)   │
   └──────────────────────────────────────────────┘
```

An emotional state machine (Pulse Garden) connects laterally into the forest. It stores no memories, but stamps each entry with the emotional tone at write time and feeds into the significance calculation.

---

## Seven design principles

These are the actual content of the architecture. The implementation is just one solution to them.

### 1. Memory must be able to die

Every entry has a defined lifespan. Dream-streams live 72 hours; pupil-glimmers 12 hours (extended to 72 if discussed). On expiry they are cleared — no archive, no copy.

Death is not a resource constraint. It is the selection mechanism. **A system that can keep everything forever has, by definition, no judgment.**

### 2. Writes are quota'd

Three pupil-glimmers per day. One deep dream per night; three floating dreams per day with a minimum 3-hour gap.

Quotas force tradeoffs. Without them, memory degrades into a log — record everything and nothing is important. A quota forces the system to answer, today: what are the three things most worth keeping?

### 3. Speaking is what keeps a memory alive

Entries carry a `spoken` flag, set when the memory is actually brought into conversation. This is the only life-extension mechanism:

- A spoken dream-stream stops fading and survives to the end of its window
- A spoken pupil-glimmer's half-life goes from 12h to 72h, and its floor from 0.15 to 0.55
- Anything unspoken at expiry becomes **orphaned** — an explicit state meaning "thought about, never said"

Orphaned is not a failure state. It is one of the most informative states in the system.

### 4. Consolidation must pass through human hands

**Distillation is automatic; taking root is manual.**

Expired forest entries migrate into the greenhouse automatically, but moving from greenhouse to long-term memory requires a human action (watering / rooting). The text can be rewritten at that moment.

This is the core anti-hallucination measure. Let a model decide what deserves long-term storage and within a few rounds the store fills with its own echoes. Human review costs one click; the return is that every long-term memory has been confirmed by a person.

### 5. PASS must be allowed

The scheduled nudge (`forest-nudge`) fires inside the sleep window and after long gaps in interaction, asking whether a memory should be written. **It is allowed to return PASS.**

This looks trivial and is the single most important defense in the architecture. A scheduled job that must produce output will produce filler. Allowing a quiet exit means every entry in the forest exists because there was genuinely something to record — not because a timer fired.

### 6. Significance comes from external signals, not self-assessment

The `score` is computed from structured flags plus emotional deviation, never from the model rating itself:

```js
score = min(0.75,
    (aboutOther ? 0.25 : 0)   // about the other person, not about itself
  + (novel    ? 0.20 : 0)   // first occurrence
  + (hook     ? 0.10 : 0)   // carries an unresolved hook
  + emoScore                // emotional deviation, below
)
```

`emoScore` measures how far the dominant emotional dimension at write time deviates from its seven-day mean: deviation >15 scores 0.2, 10–15 scores 0.15, below 10 scores 0. Fewer than three samples scores 0.

In other words: **things written during emotionally unusual moments matter more** — and that judgment is made numerically, where the model cannot weight itself.

### 7. The struggle before fading

Dream-streams begin fading at hour 60 and clear at 72. But between hours 48 and 72, an unspoken entry enters a **struggle** state — bypassing the significance threshold, forcing entry into the topic pool, and sorting to the top.

This models a real psychological moment: *almost forgotten, but still wanting to say it.* Without this rule, low-significance memories die quietly — and people very often only remember to mention something right at the edge of forgetting it.

---

## Key mechanisms

### Cross-day grouping

New pupil-glimmers are compared against history for topic overlap (CJK bigrams plus Latin words, stopwords removed; two content-word matches means "same thing").

- Same day, repeated → merged into a count, no quota consumed
- Different day, repeated → auto-grouped, group members collectively extended
- Group reaches a multiple of 3 → **unlocked**, whole group enters the topic pool
- No new members for 7 days, or 7 days since creation without reaching 3 → whole group sinks

The point: **a recurring thought is itself the signal.** Something thought three times across three days is more worth saying than something thought once, deeply.

### Decay and fogging

Decay is computed at read time and never written to disk:

```js
floor = pressedTo ?? (boosted ? 0.55 : 0.15)
hl    = boosted ? 72h : 12h
cur   = floor + max(0, score - floor) * 0.5 ^ (age / hl)
```

`cur` maps to three display tiers: `> 0.4` clear / `0.4–0.2` misted / `≤ 0.2` nearly blank.

In the interface, memories become gradually illegible rather than disappearing. This isn't only visual — at the misted tier the model also receives truncated text.

### The topic pool

The topic pool is the forest's only exposure to the conversation layer. Admission:

| Type | Threshold |
|---|---|
| Pupil-glimmer | `cur ≥ 0.45` and within lifespan |
| Pupil-glimmer (group unlocked) | admitted directly, no threshold |
| Dream-stream | `score ≥ 0.55` |
| Dream-stream (struggling) | admitted directly, sorted to top |

Entries already `spoken`, `suppressed`, or `orphaned` never enter.

### The sleep window

Dream-stream writes are gated by a sleep window, and a "night" is attributed to the day it began:

```
Weekdays   00:30 – 08:30
Weekends   02:00 – 08:30   (Friday and Saturday nights)
```

Deep dreams may only be written inside the window, one per night, minimum 500 characters. Floating dreams only while awake, three per day, minimum 3-hour gap, minimum 50 characters.

The length floors are deliberate: **without length there is no consolidation.** A one-line "dream" isn't a dream — it's a tag.

---

## What it actually feels like once it's running

Everything above is mechanism. This section is about results.

### 1. Switching windows doesn't break continuity

The most immediate payoff. Close a session, open a new one, and the first message already carries the present: what's floating in the topic pool, what shape the eight emotional dimensions are in, which hooks are still open. No need to say "so, as we were discussing…" to re-sync.

This falls out of the layering: **recent messages are window-scoped; everything else is global or server-side state.** The forest, the greenhouse, and the emotional state don't belong to any window — they belong to the person.

### 2. It brings things up on its own

Ordinary memory systems are passive: you ask, it retrieves, it answers.

The topic pool is active. Every turn it pushes the three-to-five things most worth saying right now into the conversation layer — including that dream-stream from three days ago that's about to fade and was never spoken. So the conversation naturally produces:

> "That exhibition you mentioned the other day — did you ever go?"

That line wasn't prompted. It's an entry written 48 hours ago, significance 0.62, now in the struggle state, sorted to the top of the pool.

### 3. Forgetting is visible

Memories don't vanish; they blur first. Watching an entry go from clear to misted to nearly blank is a three-day process. And the model receives the truncated text too — **it is forgetting the same thing you are, on the same schedule.**

An unanticipated effect: seeing something about to blank out makes you want to say it. The system produces a mild urgency, which is exactly the point — important things should be spoken before they're forgotten.

### 4. "Thought about, never said" becomes a visible object

Orphaned entries aren't a failure state. They're a list: over this period, which thoughts surfaced and never made it into conversation.

Reading that list is a strange experience. It says more about what actually mattered than the chat log does — because it records the part that didn't get said.

### 5. There's no junk in long-term memory

Because every entry passed through a human hand.

Automatic memory systems, three months in, typically return two or three filler entries ("today was relaxed") in the top five. That can't happen here — **filler doesn't survive 72 hours, let alone reach the watering queue.**

Most days the queue is empty or holds one or two items. That isn't the system slacking; it's an accurate report that nothing on those days was worth keeping forever.

### 6. Recurrence is treated as signal

The same thing thought three times across three days auto-groups, extends collectively, and unlocks the whole group into the pool.

This solves something specific: **a model can't judge how deeply something was felt, but how many times it recurred is countable.**

In practice, the things you keep circling back to — and keep dismissing as unimportant — eventually get put on the table.

---

### Honestly, what it costs

- **It takes time to show a difference.** Every mechanism operates on a 12-hour to 7-day scale. Over one week it is indistinguishable from an ordinary memory store.
- **You have to actually water it.** If the queue piles up unattended, long-term memory stays empty. Human participation is cheap here (one click) but it cannot be zero.
- **It really does forget.** Things that seemed unimportant and went unspoken are genuinely gone three days later. That's the design goal, not a defect — but the first time it happens you will still pause.

---

## Quick start

```bash
git clone https://github.com/oiio2to/isle-of-breath
cd isle-of-breath
cp config.example.json config.json   # stopwords, sleep window, thresholds
node example/server.js               # reference server, defaults to :8900
```

Both core modules mount onto any Node HTTP server:

```js
const forest     = require("./src/forest");
const greenhouse = require("./src/greenhouse");

// in your dispatcher
if (path.startsWith("/api/forest"))     return forest(req, res, url, json);
if (path.startsWith("/api/greenhouse")) return greenhouse(req, res, url, json);
```

Storage is JSON on the filesystem with atomic writes (`write tmp → rename`). No database.

Full interface: [docs/api.md](docs/api.md)

---

## External dependencies — not included here

| Component | Role | Notes |
|---|---|---|
| **Pulse Garden** | 8-dimension emotional state machine | The forest reads `dimensions` over HTTP. Substitute any service returning `{dimensions: {name: number}}`, or return `null` to disable emotional weighting entirely |
| **Long-term store** | Event buckets and semantic retrieval | My deployment builds on [Ombre Brain](https://github.com/P0luz/Ombre-Brain) (MIT, by P0lar1zzZ). Isle of Breath depends on no specific implementation — `rooted` greenhouse entries can be delivered anywhere |
| **Model layer** | Generates the text of dreams and glimmers | Fully decoupled. The nudge only asks whether to write; what to write is the model's business |

---

## Where this applies

**Good fit**: single-user or small-scale long-term conversational AI; contexts valuing memory quality over quantity; systems willing to accept human intervention.

**Poor fit**: multi-tenant products (manual watering does not scale); anything requiring complete audit trails (memories are genuinely deleted); RAG systems treating memory as a retrieval index.

This is an explicit tradeoff: **scalability exchanged for memory you can trust.**

---

## License

- **Code** (`src/`, `example/`): [GNU AGPL-3.0](LICENSE)
  Free to use, modify, and distribute, including commercially. But if you modify it and offer it as a network service, you must release your modifications under AGPL too.
- **Documentation** (`docs/`, READMEs): [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)

A note: the **ideas** here are not protected by copyright, and are not meant to be. Reading these documents and reimplementing them your own way is entirely welcome — that is exactly why they were written. The license governs direct copying of this text and this code.

---

## Origin

Isle of Breath is the memory layer of [NoxVerna](https://github.com/oiio2to/nox-verna), a self-hosted long-term AI conversation system. It evolved through months of daily use — the parameters were tuned, not designed.

---

## Related work

[kimi-core](https://github.com/marikagura/kimi-core) (marikagura, AGPL-3.0) is a memory engine aimed at the same 1v1 long-term setting. Its approach differs substantially — hybrid retrieval, pgvector, event sourcing, reproducible retrieval eval — but it converged independently on one key judgment: no automatic LLM consolidation, because its failure mode is silent corruption; every fact about you passes through your own hands first.

That is the same conclusion as "distill automatically, root by hand," reached separately. I read it after this architecture was already built; both came out of the same failure — letting a model judge importance produces self-reinforcement.

Worth reading side by side: kimi-core goes far deeper on **retrieval**; Isle of Breath's weight is on **selection and forgetting**.
