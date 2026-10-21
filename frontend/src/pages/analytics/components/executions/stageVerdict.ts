import type { EnrichedTestExecution } from '@/services/api/analytics';
import { classifyExecution, type ExecutionOutcome } from './shared';

export type StageKind = ExecutionOutcome | 'not-run';

export interface StageVerdict {
  kind: StageKind;
  title: string;
  body: string;
}

/** A stage's outcome: classifyExecution's, except exit 260 (blocked before it ran) is 'not-run'. */
export function stageKind(exec: EnrichedTestExecution): StageKind {
  return exec.error_code === 260 ? 'not-run' : classifyExecution(exec);
}

const ACTION_COPY: Record<string, string> = {
  quarantined: 'quarantined the file',
  process_killed: 'killed the process',
  blocked: 'blocked it',
};

/** Per-stage flags, falling back to the bundle-level flags for older documents. */
function stageEdr(exec: EnrichedTestExecution) {
  return {
    defender: Boolean(exec.defender_stage_detected ?? exec.defender_detected),
    crowdstrike: Boolean(exec.crowdstrike_stage_detected ?? exec.crowdstrike_detected),
  };
}

function vendorLabel(defender: boolean, crowdstrike: boolean): string | null {
  if (defender && crowdstrike) return 'Defender and CrowdStrike';
  if (defender) return 'Defender';
  if (crowdstrike) return 'CrowdStrike';
  return null;
}

/** Vendor(s) that reported on this stage; null when none did. */
export function stageVendors(exec: EnrichedTestExecution): { label: string; short: string } | null {
  const { defender, crowdstrike } = stageEdr(exec);
  const label = vendorLabel(defender, crowdstrike);
  if (!label) return null;
  return { label, short: defender && crowdstrike ? 'MDE + CS' : defender ? 'MDE' : 'CS' };
}

/** "<vendor> reports it <action>." naming only the vendor whose action is used (CrowdStrike wins). */
function preventionSentence(exec: EnrichedTestExecution): string | null {
  const { defender, crowdstrike } = stageEdr(exec);
  const csAction = crowdstrike ? ACTION_COPY[exec.crowdstrike_prevention_action ?? ''] : undefined;
  if (csAction) return `CrowdStrike reports it ${csAction}.`;
  const defAction = defender ? ACTION_COPY[exec.defender_prevention_action ?? ''] : undefined;
  if (defAction) return `Defender reports it ${defAction}.`;
  return null;
}

/** Boolean-only fallback: name the vendor(s) whose *_prevented flag is set. */
function preventedFallback(exec: EnrichedTestExecution): string {
  const def = Boolean(exec.defender_prevented);
  const cs = Boolean(exec.crowdstrike_prevented);
  if (def && cs) return 'Defender and CrowdStrike report it stopped it.';
  if (def) return 'Defender reports it stopped it.';
  if (cs) return 'CrowdStrike reports it stopped it.';
  return 'An EDR reports it stopped it.';
}

/**
 * Why a skipped stage did not run. "Stop" orchestrators end the chain at the first block or the
 * first error, so the cause is the nearest earlier stage that was not itself skipped.
 */
function skippedBody(exec: EnrichedTestExecution, siblings: EnrichedTestExecution[]): string {
  const generic = 'The chain stopped before this stage.';
  const idx = siblings.indexOf(exec);
  for (let i = idx - 1; i >= 0; i--) {
    const prev = siblings[i];
    const kind = stageKind(prev);
    if (kind === 'skipped') continue;
    const m = /^Stage (\d+)$/.exec(prev.control_validator ?? '');
    if (!m) return generic;
    const n = m[1];
    if (kind === 'protected' || kind === 'prevented') return `The chain stopped at stage ${n}, where a control blocked it.`;
    if (kind === 'not-run') return `The chain stopped at stage ${n}, where a control blocked the test binary before it ran.`;
    if (kind === 'inconclusive') return `The chain stopped at stage ${n}, which ended with an error.`;
    return generic;
  }
  return generic;
}

export function stageVerdict(exec: EnrichedTestExecution, siblings: EnrichedTestExecution[]): StageVerdict {
  if (exec.error_code === 260) {
    return {
      kind: 'not-run',
      title: 'Stage not run: a control blocked the test binary before it ran.',
      body: "Usually an ASR prevalence rule. The technique itself was not tested, so it isn't scored as protected.",
    };
  }
  const kind = classifyExecution(exec);
  switch (kind) {
    case 'protected':
      return {
        kind,
        title: 'Stopped by endpoint protection.',
        body: 'The stage was blocked or quarantined before it could finish.',
      };
    case 'prevented': {
      return {
        kind,
        title: 'Ran, then an EDR stopped it.',
        body: preventionSentence(exec) ?? preventedFallback(exec),
      };
    }
    case 'detected': {
      const { defender, crowdstrike } = stageEdr(exec);
      return {
        kind,
        title: 'Ran to completion. An EDR alerted but did not stop it.',
        body: `${vendorLabel(defender, crowdstrike) ?? 'An EDR'} raised an alert naming this stage's binary; nothing was blocked.`,
      };
    }
    case 'unprotected':
      return {
        kind,
        title: 'Ran to completion with no block and no alert.',
        body: 'Nothing on the endpoint reacted to this stage.',
      };
    case 'skipped':
      return { kind, title: 'Did not run.', body: skippedBody(exec, siblings) };
    default: {
      const evidence = preventionSentence(exec);
      return {
        kind: 'inconclusive',
        title: 'Not scored: the stage ended with an error.',
        body:
          `${exec.error_name ?? 'Error'} (${exec.error_code ?? 'unknown'}) counts as neither protected nor unprotected.` +
          (evidence ? ` ${evidence.slice(0, -1)}, which is the likely cause.` : ''),
      };
    }
  }
}

const COUNT_ORDER: Array<[StageKind, string]> = [
  ['protected', 'protected'],
  ['prevented', 'prevented'],
  ['detected', 'detected'],
  ['unprotected', 'unprotected'],
  ['not-run', 'not run'],
  ['inconclusive', 'inconclusive'],
];

/** Header results line for a run: non-zero outcome counts joined with " · ". */
export function stageOutcomeCounts(members: EnrichedTestExecution[]): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    const kind = stageKind(m);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return COUNT_ORDER.filter(([k]) => (counts.get(k) ?? 0) > 0)
    .map(([k, word]) => `${counts.get(k)} ${word}`)
    .join(' · ');
}
