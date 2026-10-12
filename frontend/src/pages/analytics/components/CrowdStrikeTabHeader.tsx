import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/shared/ui/Button';
import { Alert } from '@/components/shared/ui/Alert';

interface CrowdStrikeTabHeaderProps {
  lastSync: string | null;
  syncing: boolean;
  /** Last sync failure (manual run or background), shown until a clean sync. */
  syncError?: string | null;
  onSync: () => void;
}

export default function CrowdStrikeTabHeader({ lastSync, syncing, syncError, onSync }: CrowdStrikeTabHeaderProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">CrowdStrike Falcon</h2>
          <p className="text-sm text-muted-foreground">
            Zero Trust posture score, security alerts, and detection correlation
            {lastSync && (
              <span className="ml-2">
                &middot; Last synced {new Date(lastSync).toLocaleString()}
              </span>
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onSync} disabled={syncing}>
          {syncing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          Sync Now
        </Button>
      </div>
      {syncError && (
        <Alert variant="destructive" title="CrowdStrike sync failed">
          <span className="break-words">{syncError}</span>
        </Alert>
      )}
    </div>
  );
}
