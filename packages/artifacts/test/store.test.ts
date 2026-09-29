import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/store";

const dirs: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "artifact-store-"));
  dirs.push(dir);
  const file = join(dir, "data.sqlite");
  const db = new Database(file);
  databases.push(db);
  return { store: new ArtifactStore(db), file };
}

const first = {
  slug: "release-notes",
  title: "Release notes",
  format: "html" as const,
  content: "<h1>Public version one</h1>",
};

test("draft edits do not leak through a previously published URL", () => {
  const { store } = fixture();
  expect(store.create("owner-a", first).revision).toBe(1);
  expect(store.publicRead(first.slug)).toBeNull();
  store.publish("owner-a", first.slug, 1, 1);
  const second = store.update("owner-a", first.slug, {
    expectedRevision: 1,
    title: "Confidential investigation",
    format: "markdown",
    content: "# Private version two",
  });
  expect(second.revision).toBe(2);
  expect(store.read("owner-a", first.slug).content).toBe(
    "# Private version two",
  );
  expect(store.publicRead(first.slug)).toMatchObject({
    revision: 1,
    title: "Release notes",
    content: "<h1>Public version one</h1>",
    format: "html",
  });
  store.publish("owner-a", first.slug, 2, 2);
  expect(store.publicRead(first.slug)?.content).toBe("# Private version two");
  store.unpublish("owner-a", first.slug);
  expect(store.publicRead(first.slug)).toBeNull();
  expect(store.read("owner-a", first.slug, 1).content).toBe(first.content);
});

test("stale writes and publishes fail without appending or exposing a revision", () => {
  const { store, file } = fixture();
  store.create("owner-a", first);
  const otherDb = new Database(file);
  databases.push(otherDb);
  const other = new ArtifactStore(otherDb);
  store.update("owner-a", first.slug, {
    ...first,
    expectedRevision: 1,
    content: "second",
  });
  expect(() =>
    other.update("owner-a", first.slug, { ...first, expectedRevision: 1 }),
  ).toThrow("Revision conflict");
  expect(() => other.publish("owner-a", first.slug, 1, 1)).toThrow(
    "Revision conflict",
  );
  expect(store.history("owner-a", first.slug).map((r) => r.revision)).toEqual([
    2, 1,
  ]);
  expect(store.publicRead(first.slug)).toBeNull();
});

test("ownership covers reads, history, edits, publication, and unpublishing", () => {
  const { store } = fixture();
  store.create("owner-a", first);
  expect(store.list("owner-b")).toEqual([]);
  for (const operation of [
    () => store.read("owner-b", first.slug),
    () => store.history("owner-b", first.slug),
    () =>
      store.update("owner-b", first.slug, { ...first, expectedRevision: 1 }),
    () => store.publish("owner-b", first.slug, 1, 1),
    () => store.unpublish("owner-b", first.slug),
  ])
    expect(operation).toThrow("Artifact not found");
  expect(() => store.publish("owner-a", first.slug, 7, 1)).toThrow(
    "Revision not found",
  );
  expect(() => store.create("owner-b", first)).toThrow("Slug already exists");
});

test("reopening storage retains immutable revision contents and public pointer", () => {
  const { store, file } = fixture();
  store.create("owner-a", first);
  store.publish("owner-a", first.slug, 1, 1);
  store.update("owner-a", first.slug, {
    ...first,
    content: "new draft",
    expectedRevision: 1,
  });
  const db = new Database(file);
  databases.push(db);
  const reopened = new ArtifactStore(db);
  expect(reopened.publicRead(first.slug)?.content).toBe(first.content);
  expect(reopened.read("owner-a", first.slug).content).toBe("new draft");
});

test("validates hostname slugs and UTF-8 byte limits before storing content", () => {
  const { store } = fixture();
  for (const slug of [
    "../escape",
    "UPPER",
    "a.b",
    "-start",
    "end-",
    "a".repeat(55),
  ]) {
    expect(() => store.create("owner-a", { ...first, slug })).toThrow();
  }
  expect(() =>
    store.create("owner-a", { ...first, content: "bad\ufffdtext" }),
  ).toThrow();
  expect(() =>
    store.create("owner-a", {
      ...first,
      content: "é".repeat(8 * 1024 * 1024 + 1),
    }),
  ).toThrow();
  expect(store.list("owner-a")).toEqual([]);
});
