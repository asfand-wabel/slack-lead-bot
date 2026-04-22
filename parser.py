import re
from datetime import datetime, timezone

FIELD_MAP = {
    'account': ['account', 'company', 'organization', 'org', 'firm', 'business'],
    'contact': ['contact', 'name', 'full name', 'contact name', 'person'],
    'title':   ['title', 'job title', 'position', 'role', 'designation'],
    'phone':   ['phone', 'mobile', 'cell', 'tel', 'telephone', 'mob', 'contact number'],
    'email':   ['email', 'e-mail', 'mail'],
    'source':  ['source', 'lead source', 'origin', 'event', 'from'],
    'type':    ['type', 'category', 'kind', 'lead type'],
    'notes':   ['notes', 'note', 'comment', 'remarks', 'description', 'details'],
}

REQUIRED = ['account', 'contact', 'email', 'phone']


def _normalise(raw):
    k = raw.lower().strip()
    for field, aliases in FIELD_MAP.items():
        if k in aliases:
            return field
    return None


def parse_message(text, metadata=None):
    if metadata is None:
        metadata = {}

    lines = [l.strip() for l in text.split('\n') if l.strip()]
    fields = {}

    for line in lines:
        m = re.match(r'^([^:]{2,40}):\s*(.+)$', line)
        if not m:
            continue
        key = _normalise(m.group(1))
        if not key:
            continue
        val = m.group(2).strip()
        if val and key not in fields:
            fields[key] = val

    if 'type' not in fields:
        lower = text.lower()
        fields['type'] = 'Supplier' if any(
            w in lower for w in ['supplier', 'vendor', 'manufacturer', 'wholesaler']
        ) else 'Lead'

    if 'account' in fields:
        fields['potential'] = (
            f"{fields['account']} – {fields['source']}"
            if 'source' in fields else
            f"{fields['account']} Lead"
        )

    missing = [f for f in REQUIRED if f not in fields]

    ts = metadata.get('ts')
    if ts:
        received_at = datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
        entry_id = str(ts)
    else:
        now = datetime.now(tz=timezone.utc)
        received_at = now.isoformat()
        entry_id = str(int(now.timestamp() * 1000))

    return {
        'id':         entry_id,
        'receivedAt': received_at,
        'channel':    metadata.get('channel'),
        'user':       metadata.get('user'),
        'raw':        text,
        'valid':      len(missing) == 0,
        'missing':    missing,
        'fields':     fields,
    }
