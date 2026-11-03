# Overview, incident bundles and `shipyard_incident`

Overview is the console destination that says what runs on the host and what is wrong with it
(SHP-ADR-013, SHP-P-19). When a container is failing, Shipyard can assemble an **incident bundle**
for it: the facts it can state from fixed rules, the container's state, its redacted logs since the
first error, and its owner's last change. A bundle is built when someone asks and is **never
stored** (SHP-REQ-215). It carries logs, so it is read by the same people who may read logs.

| Act | Who | Where |
|---|---|---|
| Open Overview | the console | Overview (`/overview`) |
| Read an incident bundle | admin or operator; a "can read logs" token whose owner is still one, scoped to the container's app or stack | container sheet › Copy for Claude, `shipyard_incident`, `GET /api/containers/:id/incident` |

## Overview

Overview shows, in this order:

- what runs on the host, in totals;
- what is happening now, and **Needs you**;
- the last 24 hours;
- a health tile per Deployed app and a chip per other compose project.

During SHP-P-19 Overview lives at `/overview`. It becomes the home page only after a second
usability run (SHP-T-19.9), so until then the home page is unchanged.

### The incident banner

A banner appears for a **Deployed or Operated** app or stack with a container that is unhealthy or
restarting. An Observed project never gets one: its failing containers show on its chip and
nowhere louder (SHP-REQ-209). There is **one banner per app**, and it names:

- the failing container (every one, oldest failure first);
- since when: the first report in which the server saw it failing, by the **server's clock**;
- the app's last deploy, or the stack's last update.

"Since" is when Shipyard first saw the failure, not when it began.

## What a bundle holds

The container's sheet offers **Copy for Claude** for a container. The bundle holds four
things:

1. **Facts Shipyard states from fixed rules**, in time order, undated ones last (SHP-REQ-216):
   - when it began failing;
   - how many times Docker restarted it;
   - its Docker state;
   - the first log line that looks like an error, and how many do;
   - its memory against its limit, when that is 70% or more;
   - the last deploy or update, and whether it came **before or after** the failure.

   These are rules, never a model's guess. Shipyard does not diagnose; the reader or Claude does.
2. **Inspect state**, from the container's latest report: image, digest, state, health, restart
   count, created and started times, CPU and memory, and memory limit.
3. **Logs since the first error line** among the last 2000, or the **last 200 lines** if none looks
   like an error. They are redacted on the host by the agent, exactly as logs always are
   (SHP-ADR-011); the server never sees an unredacted line.
4. **The owner's last change**: the app's last deploy or the stack's last update, with its state
   and time.

## What a bundle never holds

- The container's **environment, command or labels**. The agent never reports them (SHP-REQ-177),
  so there is nothing for a bundle to include.
- Any **unredacted output**.

A bundle is **not stored**: not in the database, and not in Shipyard's own logs (SHP-REQ-215,
SHP-REQ-191). The server builds it from the latest report plus a live log read, hands it to the
reader and forgets it. Reading it again builds it again.

## Who may read one

A bundle carries logs, so the rule is the logs rule:

- an **admin or operator** signed in;
- an **API token created with "can read logs"** whose owner is still an admin or operator, and
  then only for containers of the apps and adopted stacks the token is scoped to;
- **never an Observed container through a token**.

Anyone else is refused with the
usual `{ code, gate, message, fix }`.

## Each read is audited

Every read records an `incident.read` audit event naming **the reader and the container**, never a
line of content. The log read inside it leaves its own `logs.view` event as usual, so a read shows
twice in the audit trail by design.

## If the agent does not answer

The bundle still comes back. Its facts, inspect state and last change come from the server's latest
report, so they stand; the logs section is marked **unavailable** and says why (the agent is
offline, or the reader may not read logs) with the fix. Read the bundle again once the agent is
back.

## Handing a bundle to Claude

**In the console:** open the failing container's sheet and choose **Copy for Claude**. It copies
the bundle as Markdown. Paste it into a Claude session.

**From Claude Code:** call `shipyard_incident { container }`. `container` is a name as the Host
view shows it, or the full 64-hex ID. It returns the same Markdown, from the same renderer as
Copy for Claude, so the two cannot differ. The token must have logs allowed and be scoped to the
container's app or stack.

A client that connected to the MCP server before the tool existed must **reconnect** to see it.

**Over REST:** `GET /api/containers/:id/incident` with the full 64-hex container ID returns the
bundle as JSON.

Check what you paste before you share it outside your own sessions. Redaction removes what
Shipyard recognises as a secret; it cannot know every value an application chooses to log.
