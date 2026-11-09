import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { foldGutter, foldKeymap } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import type { FileDocument, HighlightSpan } from "../types";

const setHighlights = StateEffect.define<HighlightSpan[]>();

function buildHighlightField() {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      let next = value;
      transaction.effects.forEach((effect) => {
        if (effect.is(setHighlights)) {
          const spans = [...effect.value]
            .filter((span) => span.end > span.start && span.end <= transaction.newDoc.length)
            .sort((a, b) => a.start - b.start || b.end - a.end);
          const builder: Range<Decoration>[] = [];
          let lastEnd = -1;
          for (const span of spans) {
            if (span.start < lastEnd) continue;
            builder.push(
              Decoration.mark({ class: `lr-token lr-${span.kind}` }).range(span.start, span.end),
            );
            lastEnd = span.end;
          }
          next = Decoration.set(builder, true);
        }
      });
      return next.map(transaction.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

interface CodeViewerProps {
  file: FileDocument | null;
  activePath: string | null;
  onDefinitionClick: (path: string, position: number) => void;
  scrollTarget: { path: string; start: number } | null;
  hint?: string;
  emptyLabel?: string;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
}

export function CodeViewer({ file, activePath, onDefinitionClick, scrollTarget, hint, emptyLabel, isBookmarked, onToggleBookmark }: CodeViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const definitionClickRef = useRef(onDefinitionClick);
  useEffect(() => {
    definitionClickRef.current = onDefinitionClick;
  }, [onDefinitionClick]);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          foldGutter(),
          history(),
          highlightSelectionMatches(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)" },
            ".cm-scroller": {
              fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
              lineHeight: "1.55",
              padding: "16px 0 48px",
            },
            ".cm-content": { caretColor: "transparent" },
            ".cm-gutters": {
              backgroundColor: "transparent",
              borderRight: "1px solid var(--border)",
              color: "var(--muted)",
            },
            ".cm-activeLine": { backgroundColor: "rgba(148, 163, 184, .08)" },
            ".cm-activeLineGutter": { backgroundColor: "rgba(148, 163, 184, .10)" },
            ".cm-selectionBackground": { backgroundColor: "rgba(56, 189, 248, .22) !important" },
          }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
          buildHighlightField(),
          EditorView.domEventHandlers({
            mousedown(event, editor) {
              if (!event.ctrlKey && !event.metaKey) return false;
              const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
              if (position == null || !activePath) return false;
              event.preventDefault();
              definitionClickRef.current(activePath, position);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activePath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const content = file?.content ?? "";
    const effects: StateEffect<unknown>[] = [setHighlights.of(file?.highlights ?? [])];
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      effects,
    });
  }, [file]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !file || !scrollTarget || scrollTarget.path !== activePath) return;
    const position = Math.max(0, Math.min(scrollTarget.start, file.content.length));
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
  }, [activePath, file, scrollTarget]);

  return (
    <div className="code-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-path">{activePath ?? emptyLabel ?? "No file selected"}</span>
        {file ? (
          <span className={`language-chip ${file.language}`}>
            {file.language}
            {file.truncated ? " \u00b7 truncated" : ""}
          </span>
        ) : null}
        <span className="viewer-hint">{hint ?? "Ctrl / \u2318 + click a symbol to jump"}</span>
        {onToggleBookmark ? (
          <button
            className={`bookmark-star ${isBookmarked ? "active" : ""}`}
            onClick={onToggleBookmark}
          >
            {isBookmarked ? "\u2605" : "\u2606"}
          </button>
        ) : null}
      </div>
      <div ref={hostRef} className="editor-host" />
    </div>
  );
}
