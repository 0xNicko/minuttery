import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const rpcTarget = "https://devnet.rpcpool.com";
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/rpc") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const upstream = await fetch(rpcTarget, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.concat(chunks),
      });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      send(response, 502, JSON.stringify({ error: "RPC proxy unavailable", detail: error.message }), "application/json");
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method Not Allowed");
    return;
  }

  const requestedPath = new URL(request.url, `http://${request.headers.host}`).pathname;
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    send(response, 403, "Forbidden");
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    send(response, 404, "Not Found");
  }
});

server.listen(4173, "0.0.0.0", () => {
  console.log("Frontend: http://0.0.0.0:4173");
  console.log(`RPC proxy: /rpc -> ${rpcTarget}`);
});