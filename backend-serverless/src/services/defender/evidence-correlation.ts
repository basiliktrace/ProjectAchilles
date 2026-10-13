// Pure helper: builds the ES bool query that finds Defender alerts matching
// a single test doc via bundle UUID + hostname + time window.
//
// Mirror of backend/src/services/defender/evidence-correlation.ts —
// see that file's header comment for the full design rationale.
//
// Summary:
//   - Each wildcard clause is duplicated against the bare field AND the
//     `.keyword` subfield in a `should` with `minimum_should_match: 1`.
//     Tolerates legacy bare-keyword and newer text+keyword index shapes.
//   - Time-windowing is a disjunction over `timestamp` (= lastUpdateDateTime
//     || createdDateTime) AND `created_at`; see `buildAlertTimeWindowQuery`
//     for why both fields are needed.
//   - The :: suffix in test_uuid is stripped to the bundle UUID prefix.
//   - Filepath matching (Issue #2 / Option B) recovers AV-only alerts that
//     carry only a dropped-file path under a bundle-named sandbox dir.

export interface TestEvidenceInput {
  test_uuid: string;
  routing_event_time: string;
  routing_hostname: string;
  /**
   * Optional `f0rtika.bundle_name` from the test doc. Adds a
   * `*<bundle_name_token>*` wildcard against `evidence_filepaths` to the
   * file-or-path disjunction so AV alerts with only sandbox-dir filepath
   * evidence (e.g. `\BlueHammerSandbox\`) become correlatable.
   */
  bundle_name?: string;
}

const PRE_WINDOW_MS = 5 * 60 * 1000;
const POST_WINDOW_MS = 30 * 60 * 1000;
const MIN_BUNDLE_TOKEN_LEN = 6;

/**
 * Time-window clause for Defender correlation queries. Three disjunctive
 * branches (see docs/edr-alert-refire-watermark.md):
 *
 *   a. `created_at` in window — the alert fired in the window; always a
 *      valid match, even for alerts later resolved (resolution bumps
 *      lastUpdateDateTime forward, eventually past the test's window, so
 *      created_at is the only field that still carries the fire time).
 *   b. `timestamp` (= lastUpdateDateTime || createdDateTime) in window AND
 *      status NOT terminal — an ACTIVE alert updated in the window (Defender
 *      aggregates repeat detections into one alert: an old alert reactivated
 *      with new evidence carries a stale createdDateTime but a fresh
 *      lastUpdateDateTime). Terminal alerts are excluded here because the
 *      dominant in-window update for them is a lifecycle event — most
 *      notably our own auto-resolve PATCH, which would otherwise re-float
 *      an alert from a previous run into the new run's window.
 *   c. `timestamp` in window AND status terminal AND
 *      timestamp > resolved_at + 60s — a genuine re-fire of an aggregated
 *      terminal alert. Defender bumps lastUpdateDateTime on re-fire WITHOUT
 *      reopening (status stays resolved), so branch (b) alone makes re-fires
 *      invisible. The 60s watermark absorbs resolution-adjacent bumps (our
 *      auto-resolve comment POST lands seconds after the status PATCH);
 *      our PATCH sets resolvedDateTime and lastUpdateDateTime to the same
 *      instant, so the echo path stays closed. Born-resolved alerts
 *      (resolved_at == created_at — AV auto-remediation) take this branch on
 *      any post-creation update, which is correct: they have no lifecycle
 *      path, so every update is vendor evidence activity.
 */
export function buildAlertTimeWindowQuery(
  fromIso: string,
  toIso: string,
): Record<string, unknown> {
  return {
    bool: {
      should: [
        // (a) fired in the window
        { range: { created_at: { gte: fromIso, lte: toIso } } },
        // (b) active alert updated in the window
        {
          bool: {
            filter: [{ range: { timestamp: { gte: fromIso, lte: toIso } } }],
            must_not: [{ terms: { status: ['resolved', 'closed'] } }],
          },
        },
        // (c) terminal alert updated >60s AFTER its resolution — a genuine
        // re-fire, not the resolution itself. The Painless script guards on
        // both fields being present (alerts missing resolved_at are
        // conservatively excluded). NOTE: `.value.toInstant().toEpochMilli()`
        // is required — `toMillis()` does not exist on ZonedDateTime.
        {
          bool: {
            filter: [
              { range: { timestamp: { gte: fromIso, lte: toIso } } },
              { terms: { status: ['resolved', 'closed'] } },
              { script: { script: { lang: 'painless', source: "doc['resolved_at'].size() > 0 && doc['timestamp'].size() > 0 && doc['timestamp'].value.toInstant().toEpochMilli() > doc['resolved_at'].value.toInstant().toEpochMilli() + 60000" } } },
            ],
          },
        },
      ],
      minimum_should_match: 1,
    },
  };
}

