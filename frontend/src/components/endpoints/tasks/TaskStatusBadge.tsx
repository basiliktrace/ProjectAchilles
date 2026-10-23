import { Badge } from '@/components/shared/ui/Badge';
import { resolveTaskStatusDisplay } from '@/utils/taskStatusDisplay';
import type { AgentTask, NoticeSummary } from '@/types/agent';

interface TaskStatusBadgeProps {
  task: Pick<AgentTask, 'status' | 'result'>;
  notice?: NoticeSummary;
  className?: string;
}

/** Renders a task's HONEST status (completed-but-nonzero-exit shows Failed). */
export function TaskStatusBadge({ task, notice, className }: TaskStatusBadgeProps) {
  const { label, variant, title } = resolveTaskStatusDisplay(task, notice);
  return (
    <Badge variant={variant} className={className} title={title}>
      {label}
    </Badge>
  );
}

export default TaskStatusBadge;
