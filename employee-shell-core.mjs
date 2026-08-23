// employee-shell-core.mjs
// ETR-1 — PURE MODEL ONLY. Dependency-free. No DOM, no network, no Firebase.
// Implements the accepted multi-tenant authority shape:
//   membership = { uid, tenantId, accessRole, ansattId, accessEnabled }
// Authority derives ONLY from membership objects passed in. This module never
// reads users/{uid}, email, display name, custom claims, PIN role, or tenant
// labels for authority. Fail-closed everywhere.
//
// Governing design: SOREN-SIRRHA-MULTI-TENANT-IDENTITY-AND-CONSOLIDATED-S1R-DESIGN-001.

/**
 * Structural usability of a membership record for this slice.
 * Requires the five fields with correct types. ansattId may be a non-empty
 * string OR null (an admin membership may legitimately carry no ansattId);
 * any other ansattId shape is treated as malformed -> not usable.
 */
export function isUsableMembership(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.uid !== 'string' || m.uid.length === 0) return false;
  if (typeof m.tenantId !== 'string' || m.tenantId.length === 0) return false;
  if (typeof m.accessRole !== 'string' || m.accessRole.length === 0) return false;
  if (typeof m.accessEnabled !== 'boolean') return false;
  if (!(m.ansattId === null || typeof m.ansattId === 'string')) return false;
  return true;
}

/**
 * Eligible memberships for a requested uid:
 *  - structurally usable, AND
 *  - membership.uid === requestedUid (UID isolation), AND
 *  - accessEnabled === true.
 * Returns [] for a non-string/empty uid or non-array input (fail-closed).
 */
export function eligibleMemberships(memberships, requestedUid) {
  if (typeof requestedUid !== 'string' || requestedUid.length === 0) return [];
  if (!Array.isArray(memberships)) return [];
  return memberships.filter(
    (m) => isUsableMembership(m) && m.uid === requestedUid && m.accessEnabled === true
  );
}

/**
 * Deterministic routing from a requested uid + membership set:
 *   0 eligible -> { kind: 'no-access', uid }
 *   1 eligible -> { kind: 'direct', membership, eligible }
 *   2+ eligible -> { kind: 'picker', memberships, eligible }
 * `eligible` is included so a door selection can be constrained to it.
 */
export function resolveRouting(memberships, requestedUid) {
  const eligible = eligibleMemberships(memberships, requestedUid);
  const uid = typeof requestedUid === 'string' ? requestedUid : null;
  if (eligible.length === 0) return { kind: 'no-access', uid, eligible };
  if (eligible.length === 1) return { kind: 'direct', membership: eligible[0], eligible };
  return { kind: 'picker', memberships: eligible, eligible };
}

/**
 * Door/workplace selection. May select ONLY one of the already-eligible
 * memberships, identified by tenantId. No arbitrary tenantId can create
 * authority: a tenantId not present in `eligible` returns null. Ambiguous
 * (more than one eligible membership for the same tenantId) also returns null
 * (fail-closed).
 */
export function selectMembership(eligible, tenantId) {
  if (!Array.isArray(eligible)) return null;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
  const matches = eligible.filter(
    (m) => isUsableMembership(m) && m.accessEnabled === true && m.tenantId === tenantId
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The ansattId to scope own-shift reads to: the selected membership's ansattId
 * if it is a non-empty string, else null (fail-closed).
 */
export function usableAnsattId(selectedMembership) {
  if (!selectedMembership || typeof selectedMembership !== 'object') return null;
  const a = selectedMembership.ansattId;
  return typeof a === 'string' && a.length > 0 ? a : null;
}

/**
 * Own shifts for the selected membership. Uses ONLY selectedMembership.ansattId.
 * If there is no usable ansattId, returns [] (empty / fail-closed). Never falls
 * back to any other identifier.
 */
export function ownShifts(shifts, selectedMembership) {
  const ansattId = usableAnsattId(selectedMembership);
  if (!ansattId) return [];
  if (!Array.isArray(shifts)) return [];
  return shifts.filter((s) => s && typeof s === 'object' && s.ansattId === ansattId);
}
