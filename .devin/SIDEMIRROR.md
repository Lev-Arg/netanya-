# SIDEMIRROR — Netanya Pharmacy & Retail Platform

Standing reference for this repo. Modeled on `~/.config/devin/SIDEMIRROR.md`.
Consult before ANY code change. If anything here conflicts with memory or
convenience, this file wins.

## 1. The bar: "best secure" — nothing below

- **Latest stable wins.** Current stable versions of Node, React, Express, Vite,
  `node:sqlite`, `ws`, etc. Verify versions/APIs against official sources
  (npm registry, nodejs.org docs, MDN) — never memory.
- **Current docs over memory.** For auth, crypto, PHI handling, payments, or
  compliance work: pull @latest official docs first.
- **Own hardened version.** Where off-the-shelf patterns are weak, design the
  stronger control: fail-closed defaults, server-authoritative decisions,
  session-bound tokens, minimum-exposure fields.
- **Harden, don't accept defaults.** Platform defaults are evaluated, not
  finished answers.

## 2. Controls are never weakened — not even temporarily

- NEVER disable, comment out, bypass, stub, or loosen a security control "just
  to test", "just to make it pass", or "temporarily".
- NEVER add bypass flags, skip checks, swallow errors, or relax
  validators/ownership/rate-limits to get green builds.
- If a control blocks progress: fix the ROOT CAUSE or stop and escalate.
- No "TODO: re-enable later" on security code.

## 3. Security & privacy designed in, evaluated for abuse

Ask for every feature: who can call it, what they can see, what they can
change, replay/timeout/race/duplicate behavior.

- Authorization server-side, fail-closed, default deny. Every route goes
  through `requireAuth`/`requireRole` plus object-level ownership checks.
- **NO sensitive info to the browser, under any circumstance.** PHI stays
  AES-256-GCM encrypted at rest (`patients_phi`), decrypted only server-side.
  Expose minimum derived values only — never raw PHI records, password hashes,
  other users' data, internal ledger detail.
- Secrets/keys/env never reach client, logs, commits, or chat.
- Privileged mutations audited via `writeAuditLog` (the canonical audit path).
- Rate-limit and lock out abuse paths; public surfaces (`/api/public/*`,
  `/api/auth/*`) get strictest validation, bounding, and rate limits.
- Proven primitives only (AES-GCM, HMAC, scrypt, timingSafeEqual). Never
  invent crypto.
- Claim adjudication (`server/claimEngine.ts`) is safety-relevant: changes
  require careful review of override codes and rejection semantics.

## 4. Project conventions

- Backend: `server.ts` (Express + `ws` + `node:http`), modules in `server/`
  (`db.ts`, `security.ts`, `claimEngine.ts`).
- Frontend: React 19 + Vite + Tailwind 4, components in `src/components/`.
- DB: embedded SQLite via `node:sqlite` `DatabaseSync`; all queries use
  prepared statements with `?` bindings — keep it that way, no string-built SQL.
- Transactions via `runTx()` (`BEGIN IMMEDIATE` / COMMIT / ROLLBACK).
- Match existing code style; compact, no drive-by refactors or comment edits.

## 5. Discipline

- No speculation — verify with tools before stating facts.
- No silent assumptions — ambiguous → focused clarifying question.
- Read before write — match existing conventions.
- One task at a time — finish and verify each step.
- No unrequested changes.
- No shortcuts — no skipped verification, no "should work".

## 6. Verification — evidence or it didn't happen

- After ANY code change run the project's real checks and report actual output:
  - Typecheck/lint: `npm run lint` (`tsc --noEmit`)
  - Build: `npm run build`
  - Dev smoke: `npm run dev` (tsx server.ts) — verify server boots and key
    endpoints respond.
- Never claim success without command output. On error: root cause first,
  no shotgun fixes.

## 7. Asset hygiene

- Every binary asset (images, fonts, PWA icons) MUST be metadata-cleaned before
  it ships: deep strip all EXIF/XMP/IPTC/PNG text chunks/C2PA/AI tags, then
  bake ONLY LEVELACE SENTINEL provenance (Artist/Author/Creator
  "LEVELACE SENTINEL", Copyright "Copyright (c) <current year> LEVELACE
  SENTINEL. All rights reserved.", Description → https://ilevelace.com).
- Verify with `exiftool` after cleaning; file must still decode.

## 8. Safety

- No destructive ops without explicit confirmation.
- No commits/pushes unless explicitly requested. Git stays untouched otherwise.
- `.env*` is gitignored; never print or commit secret values.
- Deployment-affecting commands: classify env, fresh explicit consent for prod.
