import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useCapabilities, type Capabilities } from '@/hooks/useCapabilities';

type BooleanCapability = Exclude<{
  [K in keyof Capabilities]-?: Capabilities[K] extends boolean ? K : never;
}[keyof Capabilities], 'loaded'>;

/**
 * Renders children only when the backend reports the capability. Renders nothing
 * until /api/capabilities has resolved (defaults are not trustworthy yet), then
 * redirects when the capability is off (e.g. a bookmarked URL on serverless).
 */
export function RequireCapability({ capability, children }: { capability: BooleanCapability; children: ReactNode }) {
  const caps = useCapabilities();
  if (!caps.loaded) return null;
  if (!caps[capability]) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
