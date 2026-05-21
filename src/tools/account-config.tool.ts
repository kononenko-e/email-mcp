/**
 * MCP tools: list_account_configs, upsert_account_config, delete_account_config, test_account_config
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CONFIG_FILE,
  configExists,
  createDefaultRawConfig,
  loadRawConfig,
  normalizeRawAccount,
  saveConfig,
} from '../config/loader.js';
import type { RawAccountConfig, RawAppConfig } from '../config/schema.js';
import { AppConfigFileSchema } from '../config/schema.js';
import ConnectionManager from '../connections/manager.js';
import type OAuthService from '../services/oauth.service.js';
import type WatcherService from '../services/watcher.service.js';

const ImapSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  tls: z.boolean().default(true),
  starttls: z.boolean().default(false),
  verify_ssl: z.boolean().default(true),
});

const SmtpPoolSchema = z.object({
  enabled: z.boolean().default(true),
  max_connections: z.number().int().min(1).default(1),
  max_messages: z.number().int().min(1).default(100),
});

const SmtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(465),
  tls: z.boolean().default(true),
  starttls: z.boolean().default(false),
  verify_ssl: z.boolean().default(true),
  pool: SmtpPoolSchema.default({
    enabled: true,
    max_connections: 1,
    max_messages: 100,
  }),
});

const OAuth2Schema = z.object({
  provider: z.enum(['google', 'microsoft', 'custom']),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  token_url: z.string().url().optional(),
  auth_url: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
});

const AccountInputSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email(),
    full_name: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    oauth2: OAuth2Schema.optional(),
    imap: ImapSchema,
    smtp: SmtpSchema,
  })
  .refine((data) => data.password ?? data.oauth2, {
    message: 'Either password or oauth2 must be provided',
  });

interface RuntimeState {
  connections: ConnectionManager;
  watcherService: WatcherService;
}

function maskSecret(secret?: string): string | undefined {
  if (!secret) return undefined;
  if (secret.length <= 4) return '*'.repeat(secret.length);
  return `${'*'.repeat(Math.max(secret.length - 4, 4))}${secret.slice(-4)}`;
}

function redactAccount(account: RawAccountConfig) {
  return {
    name: account.name,
    email: account.email,
    full_name: account.full_name ?? null,
    username: account.username ?? account.email,
    auth_type: account.oauth2 ? 'oauth2' : 'password',
    password_masked: account.password ? maskSecret(account.password) : null,
    oauth2: account.oauth2
      ? {
          provider: account.oauth2.provider,
          client_id_masked: maskSecret(account.oauth2.client_id),
          client_secret_masked: maskSecret(account.oauth2.client_secret),
          refresh_token_masked: maskSecret(account.oauth2.refresh_token),
          token_url: account.oauth2.token_url ?? null,
          auth_url: account.oauth2.auth_url ?? null,
          scopes: account.oauth2.scopes ?? [],
        }
      : null,
    imap: account.imap,
    smtp: account.smtp,
  };
}

async function loadOrCreateRawConfig(): Promise<RawAppConfig> {
  const exists = await configExists();
  if (!exists) return createDefaultRawConfig([]);
  return loadRawConfig();
}

async function persistConfig(config: RawAppConfig, runtimeState: RuntimeState): Promise<void> {
  const validated = AppConfigFileSchema.parse(config);
  await saveConfig(validated);
  const normalizedAccounts = validated.accounts.map(normalizeRawAccount);
  runtimeState.connections.setAccounts(normalizedAccounts);
  runtimeState.watcherService.setAccounts(normalizedAccounts);
}

export default function registerAccountConfigTools(
  server: McpServer,
  runtimeState: RuntimeState,
  oauthService: OAuthService,
): void {
  server.tool(
    'list_account_configs',
    'List configured email accounts including server settings, while masking all secrets. Use this before adding or updating account config entries.',
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      const config = await loadOrCreateRawConfig();
      const redacted = config.accounts.map(redactAccount);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                config_path: CONFIG_FILE,
                accounts: redacted,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'upsert_account_config',
    'Create or update an email account configuration in the email-mcp config file. This stores credentials for future email tool usage and supports password or OAuth2 authentication.',
    {
      account: AccountInputSchema,
      test_connection: z
        .boolean()
        .default(true)
        .describe('Run IMAP/SMTP connection checks after saving the account'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ account, test_connection }) => {
      try {
        const config = await loadOrCreateRawConfig();
        const nextAccount: RawAccountConfig = {
          ...account,
          username: account.username ?? account.email,
        };

        const existingIndex = config.accounts.findIndex((item) => item.name === nextAccount.name);
        if (existingIndex >= 0) {
          config.accounts[existingIndex] = nextAccount;
        } else {
          config.accounts.push(nextAccount);
        }

        await persistConfig(config, runtimeState);

        let testResult:
          | {
              imap: { success: boolean; error?: string };
              smtp: { success: boolean; error?: string };
            }
          | undefined;

        if (test_connection) {
          const normalized = normalizeRawAccount(nextAccount);
          const [imap, smtp] = await Promise.all([
            ConnectionManager.testImap(normalized, oauthService),
            ConnectionManager.testSmtp(normalized, oauthService),
          ]);
          testResult = {
            imap: { success: imap.success, error: imap.error },
            smtp: { success: smtp.success, error: smtp.error },
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  action: existingIndex >= 0 ? 'updated' : 'created',
                  config_path: CONFIG_FILE,
                  account: redactAccount(nextAccount),
                  test_result: testResult ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to upsert account config: ${message}` }],
        };
      }
    },
  );

  server.tool(
    'delete_account_config',
    'Delete an email account configuration from the email-mcp config file by account name.',
    {
      name: z.string().min(1).describe('Configured account name to delete'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ name }) => {
      try {
        const config = await loadOrCreateRawConfig();
        const existing = config.accounts.find((item) => item.name === name);
        if (!existing) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Account config "${name}" not found.` }],
          };
        }

        config.accounts = config.accounts.filter((item) => item.name !== name);
        await persistConfig(config, runtimeState);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  deleted: name,
                  config_path: CONFIG_FILE,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to delete account config: ${message}` }],
        };
      }
    },
  );

  server.tool(
    'test_account_config',
    'Test IMAP and SMTP connectivity for a configured account without exposing stored secrets.',
    {
      name: z.string().min(1).describe('Configured account name to test'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ name }) => {
      try {
        const config = await loadOrCreateRawConfig();
        const rawAccount = config.accounts.find((item) => item.name === name);
        if (!rawAccount) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Account config "${name}" not found.` }],
          };
        }

        const normalized = normalizeRawAccount(rawAccount);
        const [imap, smtp] = await Promise.all([
          ConnectionManager.testImap(normalized, oauthService),
          ConnectionManager.testSmtp(normalized, oauthService),
        ]);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: imap.success && smtp.success,
                  account: redactAccount(rawAccount),
                  imap,
                  smtp,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to test account config: ${message}` }],
        };
      }
    },
  );
}
