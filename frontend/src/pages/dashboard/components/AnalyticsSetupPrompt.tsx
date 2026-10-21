import { Link } from 'react-router-dom';

interface AnalyticsSetupPromptProps {
  /** What the card would show, e.g. "testing cadence". */
  subject: string;
}

/** Card body for tenants without Elasticsearch: these cards read only from analytics. */
export function AnalyticsSetupPrompt({ subject }: AnalyticsSetupPromptProps) {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-1.5 text-center text-sm text-faint">
      <span>Connect Elasticsearch to see {subject}.</span>
      <Link to="/analytics/setup" className="text-[12.5px] text-accent hover:underline">
        Set up analytics →
      </Link>
    </div>
  );
}
