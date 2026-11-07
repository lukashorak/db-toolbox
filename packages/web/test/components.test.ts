import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DataGrid from '../src/components/DataGrid.svelte';
import PolicyChip from '../src/components/PolicyChip.svelte';
import StatusPill from '../src/components/StatusPill.svelte';
import Toasts from '../src/components/Toasts.svelte';
import { loadTabs, read, saveTabs } from '../src/lib/storage';
import { toast } from '../src/lib/toasts.svelte';
import PanelHarness from './PanelHarness.svelte';

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
});
