# Competition-Day Checklist — Coding Challenge 2026

Print or keep open. Tick each item; do not skip the backup steps.

## Before the competition

- [ ] Competition database reachable — `GET /api/public/health` returns `{"status":"ok","database":"ok"}`
- [ ] Application published and the public URL opens the student sign-in page
- [ ] Environment secrets set in the hosting secret store (`APP_SESSION_SECRET`,
      `OWN_SUPABASE_SERVICE_ROLE_KEY`, `OWN_SUPABASE_URL`/`OWN_SUPABASE_DB_URL`,
      `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DEFAULT_STUDENT_PASSWORD`)
- [ ] Admin sign-in tested on the production URL
- [ ] Test student registration + sign-in tested (use a disposable batch number)
- [ ] Round configuration verified: name, type, duration, max marks, order
- [ ] Round 1 questions and correct options verified
- [ ] Round 2 debugging problems, bug definitions and detection patterns verified
- [ ] Round 3 problems, visible and hidden test cases verified
- [ ] Only JavaScript enabled as an executable language (no gcc/javac/python in this runtime)
- [ ] Timer behaviour verified: start a test round, refresh, confirm the deadline is unchanged
- [ ] Anti-cheating settings verified (violation reporting, single active session per user)
- [ ] Results publication flag is **off**
- [ ] **Database backup taken and stored off-machine** (see DEPLOYMENT.md §5)
- [ ] Test records used for rehearsal removed or clearly marked

## During the competition

- [ ] Admin control panel open on the organiser machine
- [ ] Round state monitored (WAITING → LIVE → PAUSED → RESUMED → ENDED)
- [ ] Participation monitored: in-progress vs submitted counts per round
- [ ] Violations monitored on the integrity feed
- [ ] Submission activity monitored per round
- [ ] Only one organiser drives round state changes
- [ ] Pause rather than end a round if an incident needs investigating
- [ ] Note the exact time of any incident for the audit log

## After the competition

- [ ] End the final round from the admin panel
- [ ] Verify per-round scores are recalculated and stable
- [ ] Verify final aggregate scores
- [ ] Verify leaderboard ordering and tie handling
- [ ] Publish results only when the organisers agree
- [ ] Confirm students see only their authorised results
- [ ] **Take a post-event database backup** (new timestamped file, never overwrite)
- [ ] Preserve submissions, violations and audit logs — no deletion, no truncation
- [ ] Archive the backup off-machine and record its location
