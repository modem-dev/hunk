/** Serve a disk-backed npm registry in a separate process so synchronous CLI installs cannot block it. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2]!;
const authToken = JSON.parse(readFileSync(join(root, "registry-auth.json"), "utf8"));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (authToken && request.headers.get("authorization") !== `Bearer ${authToken}`) {
      return new Response("Test registry requires a bearer token", { status: 401 });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/tarballs/")) {
      return new Response(Bun.file(join(root, url.pathname.slice("/tarballs/".length))));
    }

    const name = decodeURIComponent(url.pathname.slice(1));
    const packages = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
    const record = packages[name];
    if (!record) return Response.json({ error: "not_found" }, { status: 404 });
    const versions = Object.fromEntries(
      Object.entries(record.versions).map(([version, value]) => {
        const entry = value as { manifest: object; tarball: string };
        return [
          version,
          {
            ...entry.manifest,
            dist: {
              tarball: `${url.origin}/tarballs/${entry.tarball}`,
              shasum: createHash("sha1")
                .update(readFileSync(join(root, entry.tarball)))
                .digest("hex"),
            },
          },
        ];
      }),
    );
    return Response.json({ name, "dist-tags": record.tags, versions });
  },
});
console.log(server.url.origin);
