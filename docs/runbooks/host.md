# Host: what the agent reports and what the server keeps

The agent reports on the Docker host so the console can show what runs there, and the server keeps
part of that for a limited time (SHP-ADR-009 as amended by SHP-ADR-013, SHP-P-20). The agent reads
the local Docker Engine API only, read-only, with no new mounts, and opens no port. This page says
what it reports, what the server keeps and for how long, and the one rule that holds throughout:
**health-check output never enters history** (SHP-REQ-224).

| Act | Who | Where |
|---|---|---|
| Open Host and Resources | any signed-in role; any API token (read-only) | Host (`/host`), Host › Resources, `GET /api/host` |
| Read a container's health-check output | admin or operator; a "can read logs" token whose owner is still one, scoped to the container's app or stack | container sheet, Host |
| Read an incident bundle | see `incidents.md` | container sheet › Copy for Claude, `shipyard_incident` |

## What the agent reports

Every report, about once a minute, carries:

- every container, volume, image and network;
- disk;
- a one-shot CPU and memory sample for each container.

SHP-P-20 adds the following.

### Container events

The agent keeps one read-only, long-lived `/events` stream to the local Engine and sends the
`start`, `die` (with its exit code), `oom`, `health_status` and `restart` events with each report,
so a restart between two reports is not lost (SHP-REQ-217).

- If the stream drops, the agent reconnects from the time of the last event it saw (SHP-REQ-218).
- It holds at most **2,000 unsent events**. Past that it drops the oldest and reports how many it
  dropped (SHP-REQ-219).
- The stream is local to the host. The agent still opens no port.

### Health-check results

For a container that is unhealthy or starting, the agent reports its **last five health-check
results** (`State.Health.Log`). They are redacted on the agent exactly as logs are (SHP-ADR-011,
SHP-REQ-220), and each is cut to 4 KiB. The server never sees an unredacted line.

### Exit state

For each container: its last exit code, whether it was OOM-killed, and its restart policy
(SHP-REQ-221).

### Host totals from `/info`

CPU core count and total memory, from the Engine's `/info` (SHP-REQ-221).

Load average and page cache are **not collected**: they need a `/proc` mount, which SHP-ADR-009
rules out. Host › Resources says "in containers" for what it shows and links to Grafana for the
rest.

### What it never reports

A container's **environment, command, entrypoint or labels** (SHP-REQ-177).

## What the server keeps, and for how long

| Data | Kept | Notes |
|---|---|---|
| Latest snapshot per agent | until the next report replaces it | the only place health-check output lives |
| Container events | 30 days, then deleted (SHP-REQ-222) | no health-check output |
| Health per container per 30-minute bucket | 7 days (SHP-REQ-223) | the worst state seen and the number of failed checks; about 4,200 rows a day at 88 containers |
| CPU and memory samples | 24 hours (unchanged) | spikes on Resources are computed from them when read |

A **spike** on Resources is a container above five times its own 24-hour median for two or more
samples in a row, and at least a tenth of a core. It is computed on read, not stored.

Shipyard is **not a metrics database**: no arbitrary series and no query language. Use Grafana for
those.

### Health-check output never enters history

Probe output exists only in the latest snapshot (SHP-REQ-224). It is not in events, not in the
health buckets and not in Shipyard's own logs. The next report replaces it.

Reading the latest snapshot's probe output follows the logs rule:

- an **admin or operator**;
- an **API token created with "can read logs"** whose owner is still an admin or operator, and
  then only for containers of the app or stack the token is scoped to.

Anyone else sees the results (pass or fail, and when) with the output blanked.

## Restart loops and incident bundles

Three restarts of a Deployed or Operated container within 15 minutes show as a **restart loop** on
its app's incident banner on Overview (SHP-REQ-227).

The incident bundle gains the container's events of the last 24 hours, its latest health-check
results, its exit code, whether it was OOM-killed and its restart policy (SHP-REQ-228). A bundle is
still built on request and never stored; see `incidents.md`.

## Upgrade order

SHP-P-20 changes the protocol between agent and server. **Upgrade the server first**, because the
report object is strict and a server that does not know the new fields refuses a new agent's
report. Then upgrade the agent from `upgrade-agent.md`, with `--no-deps`.

An agent older than SHP-P-20 keeps working. Its reports lack events, probe results, exit state and
host totals, and those parts of the console say "not reported".

Related: SHP-ADR-009, SHP-ADR-011, SHP-ADR-013, `incidents.md`.
