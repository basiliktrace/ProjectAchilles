import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskStatusBadge } from '../TaskStatusBadge';
import type { AgentTask, NoticeSummary, TaskResult } from '@/types/agent';

const notice = (over: Partial<NoticeSummary>): NoticeSummary => ({
  id: 'n1',
  run_tag: 'PA-RUN-7f3c9a',
  state: 'pending',
  last_error: null,
  release_at: null,
  pickup_deadline: null,
  ...over,
});

const task = (status: AgentTask['status'], result: Partial<TaskResult> | null = null) =>
  ({ status, result } as Pick<AgentTask, 'status' | 'result'>);

describe('TaskStatusBadge notice states', () => {
  it('shows "Waiting for notice" for a pending task with a pending notice', () => {
    render(<TaskStatusBadge task={task('pending')} notice={notice({ state: 'pending' })} />);
    expect(screen.getByText('Waiting for notice')).toBeInTheDocument();
  });

  it('uses last_error as the title when present', () => {
    render(<TaskStatusBadge task={task('pending')} notice={notice({ last_error: 'SMTP down' })} />);
    expect(screen.getByText('Waiting for notice')).toHaveAttribute('title', 'SMTP down');
  });

  it('shows "Starting soon" when notice is sent and release_at is in the future', () => {
    const future = new Date(Date.now() + 3 * 60_000).toISOString();
    render(<TaskStatusBadge task={task('pending')} notice={notice({ state: 'sent', release_at: future })} />);
    expect(screen.getByText('Starting soon')).toBeInTheDocument();
  });

  it('shows "Starting soon" for an overridden notice with future release_at', () => {
    const future = new Date(Date.now() + 3 * 60_000).toISOString();
    render(<TaskStatusBadge task={task('pending')} notice={notice({ state: 'overridden', release_at: future })} />);
    expect(screen.getByText('Starting soon')).toBeInTheDocument();
  });

  it('stays "Pending" when release_at has passed', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    render(<TaskStatusBadge task={task('pending')} notice={notice({ state: 'sent', release_at: past })} />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('shows "Not run" with the full reason as title for expired Not run: tasks', () => {
    render(
      <TaskStatusBadge
        task={task('expired', { error: 'Not run: notice not delivered' })}
        notice={notice({ state: 'not_delivered' })}
      />,
    );
    expect(screen.getByText('Not run')).toHaveAttribute('title', 'Not run: notice not delivered');
  });

  it('leaves expired tasks without a Not run reason unchanged', () => {
    render(<TaskStatusBadge task={task('expired', { error: 'timed out' })} />);
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });

  it('is unchanged without a notice', () => {
    render(<TaskStatusBadge task={task('pending')} />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });
});
