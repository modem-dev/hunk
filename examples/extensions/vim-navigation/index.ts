import type { HunkExtensionAPI } from "hunkdiff/extension";
import { createVimNavigationState, executeVimCommand } from "./state";

export default function (hunk: HunkExtensionAPI) {
  let navigation = createVimNavigationState({ execute: () => false });

  hunk.registerKeyboardMode({
    id: "normal",
    title: "Vim navigation",
    onEnter(ctx) {
      navigation = createVimNavigationState(ctx.commands);
      // Alignment commands need a current-line target, so make the host-owned marker visible.
      ctx.commands.execute("hunk.view.cursorLineRow");
    },
    onExit() {
      navigation.reset();
    },
    onKey(key) {
      return navigation.handleKey(key);
    },
  });

  hunk.registerCommand(
    { id: "command-line", title: "Open Vim command line", key: ";" },
    async (ctx) => {
      if (!ctx.keyboardModes.isActive("normal")) {
        ctx.notify("Enter Vim navigation before opening its command line", "info");
        return;
      }

      const input = await ctx.dialogs.input({
        title: "Vim command (;)",
        placeholder: "top or bottom",
      });
      if (input === null || !ctx.keyboardModes.isActive("normal")) return;

      const result = executeVimCommand(input, ctx.commands);
      if (result === "unknown") {
        ctx.notify(`Unknown Vim command "${input.trim()}"`, "warning");
      }
    },
  );

  hunk.registerCommand({ id: "toggle", title: "Toggle Vim navigation", key: "f6" }, (ctx) => {
    if (ctx.keyboardModes.isActive("normal")) {
      ctx.keyboardModes.exitMode();
      return;
    }

    ctx.keyboardModes.enterMode("normal");
  });
}
