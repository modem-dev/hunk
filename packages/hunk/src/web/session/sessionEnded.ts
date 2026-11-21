/**
 * Tells the page's controls whether the session behind the page has ended.
 *
 * True once the event stream ends because the session's process exited. Controls that need the
 * session — the filter, refresh, note actions, Viewed checkboxes — read it and disable
 * themselves; reading, scrolling, layout, theme, and the palette keep working. The action
 * sender refuses writes on its own as well (`../actions/reviewActions.ts`), so a key that
 * reaches a write still shows the ended message instead of posting.
 */
import { createContext } from "react";

export const SessionEndedContext = createContext(false);
