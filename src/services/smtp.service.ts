/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { AttachmentInput } from '../safety/validation.js';
import { buildNodemailerAttachments, validateAttachments } from '../safety/validation.js';
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
      attachments?: AttachmentInput[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    if (options.attachments?.length) {
      await validateAttachments(options.attachments);
    }

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const mailOptions: Record<string, unknown> = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
    };

    if (options.attachments?.length) {
      mailOptions.attachments = buildNodemailerAttachments(options.attachments);
    }

    const result = await transport.sendMail(mailOptions);

    // Save a copy to the Sent folder via IMAP
    await this.saveSentCopy(accountName, account, {
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject: options.subject,
      body: options.body,
      html: options.html,
      messageId: result.messageId,
      attachments: options.attachments,
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
      attachments?: AttachmentInput[];
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
        attachments: options.attachments,
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
      attachments?: AttachmentInput[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    if (options.attachments?.length) {
      await validateAttachments(options.attachments);
    }

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

    const mailOptions: Record<string, unknown> = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(options.html ? { html: options.body } : { text: options.body }),
    };

    if (options.attachments?.length) {
      mailOptions.attachments = buildNodemailerAttachments(options.attachments);
    }

    const result = await transport.sendMail(mailOptions);

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
      attachments: options.attachments,
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
      attachments?: AttachmentInput[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    if (options.attachments?.length) {
      await validateAttachments(options.attachments);
    }

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = original.subject.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject}`;

    const fromLabel = original.from.name
      ? `${original.from.name} <${original.from.address}>`
      : original.from.address;
    const toLabel = original.to.map((a) => a.address).join(', ');

    // Plain-text forwarded body
    const forwardHeader = [
      '',
      '---------- Forwarded message ----------',
      `From: ${fromLabel}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${toLabel}`,
      '',
    ].join('\n');

    const originalText = original.bodyText ?? '';
    const fullBody = (options.body ?? '') + forwardHeader + originalText;

    const transport = await this.connections.getSmtpTransport(accountName);

    const mailOptions: Record<string, unknown> = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      text: fullBody,
    };

    // If the original carried HTML, forward an HTML version too so the
    // recipient sees correctly rendered content (mailparser has already
    // decoded base64/quoted-printable and charset for us).
    let htmlForwarded = false;
    if (original.bodyHtml) {
      const escapeHtml = (s: string) =>
        s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      const intro = options.body ? `<p>${escapeHtml(options.body).replace(/\n/g, '<br>')}</p>` : '';
      const htmlHeader = [
        '<div>',
        '---------- Forwarded message ----------<br>',
        `From: ${escapeHtml(fromLabel)}<br>`,
        `Date: ${escapeHtml(original.date)}<br>`,
        `Subject: ${escapeHtml(original.subject)}<br>`,
        `To: ${escapeHtml(toLabel)}<br>`,
        '</div><br>',
      ].join('');
      mailOptions.html = intro + htmlHeader + original.bodyHtml;
      htmlForwarded = true;
    }

    if (options.attachments?.length) {
      mailOptions.attachments = buildNodemailerAttachments(options.attachments);
    }

    const result = await transport.sendMail(mailOptions);

    // Save a copy to the Sent folder via IMAP
    await this.saveSentCopy(accountName, account, {
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      body: htmlForwarded ? (mailOptions.html as string) : fullBody,
      html: htmlForwarded,
      messageId: result.messageId,
      attachments: options.attachments,
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
