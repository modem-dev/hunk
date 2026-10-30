import { resolveRenderLib } from "@opentui/core";

process.stdout.write(resolveRenderLib() ? "loaded" : "missing");
