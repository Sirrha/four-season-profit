// employee-shell-ui.mjs
// ETR-1 — DEV / FIXTURE UI ONLY. Synthetic data only. No real names, emails, UIDs,
// ansattIds, passwords, personnummer, or bank details. No network, no Firebase,
// no Firestore. Authority comes ONLY from the pure core model.
//
// All fixture-derived text is rendered via textContent / created elements — never
// via innerHTML — so fixture values can never become executable markup.

import { resolveRouting, selectMembership, ownShifts } from './employee-shell-core.mjs';

// ---- Synthetic fixtures (NOT real data) --------------------------------------

// Fixture "identities" offered by the LOCAL TEST chooser.
export const FIXTURE_USERS = [
  { uid: 'uid-tom', label: 'TEST: Tom — 0 aktive medlemskap' },
  { uid: 'uid-ida', label: 'TEST: Ida — 1 aktivt medlemskap' },
  { uid: 'uid-per', label: 'TEST: Per — 2 aktive medlemskap' },
];

// Authority records. accessEnabled:false must never grant a door. A membership
// for a different uid (uid-annen) is present to prove UID isolation.
export const FIXTURE_MEMBERSHIPS = [
  { uid: 'uid-tom', tenantId: 'tenant-alpha', accessRole: 'employee', ansattId: 'ansatt-101', accessEnabled: false },
  { uid: 'uid-ida', tenantId: 'tenant-alpha', accessRole: 'employee', ansattId: 'ansatt-102', accessEnabled: true },
  { uid: 'uid-per', tenantId: 'tenant-alpha', accessRole: 'employee', ansattId: 'ansatt-103', accessEnabled: true },
  { uid: 'uid-per', tenantId: 'tenant-beta', accessRole: 'employee', ansattId: 'ansatt-204', accessEnabled: true },
  { uid: 'uid-annen', tenantId: 'tenant-alpha', accessRole: 'employee', ansattId: 'ansatt-999', accessEnabled: true },
];

// Synthetic shifts (vakt-shaped, NO wages/PII). Belong to several ansattIds so
// cross-employee filtering can be visibly verified.
export const FIXTURE_SHIFTS = [
  { id: 'v-01', ansattId: 'ansatt-102', dato: '2026-08-18', fra: '08:00', til: '14:00', notat: 'Morgenvakt' },
  { id: 'v-02', ansattId: 'ansatt-102', dato: '2026-08-20', timer: 5, notat: 'Ekstra' },
  { id: 'v-03', ansattId: 'ansatt-103', dato: '2026-08-18', fra: '10:00', til: '18:00', notat: '' },
  { id: 'v-04', ansattId: 'ansatt-204', dato: '2026-08-19', fra: '16:00', til: '22:00', notat: 'Kveld' },
  { id: 'v-05', ansattId: 'ansatt-204', dato: '2026-08-21', fra: '12:00', til: '20:00', notat: '' },
  { id: 'v-06', ansattId: 'ansatt-999', dato: '2026-08-18', fra: '09:00', til: '17:00', notat: 'Annen ansatt' },
  { id: 'v-07', ansattId: 'ansatt-101', dato: '2026-08-18', fra: '09:00', til: '17:00', notat: 'Deaktivert medlem' },
];

// Non-authoritative human labels for tenants. DISPLAY ONLY — authority stays the
// membership object.
export const TENANT_LABELS = {
  'tenant-alpha': 'Butikk Alpha (TEST)',
  'tenant-beta': 'Kafé Beta (TEST)',
};
function tenantLabel(tenantId) {
  return Object.prototype.hasOwnProperty.call(TENANT_LABELS, tenantId)
    ? TENANT_LABELS[tenantId]
    : tenantId;
}

// ---- Small safe DOM helpers --------------------------------------------------

function el(tag, opts) {
  const node = document.createElement(tag);
  if (opts) {
    if (opts.text != null) node.textContent = String(opts.text); // textContent only
    if (opts.cls) node.className = opts.cls;
    if (opts.attrs) for (const k of Object.keys(opts.attrs)) node.setAttribute(k, String(opts.attrs[k]));
    if (opts.style) node.style.cssText = opts.style;
  }
  return node;
}
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---- Shell -------------------------------------------------------------------

