import type { Database } from "bun:sqlite";
import { z } from "zod";

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?$/);
export const revisionSchema = z.number().int().positive();
export const documentSchema = z.object({
  title: z.string().trim().min(1).max(160),
  format: z.enum(["html", "markdown"]),
  content: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.includes("\ufffd") &&
        Buffer.byteLength(value, "utf8") <= 16 * 1024 * 1024,
      "Content must be valid UTF-8 and at most 16 MiB",
    ),
});
export const createSchema = documentSchema.extend({ slug: slugSchema });
export const updateSchema = documentSchema.extend({
  expectedRevision: revisionSchema,
});
export const metadataSchema = z.object({
  slug: z.string(),
  title: z.string(),
  format: z.enum(["html", "markdown"]),
  revision: revisionSchema,
  publishedRevision: revisionSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Metadata = z.infer<typeof metadataSchema>;
export type Artifact = Metadata & { content: string };

export class ArtifactError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const columns = `a.slug, r.title, r.format, r.revision,
  a.published_revision AS publishedRevision, a.created_at AS createdAt,
  r.created_at AS updatedAt`;

export class ArtifactStore {
  constructor(private readonly db: Database) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS artifact (
        slug TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL,
        published_revision INTEGER, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_revision (
        slug TEXT NOT NULL REFERENCES artifact(slug), revision INTEGER NOT NULL,
        title TEXT NOT NULL, format TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(slug, revision)
      );`);
  }

  create(owner: string, input: z.input<typeof createSchema>): Metadata {
    const data = createSchema.parse(input);
    return this.db
      .transaction(() => {
        if (
          this.db.query("SELECT 1 FROM artifact WHERE slug=?").get(data.slug)
        ) {
          throw new ArtifactError("Slug already exists", 409);
        }
        const now = new Date().toISOString();
        this.db
          .query("INSERT INTO artifact VALUES (?, ?, 1, NULL, ?)")
          .run(data.slug, owner, now);
        this.insertRevision(data.slug, 1, data, now);
        return this.metadata(owner, data.slug);
      })
      .immediate();
  }

  update(
    owner: string,
    slug: string,
    input: z.input<typeof updateSchema>,
  ): Metadata {
    const data = updateSchema.parse(input);
    return this.db
      .transaction(() => {
        const current = this.metadata(owner, slug);
        if (current.revision !== data.expectedRevision)
          throw new ArtifactError("Revision conflict", 409);
        const revision = current.revision + 1;
        this.insertRevision(slug, revision, data, new Date().toISOString());
        this.db
          .query(
            "UPDATE artifact SET revision=? WHERE slug=? AND owner=? AND revision=?",
          )
          .run(revision, slug, owner, data.expectedRevision);
        return this.metadata(owner, slug);
      })
      .immediate();
  }

  list(owner: string): Metadata[] {
    return this.db
      .query<Metadata, [string]>(`SELECT ${columns} FROM artifact a
      JOIN artifact_revision r ON r.slug=a.slug AND r.revision=a.revision
      WHERE a.owner=? ORDER BY r.created_at DESC, a.slug`)
      .all(owner);
  }

  metadata(owner: string, slug: string): Metadata {
    slugSchema.parse(slug);
    const value = this.db
      .query<Metadata, [string, string]>(`SELECT ${columns}
      FROM artifact a JOIN artifact_revision r ON r.slug=a.slug AND r.revision=a.revision
      WHERE a.owner=? AND a.slug=?`)
      .get(owner, slug);
    if (!value) throw new ArtifactError("Artifact not found", 404);
    return value;
  }

  read(owner: string, slug: string, revision?: number): Artifact {
    const current = this.metadata(owner, slug);
    const number = revisionSchema.parse(revision ?? current.revision);
    const value = this.db
      .query<Artifact, [string, string, number]>(`SELECT ${columns}, r.content
      FROM artifact a JOIN artifact_revision r ON r.slug=a.slug
      WHERE a.owner=? AND a.slug=? AND r.revision=?`)
      .get(owner, slug, number);
    if (!value) throw new ArtifactError("Revision not found", 404);
    return value;
  }

  history(owner: string, slug: string): Metadata[] {
    this.metadata(owner, slug);
    return this.db
      .query<Metadata, [string, string]>(`SELECT ${columns}
      FROM artifact a JOIN artifact_revision r ON r.slug=a.slug
      WHERE a.owner=? AND a.slug=? ORDER BY r.revision DESC`)
      .all(owner, slug);
  }

  publish(
    owner: string,
    slug: string,
    revision: number,
    expectedRevision: number,
  ): Metadata {
    revisionSchema.parse(revision);
    revisionSchema.parse(expectedRevision);
    return this.db
      .transaction(() => {
        if (this.metadata(owner, slug).revision !== expectedRevision) {
          throw new ArtifactError("Revision conflict", 409);
        }
        this.read(owner, slug, revision);
        this.db
          .query(
            "UPDATE artifact SET published_revision=? WHERE slug=? AND owner=?",
          )
          .run(revision, slug, owner);
        return this.metadata(owner, slug);
      })
      .immediate();
  }

  unpublish(owner: string, slug: string): Metadata {
    return this.db
      .transaction(() => {
        this.metadata(owner, slug);
        this.db
          .query(
            "UPDATE artifact SET published_revision=NULL WHERE slug=? AND owner=?",
          )
          .run(slug, owner);
        return this.metadata(owner, slug);
      })
      .immediate();
  }

  publicRead(slug: string): Artifact | null {
    return this.db
      .query<Artifact, [string]>(`SELECT ${columns}, r.content
      FROM artifact a JOIN artifact_revision r ON r.slug=a.slug AND r.revision=a.published_revision
      WHERE a.slug=?`)
      .get(slug);
  }

  publicMetadata(slug: string): Metadata | null {
    return this.db
      .query<Metadata, [string]>(`SELECT ${columns}
      FROM artifact a JOIN artifact_revision r ON r.slug=a.slug AND r.revision=a.published_revision
      WHERE a.slug=?`)
      .get(slug);
  }

  private insertRevision(
    slug: string,
    revision: number,
    data: z.infer<typeof documentSchema>,
    now: string,
  ) {
    this.db
      .query("INSERT INTO artifact_revision VALUES (?, ?, ?, ?, ?, ?)")
      .run(slug, revision, data.title, data.format, data.content, now);
  }
}
