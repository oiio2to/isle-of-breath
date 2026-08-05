# CLAUDE.md

Context for AI coding assistants working in this repository.

## What this is

**Isle of Breath (息之洲)** — a layered memory architecture for long-term conversational AI, built around decay and forgetting rather than accumulation. Extracted from a private project ([NoxVerna](https://github.com/oiio2to/nox-verna)) and published on its own.

Two core modules, both plain CommonJS with no framework dependency:

```
src/forest.js       Forest of Eyelids — short-term layer (dreams + glimmers)
src/greenhouse.js   Greenhouse — consolidation layer (distill auto, root by hand)
```

Storage is JSON on the filesystem with atomic writes. There is no database and no ORM. Do not introduce one.

## Repository layout

```
README.md            中文主文档（source of truth）
README.en.md         English equivalent — keep in sync
CLAUDE.md            this file
LICENSE              GNU AGPL-3.0 (code)
NOTICE.md            dual-licensing statement, attribution
config.example.json  stopwords, sleep window, thresholds
src/
  forest.js          ~240 lines
  greenhouse.js      ~75 lines
example/
  server.js          minimal reference HTTP server
docs/
  methodology.md     the seven design principles, at length
  api.md             endpoint reference
```

## Domain vocabulary — use these consistently

| 中文 | English | Meaning |
|---|---|---|
| 息之洲 | Isle of Breath | the whole architecture |
| 眼睑森林 | Forest of Eyelids | short-term layer |
| 寐川 | dream-stream | sleep-window entry; `deep` (沉寐) or `float` (浮寐) |
| 瞳荧 | pupil-glimmer | waking thought-flash |
| 骨骼温室 | Greenhouse | consolidation layer |
| 话题池 | topic pool | the forest's only exposure to the conversation layer |
| 孤悬 | orphan | expired without being spoken |
| 泛白 | fade / blanching | visual decay in the final 12 hours |
| 挣扎 | struggle | hours 48–72, unspoken, force-admitted to the pool |
| 意义值 | significance score | `score`, computed from external flags, never self-rated |
| 生根 / 浇水 | root / water | the manual consolidation action |

Do not invent new names for these. If a concept needs a name it doesn't have, flag it rather than coining one silently.

## Invariants — changing these changes the architecture

These are not implementation details. If a change would break one, stop and say so.

1. **Entries expire and are deleted.** No archive, no soft-delete, no tombstone. `prune()` removes them.
2. **Writes are quota'd.** Daily and per-night caps are load-bearing, not configuration niceties.
3. **`spoken` is the only life-extension path.** Do not add other ways to boost longevity.
4. **Forest → long-term requires a human action.** Never add an automatic path from greenhouse `pending` to `rooted`.
5. **Significance is never self-rated by a model.** `score` comes from `aboutOther` / `novel` / `hook` flags plus `emoScore`. Do not add a "let the model score it" path.
6. **The nudge may PASS.** Any scheduled generator must be able to exit without writing.
7. **Decay is computed at read time.** `thoughtView` / `dreamView` never mutate and never write. Keep it that way — persisted decay makes the state unreproducible.

## Code conventions

- CommonJS (`require`), Node built-ins only. No dependencies in `src/`.
- Atomic writes everywhere: `write to .tmp → rename`. Never write in place.
- Handlers take `(req, res, url, json)` and return via the injected `json(res, status, body)`. This keeps the modules mountable on any dispatcher.
- Timestamps are epoch milliseconds. Timezone handling is isolated in `bj()` — the day-boundary function. If you need a different timezone, change `config.json`, not the call sites.
- Comments are in Chinese in the source. Keep them Chinese; do not translate them into English during unrelated edits.

## Before committing

**Nothing personal ships here.** This code was extracted from a private project. Specifically check that no diff contains:

- Real names, nicknames, or terms of address (the stopword list is a common leak path — it belongs in `config.json`, never hardcoded)
- Server addresses, ports of private services, or credentials
- Sample data, fixtures, or logs containing real conversation
- Persona text or journal content

Config values that were personal in the original (sleep window hours, stopwords, thresholds) must live in `config.example.json` with neutral defaults.

## Licensing

Code is AGPL-3.0; documentation is CC BY-NC-SA 4.0. If you add a file, it inherits by location: `src/` and `example/` are code, `docs/` and READMEs are documentation.

Do not add dependencies with incompatible licenses. Do not copy code in from the upstream Ombre Brain project (MIT) — it is a separate component referenced by URL, not vendored.
