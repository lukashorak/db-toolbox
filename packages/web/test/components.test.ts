import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DataGrid from '../src/components/DataGrid.svelte';
import ResultsPanel from '../src/components/ResultsPanel.svelte';
import PolicyChip from '../src/components/PolicyChip.svelte';
import StatusPill from '../src/components/StatusPill.svelte';
import Toasts from '../src/components/Toasts.svelte';
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
