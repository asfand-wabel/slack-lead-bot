import json
import os
import time
import threading
from datetime import datetime, timezone
from urllib.parse import quote

from dotenv import load_dotenv
load_dotenv()

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from slack_sdk import WebClient
from flask import Flask, jsonify, redirect, request, send_from_directory
from flask_cors import CORS

from parser import parse_message
from token_store import get as get_token, set_token

# ── In-memory store ───────────────────────────────────────────────────────────
_lock   = threading.Lock()
entries = []
MAX_ENTRIES = 500


def add_entry(entry):
    with _lock:
        entries.insert(0, entry)
        if len(entries) > MAX_ENTRIES:
            del entries[MAX_ENTRIES:]


def build_entry_from_fields(fields, channel_name):
    clean = {k: v for k, v in fields.items() if v}
    clean['potential'] = (
        f"{clean['account']} – {clean['source']}"
        if 'source' in clean else
        f"{clean['account']} Lead"
    )
    now = datetime.now(tz=timezone.utc)
    return {
        'id':         str(int(now.timestamp() * 1000)),
        'receivedAt': now.isoformat(),
        'channel':    channel_name or '#slack-form',
        'user':       None,
        'raw':        '\n'.join(f"{k}: {v}" for k, v in clean.items()),
        'valid':      True,
        'missing':    [],
        'fields':     clean,
    }


# ── Slack bot ─────────────────────────────────────────────────────────────────
slack_connected = all([
    os.environ.get('SLACK_BOT_TOKEN'),
    os.environ.get('SLACK_APP_TOKEN'),
    os.environ.get('SLACK_SIGNING_SECRET'),
])

slack_app = None

if slack_connected:
    slack_app = App(
        token=os.environ['SLACK_BOT_TOKEN'],
        signing_secret=os.environ['SLACK_SIGNING_SECRET'],
    )

    watch_channels = [
        c.strip() for c in os.environ.get('WATCH_CHANNELS', '').split(',') if c.strip()
    ]

    @slack_app.command('/lead')
    def handle_lead(ack, command, client):
        ack()
        client.views_open(
            trigger_id=command['trigger_id'],
            view=build_modal(command['channel_id']),
        )

    @slack_app.view('new_lead_modal')
    def handle_modal_submit(ack, view, body, client):
        v = view['state']['values']
        fields = {
            'account': (v['account_block']['account'].get('value') or '').strip() or None,
            'contact': (v['contact_block']['contact'].get('value') or '').strip() or None,
            'title':   (v['title_block']['title'].get('value') or '').strip() or None,
            'email':   (v['email_block']['email'].get('value') or '').strip() or None,
            'phone':   (v['phone_block']['phone'].get('value') or '').strip() or None,
            'source':  (v['source_block']['source'].get('value') or '').strip() or None,
            'type':    (v['type_block']['type'].get('selected_option') or {}).get('value', 'Lead'),
            'notes':   (v['notes_block']['notes'].get('value') or '').strip() or None,
        }

        errors = {}
        if not fields['email']:
            errors['email_block'] = 'Email is required'
        if not fields['phone']:
            errors['phone_block'] = 'Phone is required'
        if errors:
            ack(response_action='errors', errors=errors)
            return

        ack()

        meta       = json.loads(view.get('private_metadata') or '{}')
        channel_id = meta.get('channelId')
        channel_name = channel_id or '#slack-form'
        try:
            info = client.conversations_info(channel=channel_id)
            channel_name = f"#{info['channel']['name']}"
        except Exception:
            pass

        entry = build_entry_from_fields(fields, channel_name)
        add_entry(entry)
        print(f"[bot] /lead form submitted — {fields['account']} ({fields['type']})")

        lines = [f"✅ *New {fields['type']} added to CRM*"]
        lines.append(f"*Account:* {fields['account']}")
        lines.append(f"*Contact:* {fields['contact']}")
        if fields.get('title'):  lines.append(f"*Title:* {fields['title']}")
        if fields.get('email'):  lines.append(f"*Email:* {fields['email']}")
        if fields.get('phone'):  lines.append(f"*Phone:* {fields['phone']}")
        if fields.get('source'): lines.append(f"*Source:* {fields['source']}")
        if fields.get('notes'):  lines.append(f"*Notes:* {fields['notes']}")
        message_text = '\n'.join(lines)

        try:
            user_token = get_token(body['user']['id'])
            if user_token:
                WebClient(token=user_token).chat_postMessage(
                    channel=channel_id, text=message_text
                )
            else:
                dm = client.conversations_open(users=body['user']['id'])
                connect_url = f"{os.environ.get('APP_URL', '')}/connect"
                client.chat_postMessage(
                    channel=dm['channel']['id'],
                    text=(
                        f"Your lead was saved ✅ but the message couldn't be posted as you.\n"
                        f"Connect your account once so future messages appear from you: {connect_url}"
                    ),
                )
        except Exception as err:
            print(f"[bot] failed to post message: {err}")

    @slack_app.message()
    def handle_message(message, client):
        if message.get('subtype'):
            return
        if watch_channels and message['channel'] not in watch_channels:
            return

        channel_name = message['channel']
        try:
            info = client.conversations_info(channel=message['channel'])
            channel_name = f"#{info['channel']['name']}"
        except Exception:
            pass

        entry = parse_message(message.get('text', ''), {
            'ts':      message['ts'],
            'channel': channel_name,
            'user':    message.get('user'),
        })

        if not entry['valid']:
            print(f"[bot] ignored message — missing: {', '.join(entry['missing'])}")
            return

        add_entry(entry)
        print(f"[bot] message captured from {channel_name} ({entry['fields'].get('type')})")


