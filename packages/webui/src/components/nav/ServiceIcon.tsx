/**
 * The marks the architecture diagram draws, reused in the header menus.
 *
 * Imported straight from `brand/icons/` rather than copied: those files are the
 * vendored masters (see their README), and a second copy here would be one more to
 * keep in step. Keyed by the model's `IconKey`, so a topology node's `icon` is all a
 * menu needs to show it.
 */
import type { IconKey } from "@claude-transcripts/shared";
import { Box } from "@mui/material";
import claude from "../../../../../brand/icons/claude.svg";
import couchdb from "../../../../../brand/icons/couchdb.svg";
import fossil from "../../../../../brand/icons/fossil.svg";
import garage from "../../../../../brand/icons/garage.svg";
import meilisearch from "../../../../../brand/icons/meilisearch.svg";
import mark from "../../assets/logo-mark.svg";

const SRC: Record<IconKey, string> = { claude, couchdb, fossil, garage, meilisearch, mark };

/**
 * Marks drawn in `currentColor`. As an `<img>` they would render black — invisible on
 * the dark theme — so they're painted through a CSS mask in the given colour instead.
 */
const MONO: Partial<Record<IconKey, string>> = { claude: "#D97757" };

export function ServiceIcon({ icon, size = 18 }: { icon: IconKey; size?: number }) {
  const tint = MONO[icon];
  if (tint) {
    return (
      <Box
        component="span"
        aria-hidden
        sx={{
          display: "inline-block",
          flexShrink: 0,
          width: size,
          height: size,
          bgcolor: tint,
          mask: `url("${SRC[icon]}") center / contain no-repeat`,
        }}
      />
    );
  }
  return (
    <Box
      component="img"
      src={SRC[icon]}
      alt=""
      sx={{ width: size, height: size, flexShrink: 0, objectFit: "contain", display: "block" }}
    />
  );
}
