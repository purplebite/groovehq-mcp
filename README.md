# groovehq-mcp

Talk to your [Groove](https://groovehq.com) inbox from Claude or any other MCP client. Find that one ticket from three weeks ago, read the whole thread, reply, leave a note for a colleague, and close it, all without opening a single tab.

## Why this fork exists

We started this because Claude couldn't find our tickets. The npm package of [christiangenco/groove-mcp](https://github.com/christiangenco/groove-mcp) fails on nearly every lookup, and [ebenpaul/groovehq-mcp](https://github.com/ebenpaul/groovehq-mcp) has no keyword search.

Both repos use Groove's REST API for conversations. This one runs on GraphQL only, and it's tested against a live account.

## What you get

**Tickets**

- `listConversations`: search and filter by keyword, state, agent, team, contact, channel, or tag
- `getConversation`: get one ticket
- `createConversation`: start a new ticket by sending an email, in a chosen `state`
- `logConversation`: Groove's Log a Conversation. Start a ticket with an internal note, for example after a phone call. It never sends mail
- `updateConversation`: change the state, subject, contact, or mailbox, mark a ticket unread, spam, or trash, star or follow it, assign or unassign someone, or add or remove tags
- `closeConversation`: the most satisfying one
- `mergeConversations`: merge one ticket into another. This can't be undone
- `forwardConversation`: forward a ticket by email. The ticket stays as it was
- `deleteConversation`, `restoreConversation`: delete a ticket and bring it back

**Messages**

- `listMessages`: every message and note on a ticket, oldest first
- `sendMessage`: send an email reply
- `undoSend`: cancel a mail right after sending it
- `createNote`: leave an internal note
- `editNote`, `reactToNote`, `deleteNote`: change, react to, or remove an internal note
- Attach files to mail, notes, and logged tickets with `attachments`, from a public `https` link or as base64
- `createReplyDraft`: save a reply or note as a draft for someone to review. It never sends
- `listDrafts`, `deleteDraft`: see and remove your own drafts

**Everything else**

- `listContacts`, `getContact`, `createContact`, `updateContact`
- `mergeContacts`: merge a typo or duplicate contact into the right one. This can't be undone
- `deleteContact`, `deleteContacts`: delete contacts without tickets, which also removes them from recipient suggestions. This can't be undone
- `listCompanies`, `updateCompany`: find companies, and change a company's name or extra domains
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

`allowSend`, `allowSendAs`, `allowMerge`, `allowPermanentDelete`, and `apiUrl` are optional too. Sending, acting as a colleague, and permanent deletion stay off unless you set them to `true`, merging stays on unless you set `allowMerge: false`, and `readOnly` always wins.

## Handle with care

This server can send real email to real customers. A few things keep that honest:

- **Sending is off by default.** `sendMessage`, `createConversation`, `forwardConversation`, and `undoSend` only appear when you set `GROOVE_ALLOW_SEND=1`.
- **Read-only mode.** Set `GROOVE_READ_ONLY=1` to leave out every tool that writes, including drafts.
- **Recipients are always explicit.** `createConversation` and `sendMessage` require a `to` address, nothing is sent to a default, and `cc` and `bcc` are optional.
- **Acting as a colleague is off by default.** Mail and notes go out as the agent who owns the API token. Set `GROOVE_ALLOW_SEND_AS=1` to pass `authorId` to `createConversation`, `sendMessage`, `createNote`, or `logConversation`. The server first checks that this agent exists and is active, because Groove can otherwise use the token owner without saying so.
- **Attachments are checked first.** Links must use `https`, and local or private addresses are refused. Files can be up to 20 MB from a link or 5 MB as base64, with at most 25 per message.
- **Merging is permanent.** Only the target ticket stays, with its own contact, subject, and assignee. Replies and notes move over, tags are combined, and an open ticket reopens the target. `mergeConversations` is marked as destructive, and it refuses tickets with different contacts or your own drafts on the merged ticket unless told otherwise. Set `GROOVE_ALLOW_MERGE=0` to turn off merging tickets and contacts.
- **Deleting is limited.** A deleted ticket can always be restored, unless you set `GROOVE_ALLOW_PERMANENT_DELETE=1` and pass `permanent: true`. A deleted contact is gone for good, so contacts with tickets can't be deleted at all: merge them first with `mergeContacts`. Other contacts are only deleted with `confirm: true`, at most 100 per call.
- **Failed updates tell you what happened.** Groove has no all-or-nothing update, so `updateConversation` can succeed halfway. When it does, the error says which steps already went through.

Sending a draft from Groove may close the ticket, depending on your Groove settings.

Your MCP client will usually ask before a tool runs. For sending mail, it's a good idea to keep it that way.

## Good to know

- **The docs don't cover everything.** Everything here uses Groove's documented GraphQL API, but details like the draft format and what a merge keeps come from testing on a live account.
- **Not tested with everything.** Our account only has email tickets and no knowledge base articles, so chat, widget, knowledge base search haven't been tried with real data.
- **Drafts are personal.** They belong to the agent who owns the API token, and they only work on existing tickets.
- **Merged messages don't get sorted.** Groove adds them to the end of the ticket with their original dates, while `listMessages` always sorts by date.
- **0 tickets doesn't always mean unused.** A contact's mail can sit in someone else's ticket after a merge. If you delete that contact, the mail stays but no longer shows who wrote it, and there's no practical way to check beforehand which contacts this affects.
- **Orphans come in batches.** `listContacts` with `orphansOnly` reads at most 500 contacts per call. Call it again for more, but Groove's list isn't strictly sorted and can repeat contacts, so there's no guarantee you've seen them all.
- **Companies come from mail domains.** Groove creates them by itself, often without a name, and a contact can have several. `updateContact` adds or removes one and keeps the others, and it also manages extra email addresses.
- **Mailbox moves need access.** A ticket can't be moved to a mailbox your account can't reach, because you couldn't access the ticket afterwards.
- **`listMessages` can show too much.** Groove can still return deleted notes, mail moved to another ticket, and undone mail as an empty message.

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

To test ticket changes and attachments, add `--tickets`. It asks first, then sends 8 test mails to plus addresses of `GROOVE_TEST_TO`, two of them as a random active agent, and changes and deletes test tickets:

```bash
GROOVE_API_TOKEN=your_token_here GROOVE_TEST_TO=you@example.com GROOVE_TEST_CHANNEL=ch_123 npm run test:live -- --tickets
```

## License

MIT. Original work by [Christian Genco](https://github.com/christiangenco). Thanks for the head start!
