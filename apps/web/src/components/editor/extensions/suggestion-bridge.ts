import type { SuggestionSink } from "../suggestion-popup";
import type { Editor } from "@tiptap/core";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

type SuggestionRenderFactory<TItem> = NonNullable<SuggestionOptions<TItem, TItem>["render"]>;
type SuggestionItemsLoader<TItem> = NonNullable<SuggestionOptions<TItem, TItem>["items"]>;

export interface SuggestionSource<TItem> {
  readonly items: SuggestionItemsLoader<TItem>;
  readonly render: SuggestionRenderFactory<TItem>;
}

/**
 * Bridge one `@tiptap/suggestion` plugin to one React popup.
 *
 * The extension never imports React and the popup never imports ProseMirror;
 * they meet at `SuggestionSink`. The sink is resolved on every call rather than
 * captured, so React state changes never require rebuilding the editor.
 *
 * `items` must never reject: the suggestion utility awaits it inside a plugin
 * view update, where a rejection would surface as an unhandled promise
 * rejection. A failed lookup is recorded and reported to the popup as an error
 * state on exactly the query that failed.
 */
export function createSuggestionSource<TItem>(
  resolveSink: () => SuggestionSink<TItem> | null,
  search: (query: string, editor: Editor) => readonly TItem[] | Promise<readonly TItem[]>,
): SuggestionSource<TItem> {
  let failedQuery: string | null = null;

  const items: SuggestionItemsLoader<TItem> = async ({ query, editor }) => {
    try {
      const results = await search(query, editor);
      if (failedQuery === query) failedQuery = null;
      return [...results];
    } catch {
      failedQuery = query;
      return [];
    }
  };

  const settle = (props: SuggestionProps<TItem, TItem>): void => {
    resolveSink()?.settle({
      query: props.query,
      items: props.items,
      failed: failedQuery === props.query,
    });
  };

  const render: SuggestionRenderFactory<TItem> = () => ({
    onBeforeStart: (props) => {
      resolveSink()?.begin({
        query: props.query,
        clientRect: props.clientRect,
        command: props.command,
      });
    },
    onBeforeUpdate: (props) => {
      resolveSink()?.update({
        query: props.query,
        clientRect: props.clientRect,
        command: props.command,
      });
    },
    onStart: settle,
    onUpdate: settle,
    onExit: () => {
      // The popup session is over, so a failure recorded for one of its queries
      // must not survive into the next session and mark an unrelated lookup as
      // failed just because the user typed the same query again.
      failedQuery = null;
      resolveSink()?.exit();
    },
    onKeyDown: ({ event }) => resolveSink()?.keyDown(event) ?? false,
  });

  return { items, render };
}
