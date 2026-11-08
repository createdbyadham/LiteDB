// The SQL editor: CodeMirror 6 with the connection's dialect and schema.
//
// Each query tab keeps its own editor state (text, cursor, undo history), so
// switching tabs is not an edit and Ctrl+Z still works where you left off.

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { PostgreSQL, SQLite, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import type { SqlDialect } from '@/lib/schemaTypes';

export interface SqlCodeEditorHandle {
  focus(): void;
  getValue(): string;
  getSelection(): { from: number; to: number; text: string };
  getCursor(): number;
  replaceRange(from: number, to: number, text: string): void;
  /** Put a red underline (and gutter marker) over part of the text. */
  markError(from: number, to: number, message: string): void;
  clearErrors(): void;
  select(from: number, to: number): void;
}

export interface SqlCodeEditorProps {
  /** Which tab's state to show. Changing it swaps the whole editor state. */
  docKey: string;
  value: string;
  onChange: (value: string) => void;
  dialect: SqlDialect;
  schema: SQLNamespace;
  defaultSchema?: string;
  placeholder?: string;
  onRunStatement: () => void;
  onRunAll: () => void;
  onAi: () => void;
  onExplain: () => void;
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'hsl(var(--sql-keyword))', fontWeight: '500' },
  { tag: [t.string, t.special(t.string), t.character], color: 'hsl(var(--sql-string))' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'hsl(var(--sql-number))' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'hsl(var(--sql-comment))', fontStyle: 'italic' },
  { tag: [t.standard(t.name), t.function(t.variableName)], color: 'hsl(var(--sql-function))' },
  { tag: [t.typeName, t.className], color: 'hsl(var(--sql-type))' },
  { tag: [t.special(t.name), t.special(t.variableName)], color: 'hsl(var(--foreground))' },
  { tag: [t.operator, t.punctuation, t.separator, t.paren, t.brace, t.squareBracket], color: 'hsl(var(--muted-foreground))' },
]);

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "ui-monospace, 'Cascadia Mono', SFMono-Regular, Consolas, monospace",
    lineHeight: '1.6',
  },
  '.cm-content': { caretColor: 'hsl(var(--foreground))', padding: '10px 0' },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--muted-foreground) / 0.55)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
  '.cm-activeLine': { backgroundColor: 'hsl(var(--foreground) / 0.035)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'hsl(var(--foreground) / 0.8)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'hsl(var(--foreground))' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'hsl(var(--key) / 0.22) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'hsl(var(--key) / 0.12)' },
  '.cm-matchingBracket': { backgroundColor: 'hsl(var(--key) / 0.18)', outline: 'none' },
  '.cm-placeholder': { color: 'hsl(var(--muted-foreground) / 0.7)' },
  '.cm-tooltip': {
    backgroundColor: 'hsl(var(--popover))',
    color: 'hsl(var(--popover-foreground))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: "ui-monospace, 'Cascadia Mono', SFMono-Regular, Consolas, monospace", maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'hsl(var(--accent))',
    color: 'hsl(var(--accent-foreground))',
  },
  '.cm-completionDetail': { color: 'hsl(var(--muted-foreground))', fontStyle: 'normal', marginLeft: '0.75em' },
  '.cm-panels': { backgroundColor: 'hsl(var(--card))', color: 'hsl(var(--foreground))', borderColor: 'hsl(var(--border))' },
  '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  '.cm-searchMatch': { backgroundColor: 'hsl(var(--key) / 0.25)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'hsl(var(--key) / 0.45)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy hsl(var(--destructive))',
    textUnderlineOffset: '3px',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'hsl(var(--destructive))' },
});

function languageFor(dialect: SqlDialect, schema: SQLNamespace, defaultSchema?: string): Extension {
  return sql({
    dialect: dialect === 'postgres' ? PostgreSQL : SQLite,
    schema,
    defaultSchema,
    upperCaseKeywords: true,
  });
}

