#!/usr/bin/env bash
# Image-only checks; does not start the API or connect to a database.
set -Eeuo pipefail
image=${1:?Usage: bash scripts/docker-smoke.sh IMAGE}
docker run --rm --entrypoint node "$image" -e '
const assert = require("node:assert/strict");
const fs = require("node:fs");
assert.notEqual(process.getuid(), 0, "runtime must be non-root");
assert.equal(require("bcrypt").compareSync("smoke", require("bcrypt").hashSync("smoke", 4)), true);
assert.equal(typeof require("sharp"), "function");
assert.equal(typeof require("pg").Client, "function");
assert.equal(typeof require("typeorm").DataSource, "function");
for (const path of ["/app/uploads", "/app/logs"]) {
  const file = path + "/.docker-smoke";
  fs.writeFileSync(file, "smoke");
  fs.unlinkSync(file);
}
assert.equal(fs.existsSync("/app/.env"), false);
assert.equal(fs.existsSync("/app/dist/main.js"), true);
assert.equal(fs.existsSync("/app/dist/database/data-source.js"), true);
assert.equal(fs.readFileSync("/app/dist/main.js", "utf8").includes("127.0.0.1"), true);
console.log("API native dependencies, non-root permissions, artifacts and loopback bind: passed");
'
docker run --rm --entrypoint node "$image" \
  node_modules/typeorm/cli.js migration:run --help >/dev/null
echo 'Compiled migration CLI: passed'
