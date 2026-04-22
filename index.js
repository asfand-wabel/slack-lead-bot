require('dotenv').config();
const { App, LogLevel } = require('@slack/bolt');
const { WebClient }     = require('@slack/web-api');
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { parseMessage } = require('./parser');
const tokenStore       = require('./token-store');

// ── in-memory store ──────────────────────────────────────────────────────────
const entries = [];
const MAX_ENTRIES = 500;

function addEntry(entry) {
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
}

function buildEntryFromFields(fields, channelName) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v != null && v !== '')
  );

  clean.potential = clean.source
    ? `${clean.account} – ${clean.source}`
    : `${clean.account} Lead`;

  return {
    id:         String(Date.now()),
    receivedAt: new Date().toISOString(),
    channel:    channelName ?? '#slack-form',
    user:       null,
    raw:        Object.entries(clean).map(([k, v]) => `${k}: ${v}`).join('\n'),
    valid:      true,
    missing:    [],
    fields:     clean,
  };
}

// ── Slack bot ────────────────────────────────────────────────────────────────
const slackConnected = !!(
  process.env.SLACK_BOT_TOKEN &&
  process.env.SLACK_APP_TOKEN &&
  process.env.SLACK_SIGNING_SECRET
);

let slackApp = null;

if (slackConnected) {
  slackApp = new App({
    token:         process.env.SLACK_BOT_TOKEN,
    appToken:      process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode:    true,
    logLevel:      LogLevel.WARN,
  });

  const watchChannels = process.env.WATCH_CHANNELS
    ? process.env.WATCH_CHANNELS.split(',').map(c => c.trim()).filter(Boolean)
    : [];

  // ── /lead slash command → open modal form ─────────────────────────────────
  slackApp.command('/lead', async ({ command, ack, client }) => {
    await ack();
    await client.views.open({
      trigger_id: command.trigger_id,
      view:       buildModal(command.channel_id),
    });
  });

  // ── Modal submitted ───────────────────────────────────────────────────────
  slackApp.view('new_lead_modal', async ({ ack, view, body, client }) => {
    const v = view.state.values;
    const fields = {
      account: v.account_block.account.value?.trim(),
      contact: v.contact_block.contact.value?.trim(),
      title:   v.title_block.title.value?.trim()   || null,
      email:   v.email_block.email.value?.trim()   || null,
      phone:   v.phone_block.phone.value?.trim()   || null,
      source:  v.source_block.source.value?.trim() || null,
      type:    v.type_block.type.selected_option?.value ?? 'Lead',
      notes:   v.notes_block.notes.value?.trim()   || null,
    };

    // Require both email and phone
    const errors = {};
    if (!fields.email) errors.email_block = 'Email is required';
    if (!fields.phone) errors.phone_block = 'Phone is required';
    if (Object.keys(errors).length) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    await ack();

    const meta        = JSON.parse(view.private_metadata || '{}');
    const channelId   = meta.channelId;
    let   channelName = channelId ?? '#slack-form';
    try {
      const info = await client.conversations.info({ channel: channelId });
      channelName = `#${info.channel.name}`;
    } catch (_) {}

    const entry = buildEntryFromFields(fields, channelName);
    addEntry(entry);
    console.log(`[bot] /lead form submitted — ${fields.account} (${fields.type})`);

    // Post full details as a message back to where /lead was typed
    try {
      const lines = [
        `✅ *New ${fields.type} added to CRM*`,
        `*Account:* ${fields.account}`,
        `*Contact:* ${fields.contact}`,
        fields.title  ? `*Title:* ${fields.title}`   : null,
        fields.email  ? `*Email:* ${fields.email}`   : null,
        fields.phone  ? `*Phone:* ${fields.phone}`   : null,
        fields.source ? `*Source:* ${fields.source}` : null,
        fields.notes  ? `*Notes:* ${fields.notes}`   : null,
      ].filter(Boolean).join('\n');

      const userToken = tokenStore.get(body.user.id);
      if (userToken) {
        // Post as the salesperson — they're a member of the DM so this works directly
        await new WebClient(userToken).chat.postMessage({ channel: channelId, text: lines });
      } else {
        // No token yet — open a bot DM with the invoker and ask them to connect
        const dm = await client.conversations.open({ users: body.user.id });
        const connectUrl = `${process.env.APP_URL}/connect`;
        await client.chat.postMessage({
          channel: dm.channel.id,
          text: `Your lead was saved ✅ but the message couldn't be posted as you.\nConnect your account once so future messages appear from you: ${connectUrl}`,
        });
      }
      console.log(`[bot] posted summary to ${channelName}`);
    } catch (err) {
      console.error(`[bot] failed to post message:`, err?.data?.error ?? err.message);
    }
  });

  // ── Plain-text message listener (fallback for typed messages) ─────────────
  slackApp.message(async ({ message, client }) => {
    if (message.subtype) return;
    if (watchChannels.length && !watchChannels.includes(message.channel)) return;

    let channelName = message.channel;
    try {
      const info = await client.conversations.info({ channel: message.channel });
      channelName = `#${info.channel.name}`;
    } catch (_) {}

    const entry = parseMessage(message.text ?? '', {
      ts:      message.ts,
      channel: channelName,
      user:    message.user,
    });

    if (!entry.valid) {
      console.log(`[bot] ignored message — missing: ${entry.missing.join(', ')}`);
      return;
    }

    addEntry(entry);
    console.log(`[bot] message captured from ${channelName} (${entry.fields.type})`);
  });
}

