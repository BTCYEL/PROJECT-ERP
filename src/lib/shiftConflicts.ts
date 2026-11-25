export interface ShiftWindowLike {
  id: string;
  templateId?: string | null;
  templateName: string;
  locationId: string;
  locationName?: string | null;
  employeeId?: string | null;
  employeeName?: string | null;
  employeeCode?: string | null;
  shiftDate: string;
  startTime: string;
  endTime: string;
  status?: string;
}

export interface ShiftOverlapConflict {
  conflictKey: string;
  type: 'CREW_OVERLAP';
  employeeId: string;
  employeeName: string;
  employeeCode: string | null;
  shiftDate: string;
  newScheduleId: string;
  newTemplateName: string;
  newLocationId: string;
  newLocationName: string;
  newTimeRange: string;
  existingScheduleId: string;
  existingTemplateName: string;
  existingLocationId: string;
  existingLocationName: string;
  existingShiftDate: string;
  existingTimeRange: string;
  overlapMinutes: number;
  isSameLocation: boolean;
}

export interface RosterConflictPair {
  conflictId: string;
  scheduleIdA: string;
  scheduleIdB: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string | null;
  shiftDate: string;
  overlapMinutes: number;
  summary: string;
}

export function parseShiftDateDayIndex(isoDate: string): number | null {
  const trimmed = String(isoDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [y, m, d] = trimmed.split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function parseShiftTimeMins(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function getShiftIntervalMins(
  shiftDate: string,
  startTime: string,
  endTime: string,
): { start: number; end: number } | null {
  const dayIdx = parseShiftDateDayIndex(shiftDate);
  const startM = parseShiftTimeMins(startTime);
  const endM = parseShiftTimeMins(endTime);
  if (dayIdx === null || startM === null || endM === null) return null;
  const base = dayIdx * 1440;
  const start = base + startM;
  const end = endM <= startM ? base + endM + 1440 : base + endM;
  return { start, end };
}

export function computeOverlapMinutes(
  a: { start: number; end: number },
  b: { start: number; end: number },
): number {
  const overlapStart = Math.max(a.start, b.start);
  const overlapEnd = Math.min(a.end, b.end);
  return overlapEnd > overlapStart ? overlapEnd - overlapStart : 0;
}

export function formatOverlapDuration(minutes: number): string {
  const mins = Math.max(0, Math.round(minutes));
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs > 0 && rem > 0) return `${hrs}h ${rem}m`;
  if (hrs > 0) return `${hrs}h`;
  return `${rem}m`;
}

function buildOverlapConflict(candidate: ShiftWindowLike, partner: ShiftWindowLike, overlapMinutes: number): ShiftOverlapConflict {
  const empId = String(candidate.employeeId || '');
  const empName = candidate.employeeName || partner.employeeName || empId;
  const empCode = candidate.employeeCode || partner.employeeCode || null;
  return {
    conflictKey: `${candidate.id}::${partner.id}`,
    type: 'CREW_OVERLAP',
    employeeId: empId,
    employeeName: empName,
    employeeCode: empCode,
    shiftDate: candidate.shiftDate,
    newScheduleId: candidate.id,
    newTemplateName: candidate.templateName,
    newLocationId: candidate.locationId,
    newLocationName: candidate.locationName || candidate.locationId,
    newTimeRange: `${candidate.startTime}–${candidate.endTime}`,
    existingScheduleId: partner.id,
    existingTemplateName: partner.templateName,
    existingLocationId: partner.locationId,
    existingLocationName: partner.locationName || partner.locationId,
    existingShiftDate: partner.shiftDate,
    existingTimeRange: `${partner.startTime}–${partner.endTime}`,
    overlapMinutes,
    isSameLocation: candidate.locationId === partner.locationId,
  };
}

/**
 * Checks candidate shifts (being saved or generated) against existing active schedules
 * and against earlier candidates in the same batch for overlapping employee shift windows.
 */
export function findScheduleCandidateConflicts(
  candidates: ShiftWindowLike[],
  existingSchedules: ShiftWindowLike[],
): ShiftOverlapConflict[] {
  const conflicts: ShiftOverlapConflict[] = [];
  const seenKeys = new Set<string>();

  const activeExisting = existingSchedules.filter(
    (s) => s.status !== 'CANCELLED' && Boolean(s.employeeId),
  );
  const pool: ShiftWindowLike[] = [...activeExisting];

  for (const cand of candidates) {
    if (cand.status === 'CANCELLED' || !cand.employeeId) continue;
    const candInterval = getShiftIntervalMins(cand.shiftDate, cand.startTime, cand.endTime);
    if (!candInterval) continue;

    for (const existing of pool) {
      if (existing.id === cand.id) continue;
      if (!existing.employeeId || existing.employeeId !== cand.employeeId) continue;
      const exInterval = getShiftIntervalMins(existing.shiftDate, existing.startTime, existing.endTime);
      if (!exInterval) continue;

      const overlapMinutes = computeOverlapMinutes(candInterval, exInterval);
      if (overlapMinutes > 0) {
        const key = `${cand.id}::${existing.id}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          conflicts.push(buildOverlapConflict(cand, existing, overlapMinutes));
        }
      }
    }

    pool.push(cand);
  }

  return conflicts;
}

/**
 * Scans all active shifts in the roster and returns:
 * - conflictPairs: unique overlapping pairs for summary alert display
 * - conflictsByScheduleId: lookup map for highlighting individual conflicting schedule rows
 */
export function detectRosterScheduleConflicts(schedules: ShiftWindowLike[]): {
  conflictPairs: RosterConflictPair[];
  conflictsByScheduleId: Record<string, ShiftOverlapConflict[]>;
} {
  const conflictPairs: RosterConflictPair[] = [];
  const conflictsByScheduleId: Record<string, ShiftOverlapConflict[]> = {};
  const byEmployee = new Map<string, Array<{ shift: ShiftWindowLike; start: number; end: number }>>();

  for (const shift of schedules) {
    if (shift.status === 'CANCELLED' || !shift.employeeId) continue;
    const interval = getShiftIntervalMins(shift.shiftDate, shift.startTime, shift.endTime);
    if (!interval) continue;
    const list = byEmployee.get(shift.employeeId) || [];
    list.push({ shift, start: interval.start, end: interval.end });
    byEmployee.set(shift.employeeId, list);
  }

  for (const [employeeId, entries] of byEmployee.entries()) {
    entries.sort((a, b) => a.start - b.start);
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j];
        if (b.start >= a.end) break;
        const overlapMinutes = computeOverlapMinutes(a, b);
        if (overlapMinutes <= 0) continue;

        const cA = buildOverlapConflict(a.shift, b.shift, overlapMinutes);
        const cB = buildOverlapConflict(b.shift, a.shift, overlapMinutes);
        (conflictsByScheduleId[a.shift.id] ||= []).push(cA);
        (conflictsByScheduleId[b.shift.id] ||= []).push(cB);

        const pairIds = [a.shift.id, b.shift.id].sort();
        const empName = a.shift.employeeName || b.shift.employeeName || employeeId;
        const locA = a.shift.locationName || a.shift.locationId;
        const locB = b.shift.locationName || b.shift.locationId;
        conflictPairs.push({
          conflictId: `${pairIds[0]}__${pairIds[1]}`,
          scheduleIdA: a.shift.id,
          scheduleIdB: b.shift.id,
          employeeId,
          employeeName: empName,
          employeeCode: a.shift.employeeCode || b.shift.employeeCode || null,
          shiftDate: a.shift.shiftDate,
          overlapMinutes,
          summary: `${empName}: ${a.shift.templateName} (${a.shift.startTime}–${a.shift.endTime} · ${locA}) overlaps ${b.shift.templateName} (${b.shift.startTime}–${b.shift.endTime} · ${locB}) by ${formatOverlapDuration(overlapMinutes)}`,
        });
      }
    }
  }

  return { conflictPairs, conflictsByScheduleId };
}