# ── Modal builder ─────────────────────────────────────────────────────────────
def build_modal(channel_id):
    return {
        'type':             'modal',
        'callback_id':      'new_lead_modal',
        'private_metadata': json.dumps({'channelId': channel_id}),
        'title':  {'type': 'plain_text', 'text': 'New Lead / Supplier'},
        'submit': {'type': 'plain_text', 'text': 'Add to CRM'},
        'close':  {'type': 'plain_text', 'text': 'Cancel'},
        'blocks': [
            _input_block('account_block', 'account', 'Account (Company) *', 'e.g. Limbazu Formaggi'),
            _input_block('contact_block', 'contact', 'Contact Name *',      'e.g. Igors Aleksejevs'),
            _input_block('title_block',   'title',   'Job Title',           'e.g. Export Manager',  optional=True),
            _input_block('email_block',   'email',   'Email *',             'name@company.com'),
            _input_block('phone_block',   'phone',   'Phone *',             'e.g. +37126057829'),
            _input_block('source_block',  'source',  'Source',              'e.g. Anuga, LinkedIn', optional=True),
            {
                'type':     'input',
                'block_id': 'type_block',
                'label':    {'type': 'plain_text', 'text': 'Type'},
                'element':  {
                    'type':           'static_select',
                    'action_id':      'type',
                    'initial_option': {'text': {'type': 'plain_text', 'text': 'Lead'}, 'value': 'Lead'},
                    'options': [
                        {'text': {'type': 'plain_text', 'text': 'Lead'},     'value': 'Lead'},
                        {'text': {'type': 'plain_text', 'text': 'Supplier'}, 'value': 'Supplier'},
                    ],
                },
            },
            {
                'type':     'input',
                'block_id': 'notes_block',
                'optional': True,
                'label':    {'type': 'plain_text', 'text': 'Notes'},
                'element':  {
                    'type':        'plain_text_input',
                    'action_id':   'notes',
                    'multiline':   True,
                    'placeholder': {'type': 'plain_text', 'text': 'Any additional notes…'},
                },
            },
        ],
    }