// ── Modal definition ─────────────────────────────────────────────────────────
function buildModal(channelId) {
  return {
    type:             'modal',
    callback_id:      'new_lead_modal',
    private_metadata: JSON.stringify({ channelId }),
    title:  { type: 'plain_text', text: 'New Lead / Supplier' },
    submit: { type: 'plain_text', text: 'Add to CRM' },
    close:  { type: 'plain_text', text: 'Cancel' },
    blocks: [
      inputBlock('account_block', 'account', 'Account (Company) *', 'e.g. Limbazu Formaggi'),
      inputBlock('contact_block', 'contact', 'Contact Name *',      'e.g. Igors Aleksejevs'),
      inputBlock('title_block',   'title',   'Job Title',           'e.g. Export Manager',    true),
      inputBlock('email_block',   'email',   'Email *',             'name@company.com'),
      inputBlock('phone_block',   'phone',   'Phone *',             'e.g. +37126057829'),
      inputBlock('source_block',  'source',  'Source',              'e.g. Anuga, LinkedIn',    true),
      {
        type:     'input',
        block_id: 'type_block',
        label:    { type: 'plain_text', text: 'Type' },
        element:  {
          type:           'static_select',
          action_id:      'type',
          initial_option: { text: { type: 'plain_text', text: 'Lead' }, value: 'Lead' },
          options: [
            { text: { type: 'plain_text', text: 'Lead'     }, value: 'Lead'     },
            { text: { type: 'plain_text', text: 'Supplier' }, value: 'Supplier' },
          ],
        },
      },
      {
        type:     'input',
        block_id: 'notes_block',
        optional: true,
        label:    { type: 'plain_text', text: 'Notes' },
        element:  {
          type:        'plain_text_input',
          action_id:   'notes',
          multiline:   true,
          placeholder: { type: 'plain_text', text: 'Any additional notes…' },
        },
      },
    ],
  };
}

function inputBlock(blockId, actionId, label, placeholder, optional = false) {
  return {
    type:     'input',
    block_id: blockId,
    optional,
    label:    { type: 'plain_text', text: label },
    element:  {
      type:        'plain_text_input',
      action_id:   actionId,
      placeholder: { type: 'plain_text', text: placeholder },
    },
  };
}

// ── Express API + static frontend ────────────────────────────────────────────
const web = express();
web.use(cors());
web.use(express.json());
web.use(express.static(path.join(__dirname, 'public')));

// ── Slack OAuth (per-user connect) ───────────────────────────────────────────
web.get('/connect', (_req, res) => {
  const redirectUri = encodeURIComponent(`${process.env.APP_URL}/slack/callback`);
  res.redirect(
    `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}` +
    `&user_scope=chat:write&redirect_uri=${redirectUri}`
  );
});

web.get('/slack/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(`Authorization failed: ${error ?? 'no code'}`);
  try {
    const oauthClient = new WebClient();
    const result = await oauthClient.oauth.v2.access({
      client_id:     process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri:  `${process.env.APP_URL}/slack/callback`,
    });
    const userId    = result.authed_user.id;
    const userToken = result.authed_user.access_token;
    tokenStore.set(userId, userToken);
    console.log(`[oauth] stored token for user ${userId}`);
    res.send('<h2>✅ Connected! You can close this tab. Future /lead messages will be posted as you.</h2>');
  } catch (err) {
    console.error('[oauth] error:', err?.data?.error ?? err.message);
    res.status(500).send('OAuth exchange failed. Check server logs.');
  }
});

web.get('/api/entries', (req, res) => {
  const { type, search, limit = 50, offset = 0 } = req.query;
  let result = entries;
  if (type && type !== 'all') {
    result = result.filter(e => e.fields.type?.toLowerCase() === type.toLowerCase());
  }
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(e =>
      e.raw.toLowerCase().includes(q) ||
      Object.values(e.fields).some(v => String(v).toLowerCase().includes(q))
    );
  }
  res.json({ total: result.length, data: result.slice(Number(offset), Number(offset) + Number(limit)) });
});

web.delete('/api/entries/:id', (req, res) => {
  const idx = entries.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  entries.splice(idx, 1);
  res.json({ ok: true });
});

web.post('/api/entries/mock', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const entry = parseMessage(text, { ts: Date.now() / 1000 + '', channel: '#mock' });
  if (!entry.valid) {
    return res.status(422).json({ error: 'Missing required fields', missing: entry.missing, fields: entry.fields });
  }
  addEntry(entry);
  res.status(201).json(entry);
});

// ── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;

(async () => {
  if (slackApp) {
    await slackApp.start();
    console.log('[slack] Socket Mode connected');
  } else {
    console.log('[slack] No credentials — running in mock-only mode');
  }
  web.listen(PORT, () => console.log(`[web]   Admin dashboard → http://localhost:${PORT}`));
})();
