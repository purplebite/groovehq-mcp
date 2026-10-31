# groovehq-mcp

Talk to your [Groove](https://groovehq.com) inbox from Claude or any other MCP client. Find that one ticket from three weeks ago, read the whole thread, reply, leave a note for a colleague, and close it, all without opening a single tab.

## Why this fork exists

We started this because Claude couldn't find our tickets. The npm package of [christiangenco/groove-mcp](https://github.com/christiangenco/groove-mcp) fails on nearly every lookup, and [ebenpaul/groovehq-mcp](https://github.com/ebenpaul/groovehq-mcp) has no keyword search.

Both repos use Groove's REST API for conversations. This one runs on GraphQL only, and it's tested against a live account.

## What you get

**Tickets**

- `listConversations`: search and filter by keyword, state, agent, team, contact, channel, or tag
- `getConversation`: get one ticket
- `createConversation`: start a new ticket by sending an email
- `updateConversation`: change the state, assign someone, or add tags
- `closeConversation`: the most satisfying one

**Messages**

- `listMessages`: every message and note on a ticket, oldest first
- `sendMessage`: send an email reply
- `createNote`: leave an internal note
- `createReplyDraft`: save a reply or note as a draft for someone to review. It never sends
- `listDrafts`, `deleteDraft`: see and remove your own drafts

**Everything else**

- `listContacts`, `getContact`, `createContact`, `updateContact`
- `listAgents`, `getAgent`
- `listChannels`, `getChannel`
- `listTags`, `listTeams`
- `searchKbArticles`

Published knowledge base articles also show up as MCP resources.

Tickets go by their number, just like in Groove. `12345`, `#12345`, and `cnv_12345` all work.

## Installation

You'll need Node.js 18 or newer and a Groove API token. Grab your token here, with your own subdomain filled in:

```
https://YOUR_SUBDOMAIN.groovehq.com/settings/developer/api
```

Then add it to Claude Code:

```bash
claude mcp add groovehq-mcp -s user -e GROOVE_API_TOKEN=your_token_here -- npx -y groovehq-mcp
```

To let Claude send email, add `-e GROOVE_ALLOW_SEND=1`. Without it, Claude can still save drafts.

Restart Claude Code, then ask it something like *"show me the open tickets about invoices"*. That's it.

Using a different MCP client? Have it run `npx -y groovehq-mcp` and set `GROOVE_API_TOKEN` in its environment.

> **Heads up:** the package is `groovehq-mcp`, with the `hq`. `groove-mcp` doesn't work.

## Handle with care

This server can send real email to real customers. A few things keep that honest:

- **Sending is off by default.** `sendMessage` and `createConversation` only appear when you set `GROOVE_ALLOW_SEND=1`.
- **Read-only mode.** Set `GROOVE_READ_ONLY=1` to leave out every tool that writes, including drafts.
- **Recipients are always explicit.** `createConversation` and `sendMessage` require a `to` address, and nothing is sent to a default.
- **Failed updates tell you what happened.** Groove has no all-or-nothing update, so `updateConversation` can succeed halfway. When it does, the error says which steps already went through.

Sending a draft from Groove may close the ticket, depending on your Groove settings.

Your MCP client will usually ask before a tool runs. For sending mail, it's a good idea to keep it that way.

## Good to know

- **Some of this API is undocumented.** Sending mail and adding notes are in the official docs. The read queries (`conversations` and `events`) aren't, but Groove's own web app uses them.
- **Not tested with everything.** Our account only has email tickets and no knowledge base articles, so chat, widget, knowledge base search haven't been tried with real data.
- **Drafts are personal.** They belong to the agent who owns the API token, and they only work on existing tickets.
- **Some things aren't in here yet.** You can't send attachments, use cc and bcc when sending directly, remove tags, unassign a ticket, or set a contact's company.

## Development

```bash
git clone https://github.com/purplebite/groovehq-mcp.git
cd groovehq-mcp
npm install
npm run build

npm run dev        # rebuild on change
npm run typecheck  # check types
```

The code is small and easy to find your way around: tools live in `src/tools/`, and all the GraphQL lives in `src/utils/graphql-queries.ts`.

## Testing

`scripts/live-test.mjs` runs the real server against a real account and checks every read tool. It changes nothing and prints only counts and ticket numbers:

```bash
GROOVE_API_TOKEN=your_token_here npm run test:live
```

To test the tools that write, add `--write`. It asks first, then sends 2 real mails to `GROOVE_TEST_TO` and creates one ticket that it closes again:

```bash
GROOVE_API_TOKEN=your_token_here GROOVE_TEST_TO=you@example.com GROOVE_TEST_CHANNEL=ch_123 npm run test:live -- --write
```

To test drafts, add `--drafts` and set `GROOVE_TEST_TICKET` to a ticket you own. It saves and deletes test drafts and sends nothing:

```bash
GROOVE_API_TOKEN=your_token_here GROOVE_TEST_TICKET=12345 npm run test:live -- --drafts
```

## License

MIT. Original work by [Christian Genco](https://github.com/christiangenco). Thanks for the head start!