export function mountEmployeeShell(root) {
  if (!root) return;

  function goChooser() {
    clear(root);
    root.appendChild(el('div', {
      text: 'LOKAL TEST / FIKTIV identitet — dette er IKKE en ekte innlogging.',
      style: 'background:#fee;border:1px solid #f99;color:#900;padding:8px 10px;border-radius:8px;font-size:13px;margin-bottom:14px',
    }));
    root.appendChild(el('h2', { text: 'Velg testidentitet', style: 'font-size:18px;margin:0 0 10px' }));

    const sel = el('select', { style: 'width:100%;max-width:360px;padding:10px;font-size:15px;margin-bottom:12px' });
    sel.appendChild(el('option', { text: '— Velg fiktiv bruker —', attrs: { value: '' } }));
    for (const u of FIXTURE_USERS) {
      sel.appendChild(el('option', { text: u.label, attrs: { value: u.uid } }));
    }
    sel.addEventListener('change', () => { if (sel.value) route(sel.value); });
    root.appendChild(sel);
  }

  function route(uid) {
    const r = resolveRouting(FIXTURE_MEMBERSHIPS, uid);
    if (r.kind === 'no-access') return goNoAccess();
    if (r.kind === 'direct') return goEmployee(r.membership);
    return goPicker(r.eligible); // picker
  }

  function goNoAccess() {
    clear(root);
    root.appendChild(el('div', {
      text: 'Ingen tilgang. Denne kontoen har ingen aktive medlemskap. Kontakt administrator.',
      style: 'padding:14px;border:1px solid #ddd;border-radius:8px;background:#fafafa',
    }));
    root.appendChild(backButton());
  }

  function goPicker(eligible) {
    clear(root);
    root.appendChild(el('h2', { text: 'Velg arbeidsplass', style: 'font-size:18px;margin:0 0 10px' }));
    for (const m of eligible) {
      const b = el('button', {
        text: tenantLabel(m.tenantId) + ' — ' + m.accessRole,
        style: 'display:block;width:100%;max-width:360px;text-align:left;padding:12px;margin-bottom:8px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;font-size:15px',
      });
      // Authority = the eligible membership selected via the pure core, by tenantId.
      b.addEventListener('click', () => {
        const sel = selectMembership(eligible, m.tenantId);
        if (sel) goEmployee(sel); else goNoAccess();
      });
      root.appendChild(b);
    }
    root.appendChild(backButton());
  }

  function goEmployee(membership) {
    clear(root);
    const head = el('div', { style: 'padding:12px;border:1px solid #ddd;border-radius:8px;background:#f6fff6;margin-bottom:14px' });
    head.appendChild(el('div', { text: 'Arbeidsplass: ' + tenantLabel(membership.tenantId), style: 'font-weight:700' }));
    head.appendChild(el('div', { text: 'Rolle: ' + membership.accessRole, style: 'font-size:13px;color:#555' }));
    root.appendChild(head);

    root.appendChild(el('h2', { text: 'Mine vakter', style: 'font-size:18px;margin:0 0 4px' }));
    root.appendChild(el('div', { text: 'Skrivebeskyttet (ETR-1). Ingen lønn, personnummer eller admin-data vises.', style: 'font-size:12px;color:#777;margin-bottom:10px' }));

    const mine = ownShifts(FIXTURE_SHIFTS, membership); // scoped strictly to membership.ansattId
    if (mine.length === 0) {
      root.appendChild(el('div', { text: 'Ingen vakter registrert for denne ansatte.', style: 'color:#777;padding:8px 0' }));
    } else {
      const list = el('div');
      for (const s of mine) {
        const row = el('div', { style: 'padding:8px 10px;border:1px solid #eee;border-radius:6px;margin-bottom:6px' });
        const when = s.fra && s.til ? (s.fra + '–' + s.til) : (s.timer != null ? (s.timer + ' t') : '');
        row.appendChild(el('div', { text: s.dato + '   ' + when, style: 'font-weight:600' }));
        if (s.notat) row.appendChild(el('div', { text: s.notat, style: 'font-size:12px;color:#666' }));
        list.appendChild(row);
      }
      root.appendChild(list);
    }
    root.appendChild(backButton('Bytt arbeidsplass / identitet'));
  }

  function backButton(label) {
    const b = el('button', {
      text: label || 'Tilbake til testidentitet',
      style: 'margin-top:16px;padding:10px 14px;border:1px solid #999;border-radius:8px;background:#fff;cursor:pointer;font-size:14px',
    });
    b.addEventListener('click', goChooser);
    return b;
  }

  goChooser();
}
