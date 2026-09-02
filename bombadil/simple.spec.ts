/**
 * The smallest useful Bombadil specification for the shop.
 *
 * Bombadil's own default actions do all the exploring — clicking, scrolling,
 * typing, navigating — and these two properties must hold in every state it
 * reaches along the way.
 *
 *   bombadil browser test http://localhost:3000 bombadil/simple.spec.ts --time-limit 5m
 */

import { always } from "@antithesishq/bombadil";
import { extract } from "@antithesishq/bombadil/browser";
import { defaultActions } from "@antithesishq/bombadil/browser/defaults";

/** Explore with Bombadil's built-in actions. */
export const explore = defaultActions;

/** Uncaught exceptions seen so far. */
const uncaughtExceptions = extract((state) => state.errors.uncaughtExceptions.length);

/** Console entries seen so far (Bombadil records warnings and errors). */
const consoleEntries = extract((state) => state.console.length);

/** The page never throws. */
export const noJavaScriptErrors = always(() => uncaughtExceptions.current === 0);

/** The page never writes to the console. */
export const nothingWrittenToTheConsole = always(() => consoleEntries.current === 0);