export function extractBundleUuid(testUuid: string): string {
  if (!testUuid) return '';
  const sep = testUuid.indexOf('::');
  return sep >= 0 ? testUuid.slice(0, sep) : testUuid;
}

export function extractBundleNameToken(bundleName: string | undefined): string | null {
  if (!bundleName) return null;
  const match = bundleName.match(/^[A-Za-z0-9]+/);
  if (!match) return null;
  const token = match[0].toLowerCase();
  return token.length >= MIN_BUNDLE_TOKEN_LEN ? token : null;
}

function shouldWildcardEither(field: string, value: string): Record<string, unknown> {
  return {
    bool: {
      should: [
        { wildcard: { [field]:               { value } } },
        { wildcard: { [`${field}.keyword`]:  { value } } },
      ],
      minimum_should_match: 1,
    },
  };
}

/**
 * Stage-specific evidence query. Mirrors the backend implementation —
 * see backend/src/services/defender/evidence-correlation.ts for the
 * full rationale. Requires `evidence_filenames` to contain the per-stage
 * binary `<bundleUuid>-<control_id>[-<variant>].exe`. Filepath and
 * bundle-name fallbacks are intentionally dropped (those produce
 * bundle-level matches, not stage-specific ones). Returns null when
 * any input is missing, including `control_id`.
 */
export interface StageEvidenceInput extends TestEvidenceInput {
  control_id: string;
}

export function buildStageDefenderEvidenceQuery(
  input: StageEvidenceInput,
): Record<string, unknown> | null {
  const { test_uuid, routing_event_time, routing_hostname, control_id } = input;
  if (!test_uuid || !routing_event_time || !routing_hostname || !control_id) return null;

  const testTime = new Date(routing_event_time).getTime();
  if (Number.isNaN(testTime)) return null;

  const baseUuid = extractBundleUuid(test_uuid);
  const idLower = control_id.toLowerCase();
  const stageBinaryExact = `${baseUuid.toLowerCase()}-${idLower}.exe`;
  const stageBinaryVariant = `${baseUuid.toLowerCase()}-${idLower}-*.exe`;
  const hostnamePrefix = `${routing_hostname.toUpperCase()}*`;

  const from = new Date(testTime - PRE_WINDOW_MS).toISOString();
  const to = new Date(testTime + POST_WINDOW_MS).toISOString();

  return {
    bool: {
      must: [
        { term: { doc_type: 'alert' } },
        buildAlertTimeWindowQuery(from, to),
        shouldWildcardEither('evidence_hostnames', hostnamePrefix),
        {
          bool: {
            should: [
              { term:     { 'evidence_filenames':         stageBinaryExact } },
              { term:     { 'evidence_filenames.keyword': stageBinaryExact } },
              { wildcard: { 'evidence_filenames':         { value: stageBinaryVariant } } },
              { wildcard: { 'evidence_filenames.keyword': { value: stageBinaryVariant } } },
            ],
            minimum_should_match: 1,
          },
        },
      ],
    },
  };
}

export function buildDefenderEvidenceQuery(
  input: TestEvidenceInput,
): Record<string, unknown> | null {
  const { test_uuid, routing_event_time, routing_hostname, bundle_name } = input;
  if (!test_uuid || !routing_event_time || !routing_hostname) return null;

  const testTime = new Date(routing_event_time).getTime();
  if (Number.isNaN(testTime)) return null;

  const baseUuid = extractBundleUuid(test_uuid);
  const binaryPrefix = `${baseUuid.toLowerCase()}*`;
  const filepathUuidGlob = `*${baseUuid.toLowerCase()}*`;
  const hostnamePrefix = `${routing_hostname.toUpperCase()}*`;

  const from = new Date(testTime - PRE_WINDOW_MS).toISOString();
  const to = new Date(testTime + POST_WINDOW_MS).toISOString();

  const fileOrPathShould: Array<Record<string, unknown>> = [
    { wildcard: { 'evidence_filenames':         { value: binaryPrefix } } },
    { wildcard: { 'evidence_filenames.keyword': { value: binaryPrefix } } },
    { wildcard: { 'evidence_filepaths':         { value: filepathUuidGlob } } },
    { wildcard: { 'evidence_filepaths.keyword': { value: filepathUuidGlob } } },
  ];

  const token = extractBundleNameToken(bundle_name);
  if (token) {
    const tokenGlob = `*${token}*`;
    fileOrPathShould.push(
      { wildcard: { 'evidence_filepaths':         { value: tokenGlob } } },
      { wildcard: { 'evidence_filepaths.keyword': { value: tokenGlob } } },
    );
  }

  return {
    bool: {
      must: [
        { term: { doc_type: 'alert' } },
        buildAlertTimeWindowQuery(from, to),
        shouldWildcardEither('evidence_hostnames', hostnamePrefix),
        {
          bool: {
            should: fileOrPathShould,
            minimum_should_match: 1,
          },
        },
      ],
    },
  };
}
