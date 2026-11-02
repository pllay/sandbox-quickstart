// Shape of the sandbox create spec, taken from the staging settle error
// 403 {"error":"certification_blocked","message":"Title not offered for auto-settlement"}.
// A spec that only has title and question is not a certified auto-settle title.
// game_slug selects the title. Side-based titles also need pov_side (home or away):
// dota2 (Radiant or Dire) and rocketleague (Blue or Orange). Fortnite does not.

export const DEFAULT_GAME_SLUG = "fortnite";

const SIDE_SLUGS = new Set(["dota2", "rocketleague"]);

const DISPLAY: Record<string, { title: string; question: string }> = {
  fortnite: {
    title: "Fortnite",
    question: "Did the POV player win (Victory Royale)?",
  },
  valorant: {
    title: "VALORANT",
    question: "Did the POV player win?",
  },
  "league-of-legends": {
    title: "League of Legends",
    question: "Did the POV player win?",
  },
  dota2: {
    title: "Dota 2",
    question: "Did the POV player win?",
  },
  pubg: {
    title: "PUBG: BATTLEGROUNDS",
    question: "Did the POV player win?",
  },
  rocketleague: {
    title: "Rocket League",
    question: "Did the POV player win?",
  },
};

export interface QuickstartSpec {
  title: string;
  question: string;
  game_slug: string;
  pov_side?: "home" | "away";
}

export type QuickstartChoice =
  | { ok: true; gameSlug: string; spec: QuickstartSpec }
  | { ok: false; message: string };

function flag(argv: string[], name: string): string | undefined {
  const eq = `--${name}=`;
  const bare = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(eq)) return arg.slice(eq.length);
    if (arg === bare) {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) return "";
      return next;
    }
  }
  return undefined;
}

export function quickstartChoice(argv: string[], envGameSlug: string, envPovSide: string): QuickstartChoice {
  const flaggedSlug = flag(argv, "game-slug");
  if (flaggedSlug === "") return { ok: false, message: "--game-slug needs a value, for example --game-slug fortnite" };
  const gameSlug = (flaggedSlug ?? envGameSlug).trim().toLowerCase() || DEFAULT_GAME_SLUG;

  const flaggedSide = flag(argv, "pov-side");
  if (flaggedSide === "") return { ok: false, message: "--pov-side needs home or away" };
  const sideRaw = (flaggedSide ?? envPovSide).trim().toLowerCase();
  let povSide: "home" | "away" | undefined;
  if (sideRaw) {
    if (sideRaw !== "home" && sideRaw !== "away") {
      return { ok: false, message: `pov_side must be home or away (got ${sideRaw}). dota2 and rocketleague require it.` };
    }
    povSide = sideRaw;
  } else if (SIDE_SLUGS.has(gameSlug)) {
    povSide = "home";
  }

  const known = DISPLAY[gameSlug];
  const spec: QuickstartSpec = {
    title: known?.title ?? gameSlug,
    question: known?.question ?? "Did the POV player win?",
    game_slug: gameSlug,
  };
  if (povSide) spec.pov_side = povSide;
  return { ok: true, gameSlug, spec };
}

export function certificationBlockedMessage(gameSlug: string, eventId?: string): string {
  const stayed = eventId ? ` Event ${eventId} stays locked.` : " The event stays locked.";
  return (
    `game_slug "${gameSlug}" is not a title offered for auto-settlement.${stayed} ` +
    "It was not settled. Set PLLAY_GAME_SLUG or pass --game-slug with a certified slug (fortnite is the default). " +
    "dota2 and rocketleague also require pov_side home or away (PLLAY_POV_SIDE or --pov-side)."
  );
}
