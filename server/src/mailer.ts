// Email delivery. No SMTP provider is configured yet (see docs/decisions-and-limitations.md).

export type Mail = { to: string; subject: string; text: string };

export interface Mailer {
  readonly configured: boolean;
  send(mail: Mail): Promise<void>;
}

/** Development only: prints the message to the server console so reset links can be used locally. */
export class ConsoleMailer implements Mailer {
  readonly configured = true;
  async send(mail: Mail) {
    console.log(`\n[dev mail] To: ${mail.to}\nSubject: ${mail.subject}\n${mail.text}\n`);
  }
}

/** Production without SMTP: messages are not sent. Admins must issue reset links instead. */
export class DisabledMailer implements Mailer {
  readonly configured = false;
  private warn: (msg: string) => void;
  constructor(warn: (msg: string) => void) {
    this.warn = warn;
  }
  async send(mail: Mail) {
    this.warn(`Email not configured; message "${mail.subject}" was not sent.`);
  }
}

/** Tests: keeps messages in memory. */
export class MemoryMailer implements Mailer {
  readonly configured = true;
  readonly sent: Mail[] = [];
  async send(mail: Mail) {
    this.sent.push(mail);
  }
}
