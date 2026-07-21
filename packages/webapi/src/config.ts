/**
 * Runtime config for the webapi.
 *
 * Non-secret, deployment-wide defaults come from the repo-root `config/` dir
 * (`config/config.json`, falling back to the committed `config/config.template.json`
 * for zero-config dev); `.env` overlays only secrets + endpoints. Stores are
 * referenced by **logical key** (e.g. "sessions", "appLogs") — never by a
 * hard-coded name — so the app supports multiple databases and buckets. See
 * docs/configuration.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfigFile } from "@claude-transcripts/shared";

const env = process.env;

const CONFIG_DIR = env.CT_CONFIG_DIR ?? join(import.meta.dir, "../../../config");

/** Read the raw config file (live `config.json`, else the committed template). */
export function loadAppConfigFile(): AppConfigFile {
  const live = join(CONFIG_DIR, "config.json");
  const template = join(CONFIG_DIR, "config.template.json");
  const path = existsSync(live) ? live : template;
  return JSON.parse(readFileSync(path, "utf8")) as AppConfigFile;
}

const appConfig = loadAppConfigFile();

export interface Config {
  webapi: { host: string; port: number; staticDir?: string; version: string };
  couchdb: {
    host: string;
    port: number;
    user?: string;
    password?: string;
    /** logical key → database name */
    databases: Record<string, string>;
  };
  s3: {
    endpoint: string;
    region: string;
    accessKey?: string;
    secretKey?: string;
    /** logical key → bucket name */
    buckets: Record<string, string>;
  };
  system: { logging: { chunk: { maxEntriesPerChunk: number; flushIntervalMs: number } } };
  features: Record<string, boolean>;
  servicesMenu: Record<string, string>;
}

export function loadConfig(): Config {
  return {
    webapi: {
      host: env.WEBAPI_HOST ?? "127.0.0.1",
      port: Number(env.WEBAPI_PORT ?? 7650),
      staticDir: env.CT_STATIC_DIR || undefined,
      version: env.CT_VERSION ?? "0.0.0-dev",
    },
    couchdb: {
      host: env.COUCHDB_HOST ?? "127.0.0.1",
      port: Number(env.COUCHDB_PORT ?? 7652),
      user: env.COUCHDB_USER || undefined,
      password: env.COUCHDB_PASSWORD || undefined,
      databases: { ...appConfig.couchdb.databases },
    },
    s3: {
      endpoint: env.S3_ENDPOINT ?? "http://127.0.0.1:7653",
      region: env.S3_REGION ?? "garage",
      accessKey: env.S3_ACCESS_KEY || undefined,
      secretKey: env.S3_SECRET_KEY || undefined,
      buckets: { ...appConfig.s3.buckets },
    },
    system: appConfig.system,
    features: appConfig.features,
    servicesMenu: appConfig.servicesMenu,
  };
}

/** Resolve a CouchDB database name from its logical key. */
export function dbName(config: Config, key: string): string {
  const name = config.couchdb.databases[key];
  if (!name) throw new Error(`Unknown CouchDB database key: ${key}`);
  return name;
}

/** Resolve an S3 bucket name from its logical key. */
export function bucketName(config: Config, key: string): string {
  const name = config.s3.buckets[key];
  if (!name) throw new Error(`Unknown S3 bucket key: ${key}`);
  return name;
}
