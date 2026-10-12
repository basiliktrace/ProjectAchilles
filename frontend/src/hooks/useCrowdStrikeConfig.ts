import { useState, useEffect } from 'react';
import { integrationsApi } from '@/services/api/integrations';

/** Check if CrowdStrike integration is configured. Used for conditional UI rendering. */
export function useCrowdStrikeConfig() {
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    integrationsApi.getCrowdStrikeSettings()
      .then((settings) => setConfigured(settings.configured))
      .catch(() => setConfigured(false))
      .finally(() => setLoading(false));
  }, []);

  return { configured, loading };
}