export const SqlCodeEditor = forwardRef<SqlCodeEditorHandle, SqlCodeEditorProps>(function SqlCodeEditor(
  { docKey, value, onChange, dialect, schema, defaultSchema, placeholder, onRunStatement, onRunAll, onAi, onExplain },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(new Compartment());
  const placeholderRef = useRef(new Compartment());
  const states = useRef(new Map<string, EditorState>());
  const currentKey = useRef(docKey);
  /**
   * The text this editor last reported through onChange. React hands it back
   * as `value` a render later, by which time fast typing may have moved on;
   * writing that echo back would drop keystrokes, so only a `value` that
   * differs from what we sent counts as a change from outside.
   */
  const lastEmitted = useRef(value);
  const hasErrors = useRef(false);
  const handlers = useRef({ onChange, onRunStatement, onRunAll, onAi, onExplain });
  handlers.current = { onChange, onRunStatement, onRunAll, onAi, onExplain };
  const languageConfig = useRef({ dialect, schema, defaultSchema, placeholder });
  languageConfig.current = { dialect, schema, defaultSchema, placeholder };

  const createState = (doc: string): EditorState => {
    const config = languageConfig.current;
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(highlight),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true, icons: false }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        lintGutter(),
        theme,
        languageRef.current.of(languageFor(config.dialect, config.schema, config.defaultSchema)),
        placeholderRef.current.of(placeholderExt(config.placeholder ?? '')),
        // Ahead of the defaults, so Mod-Enter runs instead of inserting a line.
        Prec.highest(
          keymap.of([
            { key: 'Mod-Enter', run: () => (handlers.current.onRunStatement(), true) },
            { key: 'Shift-Mod-Enter', run: () => (handlers.current.onRunAll(), true) },
            { key: 'F5', run: () => (handlers.current.onRunAll(), true) },
            { key: 'Mod-k', run: () => (handlers.current.onAi(), true) },
            { key: 'Mod-Shift-e', run: () => (handlers.current.onExplain(), true) },
          ]),
        ),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          lastEmitted.current = text;
          handlers.current.onChange(text);
          // An edit makes the last error's position meaningless. Cleared on
          // the next tick: dispatching inside an update listener is not allowed.
          if (hasErrors.current) {
            hasErrors.current = false;
            const view = update.view;
            queueMicrotask(() => view.dispatch(setDiagnostics(view.state, [])));
          }
        }),
      ],
    });
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({ state: createState(value), parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view lives for the component; tab switches swap its state below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch tabs: keep the old tab's state, restore or create the new one's.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || docKey === currentKey.current) return;
    states.current.set(currentKey.current, view.state);
    currentKey.current = docKey;
    lastEmitted.current = value;
    hasErrors.current = false;
    const saved = states.current.get(docKey);
    view.setState(saved && saved.doc.toString() === value ? saved : createState(value));
    // Settings may have changed while the tab was away.
    view.dispatch({ effects: languageRef.current.reconfigure(languageFor(dialect, schema, defaultSchema)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // Text replaced from outside (Text to SQL, history, a saved script).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastEmitted.current) return;
    const current = view.state.doc.toString();
    lastEmitted.current = value;
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: EditorSelection.cursor(value.length) });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: languageRef.current.reconfigure(languageFor(dialect, schema, defaultSchema)) });
  }, [dialect, schema, defaultSchema]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: placeholderRef.current.reconfigure(placeholderExt(placeholder ?? '')) });
  }, [placeholder]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
      getSelection: () => {
        const state = viewRef.current?.state;
        if (!state) return { from: 0, to: 0, text: '' };
        const range = state.selection.main;
        return { from: range.from, to: range.to, text: state.sliceDoc(range.from, range.to) };
      },
      getCursor: () => viewRef.current?.state.selection.main.head ?? 0,
      replaceRange: (from, to, text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.range(from, from + text.length) });
        view.focus();
      },
      markError: (from, to, message) => {
        const view = viewRef.current;
        if (!view) return;
        const length = view.state.doc.length;
        const start = Math.max(0, Math.min(from, length));
        const end = Math.max(start, Math.min(to, length));
        view.dispatch(setDiagnostics(view.state, [{ from: start, to: end === start ? Math.min(length, start + 1) : end, severity: 'error', message }]));
        hasErrors.current = true;
      },
      clearErrors: () => {
        const view = viewRef.current;
        if (view) view.dispatch(setDiagnostics(view.state, []));
      },
      select: (from, to) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true });
        view.focus();
      },
    }),
    [],
  );

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
});
