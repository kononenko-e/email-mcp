import { writeFile } from 'node:fs/promises';
import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

function createMockConnectionManager(mockTransport: ReturnType<typeof createMockTransport>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      fullName: 'Test User',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

function createMockImapService() {
  return {
    appendSent: vi.fn().mockResolvedValue(undefined),
  } as unknown as ImapService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    service = new SmtpService(connections, rateLimiter, createMockImapService());
  });

  describe('sendEmail', () => {
    it('sends email via SMTP transport', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
      });
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Test User" <test@example.com>',
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'World',
        }),
      );
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, createMockImapService());

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('includes CC and BCC when provided', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: 'cc1@example.com, cc2@example.com',
          bcc: 'bcc@example.com',
        }),
      );
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.html).toBe('<h1>Hello</h1>');
      expect(call.text).toBeUndefined();
    });

    it('includes attachments when provided', async () => {
      const tmpFile = '/tmp/test-attachment.pdf';
      await writeFile(tmpFile, Buffer.from('%PDF-1.4 fake pdf content'));
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'With attachment',
        body: 'See attached',
        attachments: [{ path: tmpFile, filename: 'report.pdf', contentType: 'application/pdf' }],
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toBeDefined();
      expect(call.attachments).toHaveLength(1);
      expect(call.attachments[0]).toEqual({
        filename: 'report.pdf',
        path: tmpFile,
        contentType: 'application/pdf',
      });
    });

    it('includes multiple attachments', async () => {
      const f1 = '/tmp/test-file1.pdf';
      const f2 = '/tmp/test-file2.jpg';
      await writeFile(f1, Buffer.from('%PDF-1.4'));
      await writeFile(f2, Buffer.from('\xff\xd8\xff\xe0'));
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Multiple files',
        body: 'See attached',
        attachments: [{ path: f1 }, { path: f2, filename: 'photo.jpg' }],
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toHaveLength(2);
      expect(call.attachments[0].path).toBe(f1);
      expect(call.attachments[1].path).toBe(f2);
      expect(call.attachments[1].filename).toBe('photo.jpg');
    });

    it('does not include attachments key when none provided', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'No attachments',
        body: 'Just text',
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toBeUndefined();
    });
  });
});
