import { pathToFileURL } from "node:url";
import { useState } from "react";
import { registerHostRuntimeModules } from "../../../packages/hunk/src/extensions/hostRuntimeModules";

const entry = process.argv[2]!;
registerHostRuntimeModules([entry]);
const extension = await import(pathToFileURL(entry).href);
console.log(
  JSON.stringify({
    result: extension.default,
    reexported: extension.reexported,
    hostReact: extension.useState === useState,
  }),
);
