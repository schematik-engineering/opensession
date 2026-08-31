# Discord

OpenSession's Discord integration uses the official Discord Gateway and REST
API. It does not expose a Discord webhook endpoint, add a public route, or need
a second hostname. The bot creates ordinary OpenSession sessions, pins them to
the Docker sandbox, and links each Discord DM/channel/thread to one durable
OpenSession transcript.

## Discord application

1. Create an application and bot in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. In **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
   The integration identifies with `GUILDS`, `GUILD_MESSAGES`,
   `DIRECT_MESSAGES`, and `MESSAGE_CONTENT` (integer `37377`).
3. Install the bot into the internal guild with `bot` and
   `applications.commands` scopes. The minimum requested permission bitfield is
   `309237713920`: View Channels, Send Messages, Read Message History, Create
   Public Threads, and Send Messages in Threads.

The corresponding install URL is:

```text
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&permissions=309237713920&scope=bot%20applications.commands
```

No redirect URI or Interaction Endpoint URL is needed. Slash-command
interactions arrive over the Gateway.

## Server configuration

Write the token to a private file instead of the environment:

```sh
install -d -m 700 ~/.opensession/discord
install -m 600 /dev/stdin ~/.opensession/discord/bot-token
```

Then configure `~/.opensession.env`:

```dotenv
ENABLE_DISCORD_AGENT=true
DISCORD_APPLICATION_ID=123456789012345678
DISCORD_BOT_TOKEN_FILE=/home/ubuntu/.opensession/discord/bot-token
DISCORD_GUILD_IDS=123456789012345678
DISCORD_CHANNEL_IDS=123456789012345678,234567890123456789
DISCORD_ROLE_IDS=345678901234567890
DISCORD_DEFAULT_MODEL=grok/grok-4.6
```

`DISCORD_GUILD_IDS` is required and startup fails closed without it. The token
file must be a private regular file (mode `0600` or stricter).

Optional boundaries:

| Variable                      | Effect                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_CHANNEL_IDS`         | Comma-separated parent/channel allowlist. Linked child threads inherit an allowed parent's access. Empty means every channel in an allowed guild. |
| `DISCORD_ROLE_IDS`            | Comma-separated guild role allowlist. When present, guild messages and commands require at least one listed role. Direct messages fail closed.    |
| `DISCORD_USER_IDS`            | Comma-separated user allowlist. When present it also restricts guild use; direct messages fail closed unless the sender is listed.                |
| `DISCORD_DEFAULT_MODEL`       | Model for newly linked sessions. Existing sessions retain their own model.                                                                        |
| `DISCORD_RESPONSE_TIMEOUT_MS` | How long Discord waits for a final response before linking to the still-running OpenSession (30 minutes by default).                              |

The equivalent config-file keys live under `integrations.discord`, using
`applicationId`, `botTokenFile`, `guildIds`, `channelIds`, `roleIds`, `userIds`,
`defaultModel`, and `responseTimeoutMs`. Environment variables win.

`DISCORD_BOT_TOKEN` is supported for secret-manager environments that cannot
project a file, but a mode-0600 file is the self-hosted default. Neither the
token nor an interaction token is written to the Discord state file, run
specs, transcripts, logs, or command arguments.

## User surface

- The primary interaction is conversational: mention the bot in a guild text
  channel to create a fresh linked public thread and Docker-backed OpenSession.
  A prior `/os ask` link on the parent channel is never reused by a new mention.
  Thread creation is required; a failed thread create reports the error instead
  of silently reusing a parent-channel session.
- When the mention replies to another Discord message, the first OpenSession
  turn includes that exact message's author, text, attachments, message link,
  and bounded recent channel context. Reply and channel context are labelled as
  untrusted data before reaching the session.
- Discord sessions always use OpenSession **Code** mode. Ordinary tool calls
  are approved by the existing Code-mode permission engine instead of pausing
  the thread. Legacy Ask-mode links are retired on restart and the next prompt
  creates a Code-mode session. Global denied and confirmation-gated tool policy
  still applies.
- Anyone permitted by the guild/channel/role/user boundaries can reply in that
  thread to continue the same transcript. Each turn is attributed to that
  Discord user's display name, and no bot mention is required. OpenSession-owned
  threads are recognized after a restart even while their session link is being
  created. If the model asks a question, the reply answers the pending
  OpenSession question.
- `/os ask` starts or continues the channel's session.
- `/os model` switches between the configured Grok and Cursor subscription
  models.
- `/os status`, `/os stop`, and `/os new` are optional controls to inspect,
  cancel, or unlink it.
- Direct messages are supported only for explicitly allowlisted user IDs.

All outbound messages suppress parsed mentions and are split below Discord's
2,000-character limit. Accepted message payloads are persisted before the
Gateway sequence advances. Inbound event IDs, pending intake, Gateway resume
state, and channel → session links are persisted atomically in
`~/.opensession/discord/state.json` (mode 0600), so reconnects and restarts do
not lose or duplicate a prompt. Outbound status and answer messages use
deterministic Discord nonces so replaying accepted intake does not duplicate
delivered chunks either.

## Verification

After restarting OpenSession, `/health` should report the Discord agent with a
`ready` Gateway, the expected bot identity, and registered guild commands.
Run `/os status` in an allowed channel, then mention the bot with a small
request. Verify that Discord creates/updates the thread response and that the
linked `/session/<id>` opens the same transcript in the web UI.
