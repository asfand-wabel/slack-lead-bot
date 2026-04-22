/**
 * Strict key-value parser.
 *
 * Expected format (order doesn't matter, keys case-insensitive):
 *
 *   Account: Limbazu Formaggi
 *   Contact: Igors Aleksejevs
 *   Title:   Export Manager        (optional)
 *   Phone:   +37126057829          (optional if Email present)
 *   Email:   limbazu@example.eu    (optional if Phone present)
 *   Source:  Anuga                 (optional)
 *   Type:    Lead / Supplier       (optional, defaults to Lead)
 *   Notes:   any free text         (optional)
 *
 * Required: Account, Contact, and at least one of Email or Phone.
 * Messages missing any required field are rejected (valid: false).
 */

const FIELD_MAP = {
  account:  ['account', 'company', 'organization', 'org', 'firm', 'business'],
  contact:  ['contact', 'name', 'full name', 'contact name', 'person'],
  title:    ['title', 'job title', 'position', 'role', 'designation'],
  phone:    ['phone', 'mobile', 'cell', 'tel', 'telephone', 'mob', 'contact number'],
  email:    ['email', 'e-mail', 'mail'],
  source:   ['source', 'lead source', 'origin', 'event', 'from'],
  type:     ['type', 'category', 'kind', 'lead type'],
  notes:    ['notes', 'note', 'comment', 'remarks', 'description', 'details'],
};

const REQUIRED = ['account', 'contact', 'email', 'phone'];

function normalise(raw) {
  const k = raw.toLowerCase().trim();
  for (const [field, aliases] of Object.entries(FIELD_MAP)) {
    if (aliases.includes(k)) return field;
  }
  return null; // unknown key → ignored
}

function parseMessage(text, metadata = {}) {
  const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);
  const fields = {};

  for (const line of lines) {
    const m = line.match(/^([^:]{2,40}):\s*(.+)$/);
    if (!m) continue;
    const key = normalise(m[1]);
    if (!key) continue;
    const val = m[2].trim();
    if (val && !(key in fields)) fields[key] = val;
  }

  // Auto-default type
  if (!fields.type) {
    const lower = text.toLowerCase();
    fields.type = /supplier|vendor|manufacturer|wholesaler/.test(lower)
      ? 'Supplier'
      : 'Lead';
  }

  // Auto-generate Potential name
  if (fields.account) {
    fields.potential = fields.source
      ? `${fields.account} – ${fields.source}`
      : `${fields.account} Lead`;
  }

  // Validation
  const missing = [];
  for (const f of REQUIRED) {
    if (!fields[f]) missing.push(f);
  }

  return {
    id:         metadata.ts ?? String(Date.now()),
    receivedAt: metadata.ts
      ? new Date(parseFloat(metadata.ts) * 1000).toISOString()
      : new Date().toISOString(),
    channel:    metadata.channel ?? null,
    user:       metadata.user    ?? null,
    raw:        text,
    valid:      missing.length === 0,
    missing,
    fields,
  };
}

module.exports = { parseMessage };
