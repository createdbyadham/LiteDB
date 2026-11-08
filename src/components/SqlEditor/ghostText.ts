// Ghost text: a suggestion from the model, shown after the cursor in a muted
// colour. Tab accepts it, Esc dismisses it, and typing its next characters
// keeps the rest. Asked for after a pause in typing, never while the
// completion popup is open, and only while the setting is on.
//
// What is sent and how the answer is cleaned is lib/inlineSuggest.ts; this
// file is the editor side.

import { EditorSelection, Prec, StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from '@codemirror/view';
import { completionStatus } from '@codemirror/autocomplete';
import type { SqlDialect } from '@/lib/schemaTypes';
import type { ColumnCatalog } from '@/lib/sqlComplete';
import {
  buildInlinePrompt,
  inlineContext,
  reconcile,
  typeThrough,
  type Ghost,
  type InlineContext,
  type InlineSuggester,
} from '@/lib/inlineSuggest';

/** Long enough that typing a word does not ask once per letter. */
const PAUSE_MS = 400;

export interface GhostTextOptions {
  /** One per editor: in-flight request, cached answers, the pause after a failure. */
  suggester: InlineSuggester;
  /** Read before each request: the setting is on and the connection allows it. */
  enabled: () => boolean;
  dialect: () => SqlDialect;
  catalog: () => ColumnCatalog | null;
  /** A suggestion went in with Tab. */
  onAccept: () => void;
}

/** Show a suggestion, or clear it with null. */
export const setGhost = StateEffect.define<Ghost | null>();

function nextGhost(ghost: Ghost | null, tr: Transaction): Ghost | null {
  for (const effect of tr.effects) if (effect.is(setGhost)) return effect.value;
  if (!ghost) return null;
  let next: Ghost | null = ghost;
  if (tr.docChanged) {
    // Type-through: one insertion at the suggestion that matches its start.
    const changes: { from: number; to: number; text: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, text: inserted.toString() }));
    next = changes.length === 1 ? typeThrough(ghost, changes[0].from, changes[0].to, changes[0].text) : null;
  }
  if (!next) return null;
  // Moving the cursor away from it, or selecting, clears it.
  const selection = tr.newSelection;
  if (selection.ranges.length > 1 || !selection.main.empty || selection.main.head !== next.pos) return null;
  return next;
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ghostText';
    // Not part of the text, so a screen reader does not read it as typed.
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.text;
    return span;
  }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update: nextGhost,
  provide: (field) =>
    EditorView.decorations.from(field, (ghost) =>
      ghost ? Decoration.set([Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.pos)]) : Decoration.none,
    ),
});

/** The suggestion on screen, if any. */
export function currentGhost(view: EditorView): Ghost | null {
  return view.state.field(ghostField, false) ?? null;
}

function accept(view: EditorView, onAccept: () => void): boolean {
  const ghost = currentGhost(view);
  if (!ghost) return false;
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: EditorSelection.cursor(ghost.pos + ghost.text.length),
    effects: setGhost.of(null),
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  onAccept();
  return true;
}

function dismiss(view: EditorView): boolean {
  if (!currentGhost(view)) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}

/** Esc clears the suggestion and, while the completion popup is open, goes on to close that too. */
function dismissOnEscape(view: EditorView): boolean {
  return dismiss(view) && completionStatus(view.state) === null;
}

function ghostPlugin(options: GhostTextOptions) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      /** Bumped by every edit and cursor move: an answer for an older one has to be checked before it shows. */
      private generation = 0;
      /** A pause came while a request was out; ask again when it is back. */
      private askAgain = false;
      private destroyed = false;
      private readonly onSettingsChanged = () => {
        // Another provider or model: old answers no longer apply.
        options.suggester.reset();
        dismiss(this.view);
      };

      constructor(readonly view: EditorView) {
        window.addEventListener('aiSettingsChanged', this.onSettingsChanged);
      }

      update(update: ViewUpdate) {
        if (!update.docChanged && !update.selectionSet) return;
        this.generation++;
        const typed = update.docChanged && update.transactions.some((tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'));
        // Text from outside (Text to SQL, a saved script) and plain cursor moves ask nothing.
        if (typed) this.schedule();
        else this.cancel();
      }

      destroy() {
        this.destroyed = true;
        this.cancel();
        window.removeEventListener('aiSettingsChanged', this.onSettingsChanged);
      }

      private schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.ask(), PAUSE_MS);
      }

      private cancel() {
        clearTimeout(this.timer);
        this.timer = undefined;
      }

      /** The statement at the cursor, if a suggestion may be asked for or shown right now. */
      private context(): InlineContext | null {
        const { state } = this.view;
        if (this.destroyed || !options.enabled() || !this.view.hasFocus) return null;
        if (currentGhost(this.view)) return null;
        const { ranges, main } = state.selection;
        if (ranges.length > 1 || !main.empty) return null;
        // The column popup has the floor.
        if (completionStatus(state) !== null) return null;
        return inlineContext(state.doc.toString(), main.head);
      }

      private async ask() {
        this.timer = undefined;
        const asked = this.context();
        if (!asked) return;
        const generation = this.generation;
        const outcome = await options.suggester.suggest(buildInlinePrompt(asked, options.dialect(), options.catalog()));
        if (this.destroyed) return;
        if (outcome.kind === 'busy') {
          this.askAgain = true;
          return;
        }
        if (outcome.kind === 'failed') console.warn('Inline suggestion failed:', outcome.error);
        const shown = outcome.kind === 'ok' && outcome.text !== null && this.show(asked, generation, outcome.text);
        if (this.askAgain) {
          this.askAgain = false;
          if (!shown && this.timer === undefined) void this.ask();
        }
      }

      private show(asked: InlineContext, generation: number, text: string): boolean {
        const now = this.context();
        if (!now) return false;
        // Typed on while the model was answering: still good if what was typed is how it starts.
        const rest = generation === this.generation ? text : reconcile(asked, now, text);
        if (!rest) return false;
        this.view.dispatch({ effects: setGhost.of({ pos: now.pos, text: rest }) });
        return true;
      }
    },
  );
}

const ghostTheme = EditorView.baseTheme({
  '.cm-ghostText': {
    color: 'hsl(var(--muted-foreground) / 0.6)',
    whiteSpace: 'pre',
    pointerEvents: 'none',
  },
});

/** Ghost-text suggestions for one editor state. */
export function ghostText(options: GhostTextOptions): Extension {
  return [
    ghostField,
    ghostPlugin(options),
    // Ahead of indentWithTab and, when listed before autocompletion(), of
    // the completion keys. Both return false when nothing is shown, so Tab
    // still indents and Esc still closes the popup.
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: (view) => accept(view, options.onAccept) },
        { key: 'Escape', run: dismissOnEscape },
      ]),
    ),
    // Leaving the editor clears it.
    EditorView.focusChangeEffect.of((state, focusing) => (!focusing && state.field(ghostField, false) ? setGhost.of(null) : null)),
    ghostTheme,
  ];
}
