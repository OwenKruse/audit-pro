import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CreateFindingRequestSchema,
  ScannerFindingSchema,
  UpdateFindingRequestSchema,
  type CreateFindingRequest,
  type ScannerFinding,
  type UpdateFindingRequest,
} from '@cipherscope/proto';

type FindingRow = {
  evidence_json: string | null;
};

function buildDescriptionMarkdown(finding: ScannerFinding): string {
  const lines: string[] = [
    finding.summary,
    '',
    `Remediation: ${finding.remediation}`,
    '',
    'Evidence:',
    ...finding.evidence.map((ev) => `- ${ev.messageId} @ ${ev.field}: ${ev.note}`),
    '',
    ...finding.reproducibility.map((line) => `- ${line}`),
    '',
    `Check: ${finding.checkId} (${finding.mode})`,
  ];
  return lines.join('\n').trim();
}

function parseFindingRow(row: FindingRow): ScannerFinding | null {
  if (!row.evidence_json) return null;
  try {
    return ScannerFindingSchema.parse(JSON.parse(row.evidence_json));
  } catch {
    return null;
  }
}

function getStoredFinding(db: DatabaseSync, id: string): ScannerFinding | null {
  const row = db
    .prepare(
      `
      SELECT evidence_json
      FROM findings
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(id) as FindingRow | undefined;

  if (!row) return null;
  return parseFindingRow(row);
}

function upsertFindingRow(db: DatabaseSync, finding: ScannerFinding) {
  db.prepare(
    `
      INSERT INTO findings (
        id, created_at, severity, confidence, title, description_md, evidence_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        created_at = excluded.created_at,
        severity = excluded.severity,
        confidence = excluded.confidence,
        title = excluded.title,
        description_md = excluded.description_md,
        evidence_json = excluded.evidence_json,
        status = excluded.status
    `,
  ).run(
    finding.id,
    finding.createdAt,
    finding.severity,
    finding.confidence,
    finding.title,
    buildDescriptionMarkdown(finding),
    JSON.stringify(finding),
    finding.status,
  );
}

export function listFindings(
  db: DatabaseSync,
  input: { limit: number; offset: number; status?: ScannerFinding['status'] },
): ScannerFinding[] {
  const rows =
    input.status == null
      ? (db
          .prepare(
            `
      SELECT evidence_json
      FROM findings
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
          )
          .all(input.limit, input.offset) as FindingRow[])
      : (db
          .prepare(
            `
      SELECT evidence_json
      FROM findings
      WHERE status = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
          )
          .all(input.status, input.limit, input.offset) as FindingRow[]);

  const out: ScannerFinding[] = [];
  for (const row of rows) {
    const parsed = parseFindingRow(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function createFinding(db: DatabaseSync, input: CreateFindingRequest): ScannerFinding {
  const parsed = CreateFindingRequestSchema.parse(input);
  const now = new Date().toISOString();
  const finding = ScannerFindingSchema.parse({
    id: `manual_${randomUUID()}`,
    createdAt: now,
    checkId: parsed.checkId,
    mode: parsed.mode,
    severity: parsed.severity,
    confidence: parsed.confidence,
    status: parsed.status,
    title: parsed.title,
    summary: parsed.summary,
    remediation: parsed.remediation,
    reproducibility: parsed.reproducibility,
    tags: parsed.tags,
    evidence: parsed.evidence,
  });

  upsertFindingRow(db, finding);
  return finding;
}

export function updateFinding(
  db: DatabaseSync,
  input: { id: string; patch: UpdateFindingRequest },
): ScannerFinding | null {
  const patch = UpdateFindingRequestSchema.parse(input.patch);
  const current = getStoredFinding(db, input.id);
  if (!current) return null;

  const updated = ScannerFindingSchema.parse({
    ...current,
    ...patch,
  });

  upsertFindingRow(db, updated);
  return updated;
}
