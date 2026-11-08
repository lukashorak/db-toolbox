import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DataGrid from '../src/components/DataGrid.svelte';
import ResultsPanel from '../src/components/ResultsPanel.svelte';
import PolicyChip from '../src/components/PolicyChip.svelte';
import Gate from '../src/pages/Gate.svelte';
import Monitoring from '../src/pages/Monitoring.svelte';
import Shell from '../src/shell/Shell.svelte';
import Explorer from '../src/pages/Explorer.svelte';
import Executions from '../src/pages/Executions.svelte';
import SavedQueries from '../src/pages/SavedQueries.svelte';
import { navigate, route } from '../src/lib/router.svelte';
import StatusPill from '../src/components/StatusPill.svelte';
import Toasts from '../src/components/Toasts.svelte';
import { columnComparator } from '../src/lib/compare';
import { selectSql } from '../src/lib/sql';
import { loadTabs, read, saveTabs, write } from '../src/lib/storage';
import { toast } from '../src/lib/toasts.svelte';
import type { ExecutionView } from '../src/lib/execution';
import PanelHarness from './PanelHarness.svelte';

const api = vi.hoisted(() =>
  vi.fn(async (_method: string, url: string) => ({
    rows: [[url.includes('/results/1/') ? 'second' : 'first']],
  })),
);
vi.mock('../src/lib/api', () => ({ api, ApiError: class extends Error {} }));

afterEach(cleanup);

// Browsers reflect the `inert` property to its attribute (Svelte sets the property); jsdom has neither.
if (!('inert' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, 'inert', {
    get(this: HTMLElement) {
      return this.hasAttribute('inert');
    },
    set(this: HTMLElement, value: unknown) {
      this.toggleAttribute('inert', Boolean(value));
    },
  });
}

describe('status and policy', () => {
  it('shows status with a label and an icon, not color alone', () => {
    render(StatusPill, { kind: 'transaction', value: 'partial_commit' });
    const pill = screen.getByText('Partial commit');
    expect(pill.className).toContain('warning');
    expect(pill.textContent).toContain('!');
  });

  it('names every layer that makes a connection read-only', () => {
    render(PolicyChip, { readOnly: true, sources: ['user', 'profile'] });
    expect(screen.getByText('Read-only · user + profile')).toBeTruthy();
  });

  it('falls back to the raw value for an unknown status', () => {
    render(StatusPill, { kind: 'execution', value: 'something_new' });
    expect(screen.getByText('something_new')).toBeTruthy();
  });
});

