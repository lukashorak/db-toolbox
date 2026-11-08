<script lang="ts">
  import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { MySQL, PostgreSQL, sql } from '@codemirror/lang-sql';
  import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
  import { Compartment, EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
  import {
    Decoration,
    EditorView,
    highlightActiveLine,
    keymap,
    lineNumbers,
    type DecorationSet,
  } from '@codemirror/view';
  import { onMount } from 'svelte';
  import { format } from 'sql-formatter';

  /**
   * SQL editor (CodeMirror 6): engine dialect, completion from metadata, formatting, shortcuts,
   * the statement that will run, and error positions.
   */
  let {
    value,
    documentId,
    engine,
    schema = {},
    marks = [],
    onChange,
    onCursor,
    onRun,
  }: {
    value: string;
    /** Which document the text belongs to (a tab): each one has its own undo history. */
    documentId?: string;
    engine: 'postgresql' | 'mysql';
    schema?: Record<string, string[]>;
    marks?: { from: number; to: number; kind: 'target' | 'error'; title?: string }[];
    onChange: (value: string) => void;
    onCursor?: (selection: { from: number; to: number }) => void;
    onRun?: (target: 'statement' | 'script') => void;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = null;
  const language = new Compartment();
  /** Undo history: replaced (emptied) whenever another document is loaded. */
  const undoHistory = new Compartment();
  const setMarks = StateEffect.define<DecorationSet>();
  const markField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (value, tr) => {
      for (const effect of tr.effects) if (effect.is(setMarks)) return effect.value;
      return value.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const dialect = () =>
    sql({ dialect: engine === 'mysql' ? MySQL : PostgreSQL, schema, upperCaseKeywords: true });

  function formatAll(target: EditorView): boolean {
    try {
      const formatted = format(target.state.doc.toString(), {
        language: engine === 'mysql' ? 'mysql' : 'postgresql',
        keywordCase: 'upper',
      });
      target.dispatch({ changes: { from: 0, to: target.state.doc.length, insert: formatted } });
    } catch {
      // Leave text the formatter cannot parse unchanged.
    }
    return true;
  }

  onMount(() => {
    view = new EditorView({
      parent: host as HTMLDivElement,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          undoHistory.of(history()),
          highlightActiveLine(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle),
          autocompletion(),
          language.of(dialect()),
          markField,
          keymap.of([
            { key: 'Mod-Enter', run: () => (onRun?.('statement'), true) },
            { key: 'Shift-Mod-Enter', run: () => (onRun?.('script'), true) },
            { key: 'Shift-Mod-f', run: formatAll },
            indentWithTab,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const main = update.state.selection.main;
              onCursor?.({ from: main.from, to: main.to });
            }
          }),
          EditorView.contentAttributes.of({ 'aria-label': 'SQL editor', 'data-testid': 'sql-editor' }),
        ],
      }),
    });
    return () => view?.destroy();
  });

  // Another document (another tab), or text changed outside the editor (a saved query): it starts
  // with its own undo history, even when two tabs hold the same text. Undo must never bring back
  // another document's text.
  let shownDocument: string | undefined;
  $effect(() => {
    if (!view) return;
    const otherDocument = documentId !== shownDocument;
    shownDocument = documentId;
    const otherText = value !== view.state.doc.toString();
    if (otherDocument || otherText) {
      // Three steps: a history added in the same transaction as the change would record it.
      view.dispatch({ effects: undoHistory.reconfigure([]) });
      if (otherText) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      view.dispatch({ effects: undoHistory.reconfigure(history()) });
    }
  });
  $effect(() => {
    void engine;
    void schema;
    view?.dispatch({ effects: language.reconfigure(dialect()) });
  });
  $effect(() => {
    if (!view) return;
    const length = view.state.doc.length;
    const ranges: Range<Decoration>[] = marks
      .filter((m) => m.from < m.to && m.to <= length)
      .sort((a, b) => a.from - b.from)
      .map((m) =>
        Decoration.mark({ class: `cm-${m.kind}`, attributes: m.title ? { title: m.title } : {} }).range(
          m.from,
          m.to,
        ),
      );
    view.dispatch({ effects: setMarks.of(Decoration.set(ranges, true)) });
  });

  export function format_(): void {
    if (view) formatAll(view);
  }
  export function focus(): void {
    view?.focus();
  }
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    height: 100%;
    min-height: 220px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-panel);
    overflow: hidden;
  }
  .editor :global(.cm-editor) {
    height: 100%;
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .editor :global(.cm-focused) {
    outline: none;
  }
  .editor :global(.cm-target) {
    background: var(--color-accent-soft);
  }
  .editor :global(.cm-error) {
    text-decoration: underline wavy var(--color-danger);
    background: var(--color-danger-bg);
  }
</style>