def _input_block(block_id, action_id, label, placeholder, optional=False):
    return {
        'type':     'input',
        'block_id': block_id,
        'optional': optional,
        'label':    {'type': 'plain_text', 'text': label},
        'element':  {
            'type':        'plain_text_input',
            'action_id':   action_id,
            'placeholder': {'type': 'plain_text', 'text': placeholder},
        },
    }


# ── Flask API + static frontend ───────────────────────────────────────────────
web = Flask(__name__, static_folder='public', static_url_path='')
CORS(web)


@web.route('/')
def index():
    return send_from_directory('public', 'index.html')


@web.route('/connect')
def connect():
    redirect_uri = f"{os.environ.get('APP_URL', '')}/slack/callback"
    url = (
        f"https://slack.com/oauth/v2/authorize"
        f"?client_id={os.environ.get('OAUTH_CLIENT_ID', '')}"
        f"&user_scope=chat:write"
        f"&redirect_uri={quote(redirect_uri)}"
    )
    return redirect(url)


@web.route('/slack/callback')
def slack_callback():
    code  = request.args.get('code')
    error = request.args.get('error')
    if error or not code:
        return f"Authorization failed: {error or 'no code'}", 400
    try:
        result = WebClient().oauth_v2_access(
            client_id=os.environ['OAUTH_CLIENT_ID'],
            client_secret=os.environ['OAUTH_CLIENT_SECRET'],
            code=code,
            redirect_uri=f"{os.environ.get('APP_URL', '')}/slack/callback",
        )
        user_id    = result['authed_user']['id']
        user_token = result['authed_user']['access_token']
        set_token(user_id, user_token)
        print(f"[oauth] stored token for user {user_id}")
        return '<h2>✅ Connected! You can close this tab. Future /lead messages will be posted as you.</h2>'
    except Exception as err:
        print(f"[oauth] error: {err}")
        return 'OAuth exchange failed. Check server logs.', 500


@web.route('/api/entries')
def api_entries():
    type_filter = request.args.get('type', 'all')
    search      = request.args.get('search', '')
    limit       = int(request.args.get('limit', 50))
    offset      = int(request.args.get('offset', 0))

    with _lock:
        result = list(entries)

    if type_filter and type_filter != 'all':
        result = [e for e in result if (e['fields'].get('type') or '').lower() == type_filter.lower()]

    if search:
        q = search.lower()
        result = [
            e for e in result
            if q in e['raw'].lower() or any(q in str(v).lower() for v in e['fields'].values())
        ]

    return jsonify({'total': len(result), 'data': result[offset:offset + limit]})


@web.route('/api/entries/<entry_id>', methods=['DELETE'])
def api_delete_entry(entry_id):
    with _lock:
        idx = next((i for i, e in enumerate(entries) if e['id'] == entry_id), None)
        if idx is None:
            return jsonify({'error': 'not found'}), 404
        entries.pop(idx)
    return jsonify({'ok': True})


@web.route('/api/entries/mock', methods=['POST'])
def api_mock_entry():
    data = request.get_json()
    if not data or not data.get('text'):
        return jsonify({'error': 'text required'}), 400

    entry = parse_message(data['text'], {'ts': str(time.time()), 'channel': '#mock'})
    if not entry['valid']:
        return jsonify({'error': 'Missing required fields', 'missing': entry['missing'], 'fields': entry['fields']}), 422

    add_entry(entry)
    return jsonify(entry), 201


# ── Boot ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    PORT = int(os.environ.get('PORT', 3000))

    if slack_app:
        handler = SocketModeHandler(slack_app, os.environ['SLACK_APP_TOKEN'])
        threading.Thread(target=handler.start, daemon=True).start()
        print('[slack] Socket Mode connected')
    else:
        print('[slack] No credentials — running in mock-only mode')

    print(f'[web]   Admin dashboard → http://localhost:{PORT}')
    web.run(port=PORT, use_reloader=False)
