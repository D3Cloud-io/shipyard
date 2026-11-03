import type { IncidentBundle } from './overview.js';

/**
 * The incident bundle's one text form (SHP-ADR-013, SHP-REQ-212). It imports types only, so the
 * console can bundle it without zod: the console imports it by its own subpath, never the barrel.
 */

function line(label: string, value: string | number | null): string {
  return `- ${label}: ${value === null ? 'none' : String(value)}`;
}

/**
 * The bundle as Markdown: what Copy for Claude puts on the clipboard and what `shipyard_incident`
 * returns as its text. One renderer, so the two cannot drift.
 */
export function renderIncidentBundle(bundle: IncidentBundle): string {
  const { container, inspect, logs } = bundle;
  const out: string[] = [];
  out.push(`# Incident: ${container.name}`);
  out.push('');
  out.push(line('Container ID', container.id));
  out.push(line('Tier', container.tier));
  out.push(line('Owner', container.owner));
  out.push(line('Compose', container.compose === null ? null : `${container.compose.project}/${container.compose.service}`));
  out.push(line('Condition', bundle.condition));
  out.push(line('Failing since', bundle.failingSince));
  out.push(line('Bundle built', bundle.builtAt));
  out.push('');
  out.push('## What Shipyard sees');
  out.push('');
  if (bundle.facts.length === 0) out.push('- Nothing stands out.');
  for (const fact of bundle.facts) out.push(`- ${fact.at === null ? '' : `${fact.at} `}${fact.text}`);
  out.push('');
  out.push('## Inspect');
  out.push('');
  out.push(line('Image', inspect.image));
  out.push(line('Digest', inspect.digest));
  out.push(line('State', inspect.state));
  out.push(line('Health', inspect.health));
  out.push(line('Restart count', inspect.restartCount));
  out.push(line('Created', inspect.createdAt));
  out.push(line('Started', inspect.startedAt));
  out.push(line('CPU %', inspect.cpuPercent));
  out.push(line('Memory bytes', inspect.memoryBytes));
  out.push(line('Memory limit bytes', inspect.memoryLimitBytes));
  out.push('');
  out.push('## Last change');
  out.push('');
  const change = bundle.lastChange;
  out.push(change === null ? '- none' : `- ${change.kind} ${change.id} ${change.state} at ${change.at}${change.sha === null ? '' : ` (${change.sha})`}${change.digest === null ? '' : ` (${change.digest})`}`);
  out.push('');
  out.push(`## Logs (${logs.from === 'first-error' ? 'since the first error' : 'latest lines'}, redacted)`);
  out.push('');
  if (logs.unavailable !== null) {
    out.push(`Logs unavailable: ${logs.unavailable.message} ${logs.unavailable.fix}`);
  } else if (logs.lines.length === 0) {
    out.push('No lines.');
  } else {
    out.push('```');
    for (const l of logs.lines) out.push(`${l.at ?? '-'} ${l.stream} ${l.text}`);
    out.push('```');
  }
  return `${out.join('\n')}\n`;
}
