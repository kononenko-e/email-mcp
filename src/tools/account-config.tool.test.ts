import type ConnectionManager from '../connections/manager.js';
import type OAuthService from '../services/oauth.service.js';
import type WatcherService from '../services/watcher.service.js';
import registerAccountConfigTools from './account-config.tool.js';

const mockedConfigStore = vi.hoisted(() => ({
  config: {
    settings: {
      rate_limit: 10,
      read_only: false,
      watcher: { enabled: false, folders: ['INBOX'], idle_timeout: 1740 },
      hooks: {
        on_new_email: 'notify',
        preset: 'priority-focus',
        auto_label: false,
        auto_flag: false,
        batch_delay: 5,
        rules: [],
        alerts: {
          desktop: false,
          sound: false,
          urgency_threshold: 'high',
          webhook_url: '',
          webhook_events: ['urgent', 'high'],
        },
        auto_calendar: false,
        calendar_name: '',
        calendar_alarm_minutes: 15,
        calendar_confirm: true,
      },
    },
    accounts: [] as Record<string, unknown>[],
  },
  exists: true,
}));

vi.mock('../config/loader.js', () => ({
  CONFIG_FILE: '/tmp/email-mcp/config.toml',
  configExists: vi.fn(async () => mockedConfigStore.exists),
  loadRawConfig: vi.fn(async () => mockedConfigStore.config),
  saveConfig: vi.fn(async (config) => {
    mockedConfigStore.config = config as typeof mockedConfigStore.config;
  }),
  createDefaultRawConfig: vi.fn((accounts = []) => ({
    settings: mockedConfigStore.config.settings,
    accounts,
  })),
  normalizeRawAccount: vi.fn((raw) => ({
    name: raw.name,
    email: raw.email,
    fullName: raw.full_name,
    username: raw.username ?? raw.email,
    password: raw.password,
    oauth2: raw.oauth2
      ? {
          provider: raw.oauth2.provider,
          clientId: raw.oauth2.client_id,
          clientSecret: raw.oauth2.client_secret,
          refreshToken: raw.oauth2.refresh_token,
          tokenUrl: raw.oauth2.token_url,
          authUrl: raw.oauth2.auth_url,
          scopes: raw.oauth2.scopes,
        }
      : undefined,
    imap: {
      host: raw.imap.host,
      port: raw.imap.port,
      tls: raw.imap.tls,
      starttls: raw.imap.starttls,
      verifySsl: raw.imap.verify_ssl,
    },
    smtp: {
      host: raw.smtp.host,
      port: raw.smtp.port,
      tls: raw.smtp.tls,
      starttls: raw.smtp.starttls,
      verifySsl: raw.smtp.verify_ssl,
      pool: {
        enabled: raw.smtp.pool.enabled,
        maxConnections: raw.smtp.pool.max_connections,
        maxMessages: raw.smtp.pool.max_messages,
      },
    },
  })),
}));

vi.mock('../config/schema.js', () => ({
  AppConfigFileSchema: {
    parse: vi.fn((config) => config),
  },
}));

vi.mock('../connections/manager.js', () => ({
  default: {
    testImap: vi.fn(async () => ({ success: true, details: { messages: 3, folders: 2 } })),
    testSmtp: vi.fn(async () => ({ success: true })),
  },
}));

function createServerRecorder() {
  const tools = new Map<string, (input: unknown) => Promise<{ content: { text: string }[] }>>();
  return {
    server: {
      tool: vi.fn(
        (
          name: string,
          _description: string,
          _schema: unknown,
          _meta: unknown,
          handler: (input: unknown) => Promise<{ content: { text: string }[] }>,
        ) => {
          tools.set(name, handler);
        },
      ),
    },
    tools,
  };
}

describe('account-config tools', () => {
  const connections = { setAccounts: vi.fn() } as unknown as ConnectionManager;
  const watcherService = { setAccounts: vi.fn() } as unknown as WatcherService;
  const oauthService = {} as OAuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedConfigStore.exists = true;
    mockedConfigStore.config = {
      settings: mockedConfigStore.config.settings,
      accounts: [
        {
          name: 'work',
          email: 'work@example.com',
          username: 'work@example.com',
          password: 'supersecret',
          imap: {
            host: 'imap.example.com',
            port: 993,
            tls: true,
            starttls: false,
            verify_ssl: true,
          },
          smtp: {
            host: 'smtp.example.com',
            port: 465,
            tls: true,
            starttls: false,
            verify_ssl: true,
            pool: { enabled: true, max_connections: 1, max_messages: 100 },
          },
        },
      ],
    };
  });

  it('registers account config tools', () => {
    const { server, tools } = createServerRecorder();
    registerAccountConfigTools(server as never, { connections, watcherService }, oauthService);
    expect(tools.has('list_account_configs')).toBe(true);
    expect(tools.has('upsert_account_config')).toBe(true);
    expect(tools.has('delete_account_config')).toBe(true);
    expect(tools.has('test_account_config')).toBe(true);
  });

  it('redacts secrets when listing accounts', async () => {
    const { server, tools } = createServerRecorder();
    registerAccountConfigTools(server as never, { connections, watcherService }, oauthService);
    const handler = tools.get('list_account_configs');
    expect(handler).toBeDefined();
    if (!handler) throw new Error('list_account_configs handler missing');
    const result = await handler({});
    const { text } = result.content[0];
    expect(text).toContain('password_masked');
    expect(text).not.toContain('supersecret');
  });

  it('upserts an account, persists config, and refreshes runtime accounts', async () => {
    const { server, tools } = createServerRecorder();
    registerAccountConfigTools(server as never, { connections, watcherService }, oauthService);
    const handler = tools.get('upsert_account_config');
    expect(handler).toBeDefined();
    if (!handler) throw new Error('upsert_account_config handler missing');
    const result = await handler({
      account: {
        name: 'personal',
        email: 'me@example.com',
        password: 'newsecret',
        imap: {
          host: 'imap.example.com',
          port: 993,
          tls: true,
          starttls: false,
          verify_ssl: true,
        },
        smtp: {
          host: 'smtp.example.com',
          port: 465,
          tls: true,
          starttls: false,
          verify_ssl: true,
          pool: { enabled: true, max_connections: 1, max_messages: 100 },
        },
      },
      test_connection: true,
    });

    expect(result.content[0].text).toContain('created');
    expect(connections.setAccounts).toHaveBeenCalled();
    expect(watcherService.setAccounts).toHaveBeenCalled();
  });
});