describe('lost session', () => {
  it('moves focus into the sign-in dialog', async () => {
    render(Gate, { kind: 'lost' });
    await tick();
    const dialog = screen.getByRole('alertdialog', { name: 'Your session has ended' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const button = screen.getByRole('button', { name: 'Sign in again' });
    expect(document.activeElement).toBe(button);
    // Tab and Shift+Tab stay on its only control, also from outside the dialog.
    for (const shiftKey of [false, true]) {
      expect(await fireEvent.keyDown(button, { key: 'Tab', shiftKey })).toBe(false);
      document.body.focus();
      expect(await fireEvent.keyDown(document.body, { key: 'Tab', shiftKey })).toBe(false);
      expect(document.activeElement).toBe(button);
    }
  });

  it('leaves Tab alone on the other gates', async () => {
    render(Gate, { kind: 'denied' });
    await tick();
    expect(await fireEvent.keyDown(screen.getByRole('button', { name: 'Sign out' }), { key: 'Tab' })).toBe(
      true,
    );
  });

  it('makes the app behind the dialog inert, and only then', async () => {
    const children = createRawSnippet(() => ({ render: () => '<button>Run</button>' }));
    const { rerender } = render(Shell, { title: 'Workbench', children, inert: true });
    for (const name of ['Skip to content', 'Run']) {
      expect(screen.getByText(name).closest('[inert]'), name).not.toBeNull();
    }
    await rerender({ title: 'Workbench', children, inert: false });
    expect(document.querySelector('[inert]')).toBeNull();
  });
});

describe('data grid', () => {
  const columns = [
    { name: 'id', type: 'int4' },
    { name: 'id', type: 'int4' },
    { name: 'raw', type: 'bytea', binary: true },
  ];
  const rows = Array.from({ length: 1000 }, (_, i) => [
    String(i + 1),
    i % 2 ? null : '',
    i === 0 ? '\\x00ff10' : null,
  ]);

  it('renders only the visible window of 1,000 rows and keeps duplicate headers', () => {
    const { container } = render(DataGrid, { columns, rows, height: 260 });
    const rendered = container.querySelectorAll('[role="row"]').length;
    expect(rendered).toBeLessThan(40);
    expect(container.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')).toBe('1001');
    expect(
      screen.getAllByRole('columnheader').map((h) => h.textContent?.replace(/int4|bytea/, '').trim()),
    ).toEqual(['#', 'id', 'id', 'raw']);
  });

  it('shows NULL distinctly from empty text, and binary as binary', () => {
    const { container } = render(DataGrid, { columns, rows: rows.slice(0, 2) });
    expect(container.querySelectorAll('.null').length).toBe(2);
    expect(screen.getByText('binary · 3 bytes')).toBeTruthy();
  });

  it('selects rows with the keyboard', async () => {
    const onSelectRow = vi.fn();
    const { container } = render(DataGrid, { columns, rows: rows.slice(0, 5), onSelectRow });
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    await fireEvent.keyDown(grid, { key: 'ArrowDown' });
    await fireEvent.keyDown(grid, { key: 'ArrowDown' });
    await fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onSelectRow).toHaveBeenCalledWith(1);
  });
});

describe('side panel', () => {
  it('moves focus in, closes on Escape and returns focus to the opener', async () => {
    render(PanelHarness);
    const opener = screen.getByText('Open panel');
    opener.focus();
    await fireEvent.click(opener);
    await tick();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await fireEvent.keyDown(dialog, { key: 'Escape' });
    await tick();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('toasts', () => {
  it('announces messages in a polite live region', async () => {
    render(Toasts);
    toast('Export ready', 'success');
    await tick();
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Export ready');
  });
});

describe('browser storage', () => {
  it('keeps tabs and drafts per user', () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as unknown as Storage;
    saveTabs(
      'alice',
      { tabs: [{ id: '1', title: 'Query 1', sql: 'SELECT 1', connectionId: null }], active: '1' },
      fake,
    );
    expect(loadTabs('alice', fake).tabs[0]?.sql).toBe('SELECT 1');
    expect(loadTabs('bob', fake).tabs).toEqual([]);
  });

  it('works when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(read('x', 'fallback', blocked)).toBe('fallback');
    expect(saveTabs('alice', { tabs: [], active: null }, blocked)).toBe(false);
  });

  it('works when even reading localStorage throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });
    try {
      expect(read('x', 'fallback')).toBe('fallback');
      expect(write('x', 1)).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});

describe('generated SQL', () => {
  it('always quotes identifiers, so reserved words and mixed case work', () => {
    expect(selectSql('postgresql', 'order', 'Users')).toBe('SELECT *\nFROM "order"."Users"\nLIMIT 100;');
    expect(selectSql('mysql', 'order', 'we`ird')).toBe('SELECT *\nFROM `order`.`we``ird`\nLIMIT 100;');
    expect(selectSql('postgresql', 'public', 'say "hi"')).toContain('"say ""hi"""');
  });
});

describe('results panel', () => {
  const statement = (ordinal: number, command: string, status: string) => ({
    ordinal,
    sql: command,
    kind: 'read',
    command,
    range: { start: 0, end: 1, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    status,
    transactionOutcome: 'none',
    affectedRows: null,
    error: status === 'failed' ? { code: '1146', message: 'Table missing' } : null,
    notices: [],
    startedAt: null,
    durationMs: 1,
  });
  const resultSet = (index: number) => ({
    index,
    statement: 0,
    columns: [{ name: 'v', type: 'text', binary: false }],
    rowCount: 1,
    byteCount: 10,
    moreAvailable: false,
    completeness: 'complete',
    expiresAt: null,
  });
  const execution = {
    id: 'exe_1',
    title: 'Procedure',
    connection: { id: 'con_1', name: 'Shop', engine: 'mysql' },
    scope: 'Script',
    transactionMode: 'per_statement',
    readOnly: false,
    policySources: [],
    status: 'failed',
    statusNote: null,
    transactionOutcome: 'none',
    queue: null,
    error: null,
    statements: [statement(0, 'CALL', 'succeeded'), statement(1, 'SELECT', 'failed')],
    resultSets: [resultSet(0), resultSet(1)],
  } as unknown as ExecutionView;
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  };

  it('jumps to a failed statement once, then keeps the statement the person picks', async () => {
    render(ResultsPanel, { execution, onRunFull: () => undefined });
    await settle();
    const tabs = () => screen.getByRole('tablist', { name: 'Statements' }).querySelectorAll('[role="tab"]');
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    await fireEvent.click(tabs()[0] as HTMLElement);
    await settle();
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('first')).toBeTruthy();
  });

  it('starts another execution shown in the same panel at its first statement', async () => {
    const { rerender } = render(ResultsPanel, { execution, onRunFull: () => undefined });
    await settle();
    // Statement 2 is selected (it failed); then a single-statement run takes the panel's place.
    const single = {
      ...execution,
      id: 'exe_2',
      status: 'succeeded',
      statements: [statement(0, 'SELECT', 'succeeded')],
      resultSets: [resultSet(0)],
    } as unknown as ExecutionView;
    await rerender({ execution: single });
    await settle();
    expect(api).toHaveBeenCalledWith('GET', '/executions/exe_2/results/0/rows?limit=1000');
    expect(screen.getByText('first')).toBeTruthy();
  });

  it('shows no rows of the previous result while the next one is still capturing', async () => {
    const { rerender } = render(ResultsPanel, { execution, onRunFull: () => undefined });
    await settle();
    await fireEvent.click(
      screen.getByRole('tablist', { name: 'Statements' }).querySelectorAll('[role="tab"]')[0] as HTMLElement,
    );
    await settle();
    expect(screen.getByText('first')).toBeTruthy();
    const capturing = {
      ...execution,
      id: 'exe_capturing',
      status: 'running',
      statements: [statement(0, 'SELECT', 'running')],
      resultSets: [{ ...resultSet(0), completeness: 'capturing' }],
    } as unknown as ExecutionView;
    await rerender({ execution: capturing });
    await settle();
    expect(screen.queryByText('first')).toBeNull();
    expect(api).not.toHaveBeenCalledWith('GET', '/executions/exe_capturing/results/0/rows?limit=1000');
  });

  it('shows a notice repeated by the database as often as it came', async () => {
    const repeated = {
      ...execution,
      id: 'exe_notices',
      status: 'succeeded',
      statements: [{ ...statement(0, 'DO', 'succeeded'), notices: ['NOTICE: again', 'NOTICE: again'] }],
      resultSets: [],
    } as unknown as ExecutionView;
    render(ResultsPanel, { execution: repeated, onRunFull: () => undefined });
    await settle();
    expect(screen.getAllByText('NOTICE: again')).toHaveLength(2);
  });

  it('keeps the selected result set’s rows when an older answer arrives late', async () => {
    render(ResultsPanel, { execution, onRunFull: () => undefined });
    await settle();
    // The first result set's rows answer slowly…
    let answerFirst: (value: { rows: string[][] }) => void = () => undefined;
    api.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    await fireEvent.click(screen.getByRole('tablist', { name: 'Statements' }).querySelector('[role="tab"]')!);
    await settle();
    // …and the person moves on to the second before they arrive.
    await fireEvent.click(screen.getAllByTestId('result-set-tab')[1] as HTMLElement);
    await settle();
    expect(screen.getByText('second')).toBeTruthy();
    answerFirst({ rows: [['late first']] });
    await settle();
    expect(screen.queryByText('late first')).toBeNull();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('shares the result the dialog was opened for, and drops it when another run is shown', async () => {
    const single = (id: string, title: string) =>
      ({
        ...execution,
        id,
        title,
        status: 'succeeded',
        statements: [statement(0, 'SELECT', 'succeeded')],
        resultSets: [resultSet(0)],
      }) as unknown as ExecutionView;
    const profiles = [{ id: 'mcp_1', name: 'Claude Code' }];
    const { rerender } = render(ResultsPanel, {
      execution: single('exe_a', 'A'),
      onRunFull: () => undefined,
    });
    await settle();
    const shareButton = () => screen.getByRole('button', { name: 'Share full result with MCP' });

    // The profiles load slowly, and the person shows another run meanwhile: no dialog for it.
    let answer: (value: unknown) => void = () => undefined;
    api.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await fireEvent.click(shareButton());
    await rerender({ execution: single('exe_b', 'B') });
    await settle();
    answer(profiles);
    await settle();
    const dialog = () => screen.queryByRole('dialog', { name: 'Share full result with MCP' });
    expect(dialog()).toBeNull();

    // Opened for B, then A is shown: the dialog closes instead of applying to A.
    api.mockImplementationOnce(async () => profiles);
    await fireEvent.click(shareButton());
    await settle();
    expect(dialog()).not.toBeNull();
    expect(screen.getByTestId('share-target').textContent).toContain('“B”');
    await rerender({ execution: single('exe_a', 'A') });
    await settle();
    expect(dialog()).toBeNull();

    // Opened and confirmed on the same result: the share is for that result.
    api.mockImplementationOnce(async () => profiles);
    await fireEvent.click(shareButton());
    await settle();
    api.mockImplementationOnce(async () => ({}));
    await fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await settle();
    expect(api).toHaveBeenLastCalledWith('POST', '/executions/exe_a/results/0/share', {
      profileId: 'mcp_1',
      minutes: 60,
    });
    expect(api).not.toHaveBeenCalledWith('POST', '/executions/exe_b/results/0/share', expect.anything());
  });

  it('shows every result set a statement returned', async () => {
    render(ResultsPanel, { execution, onRunFull: () => undefined });
    await settle();
    await fireEvent.click(screen.getByRole('tablist', { name: 'Statements' }).querySelector('[role="tab"]')!);
    await settle();
    const sets = screen.getAllByTestId('result-set-tab');
    expect(sets.map((t) => t.textContent?.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'Result 1',
      'Result 2',
    ]);
    await fireEvent.click(sets[1] as HTMLElement);
    await settle();
    expect(screen.getByText('second')).toBeTruthy();
    expect(sets[1]?.getAttribute('aria-selected')).toBe('true');
    expect(api).toHaveBeenCalledWith('GET', '/executions/exe_1/results/1/rows?limit=1000');
  });
});

describe('result sorting', () => {
  const sorted = (values: string[]) => [...values].sort(columnComparator(values));
  it('orders integers and decimals by value without losing precision', () => {
    expect(sorted(['9007199254740993', '9007199254740992', '-9007199254740993', '10', '9'])).toEqual([
      '-9007199254740993',
      '9',
      '10',
      '9007199254740992',
      '9007199254740993',
    ]);
    expect(
      sorted(['0.30000000000000004', '0.3', '-0.1', '-0.10000000000000001', '1.50', '1.5', '007']),
    ).toEqual(['-0.10000000000000001', '-0.1', '0.3', '0.30000000000000004', '1.50', '1.5', '007']);
    const numeric = columnComparator(['1']);
    expect(numeric('1.50', '1.5')).toBe(0);
    expect(numeric('-0', '0')).toBe(0);
    expect(sorted(['1e+20', '5', '2.5e3'])).toEqual(['5', '2.5e3', '1e+20']);
  });

  it('orders a column with any non-numeric cell as text throughout', () => {
    expect(sorted(['2', '10', '1A'])).toEqual(['10', '1A', '2']);
    expect(sorted(['1A', '2', '10'])).toEqual(['10', '1A', '2']);
    expect(sorted(['beta', 'alpha', '10'])).toEqual(['10', 'alpha', 'beta']);
  });
});

describe('monitoring', () => {
  const snapshotOf = (account: string) => ({
    capturedAt: '2026-01-01T00:00:00.000Z',
    account,
    sessions: { availability: 'available', reason: null, items: [] },
    lockWaits: { availability: 'available', reason: null, items: [] },
    counters: { availability: 'available', reason: null, data: null },
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await tick();
    }
  };

  it('shows a slow answer instead of starting the same refresh over', async () => {
    const original = api.getMockImplementation();
    const answers: ((value: unknown) => void)[] = [];
    api.mockImplementation((async (_method: string, url: string) => {
      if (url === '/connections') return [{ id: 'a', name: 'Alpha', enabled: true }];
      if (url === '/settings/execution') return { monitoringRefreshSeconds: 15 };
      if (url.includes('/statements'))
        return { availability: 'available', reason: null, statsSince: null, items: [] };
      // Every activity answer is slow.
      return new Promise((r) => answers.push(r));
    }) as never);
    try {
      render(Monitoring);
      await settle();
      // Refresh while the first request is still running: it does not supersede it.
      await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await settle();
      expect(answers).toHaveLength(1);
      answers[0]?.(snapshotOf('slow_account'));
      await settle();
      expect(screen.getByTestId('sample-time').textContent).toMatch(/account slow_account/);
    } finally {
      if (original) api.mockImplementation(original);
    }
  });

  it('keeps one refresh per connection in flight across connection switches', async () => {
    const original = api.getMockImplementation();
    const alpha: ((value: unknown) => void)[] = [];
    api.mockImplementation((async (_method: string, url: string) => {
      if (url === '/connections')
        return [
          { id: 'a', name: 'Alpha', enabled: true },
          { id: 'b', name: 'Beta', enabled: true },
        ];
      if (url === '/settings/execution') return { monitoringRefreshSeconds: 15 };
      if (url.includes('/statements'))
        return { availability: 'available', reason: null, statsSince: null, items: [] };
      if (url === '/connections/a/monitoring/activity') return new Promise((r) => alpha.push(r));
      return snapshotOf('beta_account');
    }) as never);
    try {
      render(Monitoring);
      await settle();
      const select = screen.getByLabelText('Connection');
      // Alpha's first request is pending; Beta, then Alpha again (a second Alpha request).
      await fireEvent.change(select, { target: { value: 'b' } });
      await settle();
      await fireEvent.change(select, { target: { value: 'a' } });
      await settle();
      expect(alpha).toHaveLength(2);
      // The first Alpha request ends; the second is still running, so Refresh starts no third.
      alpha[0]?.(snapshotOf('alpha_first'));
      await settle();
      await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await settle();
      expect(alpha).toHaveLength(2);
      alpha[1]?.(snapshotOf('alpha_second'));
      await settle();
      expect(screen.getByTestId('sample-time').textContent).toMatch(/account alpha_second/);
    } finally {
      if (original) api.mockImplementation(original);
    }
  });

  it('never shows one connection’s numbers under another', async () => {
    const original = api.getMockImplementation();
    let answerAlpha: (value: unknown) => void = () => undefined;
    api.mockImplementation((async (_method: string, url: string) => {
      if (url === '/connections')
        return [
          { id: 'a', name: 'Alpha', enabled: true },
          { id: 'b', name: 'Beta', enabled: true },
        ];
      if (url === '/settings/execution') return { monitoringRefreshSeconds: 15 };
      if (url.includes('/statements'))
        return { availability: 'available', reason: null, statsSince: null, items: [] };
      // Alpha answers slowly; Beta at once.
      if (url === '/connections/a/monitoring/activity') return new Promise((r) => (answerAlpha = r));
      return snapshotOf('beta_account');
    }) as never);
    try {
      render(Monitoring);
      await settle();
      await fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'b' } });
      await settle();
      expect(screen.getByTestId('sample-time').textContent).toMatch(/account beta_account/);
      answerAlpha(snapshotOf('alpha_account'));
      await settle();
      expect(screen.getByTestId('sample-time').textContent).toMatch(/account beta_account/);
    } finally {
      if (original) api.mockImplementation(original);
    }
  });
});

describe('saved queries', () => {
  it('"All queries" lists the queries in folders too', async () => {
    const original = api.getMockImplementation();
    const requested: string[] = [];
    api.mockImplementation((async (_method: string, url: string) => {
      requested.push(url);
      if (url === '/folders') return [{ id: 'f1', name: 'Reports', parentId: null }];
      if (url === '/queries')
        return [
          {
            id: 'q1',
            name: 'Monthly revenue',
            folderId: 'f1',
            sql: 'SELECT 1',
            connectionId: null,
            updatedAt: '2026-11-08T10:00:00.000Z',
          },
        ];
      if (url.startsWith('/queries')) return [];
      return [];
    }) as never);
    try {
      render(SavedQueries);
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await tick();
      }
      expect(requested).toContain('/queries');
      expect(requested.some((u) => u.includes('folderId=root'))).toBe(false);
      expect(screen.getByText('Monthly revenue')).toBeTruthy();
    } finally {
      if (original) api.mockImplementation(original);
    }
  });
});

describe('explorer', () => {
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await tick();
    }
  };
  const schemasOf = (name: string) => ({
    status: 'complete',
    items: [{ name, system: false, usable: true }],
  });

  const objectsOf = (name: string) => ({
    status: 'ok',
    items: [{ schema: 'sales', name, kind: 'table' }],
  });
  const twoConnections = [
    { id: 'a', name: 'Alpha', enabled: true, engine: 'postgresql' },
    { id: 'b', name: 'Beta', enabled: true, engine: 'postgresql' },
  ];

  it('shows nothing of the previous connection while the next one loads or fails', async () => {
    const original = api.getMockImplementation();
    let failBeta: (error: Error) => void = () => undefined;
    api.mockImplementation((async (_method: string, url: string) => {
      if (url === '/connections') return twoConnections;
      if (url === '/connections/a/metadata/schemas') return schemasOf('alpha_schema');
      if (url === '/connections/b/metadata/schemas') return new Promise((_, reject) => (failBeta = reject));
      return { status: 'ok', items: [] };
    }) as never);
    try {
      render(Explorer);
      await settle();
      expect(screen.getByText('alpha_schema')).toBeTruthy();
      await fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'b' } });
      await settle();
      expect(screen.queryByText('alpha_schema')).toBeNull();
      failBeta(new Error('Beta is down'));
      await settle();
      expect(screen.queryByText('alpha_schema')).toBeNull();
      expect(screen.getByText('Beta is down')).toBeTruthy();
    } finally {
      if (original) api.mockImplementation(original);
    }
  });

  it('drops a late object answer or failure from before a connection switch', async () => {
    const original = api.getMockImplementation();
    const alphaObjects: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
    api.mockImplementation((async (_method: string, url: string) => {
      if (url === '/connections') return twoConnections;
      if (url.endsWith('/metadata/schemas')) return schemasOf('sales');
      if (url === '/connections/a/metadata/schemas/sales/objects')
        return new Promise((resolve, reject) => alphaObjects.push({ resolve, reject }));
      return objectsOf('beta_table');
    }) as never);
    try {
      render(Explorer);
      await settle();
      const select = screen.getByLabelText('Connection');
      // Alpha's objects are slow; Beta's arrive at once.
      await fireEvent.click(screen.getByText('sales'));
      await settle();
      await fireEvent.change(select, { target: { value: 'b' } });
      await settle();
      await fireEvent.click(screen.getByText('sales'));
      await settle();
      expect(screen.getByText('beta_table')).toBeTruthy();
      // Alpha's failure arrives late: Beta's schema keeps its objects.
      alphaObjects[0]?.reject(new Error('Alpha failed'));
      await settle();
      expect(screen.getByText('beta_table')).toBeTruthy();
      expect(screen.queryByText(/Alpha failed/)).toBeNull();
      // Back to Alpha, which answers its new request first; the old one then arrives late.
      await fireEvent.change(select, { target: { value: 'a' } });
      await settle();
      await fireEvent.click(screen.getByText('sales'));
      await settle();
      alphaObjects[1]?.resolve(objectsOf('alpha_new'));
      await settle();
      expect(screen.getByText('alpha_new')).toBeTruthy();
    } finally {
      if (original) api.mockImplementation(original);
    }
  });

  it('keeps the newer objects when an older answer arrives after switching back', async () => {
    const original = api.getMockImplementation();
    const alphaObjects: ((v: unknown) => void)[] = [];
    api.mockImplementation((async (_method: string, url: string) => {
      if (url === '/connections') return twoConnections;
      if (url.endsWith('/metadata/schemas')) return schemasOf('sales');
      if (url === '/connections/a/metadata/schemas/sales/objects')
        return new Promise((resolve) => alphaObjects.push(resolve));
      return objectsOf('beta_table');
    }) as never);
    try {
      render(Explorer);
      await settle();
      const select = screen.getByLabelText('Connection');
      await fireEvent.click(screen.getByText('sales'));
      await settle();
      // Alpha, then Beta, then Alpha again: the first Alpha request is still pending.
      await fireEvent.change(select, { target: { value: 'b' } });
      await settle();
      await fireEvent.change(select, { target: { value: 'a' } });
      await settle();
      await fireEvent.click(screen.getByText('sales'));
      await settle();
      expect(alphaObjects).toHaveLength(2);
      alphaObjects[1]?.(objectsOf('alpha_new'));
      await settle();
      alphaObjects[0]?.(objectsOf('alpha_old'));
      await settle();
      expect(screen.getByText('alpha_new')).toBeTruthy();
      expect(screen.queryByText('alpha_old')).toBeNull();
    } finally {
      if (original) api.mockImplementation(original);
    }
  });

  it('never shows one connection’s schemas under another', async () => {
    const original = api.getMockImplementation();
    let answerAlpha: (value: unknown) => void = () => undefined;
    api.mockImplementation((async (_method: string, url: string) => {
      if (url === '/connections')
        return [
          { id: 'a', name: 'Alpha', enabled: true, engine: 'postgresql' },
          { id: 'b', name: 'Beta', enabled: true, engine: 'postgresql' },
        ];
      // Alpha answers slowly; Beta at once.
      if (url === '/connections/a/metadata/schemas') return new Promise((r) => (answerAlpha = r));
      if (url === '/connections/b/metadata/schemas') return schemasOf('beta_schema');
      return { status: 'complete', items: [] };
    }) as never);
    try {
      render(Explorer);
      await settle();
      await fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'b' } });
      await settle();
      expect(screen.getByText('beta_schema')).toBeTruthy();
      answerAlpha(schemasOf('alpha_schema'));
      await settle();
      expect(screen.getByText('beta_schema')).toBeTruthy();
      expect(screen.queryByText('alpha_schema')).toBeNull();
    } finally {
      if (original) api.mockImplementation(original);
    }
  });
});

