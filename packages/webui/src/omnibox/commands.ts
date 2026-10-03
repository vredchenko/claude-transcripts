/**
 * Omnibox command definitions — `>` prefixed inputs.
 */
export interface CommandContext {
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
  {
    name: "open fossil",
    description: "Open Fossil web UI",
    match: (input) => "open fossil".startsWith(input),
    run: (ctx) => {
      const url = ctx.servicesMenu?.fossil;
      if (url) window.open(url, "_blank");
    },
  },
];
