import { useEffect } from "react";
import { useAppBlueprint } from "../api/blueprint";

/**
 * The browser tab's title for the current page: "<page> · <app>", or just the app's
 * name when the page has nothing more specific to say.
 *
 * Every page used to share one title, so a window full of tabs (three sessions, a
 * search, the list) was a row of identical "Claude Transcripts" labels, and history
 * and bookmarks couldn't tell them apart. The app's name comes from the blueprint,
 * like the header's.
 */
export function pageTitle(page: string | undefined, appTitle: string): string {
  return page ? `${page} · ${appTitle}` : appTitle;
}

export function useDocumentTitle(page: string | undefined) {
  const { data } = useAppBlueprint();
  const appTitle = data?.identity?.title ?? "Claude Transcripts";
  useEffect(() => {
    document.title = pageTitle(page, appTitle);
  }, [page, appTitle]);
}
