/**
 * Omnibox command definitions — `>` prefixed inputs.
 */
import type { ColorModePref } from "../color-mode";

export interface CommandContext {
  setColorMode: (pref: ColorModePref) => void;
  servicesMenu?: Record<string, string>;
  sessionId?: string;
}

export interface CommandDef {
  name: string;
  description: string;
  match: (input: string) => boolean;
  run: (ctx: CommandContext) => void;
}

export const COMMANDS: CommandDef[] = [
  {
    name: "theme dark",
    description: "Switch to dark theme",
    match: (input) => "theme dark".startsWith(input) || input === "theme dark",
    run: (ctx) => ctx.setColorMode("dark"),
  },
  {
    name: "theme light",
    description: "Switch to light theme",
    match: (input) => "theme light".startsWith(input) || input === "theme light",
    run: (ctx) => ctx.setColorMode("light"),
  },
  {
    name: "theme system",
    description: "Follow system theme",
    match: (input) => "theme system".startsWith(input) || input === "theme system",
    run: (ctx) => ctx.setColorMode("system"),
  },
  {
    name: "open fauxton",
    description: "Open CouchDB Fauxton",
    match: (input) => "open fauxton".startsWith(input),
    run: (ctx) => {
      const url = ctx.servicesMenu?.couchdbFauxton;
      if (url) window.open(url, "_blank");
    },
  },
  {
    name: "open meilisearch",
    description: "Open Meilisearch UI",
    match: (input) => "open meilisearch".startsWith(input),
    run: (ctx) => {
      const url = ctx.servicesMenu?.meilisearchUi ?? ctx.servicesMenu?.meilisearch;
      if (url) window.open(url, "_blank");
    },
  },
  {
    name: "open garage",
    description: "Open Garage web UI",
    match: (input) => "open garage".startsWith(input),
    run: (ctx) => {
      const url = ctx.servicesMenu?.garageWebui;
      if (url) window.open(url, "_blank");
    },
  },
];
