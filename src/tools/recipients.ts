// A mail to a few people is normal helpdesk work; one to many is worth a look, and one to a crowd is a mistake
export const ASK_ABOVE = 5;
export const MOST_RECIPIENTS = 50;

export const RECIPIENTS_CONFIRM = `send this mail to more than ${ASK_ABOVE} people`;

interface Recipients {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  confirm?: boolean;
}

// Counts every address of a mail, and refuses a crowd or, without confirm, more than a few
export function checkRecipients(args: Recipients): void {
  const to = Array.isArray(args.to) ? args.to : [args.to];
  const cc = args.cc ?? [];
  const bcc = args.bcc ?? [];
  const count = to.length + cc.length + bcc.length;
  if (count > MOST_RECIPIENTS) {
    throw new Error(`Not sent: this mail would go to ${count} people, and more than ${MOST_RECIPIENTS} is refused. Split it up`);
  }
  if (count > ASK_ABOVE && args.confirm !== true) {
    throw new Error(
      `Not sent: this mail would go to ${count} people (${to.length} to, ${cc.length} cc, ${bcc.length} bcc). ` +
        'Tell the user, and pass confirm: true only after they agreed'
    );
  }
}
