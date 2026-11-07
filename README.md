# groovehq-mcp

Talk to your [Groove](https://groovehq.com) inbox from Claude or any other MCP client. Find that one ticket from three weeks ago, read the whole thread, reply, leave a note for a colleague, and close it, all without opening a single tab.

## What you can do with it

Ask in plain words, for example:

- *"What came in today that still needs an answer?"*
- *"Summarize ticket #12345, including the PDF the customer attached."*
- *"Which tickets did I reply to last month that are still open?"*
- *"Write a draft reply based on our standard answer about refunds, and ask Sam in a note to check it."*
- *"What did customers ask about most this month, and which questions could a help article answer?"*
- *"How did the support team handle complaints this month, and what went well?"*
- *"Why did this ticket get the urgent tag?"*

Claude searches, reads whole threads and their attachments, writes drafts and notes, and keeps tickets tidy: assigning, tagging, closing, and merging duplicates. Sending email is off until you turn it on.

## Installation

You'll need a Groove API token. Grab it here, with your own subdomain filled in:

```
https://YOUR_SUBDOMAIN.groovehq.com/settings/developer/api
```

### Claude Code on your computer

You'll need Node.js 22 or newer. Add the server, and restart Claude Code:

```bash
claude mcp add groovehq-mcp -s user -e GROOVE_API_TOKEN=your_token_here -e GROOVE_READ_ONLY=1 -- npx -y groovehq-mcp
```

This starts read-only, the safest way to try it. Now ask something like *"what came in today that still needs an answer?"*. That's it.

To have Claude always ask before it sends mail, even in auto mode, add the tools that send to `permissions.ask` in your Claude Code settings:

```json
{
  "permissions": {
    "ask": [
      "mcp__groovehq-mcp__sendMessage",
      "mcp__groovehq-mcp__createConversation",
      "mcp__groovehq-mcp__forwardConversation"
    ]
  }
}
```

### Claude Code on the web

Cloud sessions start fresh each time, so set Groove up once in a [cloud environment](https://code.claude.com/docs/en/cloud-environments):

1. **Network access:** choose Custom, allow `api.groovehq.com` and `files.groovehq.com`, and keep the default package managers so `npx` can install the package.
2. **Environment variables:** add `GROOVE_API_TOKEN=your_token_here`. Anyone who uses the environment can read it, so keep the environment to yourself.
3. **Setup script:** paste this, and put your own instructions where it says so.

```bash
#!/bin/bash
set -e

# Groove as an MCP server. GROOVE_API_TOKEN comes from the environment variables.
# Starts read-only; replace GROOVE_READ_ONLY=1 with GROOVE_ALLOW_SEND=1 to let Claude send mail.
claude mcp add groovehq-mcp -s user -e GROOVE_READ_ONLY=1 -- npx -y groovehq-mcp@latest

# Always ask before sending mail, also in auto mode
mkdir -p ~/.claude
f=~/.claude/settings.json; [ -f "$f" ] || echo '{}' > "$f"
jq '.permissions.ask = ((.permissions.ask // []) + [
  "mcp__groovehq-mcp__sendMessage",
  "mcp__groovehq-mcp__createConversation",
  "mcp__groovehq-mcp__forwardConversation"
] | unique)' "$f" > "$f.tmp" && mv "$f.tmp" "$f"

# Instructions for Claude in every session of this environment
cat >> ~/.claude/CLAUDE.md <<'EOF'
## Groove
- "Mailbox" and "tickets" mean Groove, through the groovehq-mcp tools.
- Never send, reply to, or forward anything unless I ask for it in my latest message. Show me the text and the recipient first.
- <your own instructions, for example which mailbox to use or which tickets to show by default>
EOF
```

New sessions in that environment have Groove ready.

### Other clients

Using a different MCP client? Have it run `npx -y groovehq-mcp` and set `GROOVE_API_TOKEN` in its environment. claude.ai and the Claude apps can't start a server on your computer: they need a hosted one (see [Use as a library](#use-as-a-library)).

> **Heads up:** the package is `groovehq-mcp`, with the `hq`. `groove-mcp` is the [one this fork started from](#why-this-fork).

### Defaults and the token

**What's on without settings.** Without `GROOVE_READ_ONLY=1`, Claude can also change, assign, tag, close, merge, move, and delete tickets, mark them as spam, delete contacts, and save drafts. It can't send email or delete anything for good until you turn that on below.

**About the token.** A token belongs to one Groove agent and can do everything that agent can. Everything Claude does shows up in Groove under that agent's name. For a setup that others share, consider a separate Groove agent for it. On your computer, `claude mcp add` saves the token as plain text in `~/.claude.json`, readable only by your own user account.

### Settings

| Setting | Default | What it does |
|---|---|---|
| `GROOVE_READ_ONLY` | `0` | `1` leaves out every tool that writes, including drafts |
| `GROOVE_ALLOW_SEND` | `0` | `1` adds the tools that send mail: `sendMessage`, `createConversation`, `forwardConversation` and `undoSend` |
| `GROOVE_ALLOW_SEND_AS` | `0` | `1` lets mail and notes go out as a colleague, with `authorId` |
| `GROOVE_ALLOW_MERGE` | `1` | `0` turns off merging tickets and contacts |
| `GROOVE_ALLOW_PERMANENT_DELETE` | `0` | `1` adds `deleteConversationPermanently` |
| `GROOVE_ALLOW_ATTACHMENTS` | `0` | `1` lets mail and notes carry files, from a link or as base64 |
| `GROOVE_READ_ATTACHMENTS` | `1` | `0` leaves out `getAttachment` |
| `GROOVE_API_URL` | Groove's own | Only for a different Groove API address; it must be `https` |

Settings take only `1` or `0`. Anything else, like `true`, stops the server, so a typo can't leave a safety setting off. Read-only always wins over the settings that write.

## What you get

Groove's API calls tickets *conversations*, mailboxes *channels*, and colleagues *agents*. Tool names follow Groove; this README says ticket, mailbox, and colleague.

<details>
<summary>All 47 tools</summary>

**Tickets**

- `listConversations`: search and filter tickets on almost anything Groove can filter on, such as keyword, state, agent, team, contact, tag, Smart Folder, or date, sort them, and get the total in one call
- `listConversationAuthors`: who replied or left a note, and in which tickets, with the same filters as `listConversations` plus a date range for the messages themselves. Groove can't filter on this, so the server reads the tickets, 40 per request, and returns totals per agent instead of the threads. It reads up to 1,000 tickets on its own, and asks first above that
- `getConversation`: get one ticket
- `listLinkedResources`, `linkResource`: see and add links from a ticket to items in other systems, such as Jira issues
- `createConversation`: start a new ticket by sending an email, in a chosen `state`
- `logConversation`: Groove's Log a Conversation. Start a ticket with an internal note, for example after a phone call. It never sends mail
- `updateConversation`: change the state, subject, contact, or mailbox, mark a ticket unread, star or follow it, assign or unassign someone, or add or remove tags
- `closeConversation`: the most satisfying one
- `mergeConversations`: merge one ticket into another. This can't be undone
- `forwardConversation`: forward a ticket by email. The ticket stays as it was
- `deleteConversation`, `restoreConversation`: delete a ticket and bring it back
- `deleteConversationPermanently`: delete a ticket for good
- `markAsSpam`: mark a ticket as spam

**Messages**

- `listMessages`: every message and note on a ticket, oldest first. Ask for only the first or last few, and for plain text without the HTML
- `getAttachment`: read an attachment from `listMessages`, up to 10 MB. PDF, Word, Excel and PowerPoint files come back as text, images as images, and a zip as a list of its files
- `getRawEmail`: the original email behind a message, with all its headers, to check where a mail really came from
- `sendMessage`: send an email reply
- `undoSend`: cancel a mail right after sending it
- `moveMessageToNewTicket`: take one message out of a ticket and make it a new ticket
- `createNote`: leave an internal note, and tag colleagues with `mentionAgentIds` so they get a notification
- `editNote`, `reactToNote`, `deleteNote`: change, react to, or remove an internal note
- Attach files to mail, notes, and logged tickets with `attachments`, from a public `https` link or as base64. At most 25 per message, up to 20 MB each. Base64 goes through the model, so it suits small files. Off by default
- `createReplyDraft`: save a reply or note as a draft for someone to review. It never sends
- `listCannedReplies`: the team's saved replies, to reuse their wording in a reply or draft
- `listDrafts`, `deleteDraft`: see and remove your own drafts

**Everything else**

- `listContacts`, `getContact`, `createContact`, `updateContact`
- `getContactProfile`: the extra details your own integration shows next to a contact in Groove, as plain text
- `mergeContacts`: merge a typo or duplicate contact into the right one. This can't be undone
- `deleteContact`: delete a contact without tickets, which also removes it from recipient suggestions. This can't be undone
- `listCompanies`, `updateCompany`: find companies, and change a company's name or extra domains
- `listAgents`, `getAgent`: colleagues, the teams they're in, and the username to tag them with
- `listChannels`, `getChannel`
- `listFolders`: see the Smart Folders you can use in `listConversations`
- `listRules`: read Groove's automatic rules, to see why a ticket got a tag, an assignee, or a status
- `listTags`, `listTeams`. With `includeMembers`, `listTeams` also lists who is in each team
- `searchKbArticles`

Published knowledge base articles also show up as MCP resources.

</details>

Tickets go by their number, just like in Groove. `12345`, `#12345`, and `cnv_12345` all work.

## Use as a library

You can run the same tools over your own transport, for example in a Cloudflare Worker. `createGrooveServer` returns a new MCP `Server` and connects nothing itself:

```ts
import { createGrooveServer } from 'groovehq-mcp/server';

const server = createGrooveServer({ token: 'your_token_here', readOnly: true });
```

The other options are the settings above, as booleans: `readOnly`, `allowSend`, `allowSendAs`, `allowMerge`, `allowPermanentDelete`, `allowAttachments` and `readAttachments`, plus `apiUrl`. They have the same defaults, so without options the tools that write, merge and delete are there. Options must be real booleans: anything else, like the string `'true'`, throws an error.

The library doesn't read the `GROOVE_` settings, so pass each option yourself. It also has no login, so a hosted server has two options: keep one token on the server and put your own authentication in front of it, or have each user send their own Groove API token and pass that to `createGrooveServer`.

## Handle with care

This server can send real email to real customers. A few things limit what can go wrong:

- **Recipients are always explicit.** Mail only goes to the `to`, `cc` and `bcc` you give. Nothing goes to a default.
- **A mail to many people asks first.** More than 5 recipients in one mail needs `confirm: true`; more than 50 is refused.
- **Acting as a colleague is checked.** With `authorId`, the server first checks that the colleague exists and is active, because Groove would otherwise quietly use the token's owner.
- **Links carry a risk.** With attachments on, the server fetches links itself, so a model misled by a customer email could put ticket data in a link to an outside server. Only `https` links are fetched, and the server refuses a name that points to a private address, also after a redirect. The download looks the name up again, so a name that changes in between (DNS rebinding) can still get through. Where Node's `dns` module is missing, as in a Cloudflare Worker, only the address itself is checked.
- **Attachments can contain instructions.** Text in a file comes from whoever sent it, just like an email. `getAttachment` only reads Groove's own download links and never sends your token. Anyone with such a link can download the file, so treat the links like the files.
- **Spam reaches past one ticket.** Groove blacklists the sender, so their future mail to any mailbox is spam too, until you remove the address in Groove's settings. That's why `markAsSpam` first shows the ticket and the address, and only runs with `confirm: true`.
- **Merging is permanent.** Only the target ticket stays. `mergeConversations` and `mergeContacts` first show both sides and only run with `confirm: true`; `mergeConversations` also refuses tickets with different contacts unless told otherwise.
- **Deleting shows first.** Deleting a ticket, a contact or a note first shows what would go, and only runs with `confirm: true`. A deleted ticket goes to the trash and can be restored; deleting one for good needs its own setting. A deleted contact is gone for good, so contacts with tickets can't be deleted at all: merge them first.
- **Moves keep access.** `updateConversation` won't move a ticket to a mailbox your token can't reach, because you couldn't read it or move it back. The model may only override this after asking you.
- **Updates can stop halfway.** Groove has no all-or-nothing update. If `updateConversation` fails partway, the error says which steps already went through.

Sending a draft from Groove may close the ticket, depending on your Groove settings.

Your MCP client will usually ask before a tool runs. Every tool is labeled as read, additive, or destructive, so clients like claude.ai can set approval per group. Tools that send mail are destructive too, and only exist with `GROOVE_ALLOW_SEND=1`; whether your client asks before each send is your client's setting.

## Good to know

- **The docs don't cover everything.** Everything here uses Groove's documented GraphQL API, but details like the draft format and what a merge keeps come from testing on a live account.
- **Live chat isn't supported.** Groove's API gives no access to chat messages. Messages from the widget's contact form are normal tickets and work.
- **Drafts are personal.** They belong to the agent who owns the API token, and only work on existing tickets.
- **Smart Folders follow the token.** You see the folders that the token's agent can open, so personal ones like Mine are that agent's.
- **Deleted and moved messages can still show up.** Groove can return deleted notes, mail moved to another ticket, and undone mail as an empty message.
- **Companies come from mail domains.** Groove creates them by itself, often without a name, and a contact can have several. `updateContact` adds or removes one and keeps the others, and it also manages extra email addresses.
- **Finding an agent's tickets is slow.** Groove has no author filter, so `listConversationAuthors` reads every matching ticket. A year of a busy mailbox is a few hundred requests.
- **0 tickets doesn't always mean unused.** A contact's mail can sit in someone else's ticket after a merge. Deleting that contact leaves the mail without its sender, and there's no practical way to check this beforehand.

## Why this fork

This fork started because Claude couldn't find tickets. With the [christiangenco/groove-mcp](https://github.com/christiangenco/groove-mcp) package, most lookups failed, and [ebenpaul/groovehq-mcp](https://github.com/ebenpaul/groovehq-mcp) had no keyword search. Both use Groove's older REST API for tickets. This one is rebuilt on Groove's GraphQL API, and every release is tested against a live account.

## Development

```bash
git clone https://github.com/purplebite/groovehq-mcp.git
cd groovehq-mcp
npm install
npm run build

npm run dev        # rebuild on change
npm run typecheck  # check types
npm run lint       # check the code
npm test           # run the tests against a stand-in for Groove
```

The code is small and easy to find your way around: each tool is defined in `src/tools/`, `src/server.ts` lists them and checks every call, and all the GraphQL lives in `src/utils/graphql-queries.ts`.

## Testing

`scripts/live-test.mjs` runs the real server against a real account. Without a flag it checks every read tool, changes nothing, and prints only counts and ticket numbers:

```bash
GROOVE_API_TOKEN=your_token_here npm run test:live
```

Add a flag to test tools that write. These change real data, so use a test mailbox and an address you own. `--write`, `--merge` and `--tickets` ask first; the others start right away.

| Flag | What it does | Also needs |
|---|---|---|
| `--write` | sends 2 test mails, creates one ticket and closes it again | `GROOVE_TEST_TO`, `GROOVE_TEST_CHANNEL` |
| `--drafts` | saves and deletes test drafts, sends nothing | `GROOVE_TEST_TICKET`, a ticket you own |
| `--update` | changes a ticket whose subject starts with `[TEST]`, and puts it back | – |
| `--merge` | sends 3 test mails and merges those tickets | `GROOVE_TEST_TO`, `GROOVE_TEST_CHANNEL` |
| `--contacts` | creates and deletes test contacts, and checks that a contact with tickets can't be deleted. Sends nothing | `GROOVE_TEST_TO`, an address that already has tickets |
| `--tickets` | sends 8 test mails, two of them in the name of a random active colleague, and changes and deletes test tickets | `GROOVE_TEST_TO`, `GROOVE_TEST_CHANNEL` |

## License

MIT. Original work by [Christian Genco](https://github.com/christiangenco). Thanks for the head start!
