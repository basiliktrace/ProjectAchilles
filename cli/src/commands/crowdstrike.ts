import { registerCommand } from './registry.js';
import * as api from '../api/crowdstrike.js';
import { colors, scoreColor } from '../output/colors.js';

registerCommand({
  name: 'crowdstrike',
  description: 'CrowdStrike Falcon integration analytics',
  subcommands: {
    'zta-score': {
      description: 'Current Zero Trust Assessment score',
      handler: async (ctx) => {
        const score = await api.getZtaScore();
        ctx.output.score(score.score, 'ZTA Score');
        ctx.output.detail(score as unknown as Record<string, unknown>, [
          'deviceCount',
          'minScore',
          'maxScore',
          'osScore',
          'sensorConfigScore',
          'lastUpdated',
        ]);
      },
    },
    'zta-trend': {
      description: 'ZTA score over time',
      flags: { days: { type: 'number' as const, default: 30 } },
      handler: async (ctx) => {
        const data = await api.getZtaScoreTrend(ctx.flags.days as number);
        ctx.output.table(
          data as unknown as Record<string, unknown>[],
          [
            { key: 'timestamp', label: 'Date', width: 12, transform: (v) => new Date(String(v)).toLocaleDateString() },
            { key: 'score', label: 'Score', width: 8, align: 'right', transform: (v) => scoreColor(Number(v)) },
          ],
        );
      },
    },
    alerts: {
      description: 'CrowdStrike alerts',
      flags: {
        severity: { type: 'string' as const, description: 'Filter by severity' },
        status: { type: 'string' as const, description: 'Filter by status' },
        search: { type: 'string' as const, description: 'Search text' },
        page: { type: 'number' as const, default: 1 },
        size: { type: 'number' as const, default: 20 },
      },
      handler: async (ctx) => {
        const data = await api.getAlerts({
          severity: ctx.flags.severity as string | undefined,
          status: ctx.flags.status as string | undefined,
          search: ctx.flags.search as string | undefined,
          page: ctx.flags.page as number,
          pageSize: ctx.flags.size as number,
        });
        ctx.output.table(
          data.alerts as unknown as Record<string, unknown>[],
          [
            { key: 'title', label: 'Title', width: 35 },
            { key: 'severity', label: 'Severity', width: 10,
              transform: (v) => {
                const s = String(v);
                if (s === 'critical') return colors.brightRed(s);
                if (s === 'high') return colors.red(s);
                if (s === 'medium') return colors.yellow(s);
                return s;
              },
            },
            { key: 'status', label: 'Status', width: 12 },
            { key: 'category', label: 'Category', width: 16 },
            { key: 'techniques', label: 'Techniques', transform: (v) => Array.isArray(v) ? v.join(', ') : '' },
          ],
          { total: data.pagination.total },
        );
      },
    },
    'alert-trend': {
      description: 'Alert count over time',
      flags: { days: { type: 'number' as const, default: 30 } },
      handler: async (ctx) => {
        const data = await api.getAlertsTrend(ctx.flags.days as number);
        ctx.output.table(
          data as unknown as Record<string, unknown>[],
          [
            { key: 'timestamp', label: 'Date', width: 12, transform: (v) => new Date(String(v)).toLocaleDateString() },
            { key: 'count', label: 'Alerts', width: 8, align: 'right' },
          ],
        );
      },
    },
    correlation: {
      description: 'Cross-correlation between Defense Score and ZTA score',
      args: [{ name: 'type', required: true, description: 'Correlation type: score or techniques' }],
      flags: { days: { type: 'number' as const, default: 30 } },
      handler: async (ctx) => {
        if (ctx.args.type === 'score') {
          const data = await api.getScoreCorrelation(ctx.flags.days as number);
          ctx.output.table(
            data as unknown as Record<string, unknown>[],
            [
              { key: 'timestamp', label: 'Date', width: 12, transform: (v) => new Date(String(v)).toLocaleDateString() },
              { key: 'defenseScore', label: 'Defense', width: 9, align: 'right', transform: (v) => scoreColor(Number(v)) },
              { key: 'ztaScore', label: 'ZTA', width: 9, align: 'right', transform: (v) => scoreColor(Number(v)) },
            ],
          );
        } else if (ctx.args.type === 'techniques') {
          const data = await api.getTechniqueCorrelation();
          ctx.output.result(data);
        } else {
          ctx.output.error(`Unknown correlation type: ${ctx.args.type}. Use 'score' or 'techniques'.`);
        }
      },
    },
  },
});
