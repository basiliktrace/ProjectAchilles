// Run start times for the execution report's run-strip appendix (spec §5.2 Q9).
// ES stores only completion time; the agent's started_at lives inside the
// tasks.result JSON in the agent database. Only called for small scopes
// (≤ RUN_STRIP_MAX_RUNS runs). Same exports as the serverless twin.

import { getDatabase } from '../agent/database.js';

const CHUNK = 500;

export function parseStartedAt(resultJson: unknown): string | null {
  if (typeof resultJson !== 'string' || resultJson === '') return null;
  try {
    const parsed = JSON.parse(resultJson) as { started_at?: unknown };
    if (typeof parsed.started_at !== 'string') return null;
    const ms = Date.parse(parsed.started_at);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  } catch {
    return null;
  }
}

export async function getRunStartTimes(taskIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return out;
  const db = getDatabase();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = db
      .prepare(`SELECT id, result FROM tasks WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as { id: string; result: string | null }[];
    for (const row of rows) {
      const started = parseStartedAt(row.result);
      if (started) out.set(row.id, started);
    }
  }
  return out;
}
