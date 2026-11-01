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
- `updateConversation`: change the state, assign or unassign someone, or add or remove tags
- `closeConversation`: the most satisfying one
- `mergeConversations`: merge one ticket into another. This can't be undone

**Messages**

- `listMessages`: every message and note on a ticket, oldest first
- `sendMessage`: send an email reply
- `createNote`: leave an internal note
- `createReplyDraft`: save a reply or note as a draft for someone to review. It never sends
- `listDrafts`, `deleteDraft`: see and remove your own drafts

**Everything else**

- `listContacts`, `getContact`, `createContact`, `updateContact`
- `mergeContacts`: merge a typo or duplicate contact into the right one. This can't be undone
- `deleteContact`, `deleteContacts`: delete contacts without tickets, which also removes them from recipient suggestions. This can't be undone
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

## Use as a library

You can run the same tools over your own transport, for example in a Cloudflare Worker. `createGrooveServer` returns a new MCP `Server` and connects nothing itself:

```ts
import { createGrooveServer } from 'groovehq-mcp/server';

const server = createGrooveServer({ token: 'your_token_here', readOnly: true });
```

`allowSend`, `allowMerge`, `allowContactDelete`, and `apiUrl` are optional too. Sending stays off unless you set `allowSend: true`, merging and deleting contacts stay on unless you set them to `false`, and `readOnly` always wins.

## Handle with care

This server can send real email to real customers. A few things keep that honest:

- **Sending is off by default.** `sendMessage` and `createConversation` only appear when you set `GROOVE_ALLOW_SEND=1`.
- **Read-only mode.** Set `GROOVE_READ_ONLY=1` to leave out every tool that writes, including drafts.
- **Recipients are always explicit.** `createConversation` and `sendMessage` require a `to` address, and nothing is sent to a default.
- **Merging is permanent.** Only the target ticket stays, with its own contact, subject, and assignee. Replies and notes move over, tags are combined, and an open ticket reopens the target. `mergeConversations` is marked as destructive, and it refuses tickets with different contacts or your own drafts on the merged ticket unless told otherwise. Set `GROOVE_ALLOW_MERGE=0` to turn off merging tickets and contacts.
- **Deleting contacts is permanent.** A contact with tickets can't be deleted, so move those first with `mergeContacts`. Both delete tools only show what they would do until you pass `confirm: true`, and `deleteContacts` takes at most 100 contacts per call. Set `GROOVE_ALLOW_CONTACT_DELETE=0` to turn deleting off.
- **Failed updates tell you what happened.** Groove has no all-or-nothing update, so `updateConversation` can succeed halfway. When it does, the error says which steps already went through.

Sending a draft from Groove may close the ticket, depending on your Groove settings.

Your MCP client will usually ask before a tool runs. For sending mail, it's a good idea to keep it that way.

## Good to know

- **Some of this API is undocumented.** Sending mail and adding notes are in the official docs. The read queries (`conversations` and `events`) aren't, but Groove's own web app uses them.
- **Not tested with everything.** Our account only has email tickets and no knowledge base articles, so chat, widget, knowledge base search haven't been tried with real data.
- **Drafts are personal.** They belong to the agent who owns the API token, and they only work on existing tickets.
- **Merged messages don't get sorted.** Groove adds them to the end of the ticket with their original dates, while `listMessages` always sorts by date.
- **0 tickets doesn't always mean unused.** A contact's mail can sit in someone else's ticket after a merge. If you delete that contact, the mail stays but no longer shows who wrote it, and there's no practical way to check beforehand which contacts this affects.
- **Orphans come in batches.** `listContacts` with `orphansOnly` reads at most 500 contacts per call. Call it again for more, but Groove's list isn't strictly sorted and can repeat contacts, so there's no guarantee you've seen them all.
- **Some things aren't in here yet.** You can't send attachments, use cc and bcc when sending directly, or set a contact's company.

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

To test changes to a ticket, add `--update`. It finds a ticket whose subject starts with `[TEST]`, changes its tags and assignee, and puts them back. If you don't have one yet, run `--write` once:

```bash
GROOVE_API_TOKEN=your_token_here npm run test:live -- --update
```

To test merging, add `--merge`. It asks first, then sends 3 real mails to `GROOVE_TEST_TO` and a plus address of it, and merges those tickets into one that it closes again:

```bash
GROOVE_API_TOKEN=your_token_here GROOVE_TEST_TO=you@example.com GROOVE_TEST_CHANNEL=ch_123 npm run test:live -- --merge
```

To test contacts, add `--contacts` and set `GROOVE_TEST_TO` to an address that has tickets. It creates and deletes contacts on plus addresses of it and sends nothing:

```bash
GROOVE_API_TOKEN=your_token_here GROOVE_TEST_TO=you@example.com npm run test:live -- --contacts
```

## License

MIT. Original work by [Christian Genco](https://github.com/christiangenco). Thanks for the head start!
