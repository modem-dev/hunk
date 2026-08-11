import type { HunkExtensionAPI } from "hunkdiff/extension";
import { createVimNavigationState } from "./state";

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

  hunk.registerCommand({ id: "toggle", title: "Toggle Vim navigation", key: "f6" }, (ctx) => {
    if (ctx.keyboardModes.isActive("normal")) {
      ctx.keyboardModes.exitMode();
      return;
    }

    ctx.keyboardModes.enterMode("normal");
  });
}
