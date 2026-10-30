const [entrypoint, outdir, naming, target] = process.argv.slice(2);
if (!entrypoint || !outdir || !naming || (target !== "bun" && target !== "node")) {
  throw new TypeError("Expected entrypoint, outdir, naming, and build target.");
}

const rejected: string[] = [];
let result: Awaited<ReturnType<typeof Bun.build>> | undefined;
try {
  result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    naming,
    target,
    format: "esm",
    sourcemap: "none",
    plugins: [
      {
        name: "reject-ws-in-bun-session-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^ws(?:\/|$)/ }, (args) => {
            rejected.push(args.path);
            throw new Error(`Forbidden ws resolution in Bun session fixture: ${args.path}`);
          });
        },
      },
    ],
  });
} catch (error) {
  console.log(JSON.stringify({ success: false, rejected, error: String(error) }));
  process.exitCode = 1;
}

if (result) {
  console.log(
    JSON.stringify({
      success: result.success,
      rejected,
      logs: result.logs.map((log) => String(log)),
    }),
  );
  if (!result.success) process.exitCode = 1;
}