describe('execution history', () => {
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await tick();
    }
  };
  const executionOf = (id: string, title: string) => ({
    id,
    title,
    source: 'gui',
    clientId: 'web',
    profile: null,
    connection: { id: 'con_1', name: 'Shop', engine: 'postgresql' },
    requestKey: `key_${id}`,
    sql: 'SELECT n FROM numbers',
    scope: 'Script',
    captureMode: 'preview',
    transactionMode: 'per_statement',
    continueOnError: false,
    timeoutMs: 30_000,
    retention: 'working',
    readOnly: false,
    policySources: [],
    status: 'succeeded',
    statusNote: null,
    transactionOutcome: 'none',
    submittedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    cancelRequestedAt: null,
    error: null,
    queue: null,
    statements: [
      {
        ordinal: 0,
        sql: 'SELECT n FROM numbers',
        kind: 'read',
        command: 'SELECT',
        range: { start: 0, end: 21, startLine: 1, startColumn: 1, endLine: 1, endColumn: 22 },
        status: 'succeeded',
        transactionOutcome: 'none',
        affectedRows: null,
        error: null,
        notices: [],
        startedAt: null,
        durationMs: 1,
      },
    ],
    resultSets: [
      {
        index: 0,
        statement: 0,
        columns: [{ name: 'n', type: 'int4', binary: false }],
        rowCount: 1000,
        byteCount: 10,
        moreAvailable: true,
        completeness: 'preview_limited',
        expiresAt: null,
      },
    ],
    resultExpiresAt: null,
  });

  it('never shows one execution’s detail after another was opened', async () => {
    const original = api.getMockImplementation();
    let answerAlpha: (value: unknown) => void = () => undefined;
    api.mockImplementation((async (_method: string, url: string) => {
      if (url === '/executions/exe_a') return new Promise((r) => (answerAlpha = r));
      if (url === '/executions/exe_b') return executionOf('exe_b', 'Beta run');
      if (url.endsWith('/exports') || url === '/approvals' || url === '/connections') return [];
      return { rows: [['1']] };
    }) as never);
    try {
      navigate('/executions/exe_a');
      render(Executions);
      await settle();
      navigate('/executions/exe_b');
      await settle();
      expect(screen.getAllByText('Beta run').length).toBeGreaterThan(0);
      answerAlpha(executionOf('exe_a', 'Alpha run'));
      await settle();
      expect(screen.queryByText('Alpha run')).toBeNull();
      expect(screen.getAllByText('Beta run').length).toBeGreaterThan(0);
    } finally {
      if (original) api.mockImplementation(original);
      navigate('/');
    }
  });

  it('says when MCP disclosures could not be loaded, instead of showing none', async () => {
    const original = api.getMockImplementation();
    api.mockImplementation((async (_method: string, url: string) => {
      if (url === '/approvals') throw new Error('Approvals are unavailable');
      if (url === '/executions/exe_c') return executionOf('exe_c', 'Gamma run');
      if (url.endsWith('/exports') || url === '/connections') return [];
      return { rows: [['1']] };
    }) as never);
    try {
      navigate('/executions/exe_c');
      render(Executions);
      await settle();
      expect(screen.getByText(/Could not be loaded: Approvals are unavailable/)).toBeTruthy();
      expect(screen.queryByText('None.')).toBeNull();
    } finally {
      if (original) api.mockImplementation(original);
      navigate('/');
    }
  });

  it('runs the full result from history and opens the new execution', async () => {
    const original = api.getMockImplementation();
    const posted: unknown[] = [];
    api.mockImplementation((async (method: string, url: string, body?: unknown) => {
      if (method === 'POST' && url === '/executions') {
        posted.push(body);
        return executionOf('exe_full', 'Full run');
      }
      if (url.startsWith('/executions/exe_')) {
        if (url.endsWith('/exports')) return [];
        if (url.includes('/rows')) return { rows: [['1']] };
        // A title at the 200-character limit: the rerun's title must still fit.
        return executionOf(url.slice('/executions/'.length), 'P'.repeat(200));
      }
      if (url === '/approvals' || url === '/connections') return [];
      return { rows: [] };
    }) as never);
    try {
      navigate('/executions/exe_preview');
      render(Executions);
      await settle();
      await fireEvent.click(screen.getByRole('button', { name: 'Run full result' }));
      await settle();
      const confirm = screen.getAllByRole('button', { name: 'Run full result' }).at(-1) as HTMLElement;
      await fireEvent.click(confirm);
      await settle();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        connectionId: 'con_1',
        sql: 'SELECT n FROM numbers',
        captureMode: 'full',
      });
      const title = (posted[0] as { title: string }).title;
      expect([title.length <= 200, title.endsWith(' (full)')]).toEqual([true, true]);
      expect(route.path).toBe('/executions/exe_full');
    } finally {
      if (original) api.mockImplementation(original);
      navigate('/');
    }
  });
});
