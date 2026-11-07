import { testConnection, type ConnectionTestReport } from './connection-test.js';
import { MysqlAdapter } from './mysql.js';
import { PostgresAdapter } from './postgres.js';
import type { ConnectionTarget, DbAdapter, Endpoint, PoolSizes, Transport } from './types.js';

/** Direct TCP (and TLS on top). SSH tunnels add another Transport without touching the adapters. */
export class DirectTransport implements Transport {
  readonly kind = 'direct' as const;
  constructor(private readonly target: Pick<ConnectionTarget, 'host' | 'port'>) {}
  async open(): Promise<Endpoint> {
    return { host: this.target.host, port: this.target.port, servername: this.target.host };
  }
  async close(): Promise<void> {}
}

export interface RegistryOptions {
  sizes: PoolSizes;
  connectTimeoutMs?: number;
  applicationName?: string;
}

interface Entry {
  version: string;
  adapter: Promise<DbAdapter>;
  transport: Transport;
}

/**
 * One adapter (and its pools) per stored connection, opened on first use. A changed configuration
 * (new `updatedAt`) replaces the adapter; the old one closes once its sessions end.
 */
export class AdapterRegistry {
  readonly #entries = new Map<string, Entry>();

  constructor(private readonly options: RegistryOptions) {}

  get(target: ConnectionTarget & { updatedAt: string }): Promise<DbAdapter> {
    const existing = this.#entries.get(target.id);
    if (existing && existing.version === target.updatedAt) return existing.adapter;
    if (existing) void this.#retire(existing);
    const transport = new DirectTransport(target);
    const adapter = transport.open().then((endpoint) => {
      const common = { sizes: this.options.sizes, connectTimeoutMs: this.options.connectTimeoutMs ?? 10_000 };
      return target.engine === 'postgresql'
        ? new PostgresAdapter(target, endpoint, {
            ...common,
            applicationName: this.options.applicationName ?? 'database-workbench',
          })
        : new MysqlAdapter(target, endpoint, common);
    });
    this.#entries.set(target.id, { version: target.updatedAt, adapter, transport });
    return adapter;
  }

  /** Closes the adapter of a deleted or disabled connection. */
  async invalidate(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    this.#entries.delete(id);
    if (entry) await this.#retire(entry);
  }

  /** Runs a connection test on its own connection, outside the pools. */
  async test(target: ConnectionTarget, timeoutMs?: number): Promise<ConnectionTestReport> {
    const transport = new DirectTransport(target);
    try {
      return await testConnection(target, await transport.open(), timeoutMs);
    } finally {
      await transport.close();
    }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(entries.map((e) => this.#retire(e)));
  }

  async #retire(entry: Entry): Promise<void> {
    try {
      const adapter = await entry.adapter;
      // Wait for checked-out sessions to finish before closing the pools.
      while (adapter.activeSessions() > 0) await new Promise((r) => setTimeout(r, 100));
      await adapter.close();
    } finally {
      await entry.transport.close();
    }
  }
}
