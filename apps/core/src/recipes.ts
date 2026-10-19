import { GenerateInputError, ProfileError } from "./profile-errors.js";
import { onGrid, type GuidanceSpec } from "./guidance.js";

// Recipes: ready-made starting points ("Family photo", "Anime", "Face swap") kept in the profile so the user can
// type a short prompt. A recipe wraps the user's text in a prompt template and adds a negative prompt and a
// guidance value. It is data, validated at load; the request carries only the recipe id.

export type RecipeMode = "generate" | "edit";

export interface RecipeSpec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly modes: readonly RecipeMode[];
  /** The text sent to the model; `{prompt}` is replaced by what the user typed. */
  readonly prompt: string;
  /** True when the user may leave the prompt empty (the template alone is enough). */
  readonly promptOptional: boolean;
  readonly negativePrompt: string;
  readonly cfg: number | null;
  /** Edit only: how many reference images the recipe needs. */
  readonly references: { readonly min: number; readonly max: number } | null;
}

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const MODES: readonly RecipeMode[] = ["generate", "edit"];
const KEYS = new Set(["id", "title", "description", "enabled", "modes", "prompt", "prompt_optional", "negative_prompt", "cfg", "references"]);
const TITLE_MAX = 40;
const DESCRIPTION_MAX = 300;
const TEXT_MAX = 2000;
const MAX_REFERENCES = 10;
const PLACEHOLDER = "{prompt}";

function text(v: unknown, what: string, max: number, allowEmpty = false): string {
  if (typeof v !== "string" || (!allowEmpty && v.trim() === "") || v.length > max) {
    throw new ProfileError(`${what} must be text of 1 to ${max} characters`);
  }
  return v;
}

export function parseRecipes(raw: unknown, guidance: GuidanceSpec | null): RecipeSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ProfileError("recipes must be a list");
  const out: { enabled: boolean; recipe: RecipeSpec }[] = raw.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new ProfileError(`recipe ${i} must be a mapping`);
    const r = item as Record<string, unknown>;
    const unknown = Object.keys(r).filter((k) => !KEYS.has(k));
    if (unknown.length > 0) throw new ProfileError(`recipe ${i} has unknown keys: ${unknown.sort().join(", ")}`);
    const id = r["id"];
    if (typeof id !== "string" || !ID.test(id)) throw new ProfileError(`recipe ${i} id must be lowercase letters, digits and underscores`);
    const where = `recipe ${id}`;
    if (typeof r["enabled"] !== "boolean") throw new ProfileError(`${where} enabled must be true or false`);
    const modes = r["modes"];
    if (!Array.isArray(modes) || modes.length === 0 || !modes.every((m) => (MODES as readonly unknown[]).includes(m))) {
      throw new ProfileError(`${where} modes must be a non-empty list of generate and edit`);
    }
    const prompt = text(r["prompt"], `${where} prompt`, TEXT_MAX);
    if (prompt.split(PLACEHOLDER).length > 2) throw new ProfileError(`${where} prompt may contain ${PLACEHOLDER} only once`);
    const promptOptional = r["prompt_optional"] === undefined ? false : r["prompt_optional"];
    if (typeof promptOptional !== "boolean") throw new ProfileError(`${where} prompt_optional must be true or false`);
    let cfg: number | null = null;
    if (r["cfg"] !== undefined && r["cfg"] !== null) {
      if (guidance === null) throw new ProfileError(`${where} sets cfg but the profile has no guidance section`);
      if (typeof r["cfg"] !== "number" || !onGrid(guidance, r["cfg"])) throw new ProfileError(`${where} cfg is outside the profile guidance range`);
      cfg = r["cfg"];
    }
    let references: RecipeSpec["references"] = null;
    if (r["references"] !== undefined && r["references"] !== null) {
      if (!modes.includes("edit")) throw new ProfileError(`${where} has references but is not an edit recipe`);
      const ref = r["references"] as Record<string, unknown>;
      const { min, max } = ref ?? {};
      if (typeof min !== "number" || typeof max !== "number" || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > MAX_REFERENCES) {
        throw new ProfileError(`${where} references needs whole numbers with 1 <= min <= max <= ${MAX_REFERENCES}`);
      }
      references = { min, max };
    }
    return {
      enabled: r["enabled"],
      recipe: {
        id,
        title: text(r["title"], `${where} title`, TITLE_MAX),
        description: r["description"] === undefined ? "" : text(r["description"], `${where} description`, DESCRIPTION_MAX, true),
        modes: modes as RecipeMode[],
        prompt,
        promptOptional,
        negativePrompt: r["negative_prompt"] === undefined ? "" : text(r["negative_prompt"], `${where} negative_prompt`, TEXT_MAX, true),
        cfg,
        references,
      },
    };
  });
  const ids = out.map((o) => o.recipe.id);
  if (new Set(ids).size !== ids.length) throw new ProfileError("recipe ids must be unique");
  return out.filter((o) => o.enabled).map((o) => o.recipe);
}

/** The recipe a request names for a mode; null when it names none. */
export function resolveRecipe(recipes: readonly RecipeSpec[], mode: RecipeMode, raw: unknown): RecipeSpec | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new GenerateInputError("invalid_recipe", "recipe must be an id");
  const found = recipes.find((r) => r.id === raw);
  if (!found) throw new GenerateInputError("unknown_recipe", "recipe is not offered by the profile");
  if (!found.modes.includes(mode)) throw new GenerateInputError("recipe_not_for_mode", "this recipe cannot be used in this mode");
  return found;
}

/** The prompt sent to the model. Without the placeholder the user's text follows the template. */
export function composePrompt(recipe: RecipeSpec, userPrompt: string): string {
  const user = userPrompt.trim();
  if (recipe.prompt.includes(PLACEHOLDER)) return recipe.prompt.replace(PLACEHOLDER, () => user).trim();
  return user === "" ? recipe.prompt : `${recipe.prompt} ${user}`;
}

export function checkRecipeReferences(recipe: RecipeSpec | null, count: number): void {
  if (recipe?.references == null) return;
  if (count < recipe.references.min) {
    throw new GenerateInputError("recipe_references", `this recipe needs at least ${recipe.references.min} reference image${recipe.references.min === 1 ? "" : "s"}`);
  }
  if (count > recipe.references.max) {
    throw new GenerateInputError("recipe_references", `this recipe takes at most ${recipe.references.max} reference image${recipe.references.max === 1 ? "" : "s"}`);
  }
}
