import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDatabase } from '../../../__tests__/helpers/db.js';
import { initializeTables } from '../../agent/database.js';

const cols = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const indexes = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA index_list(${t})`).all() as { name: string }[]).map((i) => i.name);

function insertCampaign(db: Database.Database, id: string, org: string, name: string) {
  db.prepare(`INSERT INTO campaigns (id, org_id, name, test_uuids, agent_ids, created_by, created_at, updated_at)
    VALUES (?, ?, ?, '[]', '[]', 'u', 't', 't')`).run(id, org, name);
}

describe('campaigns schema', () => {
  it('creates campaigns and campaign_runs', () => {
    const db = createTestDatabase();
    expect(cols(db, 'campaigns')).toEqual(expect.arrayContaining(
      ['id', 'org_id', 'name', 'description', 'framework_label', 'test_uuids', 'agent_ids', 'created_by', 'created_at', 'updated_at']));
    expect(cols(db, 'campaign_runs')).toEqual(expect.arrayContaining(
      ['id', 'campaign_id', 'org_id', 'started_by', 'started_at', 'notice_id', 'snapshot', 'task_count']));
    expect(indexes(db, 'campaign_runs')).toContain('idx_campaign_runs_campaign');
  });

  it('enforces UNIQUE(org_id, name) per org', () => {
    const db = createTestDatabase();
    insertCampaign(db, 'c1', 'orgA', 'Plan');
    expect(() => insertCampaign(db, 'c2', 'orgA', 'Plan')).toThrow(/UNIQUE/);
    expect(() => insertCampaign(db, 'c3', 'orgB', 'Plan')).not.toThrow();
  });

  it('campaign_runs has no FK to campaigns (runs survive deletion)', () => {
    const db = createTestDatabase();
    insertCampaign(db, 'c1', 'orgA', 'Plan');
    db.prepare(`INSERT INTO campaign_runs (id, campaign_id, org_id, started_by, started_at, snapshot, task_count)
      VALUES ('r1', 'c1', 'orgA', 'u', 't', '{}', 0)`).run();
    db.prepare('DELETE FROM campaigns WHERE id = ?').run('c1');
    expect(db.prepare('SELECT id FROM campaign_runs').all()).toHaveLength(1);
  });

  it('adds tasks.campaign_run_id and its index on a fresh DB', () => {
    const db = createTestDatabase();
    expect(cols(db, 'tasks')).toContain('campaign_run_id');
    expect(indexes(db, 'tasks')).toContain('idx_tasks_campaign_run');
  });

  it('keeps campaign_run_id and notice_id through the legacy execute_command table recreation', () => {
    const db = createTestDatabase();
    // Rebuild tasks with the pre-execute_command CHECK and none of the newer columns.
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE tasks;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('execute_test', 'update_agent', 'uninstall')),
        priority INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'assigned', 'downloading', 'executing', 'completed', 'failed', 'expired')),
        payload TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        assigned_at TEXT,
        completed_at TEXT,
        ttl INTEGER NOT NULL DEFAULT 604800,
        created_by TEXT,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      );
    `);
    db.pragma('foreign_keys = ON');
    initializeTables(db);
    const c = cols(db, 'tasks');
    expect(c).toContain('campaign_run_id');
    expect(c).toContain('notice_id');
    expect(indexes(db, 'tasks')).toContain('idx_tasks_campaign_run');
    // CHECK was widened by the migration
    db.prepare(`INSERT INTO agents (id, org_id, hostname, os, arch, agent_version, api_key_hash, status, enrolled_at, enrolled_by)
      VALUES ('a', 'o', 'h', 'linux', 'amd64', '1', 'x', 'active', 't', 'u')`).run();
    expect(() => db.prepare(`INSERT INTO tasks (id, agent_id, org_id, type, payload, created_by, campaign_run_id)
      VALUES ('t', 'a', 'o', 'execute_command', '{}', 'u', 'r1')`).run()).not.toThrow();
  });
});
