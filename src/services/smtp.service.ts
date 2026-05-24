/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { SendResult } from '../types/index.js';
import type ImapService from './imap.service.js';

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
    });

    // Save a copy to the Sent folder via IMAP
    await this.saveSentCopy(accountName, account, {
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject: options.subject,
      body: options.body,
      html: options.html,
      messageId: result.messageId,
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  private async saveSentCopy(
    accountName: string,
    account: { email: string; fullName?: string },
    options: {
      to: string;
      cc?: string;
      subject: string;
      body: string;
      html?: boolean;
      messageId?: string;
      inReplyTo?: string;
      references?: string;
    },
  ): Promise<void> {
    try {
      await this.imapService.appendSent(accountName, {
        from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
        to: options.to,
        cc: options.cc,
        subject: options.subject,
        body: options.body,
        html: options.html,
        messageId: options.messageId,
        inReplyTo: options.inReplyTo,
        references: options.references,
      });
    } catch {
      // Non-critical: don't fail the send if Sent append fails
    }
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      body: string;
      replyAll?: boolean;
      html?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list
    const to = [original.from.address];
    const cc: string[] = [];

    if (options.replyAll) {
      // Add all original To recipients except ourselves
      original.to
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          to.push(addr.address);
        });
      // Add CC recipients except ourselves
      (original.cc ?? [])
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          cc.push(addr.address);
        });
    }

    // Build threading headers
    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(options.html ? { html: options.body } : { text: options.body }),
    });

    // Save a copy to the Sent folder via IMAP
    await this.saveSentCopy(accountName, account, {
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      body: options.body,
      html: options.html,
      messageId: result.messageId,
      inReplyTo: original.messageId,
      references: references.join(' '),
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = original.subject.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject}`;

    // Build forwarded message body
    const forwardHeader = [
      '',
      '---------- Forwarded message ----------',
      `From: ${original.from.name ? `${original.from.name} <${original.from.address}>` : original.from.address}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to.map((a) => a.address).join(', ')}`,
      '',
    ].join('\n');

    const originalBody = original.bodyText ?? original.bodyHtml ?? '';
    const fullBody = (options.body ?? '') + forwardHeader + originalBody;

    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      text: fullBody,
    });

    // Save a copy to the Sent folder via IMAP
    await this.saveSentCopy(accountName, account, {
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      body: fullBody,
      html: false,
      messageId: result.messageId,
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(accountName: string, draftId: number, mailbox?: string): Promise<SendResult> {
    this.checkRateLimit(accountName);

    // Fetch the draft via IMAP
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to,
      cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
    });

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    // Save a copy to the Sent folder via IMAP
    await this.saveSentCopy(accountName, account, {
      to,
      cc,
      subject: draft.subject,
      body: draft.bodyHtml ?? draft.bodyText ?? '',
      html: !!draft.bodyHtml,
      messageId: result.messageId,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }
}
